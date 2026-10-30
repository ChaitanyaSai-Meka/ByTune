/**
 * Windows media flyout, lock screen and media keys through ByTune's own
 * session: ByTuneMedia.exe, built from media-helper.cs.
 *
 * Chromium's built-in session hands Windows the cover downscaled to 150×150
 * (kDesiredImageSize in content/browser/media/system_media_controls/
 * system_media_controls_notifier.cc), which the flyout stretches into a
 * pixelated tile. The helper owns the session instead and gets the full-size
 * image — what Spotify does from native code. Chromium's session is switched
 * off so there is one ByTune entry and the media keys reach this one.
 *
 * The renderer still drives everything through its media-session code:
 * metadata and position arrive over IPC, flyout buttons and media keys go
 * back as media-session actions. JSON lines both ways over the helper's
 * stdin/stdout; the helper exits when its stdin closes.
 */
import { app } from "electron";
import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { upgradeThumb } from "./artwork";

export type MediaAction =
  | { action: "play" | "pause" | "nexttrack" | "previoustrack" }
  | { action: "seekto"; seekTime: number };

interface Deps {
  onAction: (action: MediaAction) => void;
  readLocalArt: (thumb: string) => Buffer | null;
}

/** The largest square the art hosts serve (see artwork.ts). */
const COVER_PX = 1200;
const MAX_COVER_BYTES = 10 * 1024 * 1024;
const MAX_RESTARTS = 3;
const BUTTONS = new Map<unknown, "play" | "pause" | "nexttrack" | "previoustrack">([
  ["play", "play"],
  ["pause", "pause"],
  ["next", "nexttrack"],
  ["previous", "previoustrack"],
]);

let enabled = false;
let deps: Deps | null = null;
let child: ChildProcess | null = null;
let restarts = 0;
let stopped = false;
let display: { title: string; artist: string; album: string; cover: string } | null = null;
let playing = false;
let timeline: { position: number; duration: number } | null = null;
/** Bumped per track so a slow cover download never lands on the next one. */
let coverSeq = 0;
let cachedThumb = "";
let cachedCover = "";

function helperPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "ByTuneMedia.exe")
    : path.join(__dirname, "ByTuneMedia.exe");
}

/** Call before app ready: the switch only takes effect at Chromium startup. */
export function init(): boolean {
  enabled = process.platform === "win32" && fs.existsSync(helperPath());
  if (enabled) app.commandLine.appendSwitch("disable-features", "HardwareMediaKeyHandling");
  return enabled;
}

export function start(d: Deps): void {
  if (!enabled || child) return;
  deps = d;
  launch();
}

function launch(): void {
  const p = spawn(helperPath(), ["com.bytune.music"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  child = p;
  // Writes to a helper that just died: its exit handler takes over.
  p.stdin?.on("error", () => undefined);
  if (p.stdout) readline.createInterface({ input: p.stdout }).on("line", onLine);
  if (p.stderr) readline.createInterface({ input: p.stderr }).on("line", (l) => console.warn("[bytune] media helper:", l));
  p.on("error", (err) => console.warn("[bytune] media helper failed:", err.message));
  p.on("exit", () => {
    if (child !== p) return;
    child = null;
    if (!stopped && restarts < MAX_RESTARTS) {
      restarts++;
      launch();
    }
  });
  if (display) send({ type: "display", ...display });
  send({ type: "status", playing });
  if (timeline) send({ type: "timeline", ...timeline });
}

export function stop(): void {
  stopped = true;
  child?.kill();
  child = null;
}

function send(msg: object): void {
  if (child?.stdin?.writable) child.stdin.write(JSON.stringify(msg) + "\n");
}

function onLine(line: string): void {
  let msg: { type?: unknown; button?: unknown; position?: unknown } | null;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (!msg || typeof msg !== "object") return;
  const button = BUTTONS.get(msg.button);
  if (msg.type === "button" && button) deps?.onAction({ action: button });
  else if (msg.type === "seek" && typeof msg.position === "number" && Number.isFinite(msg.position) && msg.position >= 0) {
    deps?.onAction({ action: "seekto", seekTime: msg.position });
  }
}

const text = (v: unknown, max = 500): string => (typeof v === "string" ? v.slice(0, max) : "");

/** Renderer metadata (untrusted shape); null/non-object clears the session. */
export function setTrack(track: unknown): void {
  if (!enabled) return;
  const seq = ++coverSeq;
  if (!track || typeof track !== "object") {
    display = null;
    timeline = null;
    send({ type: "clear" });
    return;
  }
  const t = track as Record<string, unknown>;
  const thumb = text(t.thumb, 4096);
  display = {
    title: text(t.title),
    artist: text(t.artist),
    album: text(t.album),
    cover: thumb && thumb === cachedThumb ? cachedCover : "",
  };
  send({ type: "display", ...display });
  if (!thumb || thumb === cachedThumb) return;
  void loadCover(thumb).then((cover) => {
    if (seq !== coverSeq || !cover || !display) return;
    cachedThumb = thumb;
    cachedCover = cover;
    display = { ...display, cover };
    send({ type: "display", ...display });
  });
}

/** The cover as base64 — remote art at full size, local art from its cache. */
async function loadCover(thumb: string): Promise<string> {
  try {
    let bytes: Buffer | null = null;
    if (/^localart:\/\//i.test(thumb)) bytes = deps?.readLocalArt(thumb) ?? null;
    else if (/^https:\/\//i.test(thumb)) {
      const res = await fetch(upgradeThumb(thumb, COVER_PX), { signal: AbortSignal.timeout(10_000) });
      if (res.ok && /^image\//i.test(res.headers.get("content-type") ?? "")) bytes = Buffer.from(await res.arrayBuffer());
    }
    return bytes && bytes.length <= MAX_COVER_BYTES ? bytes.toString("base64") : "";
  } catch {
    return "";
  }
}

export function setPlaying(value: unknown): void {
  if (!enabled) return;
  playing = value === true;
  send({ type: "status", playing });
}

export function setPosition(position: unknown, duration: unknown): void {
  if (!enabled || typeof position !== "number" || typeof duration !== "number") return;
  if (!Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0) return;
  timeline = { position: Math.min(Math.max(0, position), duration), duration };
  send({ type: "timeline", ...timeline });
}
