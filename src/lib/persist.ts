/** Zustand storage adapter: JSON files via the desktop bridge, localStorage fallback. */
import type { PersistStorage, StateStorage, StorageValue } from "zustand/middleware";

export const storage: StateStorage = {
  getItem: async (name) => {
    const b = typeof window !== "undefined" ? window.bytune : undefined;
    if (b) {
      try {
        const v = await b.readData(name);
        return v == null ? null : JSON.stringify(v);
      } catch {
        /* fall through to localStorage */
      }
    }
    try {
      return localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem: async (name, value) => {
    const b = typeof window !== "undefined" ? window.bytune : undefined;
    if (b) {
      try {
        await b.writeData(name, JSON.parse(value));
        return;
      } catch {
        /* fall through to localStorage */
      }
    }
    try {
      localStorage.setItem(name, value);
    } catch {
      /* ignore */
    }
  },
  removeItem: async (name) => {
    const b = typeof window !== "undefined" ? window.bytune : undefined;
    if (b) {
      try {
        await b.writeData(name, null);
        return;
      } catch {
        /* fall through */
      }
    }
    try {
      localStorage.removeItem(name);
    } catch {
      /* ignore */
    }
  },
};

/**
 * Write-coalescing storage for high-frequency stores (player, library). The
 * audio engine updates `position` on every `timeupdate` (~4Hz) and download
 * progress patches the library several times a second, and zustand persist
 * writes on every state change. This adapter keeps the newest value as an
 * object (no JSON work per change; it crosses IPC by structured clone) and
 * writes a store at most every 2s — every 10s when only the player's
 * `position` moved. A change lands at once when the store's last write is
 * older than that; otherwise when it falls due, so bursty user actions after
 * an idle stretch still persist immediately. Pending values flush on
 * pagehide/beforeunload, the last reliable hooks before the window or the app
 * goes away.
 */
const COALESCED_WRITE_MS = 2_000;
const POSITION_WRITE_MS = 10_000;

type Value = StorageValue<Record<string, unknown>>;

// Shared by stores of different shapes, hence `any`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const coalescedStorage: PersistStorage<any> = (() => {
  const pending = new Map<string, Value>();
  const timers = new Map<string, { at: number; timer: ReturnType<typeof setTimeout> }>();
  const lastWriteAt = new Map<string, number>();
  /** The state each store last wrote (or read at boot), to spot position-only changes. */
  const written = new Map<string, Record<string, unknown>>();
  const bridge = () => (typeof window !== "undefined" ? window.bytune : undefined);

  const write = async (name: string, value: Value | null): Promise<void> => {
    const b = bridge();
    if (b) {
      try {
        await b.writeData(name, value);
        return;
      } catch {
        /* fall through to localStorage */
      }
    }
    try {
      if (value === null) localStorage.removeItem(name);
      else localStorage.setItem(name, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  };

  const flush = (name: string): void => {
    const t = timers.get(name);
    if (t) {
      clearTimeout(t.timer);
      timers.delete(name);
    }
    const value = pending.get(name);
    if (value === undefined) return;
    pending.delete(name);
    lastWriteAt.set(name, Date.now());
    written.set(name, value.state);
    // A store without partialize carries its actions, which can't cross IPC.
    const state = Object.fromEntries(Object.entries(value.state).filter(([, v]) => typeof v !== "function"));
    void write(name, { ...value, state });
  };

  if (typeof window !== "undefined") {
    const flushAll = (): void => {
      for (const name of [...pending.keys()]) flush(name);
    };
    window.addEventListener("pagehide", flushAll);
    window.addEventListener("beforeunload", flushAll);
  }

  return {
    getItem: async (name) => {
      let value: Value | null | undefined;
      const b = bridge();
      if (b) {
        try {
          value = ((await b.readData(name)) as Value | null | undefined) ?? null;
        } catch {
          /* fall through to localStorage */
        }
      }
      if (value === undefined) {
        try {
          const raw = localStorage.getItem(name);
          value = raw == null ? null : (JSON.parse(raw) as Value);
        } catch {
          value = null;
        }
      }
      if (value?.state) {
        // As if just written: the boot's own `position: 0` must not overwrite the saved resume point.
        written.set(name, value.state);
        lastWriteAt.set(name, Date.now());
      }
      return value;
    },
    setItem: (name, value) => {
      pending.set(name, value);
      const prev = written.get(name);
      const slow = !!prev && Object.keys(value.state).every((k) => k === "position" || value.state[k] === prev[k]);
      const now = Date.now();
      const due = (lastWriteAt.get(name) ?? 0) + (slow ? POSITION_WRITE_MS : COALESCED_WRITE_MS);
      if (due <= now) flush(name);
      else {
        // Keep the earliest due time: a real change pulls a pending position-only write forward.
        const t = timers.get(name);
        if (!t || t.at > due) {
          if (t) clearTimeout(t.timer);
          timers.set(name, { at: due, timer: setTimeout(() => flush(name), due - now) });
        }
      }
    },
    removeItem: (name) => {
      // A removal must not be resurrected by a pending write.
      pending.delete(name);
      written.delete(name);
      const t = timers.get(name);
      if (t) {
        clearTimeout(t.timer);
        timers.delete(name);
      }
      return write(name, null);
    },
  };
})();
