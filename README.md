# CraftCast

CraftCast is a Dalamud plugin for *Final Fantasy XIV* that bridges your in-game
crafting session to a web-based crafting solver. It observes the actions you
actually perform (plus the resulting condition and success/failure), maintains
the full step history of the active craft, and broadcasts it to a paired
userscript over a local WebSocket; the solver's suggested next action is sent
back and shown as an overlay.

It runs automatically — start a synthesis and the overlay appears.

## How the sync works

The plugin is the single source of truth:

- A hook on `ActionManager.UseAction` records **which action you really used**
  (not which one the solver suggested), including step-free actions like
  Final Appraisal, Heart and Soul, and Careful Observation.
- Each action resolves to the condition rolled afterwards and, for fallible
  actions (Rapid Synthesis, Hasty/Daring Touch), success or failure inferred
  from the progress/quality bars. Bar reads are sanity-checked against the
  recipe sheet's real maxes; on content where an AtkValue is junk (some cosmic
  missions), the affected bar is ignored rather than fabricating failures.
- Recipe constants (difficulty/durability/quality) come from the **Recipe
  sheet** (rlvl table × recipe factors), with the Synthesis addon only as a
  fallback — the addon values are wrong on some content.
- Every broadcast carries the **entire history** of the current craft plus a
  per-craft session id, player stats (level/CP/craftsmanship/control) and
  recipe constants (rlvl, rating, difficulty, durability, quality). Chained
  crafts are detected via step regression or a recipe-id change, so each
  craft reliably gets a fresh session.
- Actions executed by other plugins or macros also go through `UseAction`,
  so automated crafting syncs the same as manual play.

One setting must be made by hand on the Thiria page: the **Relic** dropdown.
The game gives no clean way to detect the equipped relic's phase, and a
Cosmic 9+ relic changes the Good-condition quality bonus (×1.75 instead of
×1.5) — if it's set wrong, Thiria under- or over-simulates quality on every
Good-condition touch. The bridge never overwrites it, so set it once.

The userscript is an idempotent reconciler: it converges the solver's step
list to that history — resetting on a new session, correcting the action on a
row when you deviated from the suggestion (via the row's edit pencil), setting
the rolled condition, and clicking Success/Failure. Because every message is a
full document, dropped frames, slow solves, or reconnects can't skip steps or
desync the simulation. If the plugin attaches mid-craft it cannot reconstruct
earlier steps, so auto-sync is disabled for that craft (the status pill says
so) and resumes on the next one.

## Project layout

```
CraftCastPlugin.cs          IAsyncDalamudPlugin entry point
Services.cs                 [PluginService] locator
System.cs                   Long-lived singletons
Controllers/
  CraftActionTracker.cs     UseAction hook → observed crafting actions
  CraftStateController.cs   Framework-tick session/history model → broadcasts state
Networking/
  WebSocketServerService.cs Async local WebSocket server (port 8014)
  Messages.cs               Wire models + source-generated JSON
State/
  SharedState.cs            Lock-guarded bridge between network and render threads
Windows/
  OverlayWindow.cs          Borderless overlay anchored to the Synthesis window
dashboard-sync.user.js      Tampermonkey userscript (browser side)
```
