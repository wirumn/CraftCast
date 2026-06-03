using System;
using System.Threading.Tasks;
using Dalamud.Plugin.Services;
using FFXIVClientStructs.FFXIV.Client.Game.Event;
using CraftCast.Networking;
using CraftCast.State;

namespace CraftCast;

/// <summary>
/// Reads the active craft handler from game memory on each framework tick and
/// pushes condition/step changes to the network layer. All pointer access here
/// runs on the main game thread (the only thread where reading is safe).
/// </summary>
public sealed unsafe class CraftingMonitor
{
    private readonly WebSocketServerService _server;
    private readonly SharedState _state;

    private bool _active;
    private string _lastCondition = string.Empty;
    private int _lastStep = -1;

    public CraftingMonitor(WebSocketServerService server, SharedState state)
    {
        _server = server;
        _state = state;
    }

    public void OnFrameworkUpdate(IFramework framework)
    {
        try
        {
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

            _active = true;
            if (condition == _lastCondition && step == _lastStep) return; // no change

            _lastCondition = condition;
            _lastStep = step;
            _state.SetState(condition, step);

            // Fire-and-forget: never block the game thread on socket I/O.
            _ = BroadcastSafelyAsync(condition, step);
        }
        catch (Exception ex)
        {
            Plugin.Log.Error(ex, "CraftingMonitor tick failed.");
        }
    }

    private async Task BroadcastSafelyAsync(string condition, int step)
    {
        try
        {
            await _server.BroadcastAsync(new StatePayload { Condition = condition, Step = step })
                         .ConfigureAwait(false);
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
