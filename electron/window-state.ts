/**
 * The main window reopens the way it was closed: its size, its place, and maximized only if it was (issue #11:
 * Windows always opened maximized). Pure, so it is unit-tested without Electron; main.ts saves and reads the
 * state (persist "window-state") and owns the window. The miniplayer keeps its own spot the same way (pip.ts).
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowState extends Rect {
  maximized: boolean;
}

/** The saved state, or null when there is none or it is damaged: the window then opens as on a first launch. */
export function readWindowState(raw: unknown): WindowState | null {
  if (!raw || typeof raw !== "object") return null;
  const { x, y, width, height, maximized } = raw as Record<string, unknown>;
  const nums = [x, y, width, height];
  if (!nums.every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  const [rx, ry, rw, rh] = (nums as number[]).map(Math.round);
  if (rw <= 0 || rh <= 0) return null;
  return { x: rx, y: ry, width: rw, height: rh, maximized: maximized === true };
}

/** How much of a saved window a display must still show for it to reopen there: the miniplayer's 56 px (pip.ts). */
const MIN_VISIBLE = 56;

/**
 * Where a saved window reopens, given the displays' work areas (the screen minus the taskbar, or the Dock and
 * menu bar): on the display it mostly covers, moved and if need be shrunk to fit inside that work area, so its
 * top bar and the player bar are on screen. Null when no display shows enough of it (its monitor was unplugged,
 * say): the window then opens where a first launch would.
 */
export function placeOnScreen(r: Rect, areas: readonly Rect[]): Rect | null {
  let best: Rect | null = null;
  let bestOverlap = 0;
  for (const a of areas) {
    const w = Math.min(r.x + r.width, a.x + a.width) - Math.max(r.x, a.x);
    const h = Math.min(r.y + r.height, a.y + a.height) - Math.max(r.y, a.y);
    if (w >= MIN_VISIBLE && h >= MIN_VISIBLE && w * h > bestOverlap) {
      best = a;
      bestOverlap = w * h;
    }
  }
  if (!best) return null;
  const width = Math.min(r.width, best.width);
  const height = Math.min(r.height, best.height);
  return {
    x: Math.min(Math.max(r.x, best.x), best.x + best.width - width),
    y: Math.min(Math.max(r.y, best.y), best.y + best.height - height),
    width,
    height,
  };
}
