/*
 * Ends ByTune's launch intro (index.html's #intro, drawn by src/intro.css). After Arkemis Cut's, which
 * follows ZCode's startup loader (packages/desktop/src/renderer/index.html), © ZCode, licensed under the
 * Apache License, Version 2.0: http://www.apache.org/licenses/LICENSE-2.0
 * Once the intro has played and the app is ready (App sends "bytune-startup-ready"), the app shows under
 * it and the logo glides into the app's own (the top bar's, or onboarding's); with nowhere to land, or
 * with reduced motion, the intro fades out. Then the window's glass goes (main.ts setGlass). Changed from
 * ZCode's: it waits for the app as theirs does, and for the logo to finish; it lands the logo rather than
 * cross-fading.
 */

const GLIDE: KeyframeAnimationOptions = { duration: 700, easing: "cubic-bezier(0.65, 0, 0.35, 1)", fill: "forwards" };
// The intro's mark is the logo's 1994 units tall at 0.231542 of its 600-unit viewBox (index.html); the
// app's <img> is the logo's own box.
const MARK_SPAN = (0.231542 * 1994) / 600;

// For reviewing the intro: `VITE_INTRO_LOOP=1 npm run dev` replays it, hand-over included, until the window closes.
const LOOP = !!import.meta.env.VITE_INTRO_LOOP;

declare global {
  interface Window {
    /** public/intro.js: draws the mark's light show on an intro's canvas in a worker; stop() ends that worker. */
    bytuneIntroLight?: ((canvas: Element | null) => void) & { stop(): void };
  }
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Point = { x: number; y: number };
const centre = (r: DOMRect): Point => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });

/** A transform (origin: the box's top-left) that scales `box` by k and carries its point `from` onto `to`. */
export const flight = (box: { left: number; top: number }, from: Point, to: Point, k: number): string =>
  `translate(${to.x - box.left - k * (from.x - box.left)}px, ${to.y - box.top - k * (from.y - box.top)}px) scale(${k})`;

/** Call before the app renders: its ready signal comes once. */
export function endIntro(): void {
  const intro = document.getElementById("intro");
  if (!intro) return;
  // The miniplayer's window: public/intro.js left the intro off there.
  if (!document.documentElement.classList.contains("intro")) {
    intro.remove();
    return;
  }
  // Resolves with the app's own Reduce animation; never held on the intro, ready or not.
  const ready = Promise.race([
    new Promise<boolean>((r) =>
      window.addEventListener("bytune-startup-ready", (e) => r(!!(e as CustomEvent<{ reduceMotion?: boolean }>).detail?.reduceMotion), {
        once: true,
      }),
    ),
    wait(6000).then(() => false),
  ]);
  void play(intro, ready);
}

async function play(intro: HTMLElement, ready: Promise<boolean>): Promise<void> {
  const html = document.documentElement;
  // A fresh copy starts its CSS animations from zero when it goes back in.
  const replay = LOOP && (intro.cloneNode(true) as HTMLElement);
  const all = intro.getAnimations({ subtree: true });
  const played = all.filter((a) => a.effect?.getTiming().iterations !== Infinity);
  // A hidden window never runs its animations, so a timer makes sure the app still appears.
  const done = Promise.race([Promise.allSettled(played.map((a) => a.finished)), wait(4000)]);
  const reduce = (await ready) || matchMedia("(prefers-reduced-motion: reduce)").matches;
  // With Reduce animation on, the app shows as soon as it's ready.
  if (!reduce) await done;
  for (const a of all) if (!played.includes(a)) a.cancel();
  html.classList.remove("intro-wait");
  await Promise.race([handOver(intro, reduce).catch(() => undefined), wait(1500)]);
  document.querySelector<HTMLElement>("[data-intro-target]")?.style.removeProperty("visibility");
  intro.remove();
  html.classList.remove("intro", "intro-lit");
  window.bytuneIntroLight?.stop();
  // Reviewing it in a loop keeps the window's glass for every replay.
  if (!replay) {
    window.bytune?.introDone?.();
    return;
  }
  await wait(1000);
  html.classList.add("intro", "intro-wait");
  document.body.append(replay);
  window.bytuneIntroLight?.(replay.querySelector(".intro-light"));
  void play(replay, Promise.resolve(false));
}

async function handOver(intro: HTMLElement, reduce: boolean): Promise<void> {
  const target = document.querySelector<HTMLElement>("[data-intro-target]");
  const toMark = target?.querySelector("img");
  const toWord = target?.lastElementChild;
  const tile = intro.querySelector<HTMLElement>(".intro-tile");
  const word = intro.querySelector<SVGSVGElement>(".intro-word svg");
  if (reduce || !target?.checkVisibility() || !toMark || !toWord || !tile || !word) {
    await intro.animate({ opacity: [1, 0] }, 160).finished;
    return;
  }
  const t = tile.getBoundingClientRect();
  const to = toMark.getBoundingClientRect();
  const w = word.getBoundingClientRect();
  const tw = toWord.getBoundingClientRect();

  // Only the flying logo shows until it lands on the app's own. Visibility, as onboarding's fade-in holds its opacity.
  target.style.visibility = "hidden";
  tile.style.transformOrigin = word.style.transformOrigin = "0 0";
  const glide = tile.animate({ transform: ["none", flight(t, centre(t), centre(to), to.height / (t.height * MARK_SPAN))] }, GLIDE);
  word.animate({ transform: ["none", flight(w, { x: w.left, y: w.top + w.height / 2 }, { x: tw.left, y: tw.top + tw.height / 2 }, tw.height / w.height)] }, GLIDE);
  tile.animate({ opacity: [1, 0] }, { pseudoElement: "::before", duration: 300, easing: "ease-out", fill: "forwards" });
  intro.animate({ backgroundColor: [getComputedStyle(intro).backgroundColor, "transparent"] }, { duration: 500, easing: "ease-in-out", fill: "forwards" });
  await glide.finished;
  target.style.removeProperty("visibility");
  await intro.animate({ opacity: [1, 0] }, 150).finished;
}
