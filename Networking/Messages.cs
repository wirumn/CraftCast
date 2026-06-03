using System.Text.Json;
using System.Text.Json.Serialization;

namespace CraftCast.Networking;

/// <summary>Outbound state broadcast: {"condition": "string", "step": 0}</summary>
public sealed class StatePayload
{
    [JsonPropertyName("condition")] public string Condition { get; init; } = "idle";
    [JsonPropertyName("step")]      public int    Step      { get; init; }
}

/// <summary>
/// Inbound message. Either a command ({"next_action": "string"})
/// or a heartbeat control frame ({"type": "ping"}).
/// </summary>
public sealed class IncomingMessage
{
    [JsonPropertyName("next_action")] public string? NextAction { get; init; }
    [JsonPropertyName("type")]        public string? Type       { get; init; }
}

[JsonSerializable(typeof(StatePayload))]
[JsonSerializable(typeof(IncomingMessage))]
public sealed partial class WsJsonContext : JsonSerializerContext { }
