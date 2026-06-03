using Dalamud.IoC;
using Dalamud.Plugin;
using Dalamud.Plugin.Services;

namespace CraftCast;

/// <summary>
/// Dalamud-injected services. Populated by <c>pluginInterface.Create&lt;Services&gt;()</c>
/// in the plugin entry point (the MidoriKami / ChillFrames service-locator pattern).
/// </summary>
public class Services
{
    [PluginService] public static IDalamudPluginInterface PluginInterface { get; set; } = null!;
    [PluginService] public static IFramework             Framework       { get; set; } = null!;
    [PluginService] public static IPluginLog             Log             { get; set; } = null!;
    [PluginService] public static IGameGui               GameGui         { get; set; } = null!;
    [PluginService] public static IClientState           ClientState     { get; set; } = null!;
}
