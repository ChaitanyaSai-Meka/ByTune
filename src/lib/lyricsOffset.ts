/**
 * Lyric alignment offsets — audio-anchored sync for version-mismatched tracks.
 *
 * Synced lyrics are timed to a catalogue recording, but the audio actually
 * playing is a YouTube upload that may prepend (or append to) it — music
 * videos with a scene-setting intro are the classic case. No lyrics provider
 * carries the upload's own timing, so we measure it from the audio itself:
 * when the lyrics' implied song is much shorter than the upload, the track's
 * stream is decoded once and the first sustained music-level energy is taken
 * as the offset between the two timelines. Every lyric lookup then runs on
 * (element position − offset).
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { useSettings } from "../stores/settings";
import { analyseTrack } from "./analysis";
import { storage } from "./persist";

interface LyricsAlignState {
  /** track id → seconds to subtract from the element position for lyrics */
  offsets: Record<string, number>;
  setOffset(id: string, offset: number): void;
}

export const useLyricsAlign = create<LyricsAlignState>((set) => ({
  offsets: {},
  setOffset: (id, offset) =>
    set((s) => (s.offsets[id] === offset ? s : { offsets: { ...s.offsets, [id]: offset } })),
}));

/** Live offset for a track — 0 until (and unless) a mismatch is measured. */
export function getLyricsOffset(id: string | null | undefined): number {
  if (!id) return 0;
  return useLyricsAlign.getState().offsets[id] ?? 0;
}

/* ----------------------------- manual timing ----------------------------- */

/** One press of [ or ]: this much earlier or later. */
export const LYRICS_NUDGE_STEP = 0.25;
const NUDGE_LIMIT_SEC = 10;
/** Songs remembered; the oldest nudge goes first. */
const NUDGE_KEEP = 500;

/** A song's nudge after one more step (0 drops it); the oldest entries go past the cap. */
export function nextNudges(nudges: Record<string, number>, id: string, delta: number): Record<string, number> {
  const value = Math.round(Math.min(NUDGE_LIMIT_SEC, Math.max(-NUDGE_LIMIT_SEC, (nudges[id] ?? 0) + delta)) * 100) / 100;
  const rest = Object.entries(nudges).filter(([key]) => key !== id);
  const kept = value === 0 ? rest : [...rest, [id, value] as [string, number]];
  return Object.fromEntries(kept.slice(-NUDGE_KEEP));
}

/** "0.25 s later", "1 s earlier", or "In sync". Positive = lyrics later. */
export function describeLyricsShift(seconds: number): string {
  if (!seconds) return "In sync";
  return `${Math.round(Math.abs(seconds) * 100) / 100} s ${seconds > 0 ? "later" : "earlier"}`;
}

interface LyricsNudgeState {
  /** track id → seconds this song's lyrics run later (+) or earlier (−) */
  nudges: Record<string, number>;
  nudge(id: string, delta: number): void;
  resetNudge(id: string): void;
}

/** Per-song timing the listener set by hand. Kept on this device only. */
export const useLyricsNudge = create<LyricsNudgeState>()(
  persist(
    (set, get) => ({
      nudges: {},
      nudge: (id, delta) => set({ nudges: nextNudges(get().nudges, id, delta) }),
      resetNudge: (id) => set({ nudges: nextNudges(get().nudges, id, -(get().nudges[id] ?? 0)) }),
    }),
    { name: "lyrics-nudges", storage: createJSONStorage(() => storage) },
  ),
);

/**
 * Seconds to subtract from the element position for lyrics: the measured
 * version offset, this song's nudge and this device's lyrics timing.
 */
export function useLyricsOffset(id: string | null | undefined): number {
  const key = id ?? "";
  const measured = useLyricsAlign((s) => s.offsets[key] ?? 0);
  const nudge = useLyricsNudge((s) => s.nudges[key] ?? 0);
  const device = useSettings((s) => s.lyricsOffset);
  return measured + nudge + device;
}

/** Suspect a version mismatch when the upload runs this far past the lyrics. */
const MISMATCH_THRESHOLD_SEC = 10;
/** Offsets below this are indistinguishable from "song starts immediately". */
const MIN_APPLIED_OFFSET = 2.5;

const pending = new Set<string>();

/**
 * Best-effort: when the played upload is much longer than the synced lyrics'
 * song, decode the stream and anchor the lyrics to where the music actually
 * starts. Skips local files and tracks with no usable duration.
 */
export function requestLyricsAlignment(trackId: string, videoDuration: number, lyricsEnd: number): void {
  if (!trackId || trackId.startsWith("local:")) return;
  if (useLyricsAlign.getState().offsets[trackId] != null) return;
  if (pending.has(trackId)) return;
  if (!(videoDuration > 0 && lyricsEnd > 0) || videoDuration - lyricsEnd < MISMATCH_THRESHOLD_SEC) return;
  pending.add(trackId);
  void (async () => {
    try {
      const onset = (await analyseTrack({ id: trackId, duration: videoDuration }))?.onset;
      if (onset == null) return;
      // Skip-silence may already seek the element past leading silence; the
      // offset lives in element time, so that trim is subtracted out.
      const { getHeadTrim } = await import("./audio");
      const offset = Math.max(0, onset - getHeadTrim(trackId));
      useLyricsAlign.getState().setOffset(trackId, offset >= MIN_APPLIED_OFFSET ? offset : 0);
    } catch {
      /* alignment is best-effort */
    } finally {
      pending.delete(trackId);
    }
  })();
}
