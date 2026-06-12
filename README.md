# CraftCast

CraftCast is a Dalamud plugin for *Final Fantasy XIV* that bridges your in-game
crafting session to the [Thiria](https://thiria.com/expert/) web solver. It
observes the actions you actually perform (plus the resulting condition and
success/failure), maintains the full step history of the active craft, and
broadcasts it to a paired userscript over a local WebSocket; the solver's
suggested next action is sent back and shown as an overlay in game.

It runs automatically — start a synthesis and the overlay appears.

## Installation

### 1. The plugin (via custom Dalamud repo, auto-built)

Every push to `main` is built by GitHub Actions and published to the `repo`
branch as an installable Dalamud repository.

1. In game: `/xlsettings` → **Experimental** tab.
2. Under **Custom Plugin Repositories**, add:

   ```
   https://raw.githubusercontent.com/wirumn/CraftCast/repo/pluginmaster.json
   ```

3. Save, then `/xlplugins` → search **CraftCast** → Install.
4. Updates appear in the plugin installer automatically whenever a new build
   is pushed (the `AssemblyVersion` in `CraftCast.csproj` must be bumped for
   Dalamud to offer the update).

### 2. The userscript (browser side)

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser.
2. Open the raw script and Tampermonkey will offer to install it:

   ```
   https://raw.githubusercontent.com/wirumn/CraftCast/main/dashboard-sync.user.js
   ```

3. Open https://thiria.com/expert/ — a status pill appears bottom-right and
   turns green ("Connected") while the game is running with the plugin loaded.

### 3. One-time manual setting

On the Thiria page, set the **Relic** dropdown to match your mainhand
(e.g. **Cosmic 9+** for phase 9+ Cosmic/Splendorous relics). The game gives no
clean way to detect the relic phase, and it changes the Good-condition quality
bonus (×1.75 instead of ×1.5) — if it's wrong, Thiria mis-simulates quality on
every Good-condition touch. The bridge never overwrites this field.

## Usage

1. Have the Thiria tab open (pill green) **before** starting a craft.
2. Start a synthesis. The bridge resets the solver, pushes your stats and the
   recipe constants, clicks Start, and from then on mirrors every action you
   perform — including ones the solver didn't suggest, step-free actions
   (Final Appraisal, Heart and Soul, Careful Observation), and Rapid/Hasty
   failures. Thiria's recommended next action shows in the in-game overlay.
3. The status pill narrates what the bridge is doing ("syncing step 7",
   "waiting for solver"). The browser console (`F12`) logs every decision with
   a `[bridge]` prefix.

If the plugin attaches mid-craft it cannot reconstruct earlier steps, so
auto-sync stays off for that craft (pill: "attached mid-craft") and resumes on
the next one.

## How the sync works

The plugin is the single source of truth:

- A hook on `ActionManager.UseAction` records **which action you really used**
  (manual play, macros, and other plugins' casts all pass through it).
- Each action resolves to the condition rolled afterwards and, for fallible
  actions (Rapid Synthesis, Hasty/Daring Touch), success or failure inferred
  from the progress/quality bars. Bar reads are sanity-checked against the
  recipe sheet's real maxes; on content where an AtkValue is junk, the
  affected bar is ignored rather than fabricating failures.
- Recipe constants (difficulty/durability/quality, rlvl, star/expert rating,
  and the exact progress/quality dividers and level-penalty modifiers) come
  from the **Recipe sheet**, not the UI. When Thiria doesn't recognize an item
  (⚠️ next to Rating), the userscript switches the Rating to Custom and feeds
  those exact values, so the simulation matches the game's formulas.
- Every broadcast carries the **entire history** of the current craft plus a
  per-craft session id. Chained crafts are detected via step regression or a
  recipe-id change, so each craft reliably gets a fresh session, and dropped
  frames or reconnects self-heal because the next message describes the whole
  craft.

The userscript is an idempotent reconciler: it converges Thiria's step list to
that history — resetting on a new session, correcting the action on a row when
you deviated from the suggestion (via the row's edit pencil), setting the
rolled condition, and clicking Success/Failure.

## Troubleshooting

| Symptom | Meaning |
|---|---|
| Pill: "waiting for craft data" forever | The plugin is outdated and sending zeroed stats — update it. |
| Pill: "attached mid-craft — auto-sync off" | Plugin/tab connected after the craft started; finish this craft and the next one syncs. |
| Pill: "step N out of sync" | A Thiria row disagrees with the game and auto-repair gave up — check the browser console. |
| Quality drifts only on Good conditions | The Relic dropdown doesn't match your mainhand. |
| Bars drift by ~10/25% | Player Level or item parameters wrong — make sure the plugin is current; it sets these itself. |

When reporting a problem, grab the browser console (`[bridge]` lines) and the
Dalamud log (`/xllog`, `[CraftCast]` lines) covering one craft.

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
.github/workflows/build.yml CI: build → package → publish pluginmaster on the repo branch
```

## Releasing an update

1. Make changes, bump `<AssemblyVersion>` in `CraftCast.csproj`.
2. Push to `main`. The workflow builds the plugin, packages `latest.zip`, and
   force-pushes `latest.zip` + `pluginmaster.json` to the `repo` branch.
3. In game, the plugin installer offers the update. Userscript changes are
   picked up by Tampermonkey from the raw `main` URL (bump `@version`).
