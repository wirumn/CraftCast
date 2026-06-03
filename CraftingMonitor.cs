using System;
using System.Threading.Tasks;
using Dalamud.Plugin.Services;
using FFXIVClientStructs.FFXIV.Client.Game.Event;
using FFXIVClientStructs.FFXIV.Client.Game.UI;
using CraftCast.Networking;
using CraftCast.State;

namespace CraftCast;

/// <summary>
/// Reads the active craft handler from game memory on each framework tick and
/// pushes condition/step changes to the network layer. All pointer access here
/// runs on the main game thread (the only thread where reading is safe).
/// </summary>
public sealed class CraftingMonitor(WebSocketServerService server, SharedState state)
{
    private readonly WebSocketServerService _server = server;
    private readonly SharedState _state = state;

    private bool _active;
    private string _lastCondition = string.Empty;
    private int _lastStep = -1;
    private int _lastCp = -1;

    private DateTime _lastTick = DateTime.MinValue;

    public unsafe void OnFrameworkUpdate(IFramework framework)
    {
        try
        {
            // Throttle to 10 ticks a second max to prevent any possibility of giga-lag
            if ((DateTime.UtcNow - _lastTick).TotalMilliseconds < 100) return;
            _lastTick = DateTime.UtcNow;
            var eventFramework = EventFramework.Instance();
            if (eventFramework == null) { Reset(); return; }

            var handler = eventFramework->GetCraftEventHandler();
            if (handler == null) { Reset(); return; } // not in a synthesis

            // Named fields map to the documented offsets:
            //   Condition  -> offset 1063 (byte, CraftCondition)
            //   StepNumber -> offset 1046 (ushort)
            // If a FFXIVClientStructs bump drops these fields, read raw instead:
            //   var conditionByte = *((byte*)handler + 1063);
            //   var step          = *(ushort*)((byte*)handler + 1046);
            var conditionByte = (byte)handler->Condition;
            int step = handler->StepNumber;

            var condition = Translate(conditionByte);

            var playerState = PlayerState.Instance();
            int craftsmanship = playerState != null ? playerState->Attributes[70] : 0;
            int control = playerState != null ? playerState->Attributes[71] : 0;
            int maxCp = playerState != null ? playerState->Attributes[11] : 0;
            int cp = (int)(Plugin.ObjectTable.LocalPlayer?.CurrentCp ?? (uint)maxCp);

            var addonPtr = Plugin.GameGui.GetAddonByName("Synthesis", 1);
            var synthWindow = (FFXIVClientStructs.FFXIV.Component.GUI.AtkUnitBase*)addonPtr.Address;
            int maxProgress = 0, maxDurability = 0, maxQuality = 0;
            int curProgress = 0, curQuality = 0;
            if (synthWindow != null && synthWindow->AtkValuesCount >= 18)
            {
                curProgress = synthWindow->AtkValues[5].Int;
                maxProgress = synthWindow->AtkValues[6].Int;
                maxDurability = synthWindow->AtkValues[8].Int;
                curQuality = synthWindow->AtkValues[16].Int;
                maxQuality = synthWindow->AtkValues[17].Int;
            }

            _active = true;
            if (condition == _lastCondition && step == _lastStep && cp == _lastCp) return; // no change

            _lastCondition = condition;
            _lastStep = step;
            _lastCp = cp;
            _state.SetState(condition, step);

            var payload = new StatePayload
            {
                Step = step,
                Condition = condition,
                Craftsmanship = craftsmanship,
                Control = control,
                Cp = cp,
                Difficulty = maxProgress,
                Durability = maxDurability,
                MaxQuality = maxQuality,
                CurrentProgress = curProgress,
                CurrentQuality = curQuality
            };

            Plugin.Log.Information($"Sending State: Step={step}, Cond={condition}, Craft={craftsmanship}, Ctrl={control}, CP={cp}, Diff={maxProgress}, Dur={maxDurability}, Qual={maxQuality}");

            // Fire-and-forget: never block the game thread on socket I/O.
            _ = BroadcastSafelyAsync(payload);
        }
        catch (Exception ex)
        {
            Plugin.Log.Error(ex, "CraftingMonitor tick failed.");
        }
    }

    private async Task BroadcastSafelyAsync(StatePayload payload)
    {
        try
        {
            await _server.BroadcastAsync(payload).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            Plugin.Log.Error(ex, "State broadcast failed.");
        }
    }

    private void Reset()
    {
        if (!_active) return;
        _active = false;
        _lastCondition = string.Empty;
        _lastStep = -1; // forces a fresh broadcast when the next synthesis begins
        _lastCp = -1;
    }

    /// <summary>
    /// Maps the raw CraftCondition byte to the lowercase keys the browser script expects.
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
