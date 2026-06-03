# CraftCast

CraftCast is a specialized Dalamud plugin for *Final Fantasy XIV* that acts as a real-time bridge between your in-game crafting session and external web-based crafting solvers (like the Thiria Expert Crafting dashboard).

Instead of relying on heavy macro tools or network packet injection, CraftCast works seamlessly and safely entirely through local memory reading and a WebSocket connection.

## Features

- **Real-Time Memory Reading**: Instantly reads your character's Craftsmanship, Control, CP, and the current recipe's Difficulty, Durability, and Max Quality the moment you sit down to craft.
- **Condition Syncing**: Automatically tracks the active crafting step and the exact condition (Normal, Good, Pliant, Centered, etc.) 10 times a second.
- **Zero Network Injection**: Does not send any packets or simulated button presses to the FFXIV servers. You retain 100% manual control over your craft.
- **Borderless Overlay**: Receives the calculated "best next action" from the web solver and renders it as a lightweight, click-through, borderless ImGui overlay right on your game screen.
- **Auto-Web Population**: When paired with the included Tampermonkey script, your exact live stats and conditions are automatically typed into your web solver's UI, meaning you never have to manually update your stats or select conditions ever again.

## Setup Instructions

1. **Install the Plugin**: Load `CraftCast.dll` into your FFXIV client via the XIVLauncher / Dalamud Plugin Installer under the Dev Tools section.
2. **Install the Userscript**: Install the Tampermonkey browser extension and load the provided `dashboard-sync.user.js` script into it.
3. **Connect**: Open your preferred web solver (e.g., `https://thiria.com/expert/`). You will see a small green `Connected` pill appear in the bottom right corner of your browser.
4. **Craft**: Begin a synthesis in-game. Your live stats and recipe constraints will instantly populate on the webpage, and the solver's suggested action will instantly appear on your screen overlay!

## Architecture

* **C# / Dalamud**: Reads memory via `FFXIVClientStructs` (`PlayerState` and `CraftEventHandler`) and hosts a local WebSocket server on `127.0.0.1:8014`.
* **Tampermonkey / JavaScript**: Listens to the WebSocket, parses the JSON payload, dynamically updates the webpage DOM, and watches the DOM for the next suggested action to pipe back.
