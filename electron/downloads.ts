/**
 * Download manager — a real queue:
 *
 *   - enqueue(): one door into the queue; a track already saved, queued or
 *     running is left alone rather than duplicated
 *   - concurrency capped at 2 so the stream proxy and the network stay healthy
 *   - bytes land in a hidden ".part" file that takes the song's name only when
 *     complete; a stall, an HTTP error or an early end resumes from the bytes on
 *     disk on a fresh URL (same file), or starts over (another rendition)
 *   - cancel() aborts an in-flight transfer (partial file removed) or dequeues;
 *     quitting does the same, so no half-written file survives
 *   - an M4A file gets the song's title, artist, album and cover written into it
 *     before it takes its name (a file that won't take them is kept untagged)
 *   - progress + lifecycle events stream to the renderer over download:event
 */
import { app } from "electron";
import * as fs from "fs";
import * as path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { upgradeThumb } from "./artwork";
import { writeM4aTags, type M4aTags } from "./m4a-tags";
import { resolveStream } from "./music-service";
import type { Track } from "../src/types";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const MAX_CONCURRENT = 2;
/** No bytes for this long means the transfer is dead: it resumes on a fresh URL. */
const STALL_MS = 20_000;
/** Tries per download (the first plus resumes), with a growing pause between them. */
const ATTEMPTS = 4;

type QueueState =
  | { phase: "queued" }
  | { phase: "running"; downloaded: number; total: number }
  | { phase: "failed"; reason: string };

const queue: { track: Track; dir?: string; maxKbps?: number; exportCompat?: boolean }[] = [];
const state = new Map<string, QueueState>();
const controllers = new Map<string, AbortController>();
/** Partial files of the transfers running now, removed at once if the app quits mid-download. */
const partials = new Set<string>();
let active = 0;
const workers = new Set<Promise<void>>();
let resetTask: Promise<void> | null = null;

/** Stop the queue and await partial-file cleanup; completed audio is retained. */
export function resetDownloads(): Promise<void> {
  if (resetTask) return resetTask;
  resetTask = Promise.resolve().then(async () => {
    await Promise.allSettled([...workers]);
    state.clear();
  }).finally(() => { resetTask = null; });
  // Stop producers synchronously at invocation, before any awaited cleanup.
  const queued = queue.splice(0);
  for (const ctrl of controllers.values()) ctrl.abort();
  for (const item of queued) emit({ type: "cancelled", id: item.track.id });
  return resetTask;
}

let quitting = false;

/** Quitting: stop every transfer and delete its partial file now (the process won't wait for async
 *  cleanup). No "cancelled" events: the rows stay on the Downloads list, offered again at next launch. */
export function abandonDownloads(): void {
  quitting = true;
  queue.splice(0);
  for (const ctrl of controllers.values()) ctrl.abort();
  for (const file of partials) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}.tagging`, { force: true });
    } catch {
      /* best effort */
    }
  }
}

/** The song's cover for its file: a large JPEG or PNG, else none (a WebP, a failed fetch, an oversized answer). */
async function coverFor(track: Track, signal: AbortSignal): Promise<M4aTags["cover"]> {
  const url = upgradeThumb(track.thumb ?? "", 1000);
  if (!url.startsWith("https://")) return undefined;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
    if (!res.ok) return undefined;
    const data = new Uint8Array(await res.arrayBuffer());
    if (data.length > 5 * 1024 * 1024) return undefined;
    if (data[0] === 0xff && data[1] === 0xd8) return { data, mime: "image/jpeg" };
    if (data[0] === 0x89 && data[1] === 0x50) return { data, mime: "image/png" };
    return undefined;
  } catch {
    return undefined;
  }
}

// Stream resolution has no AbortSignal API. Stop waiting immediately on reset;
// its eventual resolution/rejection is consumed, with no download side effects.
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new Error("cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

export interface DownloadEvent {
  type: "queued" | "start" | "progress" | "done" | "failed" | "cancelled";
  id: string;
  downloaded?: number;
  total?: number;
  path?: string;
  reason?: string;
}

type Listener = (e: DownloadEvent) => void;
const listeners = new Set<Listener>();

function emit(e: DownloadEvent): void {
  for (const l of listeners) {
    try {
      l(e);
    } catch {
      /* listener errors never break the queue */
    }
  }
}

export function isDownloading(id: string): boolean {
  return queue.some((q) => q.track.id === id) || state.has(id);
}

export function queueSnapshot(): { id: string; phase: string; downloaded?: number; total?: number; reason?: string }[] {
  const out: { id: string; phase: string; downloaded?: number; total?: number; reason?: string }[] = [];
  for (const q of queue) out.push({ id: q.track.id, phase: "queued" });
  for (const [id, st] of state) {
    if (st.phase === "queued") out.push({ id, phase: "queued" });
    else if (st.phase === "running") out.push({ id, phase: "running", downloaded: st.downloaded, total: st.total });
    else out.push({ id, phase: "failed", reason: st.reason });
  }
  return out;
}

export async function defaultDownloadDir(): Promise<string> {
  return path.join(app.getPath("downloads"), "ByTune");
}

/**
 * Export-compatible location: the OS music library, so other players and
 * the user can reach the files — the desktop equivalent of mobile's shared
 * `Music/BitChord` (vs the app download folder above).
 */
export function exportDownloadDir(): string {
  return path.join(app.getPath("music"), "ByTune");
}

/** Exported for security regression tests — the production path is internal. */
export function sanitizeFilename(name: string): string {
  // Bidi/format controls (U+202A–U+202E etc.) would let a hostile title
  // visually masquerade the file extension in Explorer.
  const s = name.replace(/[\\/:*?"<>|\x00-\x1f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "_").replace(/\s+/g, " ").trim();
  const bounded = (s || "track").slice(0, 120);
  // A stem that is exactly a reserved Windows device name fails or misbehaves
  // on write — pad it so it becomes an ordinary file name.
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(bounded) ? `_${bounded}` : bounded;
}

/** Claim a free name for a finished file by creating it exclusively, so two downloads of
 *  same-named songs finishing together can never take (and overwrite) the same one. */
function claimName(dir: string, base: string): string {
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  for (let n = 0; ; n++) {
    const candidate = path.join(dir, n ? `${stem} (${n})${ext}` : base);
    try {
      fs.closeSync(fs.openSync(candidate, "wx"));
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
}

/** One request for the bytes from `from` on, written into `part`. A stall aborts it. */
async function transfer(
  url: string,
  part: string,
  from: number,
  job: AbortSignal,
  onBytes: (size: number, total: number) => void
): Promise<{ size: number; total: number }> {
  const attempt = new AbortController();
  const cancel = (): void => attempt.abort(new Error("cancelled"));
  job.addEventListener("abort", cancel, { once: true });
  let stall = setTimeout(() => attempt.abort(new Error("download stalled")), STALL_MS);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Range: `bytes=${from}-` }, signal: attempt.signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    // A server that ignores the range sends the whole file again: the part starts over.
    const start = res.status === 206 ? from : 0;
    const length = Number(res.headers.get("content-length") ?? 0);
    const total = length > 0 ? start + length : 0;
    const out = fs.createWriteStream(part, { flags: start > 0 ? "a" : "w" });
    const src = Readable.fromWeb(res.body as import("stream/web").ReadableStream);
    let size = start;
    src.on("data", (chunk: Buffer) => {
      clearTimeout(stall);
      stall = setTimeout(() => attempt.abort(new Error("download stalled")), STALL_MS);
      size += chunk.length;
      onBytes(size, total);
    });
    await pipeline(src, out, { signal: attempt.signal });
    return { size, total };
  } finally {
    clearTimeout(stall);
    job.removeEventListener("abort", cancel);
  }
}

/** Register a listener for lifecycle events (the renderer bridge forwards). */
export function addDownloadListener(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Queue a track. Throws when it is already saved, queued or running — the
 * caller decides what that means for its own UI.
 */
export function enqueueDownload(track: Track, dirOverride?: string, maxKbps?: number, exportCompat?: boolean): "queued" {
  if (resetTask) throw new Error("Downloads reset in progress");
  if (isDownloading(track.id)) throw new Error("Already downloading this track");
  queue.push({ track, dir: dirOverride, maxKbps, exportCompat: exportCompat === true });
  state.set(track.id, { phase: "queued" });
  emit({ type: "queued", id: track.id });
  void drain();
  return "queued";
}

export function cancelDownload(id: string): boolean {
  const qi = queue.findIndex((q) => q.track.id === id);
  if (qi >= 0) {
    queue.splice(qi, 1);
    state.delete(id);
    emit({ type: "cancelled", id });
    return true;
  }
  const ctrl = controllers.get(id);
  if (ctrl) {
    ctrl.abort(); // the transfer's catch handles cleanup + event
    return true;
  }
  return false;
}

async function drain(): Promise<void> {
  // Workers pull from the shared queue up to the concurrency cap.
  while (!resetTask && active < MAX_CONCURRENT) {
    const next = queue.shift();
    if (!next) break;
    active++;
    const worker = runDownload(next.track, next.dir, next.maxKbps, next.exportCompat)
      .catch((err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err);
        if (reason !== "cancelled") {
          // The failure is terminal for this attempt: drop the queue's own
          // bookkeeping entry so isDownloading() goes false and the track can
          // be queued again immediately. (The renderer's download registry
          // keeps the failed state for the UI; leaving the entry here made
          // every retry throw "Already downloading this track" until restart.)
          state.delete(next.track.id);
          emit({ type: "failed", id: next.track.id, reason });
        }
      })
      .finally(() => {
        active--;
        workers.delete(worker);
        if (queue.length > 0) void drain();
      });
    workers.add(worker);
  }
}

async function runDownload(track: Track, dirOverride?: string, maxKbps?: number, exportCompat?: boolean): Promise<void> {
  const ctrl = new AbortController();
  controllers.set(track.id, ctrl);
  let part = "";
  const checkCancelled = (): void => { if (ctrl.signal.aborted) throw new Error("cancelled"); };
  try {
    const dir = exportCompat ? exportDownloadDir() : dirOverride && dirOverride.trim() ? dirOverride : await defaultDownloadDir();
    checkCancelled();
    await fs.promises.mkdir(dir, { recursive: true });
    checkCancelled();

    // Downloads ask for an mp4/AAC rendition (the most portable container);
    // the resolver still falls back to the best available if a track has none,
    // so the file is named from the mime it actually returned.
    // A fresh URL: an hours-old URL may be tied to an old address.
    let stream = await abortable(resolveStream(track.id, true, maxKbps, true), ctrl.signal);
    checkCancelled();
    // Named by the track id, the part is this song's own: one left by a download the app
    // was quit in the middle of is simply started over.
    part = path.join(dir, `.bytune-${track.id}.part`);
    partials.add(part);
    emit({ type: "start", id: track.id });
    state.set(track.id, { phase: "running", downloaded: 0, total: 0 });

    let lastEmit = 0;
    const progress = (downloaded: number, total: number): void => {
      if (ctrl.signal.aborted) return;
      const now = Date.now();
      if (now - lastEmit > 250) {
        lastEmit = now;
        state.set(track.id, { phase: "running", downloaded, total });
        emit({ type: "progress", id: track.id, downloaded, total });
      }
    };
    for (let attempt = 1; ; attempt++) {
      try {
        // Resume from what actually reached the disk (a failed write may have dropped its last buffer).
        const from = attempt === 1 ? 0 : await fs.promises.stat(part).then((s) => s.size, () => 0);
        const got = await transfer(stream.url, part, from, ctrl.signal, progress);
        const expected = stream.clen || got.total;
        if (expected > 0 && got.size < expected) throw new Error("download ended early");
        break;
      } catch (err) {
        checkCancelled();
        if (attempt >= ATTEMPTS) throw err;
        console.warn(`[bytune] download ${track.id}: ${err instanceof Error ? err.message : err}; trying again`);
        await abortable(new Promise((r) => setTimeout(r, attempt * 1500)), ctrl.signal);
        // A fresh URL. The same file (rendition and length) resumes; another one starts over.
        const next = await abortable(resolveStream(track.id, true, maxKbps, true), ctrl.signal);
        if (next.itag !== stream.itag || next.clen !== stream.clen) await fs.promises.truncate(part, 0).catch(() => undefined);
        stream = next;
      }
    }
    checkCancelled();

    const ext = /webm|opus/i.test(stream.mime) ? ".webm" : ".m4a";
    // The song's details go into the file itself, so other players and phones show them.
    if (ext === ".m4a") {
      try {
        const cover = await coverFor(track, ctrl.signal);
        await writeM4aTags(part, { title: track.title, artist: track.artist, album: track.album || undefined, cover });
      } catch (err) {
        console.warn(`[bytune] download ${track.id}: tags not written:`, err instanceof Error ? err.message : err);
      }
      checkCancelled();
    }
    const dest = claimName(dir, `${sanitizeFilename(`${track.artist} - ${track.title}`)}${ext}`);
    try {
      await fs.promises.rename(part, dest); // replaces the empty file that claimed the name
    } catch (err) {
      await fs.promises.rm(dest, { force: true }).catch(() => undefined);
      throw err;
    }
    partials.delete(part);
    // A completed audio file belongs to the user now.
    state.delete(track.id);
    emit({ type: "done", id: track.id, path: dest });
  } catch (err) {
    // Remove the partial file so no broken audio is left behind. Finished
    // files are never touched.
    if (part) {
      partials.delete(part);
      await fs.promises.rm(part, { force: true }).catch(() => undefined);
    }
    if (ctrl.signal.aborted) {
      state.delete(track.id);
      if (!quitting) emit({ type: "cancelled", id: track.id });
      throw new Error("cancelled");
    }
    throw err;
  } finally {
    controllers.delete(track.id);
  }
}
