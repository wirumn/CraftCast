# CraftCast

CraftCast connects your Final Fantasy XIV crafting session to the [Thiria expert solver](https://thiria.com/expert/). A Dalamud plugin and browser userscript keep the solver page updated as you craft and show its next suggested action above the Synthesis window.

## Install

1. Open `/xlsettings`, go to **Experimental**, and add this under **Custom Plugin Repositories**:

   ```text
   https://raw.githubusercontent.com/wirumn/CraftCast/repo/pluginmaster.json
   ```

2. Open `/xlplugins`, search for **CraftCast**, and install it.
3. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser, then open the [userscript](https://raw.githubusercontent.com/wirumn/CraftCast/main/dashboard-sync.user.js) and accept the installation.
4. Open [Thiria](https://thiria.com/expert/). The bottom-right indicator shows **Connected** when it can reach the plugin.

Check Thiria's **Relic** setting before crafting. Use **Cosmic 9+** for a qualifying Cosmic or Splendorous mainhand, or **None** otherwise. The wrong setting changes quality calculations on Good conditions.

## Use

Keep Thiria open and start a craft in game. CraftCast fills in your stats and recipe settings, then updates the steps as you use actions. The overlay shows Thiria's recommendation; you choose which action to use.

To edit the Thiria page manually, click **Pause** or press **Ctrl+Shift+P**. **Resume** brings the page back into line with your in-game history.

## Limits and troubleshooting

- If the plugin starts tracking partway through a craft, automatic sync waits for the next craft.
- **Material Miracle** is skipped. Thiria does not simulate its buff, so recommendations may be inaccurate after using it.
- Actions missing from Thiria's action list can stall sync. Check the browser's status indicator if the overlay stops updating.
- If sync stays stuck, correct the issue and use **Pause**, then **Resume**, to retry.

When [reporting a bug](https://github.com/wirumn/CraftCast/issues), include the browser console's `[bridge]` messages and the Dalamud log (`/xllog`, filtered to `CraftCast`) from the affected craft.
