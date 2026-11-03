/**
 * Two-finger trackpad swipes walk the view history, as in Chrome: a sideways
 * swipe that nothing under the pointer can scroll any further goes back
 * (fingers moving right) or forward (fingers moving left), one step per
 * gesture.
 */

/** Sideways travel, in px, that takes a step. */
export const SWIPE_NAV_PX = 150;
/** A pause this long ends a gesture, its momentum included. */
export const SWIPE_GAP_MS = 300;
/** Travel, in px, after which a gesture's axis is decided. */
const AXIS_PX = 8;

export type SwipeStep = "back" | "forward";

interface WheelLike {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  timeStamp: number;
}

/**
 * Feed it every wheel event; it answers the step to take, at most once per
 * gesture. `scrolls(dx)` says whether something under the pointer would
 * scroll sideways by `dx`: a gesture that does belongs to that scroller for
 * the rest of it, as Chrome latches it, and never navigates.
 */
export function createSwipeNav(): (e: WheelLike, scrolls: (dx: number) => boolean) => SwipeStep | null {
  let last = -Infinity;
  let x = 0;
  let y = 0;
  let sideways = false;
  let spent = false; // scrolled something, went vertical, or already stepped
  return (e, scrolls) => {
    if (e.ctrlKey) return null; // a pinch zoom
    if (e.timeStamp - last > SWIPE_GAP_MS) {
      x = y = 0;
      sideways = spent = false;
    }
    last = e.timeStamp;
    if (spent) return null;
    const line = e.deltaMode === 1 ? 16 : 1;
    const dx = e.deltaX * line;
    if (dx !== 0 && scrolls(dx)) {
      spent = true;
      return null;
    }
    x += dx;
    y += e.deltaY * line;
    if (!sideways) {
      if (Math.abs(x) + Math.abs(y) < AXIS_PX) return null;
      sideways = Math.abs(x) > Math.abs(y) * 1.5;
      if (!sideways) {
        spent = true;
        return null;
      }
    }
    if (Math.abs(x) < SWIPE_NAV_PX) return null;
    spent = true;
    return x < 0 ? "back" : "forward";
  };
}

/** Whether `target` or an ancestor can still scroll sideways by `dx`. */
export function scrollsSideways(target: EventTarget | null, dx: number): boolean {
  for (let el = target instanceof Element ? target : null; el; el = el.parentElement) {
    if (el.scrollWidth <= el.clientWidth + 1) continue;
    const overflow = getComputedStyle(el).overflowX;
    if (overflow !== "auto" && overflow !== "scroll") continue;
    if (dx < 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1) return true;
  }
  return false;
}
