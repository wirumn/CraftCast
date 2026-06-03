using System;
using Dalamud.Interface.Windowing;
using Dalamud.IoC;
using Dalamud.Plugin;
using Dalamud.Plugin.Services;
using CraftCast.Networking;
using CraftCast.State;

namespace CraftCast;

public sealed class Plugin : IDalamudPlugin
{
    [PluginService] internal static IDalamudPluginInterface PluginInterface { get; private set; } = null!;
    [PluginService] internal static IFramework Framework { get; private set; } = null!;
    [PluginService] internal static IPluginLog Log { get; private set; } = null!;

    private const int WebSocketPort = 8014;

    private readonly WindowSystem _windowSystem = new("CraftCast");
    private readonly SharedState _state = new();
    private readonly WebSocketServerService _server;
    private readonly CraftingMonitor _monitor;
    private readonly OverlayUI _overlay;

    public Plugin(IDalamudPluginInterface pluginInterface, IFramework framework, IPluginLog log)
    {
        PluginInterface = pluginInterface;
        Framework = framework;
        Log = log;

        // Networking loop is started once, on the background thread pool.
        _server = new WebSocketServerService(WebSocketPort);
        _server.NextActionReceived += OnNextActionReceived;
        _server.Start();

        _monitor = new CraftingMonitor(_server, _state);

        _overlay = new OverlayUI(_state);
        _windowSystem.AddWindow(_overlay);

        Framework.Update += _monitor.OnFrameworkUpdate;
        PluginInterface.UiBuilder.Draw += _windowSystem.Draw;

        Log.Information("CraftCast loaded — WebSocket server listening on 127.0.0.1:{Port}.", WebSocketPort);
    }

    private void OnNextActionReceived(string action) => _state.SetLastAction(action);

    public void Dispose()
    {
        // Detach UI/tick hooks first so nothing fires mid-teardown.
        Framework.Update -= _monitor.OnFrameworkUpdate;
        PluginInterface.UiBuilder.Draw -= _windowSystem.Draw;
        _windowSystem.RemoveAllWindows();
        _server.NextActionReceived -= OnNextActionReceived;

        // Bounded shutdown: a stuck socket must never hang game unload.
        try
        {
            if (!_server.DisposeAsync().AsTask().Wait(TimeSpan.FromSeconds(2)))
                Log.Warning("WebSocket server did not shut down within 2s; port may linger until process exit.");
        }
        catch (Exception ex)
        {
            Log.Error(ex, "Error tearing down WebSocket server.");
        }
    }
}
