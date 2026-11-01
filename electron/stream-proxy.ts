/**
 * Local stream proxy.
 *
 * The renderer's media requests to googlevideo get rejected (403) even when
 * the exact same URL streams fine from the main process — the Chromium
 * network stack reaches googlevideo differently (address family / TLS
 * fingerprint). So the main process does all googlevideo traffic: this tiny
 * HTTP server on 127.0.0.1 resolves a track id to a stream URL and pipes the
 * upstream response (including Range requests for seeking) back to the
 * renderer's <audio> element.
 */
import fs from "fs";
import http from "http";
import path from "path";
import type { AddressInfo } from "net";
import { localStreamPath } from "./local-library";
import { resolveStream } from "./music-service";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const PASSTHROUGH_HEADERS = ["content-type", "content-length", "content-range", "accept-ranges"];

let server: http.Server | null = null;
let proxyPort = 0;

/**
 * Origin gate. The proxy is app infrastructure on a loopback port, but any
 * local process — or a hostile website via its browser's localhost exemption —
 * can reach it. With `Access-Control-Allow-Origin: *` such a caller could
 * read streamed bytes. The renderer itself never needs CORS for playback
 * (the media element sends no Origin and <audio> without crossOrigin ignores
 * CORS), and its fetch()es come from the packaged file:// origin ("null") or
 * the dev server. Any real Origin outside the dev servers is refused before
 * a single byte is resolved.
 */
export function originAllowed(origin: string | undefined, host: string | undefined): boolean {
  // Host must be the loopback authority this server serves — kills DNS
  // rebinding by hostname.
  if (host && !/^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(host)) return false;
  if (!origin) return true; // media element / non-CORS clients
  if (origin === "null") return true; // packaged renderer fetch (file:// origin)
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin); // dev renderer
}

export function startStreamProxy(): Promise<number> {
  if (proxyPort) return Promise.resolve(proxyPort);
  server = http.createServer((req, res) => {
    if (!originAllowed(req.headers.origin as string | undefined, req.headers.host as string | undefined)) {
      res.writeHead(403);
      res.end();
      return;
    }
    void handle(req, res);
  });
  // Keep idle sockets alive; media elements reuse connections while seeking.
  server.keepAliveTimeout = 65_000;
  return new Promise<number>((resolve, reject) => {
    server!.on("error", reject);
    server!.listen(0, "127.0.0.1", () => {
      proxyPort = (server!.address() as AddressInfo).port;
      console.log(`[bytune] stream proxy on 127.0.0.1:${proxyPort}`);
      resolve(proxyPort);
    });
  });
}

export function getStreamProxyPort(): number {
  return proxyPort;
}

export function proxyUrlFor(trackId: string, forceRotate = false, maxKbps?: number): string {
  const kbps = typeof maxKbps === "number" && maxKbps > 0 ? `&kbps=${Math.floor(maxKbps)}` : "";
  return `http://127.0.0.1:${proxyPort}/?id=${encodeURIComponent(trackId)}${forceRotate ? "&rotate=1" : ""}${kbps}`;
}

/* Local library files travel through the proxy too: the renderer runs on an
 * http origin (dev server / packaged build), and Chromium refuses to load
 * file:// media from a non-file origin. The route only ever serves files the
 * scanner indexed (looked up by id in the local library), so it's exactly as
 * trusted as the IPC channel itself and can't become a path relay. */
export function proxyUrlForLocalTrack(localId: string): string | null {
  if (!proxyPort) return null;
  return `http://127.0.0.1:${proxyPort}/?lid=${encodeURIComponent(localId)}`;
}

const LOCAL_MIME: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
  ".wma": "audio/x-ms-wma",
};

function serveLocalFile(id: string, range: string | undefined, res: http.ServerResponse, req: http.IncomingMessage): void {
  const filePath = localStreamPath(id);
  if (!filePath) {
    res.writeHead(404);
    res.end("local file missing");
    return;
  }
  let size: number;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    res.writeHead(404);
    res.end("local file missing");
    return;
  }

  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    "Accept-Ranges": "bytes",
    "Content-Type": LOCAL_MIME[path.extname(filePath).toLowerCase()] ?? "audio/mpeg",
  };

  // Range support is what makes seeking work: the media element re-requests
  // the byte span it jumped to, we answer 206 with exactly that slice.
  let start = 0;
  let end = size - 1;
  let status = 200;
  const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (match && (match[1] !== "" || match[2] !== "")) {
    if (match[1] === "") {
      const suffix = Math.min(parseInt(match[2], 10), size);
      start = size - suffix;
      end = size - 1;
    } else {
      start = parseInt(match[1], 10);
      end = match[2] === "" ? size - 1 : Math.min(parseInt(match[2], 10), size - 1);
    }
    if (Number.isNaN(start) || start > end || start >= size) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` });
      res.end();
      return;
    }
    status = 206;
    headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  }
  headers["Content-Length"] = String(end - start + 1);
  res.writeHead(status, headers);

  const stream = fs.createReadStream(filePath, { start, end });
  stream.on("error", (err) => {
    // Basename only — the log must not carry the user's folder structure.
    console.warn(`[bytune] local file read error (${path.basename(filePath)}):`, err instanceof Error ? err.message : err);
    res.destroy();
  });
  req.on("close", () => stream.destroy());
  stream.pipe(res);
}

/** Waiting this long for headers, or for the next chunk mid-song, means the stream is dead. */
const UPSTREAM_TIMEOUT_MS = 20_000;

/** The upstream request plus its abort switch (also used by the idle watchdog). */
async function fetchUpstream(
  streamUrl: string,
  range: string | undefined,
  ctl = new AbortController()
): Promise<Response> {
  const headers: Record<string, string> = { "User-Agent": UA };
  if (range) headers.Range = range;
  // A timeout on headers only: the body of a long song streams for minutes.
  const timer = setTimeout(() => ctl.abort(new Error("upstream timed out")), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(streamUrl, { headers, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const trackId = url.searchParams.get("id");
    const localId = url.searchParams.get("lid");
    if (!trackId && !localId) {
      res.writeHead(400);
      res.end("missing id");
      return;
    }
    const range = req.headers.range;
    if (localId) {
      serveLocalFile(localId, range, res, req);
      return;
    }
    const forceRotate = url.searchParams.get("rotate") === "1";
    const kbpsRaw = Number(url.searchParams.get("kbps") ?? 0);
    const maxKbps = Number.isFinite(kbpsRaw) && kbpsRaw > 0 ? Math.floor(kbpsRaw) : undefined;

    // Metadata-only request: the renderer asks `?id=…&meta=1` to learn the
    // track's loudness (for Spotify-style −14 LUFS normalisation) without
    // pulling audio bytes. Shares the resolution cache with playback, so it
    // costs one getBasicInfo at most.
    if (url.searchParams.get("meta") === "1") {
      try {
        const meta = await resolveStream(trackId as string, false, maxKbps);
        res.writeHead(200, {
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store",
          "Content-Type": "application/json",
        });
        res.end(JSON.stringify({ lufs: meta.lufs }));
      } catch (err) {
        console.warn("[bytune] proxy meta error:", err instanceof Error ? err.message : err);
        res.writeHead(502, { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" });
        res.end(JSON.stringify({ lufs: null }));
      }
      return;
    }

    let stream = await resolveStream(trackId as string, forceRotate, maxKbps);
    let ctl = new AbortController();
    let upstream = await fetchUpstream(stream.url, range, ctl);

    // Self-heal: a URL that just went bad gets one more resolution.
    if (upstream.status === 403 && trackId) {
      console.warn(`[bytune] proxy upstream 403 for ${trackId}, rotating client`);
      stream = await resolveStream(trackId, true, maxKbps);
      ctl = new AbortController();
      upstream = await fetchUpstream(stream.url, range, ctl);
    }

    if (!upstream.ok || !upstream.body) {
      console.warn(`[bytune] proxy upstream HTTP ${upstream.status} for ${trackId}`);
      res.writeHead(upstream.status === 403 ? 404 : upstream.status);
      res.end();
      return;
    }

    const outHeaders: Record<string, string> = {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    };
    for (const h of PASSTHROUGH_HEADERS) {
      const v = upstream.headers.get(h);
      if (v) outHeaders[h] = v;
    }
    res.writeHead(upstream.status, outHeaders);

    const reader = upstream.body.getReader();
    req.on("close", () => {
      void reader.cancel().catch(() => undefined);
    });
    // Idle watchdog: an upstream that stops sending mid-song is aborted, so
    // the player gets an error (and retries) instead of buffering forever.
    let idle = setTimeout(() => ctl.abort(new Error("upstream stalled")), UPSTREAM_TIMEOUT_MS);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        clearTimeout(idle);
        if (done || res.destroyed) break;
        if (value && value.length > 0 && !res.write(value)) {
          // Wait for room, or for the player to hang up (a seek or skip
          // closes the request; waiting on `drain` alone never returned).
          await new Promise<void>((resolve) => {
            const settle = (): void => {
              res.off("drain", settle);
              res.off("close", settle);
              resolve();
            };
            res.once("drain", settle);
            res.once("close", settle);
          });
          if (res.destroyed) break;
        }
        idle = setTimeout(() => ctl.abort(new Error("upstream stalled")), UPSTREAM_TIMEOUT_MS);
      }
    } finally {
      clearTimeout(idle);
    }
    if (res.destroyed) {
      void reader.cancel().catch(() => undefined);
      return;
    }
    res.end();
  } catch (err) {
    console.warn("[bytune] proxy error:", err instanceof Error ? err.message : err);
    // Mid-body (headers already sent) the only honest answer is to drop the
    // connection: Chromium then errors or re-requests the range. Writing a
    // status here threw and left the response open, so playback hung.
    if (res.headersSent) {
      res.destroy();
      return;
    }
    try {
      res.writeHead(502);
      res.end("proxy error");
    } catch {
      res.destroy();
    }
  }
}
