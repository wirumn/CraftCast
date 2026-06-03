using System.Numerics;
using CraftCast.State;
using Dalamud.Bindings.ImGui;
using Dalamud.Interface.Windowing;
using FFXIVClientStructs.FFXIV.Component.GUI;

namespace CraftCast.Windows;

/// <summary>
/// Borderless, click-through overlay rendered through Dalamud's WindowSystem.
/// Only draws while the Synthesis window is open, and anchors itself just above
/// it. Reads an immutable snapshot of <see cref="SharedState"/> each frame.
/// </summary>
public sealed class OverlayWindow : Window
{
    private const ImGuiWindowFlags OverlayFlags =
        ImGuiWindowFlags.NoDecoration       |
        ImGuiWindowFlags.NoResize           |
        ImGuiWindowFlags.NoScrollbar        |
        ImGuiWindowFlags.NoSavedSettings    |
        ImGuiWindowFlags.NoFocusOnAppearing |
        ImGuiWindowFlags.NoNav              |
        ImGuiWindowFlags.NoInputs           | // click-through
        ImGuiWindowFlags.AlwaysAutoResize;

    private const float AnchorYOffset = 60f;

    private readonly SharedState _state;

    public OverlayWindow(SharedState state) : base("##CraftCastOverlay", OverlayFlags)
    {
        _state = state;
        IsOpen = true;
        RespectCloseHotkey = false; // overlay isn't dismissed by ESC
    }

    /// <summary>Gate: only render while the Synthesis addon is visible.</summary>
    public override unsafe bool DrawConditions()
    {
        var synth = (AtkUnitBase*)Services.GameGui.GetAddonByName("Synthesis", 1).Address;
        return synth != null && synth->IsVisible;
    }

    public override unsafe void PreDraw()
    {
        ImGui.SetNextWindowBgAlpha(0.55f);

        var synth = (AtkUnitBase*)Services.GameGui.GetAddonByName("Synthesis", 1).Address;
        if (synth != null)
            ImGui.SetNextWindowPos(new Vector2(synth->X, synth->Y - AnchorYOffset));
    }

    public override void Draw()
    {
        var (condition, step, action) = _state.Snapshot();

        ImGui.TextColored(new Vector4(0.40f, 0.90f, 1.00f, 1f), $"Condition   : {condition}");
        ImGui.Text($"Step        : {step}");
        ImGui.Separator();
        ImGui.TextColored(new Vector4(1.00f, 0.85f, 0.30f, 1f), $"Next action : {action}");
    }
}
