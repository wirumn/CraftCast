# OverlayTool — Build Summary

A two-part system that bridges live FFXIV crafting state to a reactive web
dashboard over a local WebSocket link on port **8014**.

```
FFXIV Dalamud plugin (WebSocket SERVER, :8014) <----> Tampermonkey userscript (CLIENT, in the browser)
   - reads craft Condition/Step from memory             - injects condition into the dashboard dropdown
     each framework tick                                - scrapes top list item -> {"next_action"}
   - broadcasts {"condition","step"}                    - auto-reconnect + heartbeat + status pill
   - receives {"next_action"}
   - native Dalamud ImGui overlay shows next action
```

> **Note:** This is a third-party in-process Dalamud plugin that reads game memory
> via FFXIVClientStructs. It is *Dalamud-API* compliant but violates Square Enix's
> Terms of Service; using it carries account-action risk.

## C# side — FFXIV Dalamud plugin (.NET 8, x64, compiles to `OverlayTool.dll`)

| File | Purpose |
|------|---------|
| `OverlayTool.csproj` | Class library (`OutputType=Library`, `x64`). References the local XIVLauncher dev assemblies (`Dalamud`, `ImGui.NET`, `FFXIVClientStructs`, `Newtonsoft.Json`, all `Private=false`) + `DalamudPackager`. |
| `OverlayTool.json` | Dalamud manifest. Must be named `{AssemblyName}.json` for DalamudPackager to pick it up — a generic `manifest.json` is ignored. |
| `Plugin.cs` | Implements `IDalamudPlugin`. `[PluginService]` statics populated via `pluginInterface.Create<Plugin>()`. Starts the WebSocket server, wires `Framework.Update` → monitor and `UiBuilder.Draw` → `WindowSystem`. `Dispose()` detaches hooks then tears the server down with a **2s bounded wait** so a stuck socket can't hang game unload. |
| `CraftingMonitor.cs` | `unsafe` reader. On each framework tick (main-thread-safe) reads `EventFramework.Instance()->GetCraftEventHandler()`, maps `Condition`/`StepNumber`, de-dupes, and fire-and-forget broadcasts so the game thread never blocks on I/O. |
| `Networking/Messages.cs` | Wire models (`StatePayload`, `IncomingMessage`) + source-generated JSON. |
| `Networking/WebSocketServerService.cs` | Async WebSocket server. Accept loop + per-client receive loops on background tasks. Broadcast, incoming-command event, **app-level ping→pong heartbeat reply**. |
| `State/SharedState.cs` | Lock-guarded bridge between network threads and the ImGui render thread. |
| `OverlayUI.cs` | Borderless overlay via Dalamud's native `Window` / `WindowSystem`, showing condition / step / next action. |

Removed in the Dalamud refactor: `Program.cs`, `UI/OverlayWindow.cs`, and the
`ClickableTransparentOverlay` package (replaced by Dalamud's windowing + injected ImGui).

### Condition translation (`CraftingMonitor.Translate`)
Maps the `CraftCondition` byte to the lowercase keys the browser expects:
`normal, good, excellent, poor, centered, sturdy, pliant, malleable, primed, goodOmen`,
plus `(CraftCondition)11 => "robust"`. Unknown values fall back to `normal`.

## Browser side

| File | Purpose |
|------|---------|
| `dashboard-sync.user.js` | Tampermonkey userscript (v1.2.0). |

Userscript features:
- Connects to `ws://127.0.0.1:8014` with **capped exponential backoff + jitter** reconnect.
- Applies inbound `{"condition","step"}` to `select[x-bind-value="condition$"]`, dispatching
  bubbling `input` + `change` so the reactive framework registers it.
- **Step-aware guard:** ignores repeated broadcasts of the same `step`.
- Scrapes the top list item via `MutationObserver` and sends `{"next_action": "..."}` (debounced).
- **Heartbeat:** sends `{"type":"ping"}` every 15s; forces reconnect if no `{"type":"pong"}` in 30s.
- **Echo guard:** 400ms suppression window so our own DOM writes don't loop back out.
- **Status pill:** fixed bottom-right — green Connected / orange Reconnecting [Attempt X] / red Disconnected.

## Before it runs

**Plugin (Windows + XIVLauncher/Dalamud):**
```powershell
cd path\to\OverlayTool
dotnet build -c Release
```
Then in-game: Dalamud → Settings → Experimental → **Dev Plugin Locations**, point it at
`bin\Release\OverlayTool.dll`, and enable it from the dev-plugins list.

**Userscript — set these:**
- `@match` — your real dashboard URL (currently `https://your-dashboard.example.com/*`).
- `CONFIG.listContainer` — the element whose children are the list items (currently `#instruction-list`).
- `CONFIG.listItem` — selector for the top item (currently `:scope > *`).

## Known gotchas

**Compile-time (FFXIVClientStructs version drift):**
- `CraftCondition` enum namespace — `CraftingMonitor.cs` uses `FFXIVClientStructs.FFXIV.Client.Game.Event`; adjust the `using` if your build locates it elsewhere.
- If a CS bump renames/drops `Condition`/`StepNumber`, switch to the raw-offset reads left commented in `CraftingMonitor.cs` (offsets 1063 / 1046).

**Browser runtime (not the code):**
- **CSP:** a strict `connect-src` on the dashboard can block `ws://127.0.0.1`; userscript managers can't relax WS CSP.
- **Mixed content:** an `https://` page → `ws://` is normally allowed for loopback (127.0.0.1); if a browser build blocks it, use `wss://` with a local cert.

## Status / next ideas
- Implemented: Dalamud plugin lifecycle, framework-tick memory read, reconnect, step guard, status indicator, heartbeat (both sides), echo guard.
- Open idea (not yet built): server-side dead-client detection (server-initiated ping or pruning idle sockets).
