/**
 * Which layout the miniplayer draws at a window size (PipApp). From BAR_MAX_H up, the square one: the
 * cover card with the title under it, at every size the miniplayer has always had. Shorter, the one-row
 * bar (PR #10, by bevinkatti): the cover at the left as tall as the row allows, the title and artist,
 * then as many buttons as fit, the most needed first. Pure, so it is unit-tested.
 */

/** Below this window height the square layout's cover and title no longer fit. */
export const BAR_MAX_H = 175;

/** The bar's buttons, most needed first: when room runs out, the rest are left off. */
export const BAR_BUTTONS = ["play", "next", "like", "prev", "volume", "shuffle", "repeat"] as const;
export type BarButton = (typeof BAR_BUTTONS)[number];

export type PipLayout = { mode: "square" } | { mode: "bar"; cover: number; buttons: BarButton[] };

const EDGE = 8; // window edge to the cover, and to the last button
const GAP = 10; // cover to title, title to buttons
const TITLE_MIN = 80; // the title's least width (FitText slides a longer name)
const PLAY_W = 36; // the round play button and its margin
const BUTTON_W = 28; // any other button
const ROW_SPARE = 17; // the 3 px seek strip along the bottom, and 7 px above and below the cover

export function pipLayout(w: number, h: number): PipLayout {
  if (h >= BAR_MAX_H) return { mode: "square" };
  // As tall as the row allows, but never more than a quarter of the width.
  const cover = Math.round(Math.max(32, Math.min(h - ROW_SPARE, w / 4)));
  let room = w - 2 * EDGE - cover - 2 * GAP - TITLE_MIN - PLAY_W;
  const buttons: BarButton[] = ["play"];
  for (const b of BAR_BUTTONS.slice(1)) {
    if (room < BUTTON_W) break;
    buttons.push(b);
    room -= BUTTON_W;
  }
  return { mode: "bar", cover, buttons };
}
