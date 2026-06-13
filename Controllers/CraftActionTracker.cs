using System;
using Dalamud.Game;
using Dalamud.Game.ClientState.Conditions;
using Dalamud.Hooking;
using FFXIVClientStructs.FFXIV.Client.Game;
using LuminaAction      = Lumina.Excel.Sheets.Action;
using LuminaCraftAction = Lumina.Excel.Sheets.CraftAction;

namespace CraftCast.Controllers;

/// <summary>
/// Observes which crafting action the player ACTUALLY performs by hooking
/// <c>ActionManager.UseAction</c>. This is the ground truth the solver bridge
/// needs: without it the browser can only confirm whatever the solver
/// suggested, which desyncs the simulation the moment the player deviates.
///
/// Names are resolved from the English sheets regardless of client language,
/// because the web solver's action list is English.
/// </summary>
public sealed unsafe class CraftActionTracker : IDisposable
{
    private delegate bool UseActionDelegate(
        ActionManager* manager,
        ActionType actionType,
        uint actionId,
        ulong targetId,
        uint extraParam,
        ActionManager.UseActionMode mode,
        uint comboRouteId,
        bool* outOptAreaTargeted);

    private readonly Hook<UseActionDelegate>? _useActionHook;

    /// <summary>
    /// Raised on the game thread when a crafting action was accepted by the
    /// client while a synthesis is active. Carries the English action name.
    /// </summary>
    public event Action<string>? CraftActionUsed;

    /// <summary>False when the hook could not be created; the bridge then runs degraded.</summary>
    public bool IsAvailable => _useActionHook is not null;

    public CraftActionTracker()
    {
        try
        {
            _useActionHook = Services.GameInterop.HookFromAddress<UseActionDelegate>(
                (nint)ActionManager.Addresses.UseAction.Value, UseActionDetour);
            _useActionHook.Enable();
        }
        catch (Exception ex)
        {
            // Degrade instead of failing the whole plugin: the state controller
            // synthesizes placeholder entries when no action events arrive.
            Services.Log.Error(ex,
                "Failed to hook UseAction; performed actions cannot be observed and the " +
                "solver will assume its own suggestions were followed.");
        }
    }

    public void Dispose() => _useActionHook?.Dispose();

    private bool UseActionDetour(
        ActionManager* manager, ActionType actionType, uint actionId, ulong targetId,
        uint extraParam, ActionManager.UseActionMode mode, uint comboRouteId, bool* outOptAreaTargeted)
    {
        var used = _useActionHook!.Original(
            manager, actionType, actionId, targetId, extraParam, mode, comboRouteId, outOptAreaTargeted);

        try
        {
            // Only record requests the client accepted (CP/condition checks are
            // client-side, so an accepted craft action virtually always lands).
            if (used && Services.Condition[ConditionFlag.Crafting])
            {
                // Resolve action upgrades: pressing Hasty Touch while Expedience
                // is active executes Daring Touch, but UseAction is still called
                // with Hasty Touch's id. GetAdjustedActionId returns the action
                // that actually fires, so the solver sees what really happened.
                var resolvedId = actionId;
                try
                {
                    var adjusted = manager->GetAdjustedActionId(actionId);
                    if (adjusted != 0) resolvedId = adjusted;
                }
                catch { /* fall back to the raw id below */ }

                var name = ResolveEnglishName(actionType, resolvedId)
                        ?? ResolveEnglishName(actionType, actionId);
                if (!string.IsNullOrEmpty(name))
                    CraftActionUsed?.Invoke(name);
            }
        }
        catch (Exception ex)
        {
            Services.Log.Error(ex, "CraftActionTracker detour failed.");
        }

        return used;
    }

    private static string? ResolveEnglishName(ActionType actionType, uint actionId) => actionType switch
    {
        ActionType.CraftAction => Services.DataManager
            .GetExcelSheet<LuminaCraftAction>(ClientLanguage.English)?
            .GetRowOrDefault(actionId)?.Name.ExtractText(),
        ActionType.Action => Services.DataManager
            .GetExcelSheet<LuminaAction>(ClientLanguage.English)?
            .GetRowOrDefault(actionId)?.Name.ExtractText(),
        _ => null,
    };
}
