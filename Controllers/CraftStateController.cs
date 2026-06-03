using System;
using System.Threading.Tasks;
using CraftCast.Networking;
using CraftCast.State;
using Dalamud.Plugin.Services;
using FFXIVClientStructs.FFXIV.Client.Game.Event;
using FFXIVClientStructs.FFXIV.Client.Game.UI;
using FFXIVClientStructs.FFXIV.Component.GUI;

namespace CraftCast.Controllers;

/// <summary>
/// Reads the active craft handler from game memory on each framework tick and
/// pushes changes to the network layer. All pointer access runs on the main
/// game thread (the only thread where reading is safe). Self-subscribes to
/// <see cref="IFramework.Update"/> and detaches on <see cref="Dispose"/>.
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

    private readonly WebSocketServerService _server;
    private readonly SharedState _state;

    private bool   _active;
    private string _lastCondition = string.Empty;
    private int    _lastStep = -1;
    private int    _lastCp   = -1;
    private DateTime _lastTick = DateTime.MinValue;

    // Snapshotted once per craft — these don't change mid-synthesis.
    private int _craftsmanship, _control, _maxCp;
    private int _maxProgress, _maxDurability, _maxQuality;

    public CraftStateController(WebSocketServerService server, SharedState state)
    {
        _server = server;
        _state = state;
        Services.Framework.Update += OnFrameworkUpdate;
    }

    public void Dispose() => Services.Framework.Update -= OnFrameworkUpdate;

    private unsafe void OnFrameworkUpdate(IFramework framework)
    {
        try
        {
            if ((DateTime.UtcNow - _lastTick).TotalMilliseconds < MinTickIntervalMs) return;
            _lastTick = DateTime.UtcNow;

            var eventFramework = EventFramework.Instance();
            if (eventFramework == null) { Reset(); return; }

            var handler = eventFramework->GetCraftEventHandler();
            if (handler == null) { Reset(); return; } // not in a synthesis

            // Entering a synthesis (or recipe maxes not yet populated): cache the
            // invariant stats and recipe constants. The addon can lag a frame or
            // two behind the handler, so re-cache until the maxes read non-zero.
            _active = true;
            if (_maxProgress == 0) CacheInvariants();

            var condition = Translate((byte)handler->Condition);
            int step = handler->StepNumber;
            int cp   = ReadCurrentCp();

            if (condition == _lastCondition && step == _lastStep && cp == _lastCp) return; // no change

            _lastCondition = condition;
            _lastStep = step;
            _lastCp = cp;
            _state.SetState(condition, step);

            int curProgress = 0, curQuality = 0;
            var synth = (AtkUnitBase*)Services.GameGui.GetAddonByName("Synthesis", 1);
            if (synth != null && synth->AtkValuesCount >= AtkMinValueCount)
            {
                curProgress = synth->AtkValues[AtkCurProgress].Int;
                curQuality  = synth->AtkValues[AtkCurQuality].Int;
            }

            var payload = new StatePayload
            {
                Step            = step,
                Condition       = condition,
                Craftsmanship   = _craftsmanship,
                Control         = _control,
                Cp              = cp,
                Difficulty      = _maxProgress,
                Durability      = _maxDurability,
                MaxQuality      = _maxQuality,
                CurrentProgress = curProgress,
                CurrentQuality  = curQuality,
            };

            Services.Log.Verbose(
                $"CraftCast tx: step={step} cond={condition} cp={cp} " +
                $"prog={curProgress}/{_maxProgress} qual={curQuality}/{_maxQuality}");

            // Fire-and-forget: never block the game thread on socket I/O.
            _ = BroadcastSafelyAsync(payload);
        }
        catch (Exception ex)
        {
            Services.Log.Error(ex, "CraftStateController tick failed.");
        }
    }

    private unsafe void CacheInvariants()
    {
        var ps = PlayerState.Instance();
        if (ps != null)
        {
            _craftsmanship = ps->Attributes[AttrCraftsmanship];
            _control       = ps->Attributes[AttrControl];
            _maxCp         = ps->Attributes[AttrMaxCp];
        }

        var synth = (AtkUnitBase*)Services.GameGui.GetAddonByName("Synthesis", 1);
        if (synth != null && synth->AtkValuesCount >= AtkMinValueCount)
        {
            _maxProgress   = synth->AtkValues[AtkMaxProgress].Int;
            _maxDurability = synth->AtkValues[AtkMaxDurability].Int;
            _maxQuality    = synth->AtkValues[AtkMaxQuality].Int;
        }
    }

    private int ReadCurrentCp()
    {
        var player = Services.ClientState.LocalPlayer;
        if (player != null) return (int)player.CurrentCp;
        // Player object briefly null — keep the last known value rather than
        // falsely reporting max CP to the solver.
        return _lastCp >= 0 ? _lastCp : _maxCp;
    }

    private void Reset()
    {
        if (!_active) return;
        _active = false;
        _lastCondition = string.Empty;
        _lastStep = -1; // forces a fresh broadcast when the next synthesis begins
        _lastCp = -1;
        _maxProgress = _maxDurability = _maxQuality = 0; // re-cache next craft
    }

    private async Task BroadcastSafelyAsync(StatePayload payload)
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
