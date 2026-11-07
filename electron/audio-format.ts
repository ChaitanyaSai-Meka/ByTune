/**
 * Audio rendition selection — the pure half of stream resolution, kept free
 * of Electron/Innertube imports so it can be unit-tested directly (see
 * tests/format-pick.test.mjs).
 */

export async function formatUrl(format: any, yt: any): Promise<string | null> {
  if (typeof format?.url === "string" && format.url) return format.url;
  try {
    if (typeof format?.decipher === "function" && yt?.session?.player) {
      const out = await format.decipher(yt.session.player);
      if (typeof out === "string" && out) return out;
      if (typeof format?.url === "string" && format.url) return format.url;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Audio rendition ranking — YouTube's music ladder:
 *   141: 256k AAC-LC · 251: ~160k Opus · 140: 128k AAC-LC · 250: ~95k Opus
 *   249: ~50k Opus · 139: 48k HE-AAC.
 * Opus 251 beats AAC 140 on both bitrate and codec efficiency; the old rule
 * that preferred the mp4 container silently downgraded every stream from
 * Opus to 128k AAC — the audible quality gap vs Spotify. Known itags rank
 * first; unknown formats fall back to raw bitrate order.
 */
const AUDIO_ITAG_RANK: Record<number, number> = {
  141: 6,
  251: 5,
  140: 4,
  250: 3,
  249: 2,
  139: 1,
};

export function audioScore(f: any): number {
  const rank = AUDIO_ITAG_RANK[f?.itag] ?? 0;
  return rank * 1e9 + (f?.bitrate ?? 0);
}

/**
 * Integrated loudness of a format in LUFS. Prefer the absolute LKFS YouTube
 * reports; the relative `loudnessDb` is the attenuation YouTube's own player
 * applies to reach its -14 LUFS target, so `loudnessDb - 14` recovers the
 * same number. Verified against live responses: every format of a track
 * carries the identical value, so any candidate answers the question.
 */
export function formatLufs(f: any): number | null {
  const abs = f?.track_absolute_loudness_lkfs;
  if (typeof abs === "number" && Number.isFinite(abs)) return abs;
  const db = f?.loudness_db;
  if (typeof db === "number" && Number.isFinite(db)) return db - 14;
  return null;
}

export interface PickedAudio {
  url: string;
  mime: string;
  lufs: number | null;
  /** Which file this is. Re-resolving asks for the same one, so a seek's byte
      ranges keep coming from the file the player opened. */
  itag?: number;
  clen?: number;
}

export async function pickAudio(
  info: any,
  yt: any,
  maxKbps?: number,
  mp4Only = false,
  pin?: { itag?: number; clen?: number }
): Promise<PickedAudio | null> {
  const sd = info?.streaming_data;
  if (!sd) return null;
  const audioOnly: any[] = (sd.adaptive_formats ?? []).filter(
    (f: any) => f?.has_audio && !f?.has_video
  );
  let candidates = audioOnly;
  if (!candidates.length) {
    const progressive: any[] = (sd.formats ?? []).filter((f: any) => f?.has_audio && !f?.has_video);
    candidates = progressive;
  }
  if (!candidates.length && typeof sd.url === "string")
    return { url: sd.url, mime: String(sd.mime_type ?? "audio/mp4"), lufs: null };
  if (!candidates.length) return null;
  // "Stable volume" (DRC) and dubbed copies reuse the plain track's itags, so
  // ranking alone could flip between them from one resolution to the next.
  const plain = candidates.filter((f) => !f.is_drc && f.is_original !== false);
  if (plain.length) candidates = plain;
  candidates.sort((a, b) => audioScore(b) - audioScore(a));
  // The file the player already opened wins outright.
  const pinned = pin?.itag
    ? candidates.find(
        (f) => f.itag === pin.itag && (pin.clen == null || f.content_length == null || Number(f.content_length) === pin.clen)
      )
    : undefined;
  if (pinned) candidates = [pinned];
  // Quality ceiling: best rendition at/below the cap; if only higher ones
  // exist, take the best rather than refusing — a capped track beats silence.
  if (!pinned && maxKbps && maxKbps > 0) {
    // Ceilings name nominal tiers ("128 kbps") but `bitrate` is YouTube's
    // peak: 128k AAC (itag 140) reports ~130k and was filtered out, so a
    // "Standard" download fell to 48k HE-AAC. Prefer the average, with headroom.
    const kbps = (f: any): number => (f.average_bitrate ?? f.bitrate ?? 0) / 1000;
    const capped = candidates.filter((f) => kbps(f) <= maxKbps * 1.1);
    if (capped.length) candidates = capped;
  }
  // Downloads ask for mp4Only: an AAC `.m4a` is the most portable file across
  // devices and players. If a track somehow has no mp4 rendition, we still
  // download the best available rather than failing — the caller names the
  // file from the returned mime.
  if (!pinned && mp4Only) {
    const mp4s = candidates.filter((f) => String(f.mime_type ?? "").includes("mp4"));
    if (mp4s.length) candidates = mp4s;
  }
  const preferred = candidates[0];
  const url = await formatUrl(preferred, yt);
  if (!url) return null;
  const num = (v: unknown): number | undefined => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : undefined);
  return {
    url,
    mime: String(preferred.mime_type ?? "audio/mp4"),
    lufs: formatLufs(preferred),
    itag: num(preferred.itag),
    clen: num(preferred.content_length),
  };
}

/**
 * How long a resolved googlevideo URL may be reused: until a little before
 * its own `expire` (they live about 6 h), else the old 10 minutes. The margin
 * also covers a fast local clock; a slow one just earns a 403, which the
 * proxy heals by re-resolving.
 */
export function streamTtlMs(url: string, now: number): number {
  const expire = Number(/[?&/]expire[=/](\d{9,11})/.exec(url)?.[1]);
  if (!expire) return 10 * 60_000;
  return Math.min(6 * 3_600_000, Math.max(0, expire * 1000 - now - 5 * 60_000));
}
