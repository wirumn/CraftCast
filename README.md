# CraftCast

CraftCast is a Dalamud plugin for *Final Fantasy XIV* that bridges your in-game
crafting session to a web-based crafting solver. It reads crafting state from
game memory and sends it to a paired userscript over a local WebSocket; the
solver's suggested next action is sent back and shown as an overlay.

It runs automatically - start a synthesis and the overlay appears.

## Project layout

```
CraftCastPlugin.cs          IAsyncDalamudPlugin entry point
Services.cs                 [PluginService] locator
System.cs                   Long-lived singletons
Controllers/
  CraftStateController.cs   Framework-tick memory reader → broadcasts state
Networking/
  WebSocketServerService.cs Async local WebSocket server (port 8014)
  Messages.cs               Wire models + source-generated JSON
State/
  SharedState.cs            Lock-guarded bridge between network and render threads
Windows/
  OverlayWindow.cs          Borderless overlay anchored to the Synthesis window
dashboard-sync.user.js      Tampermonkey userscript (browser side)
```
