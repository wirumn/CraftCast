using System.Numerics;
using Dalamud.Interface.Windowing;
using Dalamud.Bindings.ImGui;
using CraftCast.State;

namespace CraftCast;

/// <summary>
/// Borderless ImGui overlay rendered through Dalamud's native WindowSystem.
/// Reads an immutable snapshot of SharedState each frame — no cross-thread access.
/// </summary>
public sealed class OverlayUI : Window
{
    private const ImGuiWindowFlags OverlayFlags =
        ImGuiWindowFlags.NoDecoration       |
        ImGuiWindowFlags.NoResize           |
        ImGuiWindowFlags.NoScrollbar        |
        ImGuiWindowFlags.NoSavedSettings    |
        ImGuiWindowFlags.NoFocusOnAppearing |
        ImGuiWindowFlags.NoNav              |
        ImGuiWindowFlags.AlwaysAutoResize;

    private readonly SharedState _state;

    public OverlayUI(SharedState state) : base("##CraftCastOverlay", OverlayFlags)
    {
        _state = state;
        IsOpen = true;
        RespectCloseHotkey = false; // overlay isn't dismissed by ESC
    }

    public override void PreDraw() => ImGui.SetNextWindowBgAlpha(0.55f);

    public override void Draw()
    {
        var addonPtr = Plugin.GameGui.GetAddonByName("Synthesis", 1);
        if (addonPtr != IntPtr.Zero)
        {
            unsafe
            {
                var synthWindow = (FFXIVClientStructs.FFXIV.Component.GUI.AtkUnitBase*)addonPtr.Address;
                // Anchor just above the synthesis window
                ImGui.SetWindowPos(new Vector2(synthWindow->X, synthWindow->Y - 60));
            }
        }
        else
        {
            // If window isn't open, don't draw the overlay at all!
            return;
        }

        var (condition, step, action) = _state.Snapshot();

        ImGui.TextColored(new Vector4(0.40f, 0.90f, 1.00f, 1f), $"Condition   : {condition}");
        ImGui.Text($"Step        : {step}");
        ImGui.Separator();
        ImGui.TextColored(new Vector4(1.00f, 0.85f, 0.30f, 1f), $"Next action : {action}");
    }
}
