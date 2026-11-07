/**
 * The Home wash follows the card under the mouse (src/stores/ui tintHoverHandlers). Crossing the gap
 * between two cards mustn't flash the playing song's colour in between; leaving the cards brings it back.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const mod = build({
  stdin: { contents: `export { useUI, tintHoverHandlers } from "./src/stores/ui";`, resolveDir: fileURLToPath(new URL("..", import.meta.url)), loader: "ts" },
  bundle: true, format: "esm", platform: "node", write: false, external: ["lucide-react"], logLevel: "silent",
}).then((r) => import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString("base64")}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("moving from one card to the next never shows the playing song's colour in between", async () => {
  const { useUI, tintHoverHandlers } = await mod;
  const seen = [];
  const stop = useUI.subscribe((s, p) => {
    if (s.tintThumb !== p.tintThumb) seen.push(s.tintThumb);
  });
  try {
    const a = tintHoverHandlers("a.jpg");
    const b = tintHoverHandlers("b.jpg");
    a.onMouseEnter();
    a.onMouseLeave();
    await sleep(60); // crossing the gap between the cards
    b.onMouseEnter();
    assert.deepEqual(seen, ["a.jpg", "b.jpg"], "straight from one card's colour to the next");
    b.onMouseLeave();
    await sleep(400);
    assert.equal(useUI.getState().tintThumb, null, "off the cards: the playing song's colour again");
  } finally {
    stop();
  }
});
