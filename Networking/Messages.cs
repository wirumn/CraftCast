using System.Text.Json.Serialization;

namespace CraftCast.Networking;

/// <summary>
/// Outbound state broadcast. Sent on every meaningful change while a synthesis
/// is active. Field names match what the paired userscript reads.
/// </summary>
public sealed class StatePayload
{
    [JsonPropertyName("condition")] public string Condition { get; init; } = string.Empty;
    [JsonPropertyName("step")]      public int    Step      { get; init; }

    [JsonPropertyName("craftsmanship")] public int Craftsmanship { get; init; }
    [JsonPropertyName("control")]       public int Control       { get; init; }
    [JsonPropertyName("cp")]            public int Cp            { get; init; }

    [JsonPropertyName("difficulty")] public int Difficulty { get; init; }
    [JsonPropertyName("durability")] public int Durability { get; init; }
    [JsonPropertyName("maxQuality")] public int MaxQuality { get; init; }

    [JsonPropertyName("currentProgress")] public int CurrentProgress { get; init; }
    [JsonPropertyName("currentQuality")]  public int CurrentQuality  { get; init; }
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
