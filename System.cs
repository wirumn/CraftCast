using CraftCast.Controllers;
using CraftCast.Networking;
using CraftCast.State;
using CraftCast.Windows;
using Dalamud.Interface.Windowing;

namespace CraftCast;

/// <summary>
/// Holds the plugin's long-lived singletons. Mirrors MidoriKami's <c>System</c>
/// pattern: one static home for everything the controllers and windows share,
/// assigned once in <see cref="CraftCastPlugin.LoadAsync"/>.
/// </summary>
public static class System
{
    public static WindowSystem            WindowSystem  { get; set; } = null!;
    public static OverlayWindow           OverlayWindow { get; set; } = null!;
    public static SharedState             State         { get; set; } = null!;
    public static WebSocketServerService  Server        { get; set; } = null!;
    public static CraftActionTracker      ActionTracker { get; set; } = null!;
    public static CraftStateController    CraftState    { get; set; } = null!;
}
