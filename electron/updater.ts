/**
 * Updates. The installed app asks GitHub for ByTune's newest release at launch, every six hours and
 * on "Check for updates", and says so when there's one: a button in the top bar, Settings › About,
 * and, once per version, a system notification.
 *
 * Windows installs it from there with electron-updater, which reads the release's latest.yml: Update
 * downloads it, Restart to update installs it and opens ByTune again. Nothing installs without that
 * click (an install on quit can be cut off half way by a shutdown, as ZCode found).
 *
 * A Mac can't install in place: macOS refuses an update to an app that isn't signed with an Apple
 * Developer ID, and ByTune's Mac builds are signed ad hoc. There, and whenever a Windows install
 * fails, Download opens bytune.space instead.
 *
 * The release check reads where github.com/…/releases/latest redirects to: no API, so no rate limit.
 * A dev run checks only with BYTUNE_UPDATE_TEST_VERSION set, and pretends to be that version.
 */
import { app, Notification, shell } from "electron";
import * as persist from "./persist";

const RELEASES = "https://github.com/rishiteja21/ByTune/releases";
export const DOWNLOAD_PAGE = "https://bytune.space";
const FIRST_CHECK_MS = 20_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

export type UpdateStatus = "idle" | "checking" | "current" | "available" | "downloading" | "ready" | "error";
export interface UpdateState {
  status: UpdateStatus;
  /** the version running now */
  current: string;
  /** the newer version, once one is found */
  version?: string;
  /** download progress, 0–100 */
  percent?: number;
  /** what went wrong, in words */
  error?: string;
  /** this app installs updates itself (installed on Windows); elsewhere Download opens the website */
  installs: boolean;
}

/* ---------------- versions (pure; exported for tests) ---------------- */

const parts = (v: string): number[] | null => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  return m ? m.slice(1).map(Number) : null;
};

/** `tag` as a version when it's ahead of `current` ("v1.2.0" over "1.1.9" → "1.2.0"), else null. */
export function newerVersion(tag: string, current: string): string | null {
  const a = parts(tag);
  const b = parts(current);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? a.join(".") : null;
  return null;
}

/** The tag GitHub's /releases/latest redirects to (".../releases/tag/v1.2.0"), or null. */
export function tagFromLocation(location: string | null): string | null {
  const m = /\/releases\/tag\/([^/?#]+)\/?$/.exec(location ?? "");
  return m ? decodeURIComponent(m[1]) : null;
}

/* ---------------- state ---------------- */

const testVersion = (): string | undefined => (app.isPackaged ? undefined : process.env.BYTUNE_UPDATE_TEST_VERSION);
const enabled = (): boolean => app.isPackaged || !!testVersion();

let state: UpdateState = { status: "idle", current: "", installs: false };
let publish: (s: UpdateState) => void = () => undefined;
let openAbout: () => void = () => undefined;

function set(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch };
  publish(state);
}

export function updateState(): UpdateState {
  return state;
}

/** Once per version, ever: a system notification, so an update shows while ByTune sits in the tray. */
function notifyOnce(version: string): void {
  const saved = persist.readData("updates") as { notified?: unknown } | null;
  if (saved?.notified === version || !Notification.isSupported()) return;
  void persist.writeData("updates", { notified: version }).catch(() => undefined);
  const note = new Notification({
    title: `ByTune ${version} is available`,
    body: state.installs ? "Click to update." : "Click to download it.",
  });
  note.on("click", () => openAbout());
  note.show();
}

let checking: Promise<void> | null = null;

/** Ask GitHub. An automatic check stays quiet: no "checking", no error, a notification when it finds one. */
export function checkForUpdates(auto = false): Promise<void> {
  if (!enabled()) {
    if (!auto) set({ status: "error", error: "Updates are checked in the installed app." });
    return Promise.resolve();
  }
  // One found and downloading or downloaded: nothing to ask until it's installed.
  if (state.status === "downloading" || state.status === "ready") return Promise.resolve();
  checking ??= (async () => {
    const before = state;
    if (!auto) set({ status: "checking", error: undefined });
    try {
      const res = await fetch(`${RELEASES}/latest`, {
        redirect: "manual",
        headers: { "User-Agent": `ByTune/${state.current}` },
        signal: AbortSignal.timeout(15_000),
      });
      const tag = tagFromLocation(res.headers.get("location"));
      if (!tag) throw new Error(`GitHub answered ${res.status}`);
      const version = newerVersion(tag, state.current);
      if (!version) {
        set({ status: "current", version: undefined, percent: undefined, error: undefined });
        return;
      }
      set({ status: "available", version, percent: undefined, error: undefined });
      if (auto) notifyOnce(version);
    } catch (err) {
      if (auto) set({ status: before.status === "checking" ? "idle" : before.status });
      else set({ status: "error", error: `Couldn't reach GitHub (${err instanceof Error ? err.message : String(err)}).` });
    }
  })().finally(() => (checking = null));
  return checking;
}

/* ---------------- installing (Windows) ---------------- */

type Updater = (typeof import("electron-updater"))["autoUpdater"];
let updater: Updater | null = null;

async function nsis(): Promise<Updater> {
  if (updater) return updater;
  const { autoUpdater } = await import("electron-updater");
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.on("download-progress", (p: { percent: number }) => {
    if (state.status === "downloading") set({ percent: Math.min(99, Math.floor(p.percent)) });
  });
  updater = autoUpdater;
  return autoUpdater;
}

/** Update: download and get it ready (Windows), or open the download page (a Mac, or an install that failed). */
export async function installUpdate(): Promise<void> {
  if (state.status === "ready") return restartToUpdate();
  if (state.status === "downloading" || !state.version) return;
  if (!state.installs || state.status === "error") {
    void shell.openExternal(DOWNLOAD_PAGE);
    return;
  }
  set({ status: "downloading", percent: 0, error: undefined });
  try {
    const u = await nsis();
    const found = await u.checkForUpdates();
    if (!found?.isUpdateAvailable) throw new Error("the release has no update for this app yet");
    await u.downloadUpdate();
    set({ status: "ready", percent: 100 });
  } catch (err) {
    console.warn("[bytune] update:", err instanceof Error ? err.message : err);
    set({ status: "error", percent: undefined, error: "The update couldn't download. Download it from bytune.space instead." });
  }
}

/** Restart to update: the installer runs silently, then opens ByTune again. */
export function restartToUpdate(): void {
  if (state.status !== "ready" || !updater) return;
  updater.quitAndInstall(true, true);
}

/**
 * Start checking: soon after launch, then every six hours. `send` carries each change to the window;
 * `about` brings the window up on Settings › About (a click on the notification).
 */
export function startUpdates(send: (s: UpdateState) => void, about: () => void): void {
  state = { status: "idle", current: testVersion() ?? app.getVersion(), installs: process.platform === "win32" && app.isPackaged };
  publish = send;
  openAbout = about;
  if (!enabled()) return;
  setTimeout(() => void checkForUpdates(true), FIRST_CHECK_MS).unref();
  setInterval(() => void checkForUpdates(true), CHECK_EVERY_MS).unref();
}
