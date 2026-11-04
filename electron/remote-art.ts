/**
 * Cover bytes for the page's colour reading (src/lib/coverColor via lib/ambient loadArtworkImage).
 * YouTube's thumbnail host (i.ytimg.com: playlist covers, video thumbnails) sends no CORS header, so
 * a page can show those covers but never read their pixels. Main fetches them instead, the same way
 * local covers come through library:artbytes. Only that host, only https, only images, at most 4 MB:
 * the page can't use this to reach anything else.
 */

const HOST = /^i\d?\.ytimg\.com$/;
const MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 8000;

/** The cover's bytes, or null when the URL isn't a YouTube thumbnail or the image can't be had. */
export async function remoteArtBytes(raw: string): Promise<Uint8Array | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !HOST.test(url.hostname) || url.username || url.password || url.port) return null;
  try {
    const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok || !/^image\//i.test(res.headers.get("content-type") ?? "")) return null;
    if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    return bytes.byteLength > MAX_BYTES ? null : bytes;
  } catch {
    return null;
  }
}
