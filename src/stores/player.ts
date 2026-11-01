/** Player state — pure data; playback side effects live in lib/audio.ts. */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
// Coalescing storage: the engine bumps `position` ~4Hz and persist writes on
// every change — raw writes would hit disk/IPC several times a second.
import { coalescedStorage } from "../lib/persist";
import type { Track } from "../types";
import { useSettings } from "./settings";

export type RepeatMode = "off" | "all" | "one";

/** Played songs kept ahead of the current one: AutoPlay never ends, so the
    queue would otherwise grow without bound (and is persisted every 2s). */
const HISTORY_KEEP = 100;

/** A bare YouTube video id — the only kind of track YouTube Music has a radio for. */
export function isRadioSeed(id: string | undefined): boolean {
  return !!id && /^[A-Za-z0-9_-]{11}$/.test(id);
}

/**
 * How many upcoming queue entries are AutoPlay suggestions. They are always
 * the queue's tail, after the listener's own songs; the stored count is
 * clamped here because the index can move into the tail (the crossfade writes
 * it directly), and a song that is playing is no longer upcoming.
 */
export function autoplayTail(s: { queue: Track[]; index: number; autoplayCount: number }): number {
  return Math.max(0, Math.min(s.autoplayCount, s.queue.length - s.index - 1));
}

/** Songs shuffle has already played in this listening context (not persisted). */
const shuffleSeen = new Set<string>();

/** The queue ran out: AutoPlay continues it when it is on, nothing repeats,
    and the newest song has a YouTube radio (local files have none). */
function autoplayContinues(queue: Track[], repeat: RepeatMode): boolean {
  const last = queue[queue.length - 1];
  return useSettings.getState().autoplay && repeat === "off" && isRadioSeed(last?.id) && !last?.episode;
}

interface PlayerState {
  queue: Track[];
  index: number;
  playing: boolean;
  buffering: boolean;
  position: number;
  duration: number;
  /** 0..1 — how much of the current track the audio element has buffered */
  buffered: number;
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  /** bumped whenever the engine should hard-seek to `position` */
  seekNonce: number;
  error: string | null;
  /** AutoPlay suggestions at the end of the queue — read via autoplayTail(). */
  autoplayCount: number;
  /** The queue ran out and AutoPlay is fetching what plays next (not persisted). */
  awaitingAutoplay: boolean;
  /** Bumped when a new listening context starts, so AutoPlay reseeds (not persisted). */
  contextId: number;

  current(): Track | null;
  playQueue(tracks: Track[], startIndex?: number): void;
  playTrack(track: Track): void;
  /** Play an entry already in the queue without rebuilding it. */
  jumpTo(i: number): void;
  /** Returns how many songs were added (0 when they were all already waiting). */
  addToQueue(tracks: Track | Track[], playNext?: boolean): number;
  /**
   * Drag-reorder among the upcoming songs: the song at `from` lands at queue
   * index `to`, kept on its own side — your songs among your songs, AutoPlay's
   * suggestions among the suggestions.
   */
  moveUpcoming(from: number, to: number): void;
  removeAt(i: number): void;
  clearUpcoming(): void;
  /** Append AutoPlay suggestions; starts the first one if the queue had run out. */
  appendAutoplay(tracks: Track[]): void;
  /** Remove the upcoming AutoPlay suggestions. */
  dropAutoplay(): void;
  /** AutoPlay found nothing to continue with: stop where the queue ended. */
  stopAwaiting(): void;
  next(manual?: boolean): void;
  prev(): void;
  toggle(): void;
  setPlaying(playing: boolean): void;
  seek(sec: number): void;
  setVolume(v: number): void;
  toggleMute(): void;
  toggleShuffle(): void;
  cycleRepeat(): void;

  /* internal setters used by the audio engine */
  _setTime(position: number, duration?: number): void;
  _setBuffered(ratio: number): void;
  _setBuffering(buffering: boolean): void;
  _setError(error: string | null): void;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export const usePlayer = create<PlayerState>()(
  persist(
    (set, get) => ({
      queue: [],
      index: 0,
      playing: false,
      buffering: false,
      position: 0,
      duration: 0,
      buffered: 0,
      volume: 0.8,
      muted: false,
      shuffle: false,
      repeat: "off",
      seekNonce: 0,
      error: null,
      autoplayCount: 0,
      awaitingAutoplay: false,
      contextId: 0,

      current() {
        const { queue, index } = get();
        return queue[index] ?? null;
      },

      playQueue(tracks, startIndex = 0) {
        if (!tracks.length) return;
        shuffleSeen.clear();
        set({
          queue: tracks,
          index: clamp(startIndex, 0, tracks.length - 1),
          playing: true,
          position: 0,
          error: null,
          autoplayCount: 0,
          awaitingAutoplay: false,
          contextId: get().contextId + 1,
        });
      },

      playTrack(track) {
        const { queue, index } = get();
        // Ahead of the current song only: an earlier copy is history, and
        // jumping back to it would replay everything after it.
        const at = queue.findIndex((t, i) => i >= index && t.id === track.id);
        if (queue.length && at >= 0) {
          set({ index: at, playing: true, position: 0, error: null, awaitingAutoplay: false });
          return;
        }
        // A song picked to play now starts its own AutoPlay radio, so the
        // old suggestions go. (An empty queue used to land on index 1 of a
        // one-song queue — nothing played.)
        const own = queue.slice(0, queue.length - autoplayTail(get()));
        const at2 = own.length ? index + 1 : 0;
        shuffleSeen.clear();
        set({
          queue: [...own.slice(0, at2), track, ...own.slice(at2)],
          index: at2,
          playing: true,
          position: 0,
          error: null,
          autoplayCount: 0,
          awaitingAutoplay: false,
          contextId: get().contextId + 1,
        });
      },

      jumpTo(i) {
        if (i < 0 || i >= get().queue.length) return;
        set({ index: i, playing: true, position: 0, error: null, awaitingAutoplay: false });
      },

      addToQueue(tracks, playNext = false) {
        const seenIn = new Set<string>();
        const list = (Array.isArray(tracks) ? tracks : [tracks]).filter((t) => !seenIn.has(t.id) && seenIn.add(t.id));
        if (!list.length) return 0;
        const { queue, index, awaitingAutoplay } = get();
        if (!queue.length) {
          set({ queue: list, index: 0, playing: false, position: 0, autoplayCount: 0 });
          return list.length;
        }
        // The listener's songs always go before the AutoPlay suggestions. The
        // count is rebased here: once a suggestion has played, the stored
        // count is larger than what is left, and the added songs would
        // otherwise be counted as suggestions (and dropped with them).
        let tail = autoplayTail(get());
        // A song waits in the queue once. Already among your upcoming songs:
        // "Play next" moves it up, "Add to queue" leaves it. Suggested by
        // AutoPlay: it becomes yours (taken out of the suggestions).
        const ownUpcoming = new Set(queue.slice(index + 1, queue.length - tail).map((t) => t.id));
        const add = playNext ? list : list.filter((t) => !ownUpcoming.has(t.id));
        if (!add.length) return 0;
        const addIds = new Set(add.map((t) => t.id));
        const firstSuggestion = queue.length - tail;
        let adopted = 0;
        const q = queue.filter((t, j) => {
          if (j <= index || !addIds.has(t.id)) return true;
          if (j >= firstSuggestion) {
            adopted++;
            return false;
          }
          return false; // your upcoming copy, moving up with Play next
        });
        tail -= adopted;
        const at = playNext ? index + 1 : q.length - tail;
        set({ queue: [...q.slice(0, at), ...add, ...q.slice(at)], autoplayCount: tail });
        // Added while AutoPlay was fetching after the queue ran out: play it now.
        if (awaitingAutoplay) set({ index: at, playing: true, position: 0, error: null, awaitingAutoplay: false });
        return add.length;
      },

      moveUpcoming(from, to) {
        const s = get();
        const tail = autoplayTail(s);
        const firstSuggestion = s.queue.length - tail;
        if (from <= s.index || from >= s.queue.length) return;
        const [lo, hi] = from < firstSuggestion ? [s.index + 1, firstSuggestion - 1] : [firstSuggestion, s.queue.length - 1];
        const at = Math.min(Math.max(to, lo), hi);
        if (at === from) return;
        const q = [...s.queue];
        q.splice(at, 0, ...q.splice(from, 1));
        set({ queue: q, autoplayCount: tail });
      },

      removeAt(i) {
        const s = get();
        const { queue, index } = s;
        if (i < 0 || i >= queue.length) return;
        const tail = autoplayTail(s);
        const q = queue.filter((_, j) => j !== i);
        let ni = index;
        if (i < index) ni = index - 1;
        else if (i === index) ni = Math.min(index, Math.max(q.length - 1, 0));
        set({
          queue: q,
          index: ni,
          autoplayCount: i >= queue.length - tail ? tail - 1 : tail,
          // The ended song AutoPlay was waiting after is gone: stop waiting.
          ...(i === index && s.awaitingAutoplay ? { awaitingAutoplay: false, playing: false } : {}),
        });
      },

      clearUpcoming() {
        // Clears the listener's own upcoming songs; the AutoPlay tail stays.
        const s = get();
        const tail = autoplayTail(s);
        set({ queue: [...s.queue.slice(0, s.index + 1), ...s.queue.slice(s.queue.length - tail)], autoplayCount: tail });
      },

      appendAutoplay(incoming) {
        const s = get();
        // Never a song that is playing or already waiting in the queue.
        const present = new Set(s.queue.slice(s.index).map((t) => t.id));
        const tracks = incoming.filter((t) => !present.has(t.id) && present.add(t.id));
        if (!tracks.length) return;
        const tail = autoplayTail(s);
        const cut = Math.max(0, s.index - HISTORY_KEEP);
        const queue = [...s.queue.slice(cut), ...tracks];
        const index = s.index - cut;
        // Only queue/index/count change: writing `position` here would make
        // the engine rewind the song that is playing.
        if (s.awaitingAutoplay) {
          set({
            queue,
            // The first new song: with shuffle the one playing may sit anywhere, not at the end.
            index: queue.length - tracks.length,
            autoplayCount: tail + tracks.length,
            playing: true,
            position: 0,
            error: null,
            awaitingAutoplay: false,
          });
          return;
        }
        set({ queue, index, autoplayCount: tail + tracks.length });
      },

      dropAutoplay() {
        const s = get();
        const tail = autoplayTail(s);
        if (!tail && !s.autoplayCount && !s.awaitingAutoplay) return;
        set({
          queue: s.queue.slice(0, s.queue.length - tail),
          autoplayCount: 0,
          awaitingAutoplay: false,
          // Cancelling a wait leaves the queue ended: nothing is playing.
          ...(s.awaitingAutoplay ? { playing: false } : {}),
        });
      },

      stopAwaiting() {
        if (get().awaitingAutoplay) set({ awaitingAutoplay: false, playing: false });
      },

      next(manual = false) {
        const s = get();
        const { queue, index, shuffle, repeat } = s;
        if (!queue.length) {
          set({ playing: false });
          return;
        }
        const tail = autoplayTail(s);
        let ni: number;
        if (shuffle && queue.length > 1 && autoplayContinues(queue, repeat)) {
          // With AutoPlay, shuffle plays each of the listener's songs once,
          // then carries on into the suggestions in order.
          shuffleSeen.add(queue[index].id);
          const userEnd = queue.length - tail;
          const fresh: number[] = [];
          for (let i = 0; i < userEnd; i++) if (!shuffleSeen.has(queue[i].id)) fresh.push(i);
          ni = fresh.length ? fresh[Math.floor(Math.random() * fresh.length)] : userEnd;
        } else if (shuffle && queue.length > 1) {
          do {
            ni = Math.floor(Math.random() * queue.length);
          } while (ni === index);
        } else {
          ni = index + 1;
        }
        if (ni >= queue.length) {
          if (repeat === "all") {
            ni = 0;
          } else if (autoplayContinues(queue, repeat)) {
            // Wait for AutoPlay (lib/autoplay) rather than stopping, or
            // wrapping back to a song from long ago.
            set({ awaitingAutoplay: true });
            return;
          } else if (manual) {
            ni = 0;
          } else {
            set({ playing: false, position: 0 });
            return;
          }
        }
        set({ index: ni, playing: true, position: 0, error: null, awaitingAutoplay: false });
      },

      prev() {
        if (get().position > 3) {
          set({ position: 0, seekNonce: get().seekNonce + 1 });
          return;
        }
        const s = get();
        const { queue, index } = s;
        if (!queue.length) return;
        // Wrapping from the first song lands on the listener's last song,
        // never on an AutoPlay suggestion.
        const ni = index > 0 ? index - 1 : Math.max(0, queue.length - autoplayTail(s) - 1);
        set({ index: ni, playing: true, position: 0, error: null, awaitingAutoplay: false });
      },

      toggle() {
        // Nothing to play or pause: flipping `playing` against an empty queue
        // left the play button reading "Pause" with no audio behind it.
        if (!get().queue.length) return;
        // Pausing while AutoPlay fetches cancels the wait, so a late batch
        // can't start playing over the pause.
        const playing = !get().playing;
        set(playing ? { playing } : { playing, awaitingAutoplay: false });
      },

      setPlaying(playing) {
        // Mirrors toggle(): a media-key "play" with an empty queue (e.g.
        // after removing every queued track) must not flip the store into a
        // playing state nothing can back.
        if (playing && !get().queue.length) return;
        set(playing ? { playing } : { playing, awaitingAutoplay: false });
      },

      seek(sec) {
        const { duration } = get();
        set({
          position: clamp(sec, 0, duration > 0 ? duration : sec),
          seekNonce: get().seekNonce + 1,
        });
      },

      setVolume(v) {
        set({ volume: clamp(v, 0, 1), muted: false });
      },

      toggleMute() {
        set({ muted: !get().muted });
      },

      toggleShuffle() {
        shuffleSeen.clear();
        set({ shuffle: !get().shuffle });
      },

      cycleRepeat() {
        const order: RepeatMode[] = ["off", "all", "one"];
        set({ repeat: order[(order.indexOf(get().repeat) + 1) % order.length] });
      },

      _setTime(position, duration) {
        const d = Number.isFinite(duration) && (duration ?? 0) > 0 ? (duration as number) : get().duration;
        set({ position, duration: d });
      },

      _setBuffered(buffered) {
        if (Math.abs(get().buffered - buffered) > 0.005) set({ buffered });
      },

      _setBuffering(buffering) {
        set({ buffering });
      },

      _setError(error) {
        set({ error });
      },
    }),
    {
      name: "player",
      storage: createJSONStorage(() => coalescedStorage),
      partialize: (s) =>
        ({
          queue: s.queue,
          index: s.index,
          position: s.position,
          volume: s.volume,
          muted: s.muted,
          shuffle: s.shuffle,
          repeat: s.repeat,
          autoplayCount: s.autoplayCount,
        }) as unknown as PlayerState,
    }
  )
);

/** How a song is doing right now — "playing", "paused" (current but paused) or
 *  null — so every list can mark the song that's on. */
export function useTrackPlayback(id: string): "playing" | "paused" | null {
  return usePlayer((s) => (s.queue[s.index]?.id === id ? (s.playing ? "playing" : "paused") : null));
}
