using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using CraftCast.Networking;
using CraftCast.State;
using Dalamud.Plugin.Services;
using FFXIVClientStructs.FFXIV.Client.Game.Event;
using FFXIVClientStructs.FFXIV.Client.Game.UI;
using FFXIVClientStructs.FFXIV.Component.GUI;

namespace CraftCast.Controllers;

/// <summary>
/// Maintains the authoritative model of the active synthesis and broadcasts it
/// as a full document on every meaningful change.
///
/// Model: a craft is a SESSION (monotonic id) plus an ordered HISTORY of the
/// actions the player performed. Each history entry resolves to the condition
/// rolled after the action and whether it succeeded. Because every broadcast
/// carries the whole history, a dropped frame or a browser reconnect can never
/// desync the solver — the client just reconciles against the latest document.
///
/// All pointer access runs on the main game thread (the only thread where
/// reading is safe). Self-subscribes to <see cref="IFramework.Update"/> and
/// detaches on <see cref="Dispose"/>.
/// </summary>
public sealed class CraftStateController : IDisposable
{
    // ── Memory-layout constants ──────────────────────────────────────────────
    // VERIFY against your installed FFXIVClientStructs version after any patch.
    // PlayerState.Attributes[] indices (invariant during a synthesis):
    private const int AttrCraftsmanship = 70;
    private const int AttrControl       = 71;
    private const int AttrMaxCp         = 11;
    // "Synthesis" addon AtkValues indices:
    private const int AtkCurProgress   = 5;
    private const int AtkMaxProgress   = 6;
    private const int AtkMaxDurability = 8;
    private const int AtkCurQuality    = 16;
    private const int AtkMaxQuality    = 17;
    private const int AtkMinValueCount = 18;

    // Cap reads to ~10/sec; the game ticks far faster and nothing here changes
    // between actions, so polling harder is pure waste.
    private const double MinTickIntervalMs = 100.0;

    /// <summary>
    /// Step-free actions resolve on a timer (or an observed condition reroll)
    /// because nothing else signals their completion.
    /// </summary>
    private static readonly TimeSpan FreeActionSettle = TimeSpan.FromMilliseconds(1200);

    /// <summary>
    /// A fallible action that produced no progress/quality delta this long
    /// after its step was consumed is a failure. The Synthesis addon's bars
    /// settle well within this window.
    /// </summary>
    private static readonly TimeSpan FailureSettle = TimeSpan.FromMilliseconds(2000);

    /// <summary>
    /// After the craft handler vanishes, keep reading the (still open) addon
    /// briefly so the final action's outcome can be resolved from its bars.
    /// </summary>
    private static readonly TimeSpan EndDrain = TimeSpan.FromMilliseconds(2500);

    /// <summary>Actions that do not consume a synthesis step.</summary>
    private static readonly HashSet<string> StepFreeActions = new(StringComparer.OrdinalIgnoreCase)
    {
        "Final Appraisal", "Heart and Soul", "Careful Observation", "Quick Innovation",
    };

    /// <summary>Actions with a success rate below 100%.</summary>
    private static readonly HashSet<string> FallibleActions = new(StringComparer.OrdinalIgnoreCase)
    {
        "Rapid Synthesis", "Hasty Touch", "Daring Touch",
    };

    /// <summary>One performed action and its (eventually observed) outcome.</summary>
    private sealed class StepEntry
    {
        public required int      Index;
        public string?           Action;          // null = hook missed it (degraded mode)
        public bool              IsFree;
        public bool              RerollsCondition; // Careful Observation: rerolls without a step
        public bool              CanFail;
        public bool              FailsOnQuality;   // Hasty/Daring judge by quality; Rapid by progress
        public int               StepAtUse;
        public int               ProgressAtUse;
        public int               QualityAtUse;
        public string            ConditionAtUse = string.Empty;
        public DateTime          UsedAt;
        public DateTime?         StepConfirmedAt; // step-consuming action observed to land
        public string?           NewCondition;    // condition rolled after the action
        public bool?             Success;
        public bool Resolved => NewCondition is not null && Success is not null;
    }

    private readonly WebSocketServerService _server;
    private readonly SharedState _state;
    private readonly CraftActionTracker _tracker;
    private readonly ConcurrentQueue<string> _usedActions = new();

    // Broadcasts chain sequentially so two fired-and-forgotten sends can never
    // deliver an older document after a newer one.
    private Task _broadcastChain = Task.CompletedTask;

    // ── Per-craft state ──────────────────────────────────────────────────────
    private readonly List<StepEntry> _history = new();
    private int       _session;
    private bool      _active;
    private bool      _fromStart;
    private DateTime? _endingSince;
    private DateTime  _sessionStartedAt;

    // Snapshotted once per craft — these don't change mid-synthesis.
    private int    _craftsmanship, _control, _maxCp, _playerLevel;
    private int    _maxProgress, _maxDurability, _maxQuality;
    private int    _sheetMaxProgress, _sheetMaxDurability, _sheetMaxQuality;
    private int    _progressDivider, _progressModifier, _qualityDivider, _qualityModifier;
    private int    _recipeLevel;
    private string _recipeRating = string.Empty;
    private uint   _activeRecipeId;

    // The Synthesis addon's progress/quality AtkValues are garbage on some
    // content (cosmic missions read a constant junk quality); reads that
    // violate the sheet-derived maxes flip these off for the session.
    private bool   _progressTrusted = true;
    private bool   _qualityTrusted  = true;

    // Live snapshot.
    private int    _step = -1;
    private string _condition = string.Empty;
    private int    _curProgress, _curQuality, _cp;

    private bool     _dirty;
    private DateTime _lastTick = DateTime.MinValue;

    public CraftStateController(WebSocketServerService server, SharedState state, CraftActionTracker tracker)
    {
        _server = server;
        _state = state;
        _tracker = tracker;
        _tracker.CraftActionUsed += OnCraftActionUsed;
        Services.Framework.Update += OnFrameworkUpdate;
    }

    public void Dispose()
    {
        Services.Framework.Update -= OnFrameworkUpdate;
        _tracker.CraftActionUsed -= OnCraftActionUsed;
    }

    // Fired on the game thread, but queued anyway so ordering with the tick is explicit.
    private void OnCraftActionUsed(string name) => _usedActions.Enqueue(name);

    private unsafe void OnFrameworkUpdate(IFramework framework)
    {
        try
        {
            var now = DateTime.UtcNow;
            if ((now - _lastTick).TotalMilliseconds < MinTickIntervalMs) return;
            _lastTick = now;

            var eventFramework = EventFramework.Instance();
            var handler = eventFramework == null ? null : eventFramework->GetCraftEventHandler();

            if (handler == null)
            {
                TickCraftEnding(now);
                return;
            }
            _endingSince = null;

            var condition = Translate((byte)handler->Condition);
            int step = handler->StepNumber;

            // Chained crafts can restart faster than the tick ever observes a
            // null handler — a step regression or recipe change is the only
            // signal. Close the old session out before starting the new one.
            if (_active && _step > 0)
            {
                var recipeId = CurrentRecipeId();
                if (step < _step || (recipeId != 0 && _activeRecipeId != 0 && recipeId != _activeRecipeId))
                {
                    Services.Log.Debug("CraftCast: new craft detected without an idle gap; finalizing previous session.");
                    FinalizeSession();
                }
            }
            // The handler lingers at step 0 while a craft initializes AND on
            // the completion screen after one ends. Only step >= 1 is a live
            // craft — beginning a session at step 0 would reset the solver and
            // ingest end-screen garbage right after every craft.
            if (!_active)
            {
                if (step < 1) return;
                BeginSession(step);
            }

            // The addon/player objects can lag a frame or two behind the
            // handler, so re-cache until everything essential reads non-zero.
            if (_maxProgress == 0 || _craftsmanship == 0 || _playerLevel == 0)
                CacheInvariants();

            ReadLiveValues(out var curProgress, out var curQuality, out var cp);

            // Sanity-bound the addon reads against the recipe's real maxes;
            // out-of-range values mean that AtkValue isn't what we think it is
            // on this content, so stop using it for outcome decisions. Skip
            // the first moments of a session: on chained crafts the addon can
            // briefly still show the previous craft's bars.
            var settledIn = (now - _sessionStartedAt).TotalMilliseconds > 500;
            if (settledIn && _progressTrusted && _maxProgress > 0 && (uint)curProgress > (uint)_maxProgress)
            {
                _progressTrusted = false;
                Services.Log.Warning($"CraftCast: progress read {curProgress} exceeds max {_maxProgress}; progress reads untrusted this craft.");
            }
            if (settledIn && _qualityTrusted && _maxQuality > 0 && (uint)curQuality > (uint)_maxQuality)
            {
                _qualityTrusted = false;
                Services.Log.Warning($"CraftCast: quality read {curQuality} exceeds max {_maxQuality}; quality reads untrusted this craft.");
            }

            // 1. Record actions the player performed since the last tick.
            while (_usedActions.TryDequeue(out var name))
                AppendEntry(name, step, condition, curProgress, curQuality, now);

            // 2. Step increments confirm in-flight step-consuming actions (FIFO).
            // The handler counts 0 -> 1 during craft initialization; only
            // transitions from step 1 onwards correspond to performed actions.
            if (step > _step && _step >= 1)
                ConfirmStepAdvance(_step, step, condition, now);

            // 3. Resolve pending outcomes (free-action timers, success/failure deltas).
            ResolvePending(condition, curProgress, curQuality, now);

            // 4. Live snapshot.
            if (step != _step || condition != _condition || cp != _cp ||
                curProgress != _curProgress || curQuality != _curQuality)
                _dirty = true;

            _step = step;
            _condition = condition;
            _cp = cp;
            _curProgress = curProgress;
            _curQuality = curQuality;
            _state.SetState(condition, step);

            if (_dirty) Broadcast("active");
        }
        catch (Exception ex)
        {
            Services.Log.Error(ex, "CraftStateController tick failed.");
        }
    }

    // ── Session lifecycle ────────────────────────────────────────────────────

    private void BeginSession(int step)
    {
        _session++;
        _active = true;
        _fromStart = step <= 1;
        _sessionStartedAt = DateTime.UtcNow;
        _history.Clear();
        _maxProgress = _maxDurability = _maxQuality = 0;
        _sheetMaxProgress = _sheetMaxDurability = _sheetMaxQuality = 0;
        _progressDivider = _progressModifier = _qualityDivider = _qualityModifier = 0;
        _recipeLevel = 0;
        _recipeRating = string.Empty;
        _activeRecipeId = 0;
        _progressTrusted = _qualityTrusted = true;
        _step = -1;
        _condition = string.Empty;
        _curProgress = _curQuality = _cp = 0;
        while (_usedActions.TryDequeue(out _)) { } // drop stale pre-craft actions
        _dirty = true;

        if (!_fromStart)
            Services.Log.Warning($"Attached to a craft already at step {step}; earlier steps are unknown, solver auto-sync is disabled for this session.");
    }

    /// <summary>
    /// The craft handler is gone. The final action's outcome may not be
    /// observable yet (the addon bars settle during the completion animation),
    /// so keep draining the addon briefly before finalizing.
    /// </summary>
    private unsafe void TickCraftEnding(DateTime now)
    {
        if (!_active) return;
        _endingSince ??= now;

        var synth = (AtkUnitBase*)Services.GameGui.GetAddonByName("Synthesis", 1).Address;
        if (synth != null && synth->AtkValuesCount >= AtkMinValueCount)
        {
            _curProgress = Math.Max(_curProgress, synth->AtkValues[AtkCurProgress].Int);
            _curQuality  = Math.Max(_curQuality,  synth->AtkValues[AtkCurQuality].Int);
            ResolvePending(_condition, _curProgress, _curQuality, now);
        }

        // Only fallible actions whose outcome is still ambiguous justify
        // waiting; everything else resolves deterministically in finalize.
        var awaitingDelta = _history.Any(e =>
            !e.Resolved && e.CanFail && e.Success is null &&
            JudgeFallible(e, _curProgress, _curQuality, settled: false) is null);
        if (synth != null && awaitingDelta && now - _endingSince.Value < EndDrain) return;

        FinalizeSession();
    }

    private void FinalizeSession()
    {
        foreach (var entry in _history.Where(e => !e.Resolved))
        {
            entry.NewCondition ??= _condition;
            // No delta observed by the end of the craft: a fallible action
            // failed; anything else succeeded by definition.
            entry.Success ??= !entry.CanFail
                || (JudgeFallible(entry, _curProgress, _curQuality, settled: true) ?? true);
        }

        Broadcast("complete");
        _active = false;
        _endingSince = null;
        _state.SetState("idle", 0);
    }

    // ── History bookkeeping ──────────────────────────────────────────────────

    private void AppendEntry(string action, int step, string condition, int progress, int quality, DateTime now)
    {
        // The game accepting a new action means every earlier action has fully
        // resolved — the bars and condition at this instant ARE its outcome.
        // Freezing the baseline here also stops a later action's delta from
        // being credited to an earlier failed Hasty/Rapid within its window.
        foreach (var stale in _history.Where(e => !e.Resolved))
        {
            stale.NewCondition ??= condition;
            stale.Success ??= !stale.CanFail
                || (JudgeFallible(stale, progress, quality, settled: true) ?? true);
        }

        _history.Add(new StepEntry
        {
            Index            = _history.Count + 1,
            Action           = action,
            IsFree           = StepFreeActions.Contains(action),
            RerollsCondition = string.Equals(action, "Careful Observation", StringComparison.OrdinalIgnoreCase),
            CanFail          = FallibleActions.Contains(action),
            FailsOnQuality   = string.Equals(action, "Hasty Touch", StringComparison.OrdinalIgnoreCase)
                            || string.Equals(action, "Daring Touch", StringComparison.OrdinalIgnoreCase),
            StepAtUse        = step,
            ProgressAtUse    = progress,
            QualityAtUse     = quality,
            ConditionAtUse   = condition,
            UsedAt           = now,
        });
        _dirty = true;

        Services.Log.Verbose($"CraftCast: recorded action '{action}' at step {step}.");
    }

    private void ConfirmStepAdvance(int prevStep, int newStep, string condition, DateTime now)
    {
        // A lag hitch can deliver more than one step per tick; confirm one
        // in-flight action (FIFO) per consumed step. Steps below 1 are craft
        // initialization, never actions.
        for (var s = Math.Max(prevStep, 1); s < newStep; s++)
        {
            var pending = _history.FirstOrDefault(e => !e.IsFree && e.StepConfirmedAt is null && !e.Resolved);
            if (pending is not null)
            {
                pending.StepConfirmedAt = now;
                pending.NewCondition = condition;
                if (!pending.CanFail) pending.Success = true;
            }
            else
            {
                // No recorded action explains this advance (hook missed/unavailable).
                // Synthesize a resolved placeholder so the indices stay aligned; the
                // client keeps the solver's suggested action for this row.
                _history.Add(new StepEntry
                {
                    Index           = _history.Count + 1,
                    Action          = null,
                    StepAtUse       = s,
                    ConditionAtUse  = _condition,
                    UsedAt          = now,
                    StepConfirmedAt = now,
                    NewCondition    = condition,
                    Success         = true,
                });
                Services.Log.Warning("CraftCast: step advanced without an observed action; recorded a placeholder.");
            }
        }
        _dirty = true;
    }

    private void ResolvePending(string condition, int curProgress, int curQuality, DateTime now)
    {
        foreach (var entry in _history)
        {
            if (entry.Resolved) continue;

            if (entry.IsFree)
            {
                // Careful Observation rerolls the condition without consuming a
                // step — an observed reroll resolves it early. The other free
                // actions never change the condition, so only the timer applies.
                if ((entry.RerollsCondition && condition != entry.ConditionAtUse) ||
                    now - entry.UsedAt > FreeActionSettle)
                {
                    entry.NewCondition = condition;
                    entry.Success = true;
                    _dirty = true;
                }
                continue;
            }

            if (entry.StepConfirmedAt is null || entry.Success is not null) continue;

            // Fallible action whose step landed: success shows up as a bar delta;
            // a settled UI with no delta means it failed.
            var judged = JudgeFallible(entry, curProgress, curQuality,
                settled: now - entry.StepConfirmedAt.Value > FailureSettle);
            if (judged is not null)
            {
                entry.Success = judged;
                _dirty = true;
            }
        }
    }

    /// <summary>
    /// Judges a fallible action from the bar relevant to it (Rapid Synthesis →
    /// progress, Hasty/Daring Touch → quality). When that bar's reads are
    /// untrusted on this content, assume success rather than fabricating a
    /// failure — a false Failure derails the solver far worse.
    /// Returns null while the outcome is still ambiguous (not settled yet).
    /// </summary>
    private bool? JudgeFallible(StepEntry entry, int progress, int quality, bool settled)
    {
        var trusted = entry.FailsOnQuality ? _qualityTrusted : _progressTrusted;
        if (!trusted)
        {
            Services.Log.Warning(
                $"CraftCast: cannot verify outcome of '{entry.Action}' " +
                $"({(entry.FailsOnQuality ? "quality" : "progress")} reads untrusted); assuming success.");
            return true;
        }

        var delta = entry.FailsOnQuality
            ? quality > entry.QualityAtUse
            : progress > entry.ProgressAtUse;
        if (delta) return true;
        return settled ? false : null;
    }

    // ── Memory reads ─────────────────────────────────────────────────────────

    private unsafe void CacheInvariants()
    {
        var ps = PlayerState.Instance();
        if (ps != null)
        {
            _craftsmanship = ps->Attributes[AttrCraftsmanship];
            _control       = ps->Attributes[AttrControl];
            _maxCp         = ps->Attributes[AttrMaxCp];
        }

        _playerLevel = (int)(Services.ObjectTable.LocalPlayer?.Level ?? 0);

        CacheRecipeInfo(); // also computes the sheet-derived maxes

        int addonProgress = 0, addonDurability = 0, addonQuality = 0;
        var synth = (AtkUnitBase*)Services.GameGui.GetAddonByName("Synthesis", 1).Address;
        if (synth != null && synth->AtkValuesCount >= AtkMinValueCount)
        {
            addonProgress   = synth->AtkValues[AtkMaxProgress].Int;
            addonDurability = synth->AtkValues[AtkMaxDurability].Int;
            addonQuality    = synth->AtkValues[AtkMaxQuality].Int;
        }

        // The recipe sheet is authoritative for the maxes; the addon AtkValues
        // have proven unreliable on some content (cosmic missions report the
        // CURRENT durability there, and junk in the quality slot).
        _maxProgress   = _sheetMaxProgress   > 0 ? _sheetMaxProgress   : addonProgress;
        _maxDurability = _sheetMaxDurability > 0 ? _sheetMaxDurability : addonDurability;
        _maxQuality    = _sheetMaxQuality    > 0 ? _sheetMaxQuality    : addonQuality;

        if (_sheetMaxDurability > 0 && addonDurability > 0 && addonDurability != _sheetMaxDurability)
            Services.Log.Debug($"CraftCast: addon/sheet max durability disagree (addon={addonDurability}, sheet={_sheetMaxDurability}); using sheet.");

        _dirty = true;
    }

    private unsafe void CacheRecipeInfo()
    {
        try
        {
            var recipeNote = RecipeNote.Instance();
            if (recipeNote == null) return;

            uint recipeId = recipeNote->ActiveCraftRecipeId;
            if (recipeId == 0) return;

            var recipe = Services.DataManager.GetExcelSheet<Lumina.Excel.Sheets.Recipe>()?.GetRowOrDefault(recipeId);
            if (recipe is not { } r) return;

            _activeRecipeId = recipeId;
            _recipeLevel    = (int)r.RecipeLevelTable.RowId;

            var rlt = r.RecipeLevelTable.Value;
            _recipeRating = r.IsExpert ? "expert"
                          : rlt.Stars >= 2 ? "star"
                          : "normal";

            // Real recipe constants: base values from the rlvl table scaled by
            // the recipe's percentage factors.
            _sheetMaxProgress   = (int)(rlt.Difficulty * r.DifficultyFactor / 100);
            _sheetMaxQuality    = (int)((long)rlt.Quality * r.QualityFactor / 100);
            _sheetMaxDurability = rlt.Durability * r.DurabilityFactor / 100;

            // Exact crafting-formula parameters for this rlvl; the client uses
            // them when the solver doesn't recognize the item.
            _progressDivider  = rlt.ProgressDivider;
            _progressModifier = rlt.ProgressModifier;
            _qualityDivider   = rlt.QualityDivider;
            _qualityModifier  = rlt.QualityModifier;
        }
        catch (Exception ex)
        {
            // Recipe metadata is a nice-to-have; the craft still syncs without it.
            Services.Log.Warning(ex, "Could not resolve active recipe metadata.");
        }
    }

    private static unsafe uint CurrentRecipeId()
    {
        try
        {
            var recipeNote = RecipeNote.Instance();
            return recipeNote == null ? 0u : recipeNote->ActiveCraftRecipeId;
        }
        catch
        {
            return 0;
        }
    }

    private unsafe void ReadLiveValues(out int curProgress, out int curQuality, out int cp)
    {
        curProgress = _curProgress;
        curQuality  = _curQuality;

        var synth = (AtkUnitBase*)Services.GameGui.GetAddonByName("Synthesis", 1).Address;
        if (synth != null && synth->AtkValuesCount >= AtkMinValueCount)
        {
            curProgress = synth->AtkValues[AtkCurProgress].Int;
            curQuality  = synth->AtkValues[AtkCurQuality].Int;
        }

        // Player object briefly null — keep the last known CP rather than
        // falsely reporting zero to the solver.
        var player = Services.ObjectTable.LocalPlayer;
        cp = player != null ? (int)player.CurrentCp : _cp;
    }

    // ── Broadcast ────────────────────────────────────────────────────────────

    private void Broadcast(string status)
    {
        _dirty = false;

        var payload = new CraftStatePayload
        {
            Session   = _session,
            Status    = status,
            FromStart = _fromStart,
            Player    = new PlayerInfo
            {
                Level         = _playerLevel,
                Craftsmanship = _craftsmanship,
                Control       = _control,
                Cp            = _maxCp,
            },
            Recipe    = new RecipeInfo
            {
                Level            = _recipeLevel,
                Rating           = _recipeRating,
                Progress         = _maxProgress,
                Durability       = _maxDurability,
                Quality          = _maxQuality,
                ProgressDivider  = _progressDivider,
                ProgressModifier = _progressModifier,
                QualityDivider   = _qualityDivider,
                QualityModifier  = _qualityModifier,
            },
            Current   = new SnapshotInfo
            {
                Step      = _step,
                Condition = _condition,
                // Don't propagate values we know are junk on this content.
                Progress  = _progressTrusted ? _curProgress : 0,
                Quality   = _qualityTrusted ? _curQuality : 0,
                Cp        = _cp,
            },
            Steps = _history.Select(e => new StepInfo
            {
                Index     = e.Index,
                Action    = e.Action,
                Condition = e.NewCondition,
                Success   = e.Success,
            }).ToList(),
        };

        Services.Log.Verbose(
            $"CraftCast tx: session={payload.Session} status={status} step={_step} cond={_condition} " +
            $"history={_history.Count} resolved={_history.Count(e => e.Resolved)}");

        // Fire-and-forget, but chained: never block the game thread on socket
        // I/O, while still guaranteeing documents go out in order.
        _broadcastChain = _broadcastChain
            .ContinueWith(_ => BroadcastSafelyAsync(payload), TaskScheduler.Default)
            .Unwrap();
    }

    private async Task BroadcastSafelyAsync(CraftStatePayload payload)
    {
        try
        {
            await _server.BroadcastAsync(payload).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            Services.Log.Error(ex, "State broadcast failed.");
        }
    }

    /// <summary>
    /// Maps the raw CraftCondition byte to the lowercase keys the userscript expects.
    /// Adjust the enum's namespace if your FFXIVClientStructs version locates it elsewhere.
    /// </summary>
    private static string Translate(byte raw) => (CraftCondition)raw switch
    {
        CraftCondition.Normal    => "normal",
        CraftCondition.Good      => "good",
        CraftCondition.Excellent => "excellent",
        CraftCondition.Poor      => "poor",
        CraftCondition.Centered  => "centered",
        CraftCondition.Sturdy    => "sturdy",
        CraftCondition.Pliant    => "pliant",
        CraftCondition.Malleable => "malleable",
        CraftCondition.Primed    => "primed",
        CraftCondition.GoodOmen  => "goodOmen",
        (CraftCondition)11       => "robust", // explicit fallback for type 11
        _                        => "normal",
    };
}
