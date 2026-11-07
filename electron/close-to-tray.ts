/**
 * Close to tray: what closing ByTune's main window does, and the menu of the Windows tray icon. Pure, so both
 * are unit-tested without Electron; main.ts owns the window, the Tray and the wiring.
 *
 * After ZCode's desktop app (packages/desktop/src/main: desktopWindowLifecycle.ts, desktopDarwinCloseBehavior.ts,
 * desktopTray.ts), © ZCode, licensed under the Apache License, Version 2.0: http://www.apache.org/licenses/LICENSE-2.0
 * ByTune keeps running with its window closed. The window that comes back is the same one, its page still
 * loaded, so the launch intro (index.html) only plays again after a real quit. Changed from ZCode's: the tray
 * carries the transport, closing to it pauses the music, and Windows only hides while the tray icon is there
 * to bring it back.
 */

import type { MenuCommand, MenuPlaybackState, MenuTemplate } from "./mac-menu";

/** "tray": hide the window in the Windows tray and pause the music. */
export type CloseAction = "close" | "hide" | "tray" | "leave-fullscreen";

/**
 * - A real quit (before-quit sets `quitting`) always closes.
 * - macOS hides the window and the music plays on, as Mac music players do (the Dock brings it back). In
 *   native fullscreen it leaves fullscreen instead: a window hidden there leaves its Space behind, black.
 * - Windows closes to the tray while Settings' "Close to tray" is on and the tray icon is there: ByTune keeps
 *   running, quiet until you press play (the tray, the media keys or the miniplayer can). Without the icon
 *   nothing could bring the window back or quit, so it closes (and ByTune quits) as it always did.
 */
export function closeAction(o: {
  platform: string;
  quitting: boolean;
  fullScreen: boolean;
  closeToTray: boolean;
  trayShown: boolean;
}): CloseAction {
  if (o.quitting) return "close";
  if (o.platform === "darwin") return o.fullScreen ? "leave-fullscreen" : "hide";
  return o.platform === "win32" && o.closeToTray && o.trayShown ? "tray" : "close";
}

export interface TrayWiring {
  /** Forward a playback command to the main window's renderer, hidden or not. */
  sendCommand(command: MenuCommand): void;
  /** Bring the main window back. */
  showMainWindow(): void;
  /** Quit ByTune for real. */
  quit(): void;
}

/** The tray icon's right-click menu: open, the transport (Play or Pause as it stands), quit. */
export function buildTrayMenu(state: MenuPlaybackState, wiring: TrayWiring): MenuTemplate {
  const cmd = (command: MenuCommand) => (): void => wiring.sendCommand(command);
  return [
    { label: "Open ByTune", click: (): void => wiring.showMainWindow() },
    { type: "separator" },
    { label: state.playing ? "Pause" : "Play", click: cmd("play-pause") },
    { label: "Next", click: cmd("next") },
    { label: "Previous", click: cmd("previous") },
    { type: "separator" },
    { label: "Quit ByTune", click: (): void => wiring.quit() },
  ];
}
