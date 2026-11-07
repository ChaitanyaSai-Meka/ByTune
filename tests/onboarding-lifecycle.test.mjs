import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import React, { act } from "react";

// React DOM detects input-event support when the module is first loaded.
const environment = new JSDOM("<div></div>", { url: "http://localhost" });
globalThis.window = environment.window;
globalThis.document = environment.window.document;
const { createRoot } = await import("react-dom/client");

const require = createRequire(import.meta.url);
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL("../src/views/OnboardingView.tsx", import.meta.url))],
  bundle: true, platform: "node", format: "cjs", write: false,
  external: ["react", "react/jsx-runtime", "lucide-react"],
  loader: { ".svg": "text" },
  plugins: [{ name: "onboarding-seams", setup(b) {
    b.onResolve({ filter: /components\/TopBar$|lib\/session$/ }, a => ({ path: a.path, namespace: "seam" }));
    b.onLoad({ filter: /.*/, namespace: "seam" }, a => ({
      contents: a.path.endsWith("TopBar")
        ? "exports.CaptionButtons = () => null;"
        : "exports.useSession = { getState: () => ({ ...globalThis.__session, refresh: () => globalThis.__refresh() }) };",
      loader: "js",
    }));
  }}],
});
const module = { exports: {} };
new Function("require", "module", "exports", outputFiles[0].text)(require, module, module.exports);
const { Onboarding } = module.exports;

async function mount(initial, api, session = {}) {
  globalThis.__session = session;
  const dom = new JSDOM("<div id='root'></div>", { url: "http://localhost" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.bytune = api;
  let refreshes = 0;
  globalThis.__refresh = async () => { refreshes++; };
  const root = createRoot(document.getElementById("root"));
  await act(async () => root.render(React.createElement(Onboarding, { initial })));
  /** A button's accessible name: what aria-labelledby points at, else its text. */
  const nameOf = b => (b.getAttribute("aria-labelledby") ? document.getElementById(b.getAttribute("aria-labelledby"))?.textContent : b.textContent)?.trim();
  const byName = text => [...document.querySelectorAll("button")].find(b => nameOf(b) === text);
  return {
    button: byName,
    /** What a button's aria-describedby says about it. */
    description: text => document.getElementById(byName(text)?.getAttribute("aria-describedby") ?? "")?.textContent ?? "",
    field: label => document.querySelector(`input[aria-label="${label}"]`),
    /** Types into a field the way React sees typing (its value setter, then an input event). */
    type: async (label, value) => {
      const input = document.querySelector(`input[aria-label="${label}"]`);
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      await act(async () => {
        setter.call(input, value);
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
    },
    click: async text => {
      await act(async () => {
        byName(text).click();
        await new Promise(r => setTimeout(r, 10));
      });
    },
    refreshes: () => refreshes,
    close: async () => { await act(async () => root.unmount()); dom.window.close(); },
  };
}

for (const [initial, label, method] of [
  ["resume", "Continue as guest", "authContinueGuest"],
  ["pickusername", "Skip for now", "authSkipUsername"],
]) {
  test(`${initial}: rejected request shows an error and permits a successful retry`, async () => {
    let calls = 0;
    const events = [];
    const h = await mount(initial, {
      [method]: async () => {
        events.push(`${method}:${++calls}`);
        if (calls === 1) throw new Error("network error");
      },
      syncNow: async () => { events.push("sync"); },
    });
    const refresh = globalThis.__refresh;
    globalThis.__refresh = async () => { events.push("refresh"); await refresh(); };
    try {
      await act(async () => { h.button(label).click(); await new Promise(r => setTimeout(r, 10)); });
      assert.equal(h.button(label).disabled, false, "failure must release the loading state");
      assert.match(document.querySelector("[role=alert]")?.textContent ?? "", /connect|try again/i);
      await act(async () => { h.button(label).click(); });
      assert.equal(calls, 2);
      assert.equal(h.refreshes(), 1);
      assert.deepEqual(events, [
        `${method}:1`, `${method}:2`,
        ...(initial === "pickusername" ? ["sync"] : []), "refresh",
      ]);
    } finally { await h.close(); }
  });
}

/* ---------------- the ways in ---------------- */

test("the first screen lists every way in, each named by its title and saying what it means", async () => {
  const h = await mount("choose", {});
  try {
    for (const [name, says] of [
      ["Create an account", /sync/i],
      ["Continue with Google", /browser/i],
      ["Sign in", /username/i],
      ["Continue as guest", /stays on this computer/i],
    ]) {
      assert.ok(h.button(name), `${name} is there`);
      assert.match(h.description(name), says, `${name} says what it means`);
    }
    await h.click("Create an account");
    assert.match(document.querySelector("h2")?.textContent ?? "", /Create your account/);
    assert.ok(h.button("Back"), "a form step leads back to the ways in");
    await h.click("Back");
    assert.ok(h.button("Continue with Google"), "and it does");
  } finally { await h.close(); }
});

/* ---------------- display names ---------------- */

test("continuing as a guest asks for a name first: Continue sends it, Skip sends none", async () => {
  const sent = [];
  const h = await mount("choose", { authContinueGuest: async (name) => { sent.push(name); } });
  try {
    await h.click("Continue as guest");
    assert.equal(sent.length, 0, "not entered yet");
    assert.match(document.querySelector("h2")?.textContent ?? "", /What should we call you/);
    assert.equal(h.button("Continue").disabled, true, "nothing typed: Continue waits, Skip is there");
    await h.type("Display name", "  Rishi  ");
    await h.click("Continue");
    assert.deepEqual(sent, ["  Rishi  "], "main tidies it");
    assert.equal(h.refreshes(), 1);
  } finally { await h.close(); }

  const skipped = [];
  const s = await mount("choose", { authContinueGuest: async (...args) => { skipped.push(args); } });
  try {
    await s.click("Continue as guest");
    await s.click("Skip for now");
    assert.deepEqual(skipped, [[undefined]]);
  } finally { await s.close(); }
});

test("creating an account asks for a display name, separate from the username", async () => {
  const calls = [];
  const h = await mount("signup", {
    authSignUp: async (...args) => { calls.push(args); },
    authUsernameAvailable: async () => ({ available: true }),
    syncNow: async () => undefined,
  });
  try {
    await h.type("Username", "rishi");
    await h.type("Password", "password1");
    await h.type("Confirm password", "password1");
    assert.equal(h.button("Create account").disabled, true, "no display name yet");
    await h.type("Display name", "x".repeat(31));
    assert.equal(h.button("Create account").disabled, true, "too long");
    assert.match(document.body.textContent, /Up to 30 characters/);
    await h.type("Display name", "Rishi Teja");
    await h.click("Create account");
    assert.deepEqual(calls, [["rishi", "password1", "Rishi Teja"]]);
  } finally { await h.close(); }
});

test("the sign-up boxes keep their words inside: a hint each, and what's known about the text on the box", async () => {
  const h = await mount("signup", { authUsernameAvailable: async () => ({ available: true }) });
  const said = label => document.getElementById(h.field(label).getAttribute("aria-describedby"))?.textContent ?? "";
  try {
    assert.equal(h.field("Display name").placeholder, "What people see");
    assert.match(h.field("Username").placeholder, /letters, numbers/i);
    assert.match(h.field("Password").placeholder, /at least 8 characters/i);
    await h.type("Username", "ri");
    assert.match(said("Username"), /at least 3 characters/i);
    await h.type("Username", "rishi");
    await act(async () => { await new Promise(r => setTimeout(r, 500)); }); // the availability check
    assert.match(said("Username"), /available/i);
    await h.type("Display name", "x".repeat(31));
    assert.match(said("Display name"), /up to 30 characters/i);
  } finally { await h.close(); }
});

test("a guest creating an account finds their name already filled in", async () => {
  const h = await mount("signup", { authUsernameAvailable: async () => ({ available: true }) }, { mode: null, suggestedDisplayName: "Guesty" });
  try {
    assert.equal(h.field("Display name").value, "Guesty");
  } finally { await h.close(); }
});

test("a new Google account: the display name comes filled in and goes with the username", async () => {
  const calls = [];
  const h = await mount(
    "pickusername",
    { authSetUsername: async (...args) => { calls.push(args); }, authUsernameAvailable: async () => ({ available: true }), syncNow: async () => undefined },
    { mode: "account", needsUsername: true, suggestedDisplayName: "Rishi Teja Thabeti" }
  );
  try {
    assert.equal(h.field("Display name").value, "Rishi Teja Thabeti");
    await h.type("Username", "rishi_t");
    await act(async () => { await new Promise(r => setTimeout(r, 500)); }); // the availability check
    await h.click("Continue");
    assert.deepEqual(calls, [["rishi_t", "Rishi Teja Thabeti"]]);
  } finally { await h.close(); }
});
