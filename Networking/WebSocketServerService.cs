using System.Collections.Concurrent;
using System.Net;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

namespace CraftCast.Networking;

/// <summary>
/// Local WebSocket server. Accept loop and per-client receive loops run on
/// background tasks; nothing here touches the UI thread.
/// </summary>
public sealed class WebSocketServerService : IAsyncDisposable
{
    private static readonly byte[] PongFrame = Encoding.UTF8.GetBytes("{\"type\":\"pong\"}");

    private readonly HttpListener _listener = new();
    private readonly ConcurrentDictionary<Guid, WebSocket> _clients = new();
    private readonly SemaphoreSlim _sendGate = new(1, 1);
    private readonly CancellationTokenSource _cts = new();
    private Task? _acceptLoop;

    /// <summary>Raised on a background thread when a client sends next_action.</summary>
    public event Action<string>? NextActionReceived;

    public WebSocketServerService(int port = 8014)
    {
        _listener.Prefixes.Add($"http://localhost:{port}/");
        _listener.Prefixes.Add($"http://127.0.0.1:{port}/");
    }

    public void Start()
    {
        _listener.Start();
        _acceptLoop = Task.Run(() => AcceptLoopAsync(_cts.Token));
    }

    private async Task AcceptLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            HttpListenerContext ctx;
            try
            {
                ctx = await _listener.GetContextAsync().ConfigureAwait(false);
            }
            catch (Exception) when (ct.IsCancellationRequested) { break; }
            catch (HttpListenerException) { break; }

            if (!ctx.Request.IsWebSocketRequest)
            {
                ctx.Response.StatusCode = 400;
                ctx.Response.Close();
                continue;
            }

            _ = Task.Run(() => HandleClientAsync(ctx, ct), ct);
        }
    }

    private async Task HandleClientAsync(HttpListenerContext ctx, CancellationToken ct)
    {
        WebSocket socket;
        try
        {
            var wsCtx = await ctx.AcceptWebSocketAsync(subProtocol: null).ConfigureAwait(false);
            socket = wsCtx.WebSocket;
        }
        catch
        {
            ctx.Response.StatusCode = 500;
            ctx.Response.Close();
            return;
        }

        var id = Guid.NewGuid();
        _clients[id] = socket;

        var buffer = new byte[4096];
        try
        {
            while (socket.State == WebSocketState.Open && !ct.IsCancellationRequested)
            {
                using var ms = new MemoryStream();
                WebSocketReceiveResult result;
                do
                {
                    result = await socket.ReceiveAsync(buffer, ct).ConfigureAwait(false);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "bye", ct)
                                    .ConfigureAwait(false);
                        return;
                    }
                    ms.Write(buffer, 0, result.Count);
                }
                while (!result.EndOfMessage);

                await HandleIncomingAsync(socket, Encoding.UTF8.GetString(ms.GetBuffer(), 0, (int)ms.Length), ct)
                    .ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) { /* shutting down */ }
        catch (WebSocketException)         { /* client dropped */ }
        finally
        {
            _clients.TryRemove(id, out _);
            socket.Dispose();
        }
    }

    private async Task HandleIncomingAsync(WebSocket socket, string json, CancellationToken ct)
    {
        IncomingMessage? msg;
        try
        {
            msg = JsonSerializer.Deserialize(json, WsJsonContext.Default.IncomingMessage);
        }
        catch (JsonException)
        {
            return; // ignore malformed frames
        }

        if (msg is null) return;

        // Heartbeat: reply to a ping immediately so the client's liveness timer resets.
        if (string.Equals(msg.Type, "ping", StringComparison.Ordinal))
        {
            await SendToAsync(socket, PongFrame, ct).ConfigureAwait(false);
            return;
        }

        if (msg.NextAction is { Length: > 0 } action)
            NextActionReceived?.Invoke(action);
    }

    /// <summary>Sends one text frame to a single client, serialized through the shared send gate.</summary>
    private async Task SendToAsync(WebSocket socket, byte[] bytes, CancellationToken ct)
    {
        if (socket.State != WebSocketState.Open) return;

        await _sendGate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await socket.SendAsync(bytes, WebSocketMessageType.Text, endOfMessage: true, ct)
                        .ConfigureAwait(false);
        }
        catch (WebSocketException) { /* client dropped; receive loop will clean up */ }
        finally
        {
            _sendGate.Release();
        }
    }

    /// <summary>Serializes state once and fans it out to every connected client.</summary>
    public async Task BroadcastAsync(StatePayload payload, CancellationToken ct = default)
    {
        if (_clients.IsEmpty) return;

        var bytes = JsonSerializer.SerializeToUtf8Bytes(payload, WsJsonContext.Default.StatePayload);

        await _sendGate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            List<Guid>? dead = null;
            foreach (var (id, socket) in _clients)
            {
                if (socket.State != WebSocketState.Open)
                {
                    (dead ??= new()).Add(id);
                    continue;
                }
                try
                {
                    await socket.SendAsync(bytes, WebSocketMessageType.Text, endOfMessage: true, ct)
                                .ConfigureAwait(false);
                }
                catch
                {
                    (dead ??= new()).Add(id);
                }
            }
            if (dead is not null)
                foreach (var id in dead) _clients.TryRemove(id, out _);
        }
        finally
        {
            _sendGate.Release();
        }
    }

    public async ValueTask DisposeAsync()
    {
        _cts.Cancel();
        try { _listener.Stop(); } catch { /* ignore */ }

        foreach (var (_, socket) in _clients)
        {
            try
            {
                await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "shutdown", CancellationToken.None);
            }
            catch { /* ignore */ }
            socket.Dispose();
        }

        if (_acceptLoop is not null)
        {
            try { await _acceptLoop; } catch { /* ignore */ }
        }

        _listener.Close();
        _sendGate.Dispose();
        _cts.Dispose();
    }
}
