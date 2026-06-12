using System;
using System.Threading;
using System.Threading.Tasks;
using CraftCast.Controllers;
using CraftCast.Networking;
using CraftCast.State;
using CraftCast.Windows;
using Dalamud.Interface.Windowing;
using Dalamud.Plugin;

namespace CraftCast;

/// <summary>
/// Plugin entry point. Async lifecycle (à la ChillFrames): the constructor only
/// wires up injected services; everything heavier happens in <see cref="LoadAsync"/>,
/// and teardown is genuinely asynchronous so the socket server shuts down cleanly.
/// </summary>
public sealed class CraftCastPlugin : IAsyncDalamudPlugin
{
    private const int WebSocketPort = 8014;
    private static readonly TimeSpan ShutdownBudget = TimeSpan.FromSeconds(2);

    public CraftCastPlugin(IDalamudPluginInterface pluginInterface)
    {
        pluginInterface.Create<Services>();
    }

    public Task LoadAsync(CancellationToken cancellationToken)
    {
        System.State = new SharedState();

        // Networking loop starts once, on the background thread pool.
        System.Server = new WebSocketServerService(WebSocketPort);
        System.Server.NextActionReceived += OnNextActionReceived;
        System.Server.Start();

        // The tracker observes which actions the player actually performs;
        // the controller self-subscribes to Framework.Update in its constructor.
        System.ActionTracker = new CraftActionTracker();
        System.CraftState = new CraftStateController(System.Server, System.State, System.ActionTracker);

        System.WindowSystem  = new WindowSystem("CraftCast");
        System.OverlayWindow = new OverlayWindow(System.State);
        System.WindowSystem.AddWindow(System.OverlayWindow);

        Services.PluginInterface.UiBuilder.Draw += System.WindowSystem.Draw;

        Services.Log.Information($"CraftCast loaded — WebSocket server listening on 127.0.0.1:{WebSocketPort}.");
        return Task.CompletedTask;
    }

    private static void OnNextActionReceived(string action) => System.State.SetLastAction(action);

    public async ValueTask DisposeAsync()
    {
        // Detach UI/tick hooks first so nothing fires mid-teardown.
        Services.PluginInterface.UiBuilder.Draw -= System.WindowSystem.Draw;
        System.WindowSystem.RemoveAllWindows();
        System.CraftState.Dispose();
        System.ActionTracker.Dispose();
        System.Server.NextActionReceived -= OnNextActionReceived;

        // Bounded shutdown: a stuck socket must never hang game unload.
        try
        {
            var disposeTask = System.Server.DisposeAsync().AsTask();
            if (await Task.WhenAny(disposeTask, Task.Delay(ShutdownBudget)) != disposeTask)
                Services.Log.Warning("WebSocket server did not shut down within 2s; port may linger until process exit.");
        }
        catch (Exception ex)
        {
            Services.Log.Error(ex, "Error tearing down WebSocket server.");
        }
    }
}
