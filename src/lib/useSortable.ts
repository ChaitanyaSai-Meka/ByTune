/**
 * Drag-to-reorder for a vertical list, by grabbing a row anywhere: the row
 * lifts and follows the pointer while the others slide out of its way, the
 * list scrolls when the pointer nears its edge, and on release the row glides
 * into its slot before the new order is committed (back home on Escape).
 * Alt+↑/↓ on a focused row moves it one step. Entries are the direct children
 * of `listRef`; a press on a button inside a row never starts a drag.
 */
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";

interface Drag {
  from: number;
  target: number;
  /** layout at grab time, relative to the list's top */
  tops: number[];
  heights: number[];
  gap: number;
  /** the list as it was at grab time — a different list at commit time skips the commit */
  signature: string;
  /** gliding into place after release: the final offset */
  settleTo: number | null;
}

export interface SortableRowProps {
  onPointerDown: (e: PointerEvent<HTMLElement>) => void;
  onPointerMove: (e: PointerEvent<HTMLElement>) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onClickCapture: (e: MouseEvent<HTMLElement>) => void;
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
}

const SETTLE_MS = 180;
const EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
const START_PX = 5;
const EDGE_PX = 48;
/** Where the dragged row's top sits, relative to the list, once it takes list slot `t`. */
const slotTop = (d: Drag, t: number): number => (t > d.from ? d.tops[t] + d.heights[t] - d.heights[d.from] : d.tops[t]);
const reduced = (): boolean =>
  document.documentElement.classList.contains("reduce-motion") ||
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function useSortable(opts: {
  /** changes whenever the entries change — a change mid-drag drops the drag */
  signature: string;
  listRef: RefObject<HTMLElement | null>;
  scrollRef: RefObject<HTMLElement | null>;
  /** where a row may land (e.g. your songs stay above the AutoPlay line) */
  clamp: (from: number, target: number) => number;
  canDrag: (index: number) => boolean;
  onCommit: (from: number, target: number) => void;
}): {
  styleFor: (index: number) => CSSProperties | undefined;
  rowProps: (index: number) => SortableRowProps;
} {
  const [drag, setDrag] = useState<Drag | null>(null);
  const live = useRef<Drag | null>(null);
  const press = useRef<{ i: number; x: number; y: number; el: HTMLElement } | null>(null);
  const pointer = useRef({ startY: 0, startScroll: 0, y: 0 });
  const row = useRef<HTMLElement | null>(null);
  const raf = useRef(0);
  const suppressClick = useRef(false);
  const o = useRef(opts);
  o.current = opts;

  const put = (d: Drag | null): void => {
    live.current = d;
    setDrag(d);
  };
  const end = (): void => {
    window.cancelAnimationFrame(raf.current);
    if (row.current) row.current.style.transform = "";
    row.current = null;
    put(null);
  };

  // The list changed under the pointer (a suggestion arrived, the song moved on).
  useEffect(() => {
    if (live.current && live.current.settleTo === null) end();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.signature]);
  useEffect(() => () => window.cancelAnimationFrame(raf.current), []);

  /** Glide the row into list slot `target` (its own slot cancels), then commit. */
  const settle = (target: number): void => {
    const d = live.current;
    if (!d || d.settleTo !== null) return;
    window.cancelAnimationFrame(raf.current);
    put({ ...d, target, settleTo: slotTop(d, target) - d.tops[d.from] });
    window.setTimeout(
      () =>
        // One render for the new order and the cleared offsets, so nothing flickers.
        flushSync(() => {
          // Same list rows, so the commit lands what the listener saw.
          if (target !== d.from && o.current.signature === d.signature) o.current.onCommit(d.from, target);
          end();
        }),
      reduced() ? 0 : SETTLE_MS,
    );
  };

  const active = drag !== null && drag.settleTo === null;
  useEffect(() => {
    if (!active) return;
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      // Before the app's own Escape, which would close the queue.
      e.preventDefault();
      e.stopImmediatePropagation();
      if (live.current) settle(live.current.from);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // The dragged row moves outside React (every pointer move would otherwise
  // re-render the whole list); React only hears when the target slot changes.
  const update = (): void => {
    const d = live.current;
    if (!d || d.settleTo !== null) return;
    const scroll = o.current.scrollRef.current;
    const offset = pointer.current.y - pointer.current.startY + (scroll?.scrollTop ?? 0) - pointer.current.startScroll;
    // On screen the row stops at the edges of where it may land; the slot still follows the pointer.
    const lo = slotTop(d, o.current.clamp(d.from, 0)) - d.tops[d.from];
    const hi = slotTop(d, o.current.clamp(d.from, d.tops.length - 1)) - d.tops[d.from];
    if (row.current) row.current.style.transform = `translateY(${Math.min(Math.max(offset, lo), hi)}px) scale(1.02)`;
    const center = d.tops[d.from] + d.heights[d.from] / 2 + offset;
    let target = 0;
    for (let j = 0; j < d.tops.length; j++) if (j !== d.from && d.tops[j] + d.heights[j] / 2 < center) target++;
    target = o.current.clamp(d.from, target);
    if (target !== d.target) put({ ...d, target });
  };

  const autoScroll = (): void => {
    const scroll = o.current.scrollRef.current;
    if (!scroll || !live.current || live.current.settleTo !== null) return;
    const r = scroll.getBoundingClientRect();
    const y = pointer.current.y;
    const over = y < r.top + EDGE_PX ? y - r.top - EDGE_PX : y > r.bottom - EDGE_PX ? y - r.bottom + EDGE_PX : 0;
    if (over) {
      const before = scroll.scrollTop;
      scroll.scrollTop += Math.sign(over) * Math.min(18, Math.max(1, Math.round(Math.abs(over) / 3)));
      if (scroll.scrollTop !== before) update();
    }
    raf.current = window.requestAnimationFrame(autoScroll);
  };

  const begin = (p: { i: number; y: number; el: HTMLElement }): void => {
    const list = o.current.listRef.current;
    if (!list) return;
    const base = list.getBoundingClientRect().top;
    const rects = [...list.children].map((c) => c.getBoundingClientRect());
    row.current = p.el;
    suppressClick.current = true; // the release is not a click on the row
    pointer.current = { startY: p.y, startScroll: o.current.scrollRef.current?.scrollTop ?? 0, y: p.y };
    put({
      from: p.i,
      target: p.i,
      tops: rects.map((r) => r.top - base),
      heights: rects.map((r) => r.height),
      gap: rects.length > 1 ? Math.max(0, rects[1].top - rects[0].bottom) : 0,
      signature: o.current.signature,
      settleTo: null,
    });
    raf.current = window.requestAnimationFrame(autoScroll);
  };

  const still = drag ? reduced() : false;
  const styleFor = (i: number): CSSProperties | undefined => {
    const d = drag;
    if (!d) return undefined;
    if (i === d.from) {
      const settling = d.settleTo !== null;
      return {
        position: "relative",
        zIndex: 20,
        cursor: "grabbing",
        background: settling ? "rgb(var(--elevated) / 0)" : "rgb(var(--elevated))",
        boxShadow: settling ? "0 0 0 rgba(0, 0, 0, 0)" : "0 10px 28px rgba(0, 0, 0, 0.5)",
        transition:
          settling && !still
            ? `transform ${SETTLE_MS}ms ${EASE}, box-shadow ${SETTLE_MS}ms ${EASE}, background-color ${SETTLE_MS}ms ${EASE}`
            : "none",
        ...(settling ? { transform: `translateY(${d.settleTo}px)` } : null),
      };
    }
    const span = d.heights[d.from] + d.gap;
    const shift =
      d.from < d.target && i > d.from && i <= d.target ? -span : d.target < d.from && i >= d.target && i < d.from ? span : 0;
    return {
      transform: shift ? `translateY(${shift}px)` : undefined,
      transition: still ? "none" : `transform ${SETTLE_MS}ms ${EASE}`,
    };
  };

  const rowProps = (i: number): SortableRowProps => ({
    onPointerDown: (e) => {
      suppressClick.current = false;
      if (e.button !== 0 || live.current || !o.current.canDrag(i)) return;
      if ((e.target as HTMLElement).closest("button, a, input")) return; // the row's own buttons stay buttons
      e.currentTarget.setPointerCapture(e.pointerId);
      press.current = { i, x: e.clientX, y: e.clientY, el: e.currentTarget };
    },
    onPointerMove: (e) => {
      const p = press.current;
      if (!p) return;
      if (!live.current) {
        if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < START_PX) return;
        begin(p);
      }
      pointer.current.y = e.clientY;
      update();
    },
    onPointerUp: () => {
      press.current = null;
      if (live.current) settle(live.current.target);
    },
    onPointerCancel: () => {
      press.current = null;
      if (live.current) settle(live.current.from);
    },
    onClickCapture: (e) => {
      if (!suppressClick.current) return;
      suppressClick.current = false;
      e.stopPropagation();
      e.preventDefault();
    },
    onKeyDown: (e) => {
      if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown") || live.current) return;
      e.preventDefault();
      e.stopPropagation(); // not the player's own arrow shortcuts, even when the row can't move
      const target = o.current.clamp(i, i + (e.key === "ArrowUp" ? -1 : 1));
      const list = o.current.listRef.current;
      if (!list || !o.current.canDrag(i) || target === i || target < 0 || target >= list.children.length) return;
      o.current.onCommit(i, target);
      // The row's DOM node moved, which drops focus: put it back on the moved row.
      window.requestAnimationFrame(() => (list.children[target] as HTMLElement | undefined)?.focus());
    },
  });

  return { styleFor, rowProps };
}
