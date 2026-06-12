using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace CraftCast.Networking;

/// <summary>
/// Outbound craft-state document. The plugin is the single source of truth:
/// every broadcast carries the FULL step history of the current craft, so the
/// browser side can reconcile idempotently instead of replaying fragile
/// one-shot deltas (which desync forever if a single frame is missed).
/// </summary>
public sealed class CraftStatePayload
{
    [JsonPropertyName("type")]    public string Type    { get; init; } = "state";

    /// <summary>Increments once per synthesis; lets the client reset reliably.</summary>
    [JsonPropertyName("session")] public int    Session { get; init; }

    /// <summary>"active" while crafting, "complete" on the final broadcast.</summary>
    [JsonPropertyName("status")]  public string Status  { get; init; } = "active";

    /// <summary>
    /// True when the history covers the craft from step 1. False when the
    /// plugin attached mid-craft and cannot reconstruct earlier steps; the
    /// client must not auto-drive the solver in that case.
    /// </summary>
    [JsonPropertyName("fromStart")] public bool FromStart { get; init; }

    [JsonPropertyName("player")]  public PlayerInfo     Player  { get; init; } = new();
    [JsonPropertyName("recipe")]  public RecipeInfo     Recipe  { get; init; } = new();
    [JsonPropertyName("current")] public SnapshotInfo   Current { get; init; } = new();
    [JsonPropertyName("steps")]   public List<StepInfo> Steps   { get; init; } = new();
}

/// <summary>Player stats that are invariant during a synthesis.</summary>
public sealed class PlayerInfo
{
    [JsonPropertyName("level")]         public int Level         { get; init; }
    [JsonPropertyName("craftsmanship")] public int Craftsmanship { get; init; }
    [JsonPropertyName("control")]       public int Control       { get; init; }
    /// <summary>Maximum CP — what the solver's "CP" stat field expects.</summary>
    [JsonPropertyName("cp")]            public int Cp            { get; init; }
}

/// <summary>Recipe constants for the active craft.</summary>
public sealed class RecipeInfo
{
    /// <summary>Recipe level (rlvl), e.g. 710 — drives the solver's hidden divisors.</summary>
    [JsonPropertyName("level")]      public int    Level      { get; init; }
    /// <summary>"expert", "star" or "normal"; empty when unknown.</summary>
    [JsonPropertyName("rating")]     public string Rating     { get; init; } = string.Empty;
    [JsonPropertyName("progress")]   public int    Progress   { get; init; }
    [JsonPropertyName("durability")] public int    Durability { get; init; }
    [JsonPropertyName("quality")]    public int    Quality    { get; init; }
}

/// <summary>Live snapshot of the craft as currently shown in game.</summary>
public sealed class SnapshotInfo
{
    [JsonPropertyName("step")]      public int    Step      { get; init; }
    [JsonPropertyName("condition")] public string Condition { get; init; } = string.Empty;
    [JsonPropertyName("progress")]  public int    Progress  { get; init; }
    [JsonPropertyName("quality")]   public int    Quality   { get; init; }
    [JsonPropertyName("cp")]        public int    Cp        { get; init; }
}

/// <summary>
/// One action the player performed, in order. <see cref="Condition"/> and
/// <see cref="Success"/> stay null until the plugin has observed the outcome;
/// the client only acts on fully resolved entries.
/// </summary>
public sealed class StepInfo
{
    [JsonPropertyName("index")]     public int     Index     { get; init; }
    /// <summary>English action name; null when the action could not be observed.</summary>
    [JsonPropertyName("action")]    public string? Action    { get; init; }
    /// <summary>Condition rolled AFTER the action resolved.</summary>
    [JsonPropertyName("condition")] public string? Condition { get; init; }
    [JsonPropertyName("success")]   public bool?   Success   { get; init; }
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

[JsonSerializable(typeof(CraftStatePayload))]
[JsonSerializable(typeof(IncomingMessage))]
public sealed partial class WsJsonContext : JsonSerializerContext { }
