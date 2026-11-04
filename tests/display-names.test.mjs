/**
 * Display names in the main process (electron/supabase.ts): set at sign-up (username + password, a new
 * Google account, a guest), kept on the server for accounts (display_names, see
 * supabase/migrations/0003-display-names.sql) and on this computer for guests, and brought back on
 * sign-in. The REAL module is bundled with stubs for electron and ./persist, and a fake Supabase
 * (auth + the profiles and display_names tables) answers every request; nothing leaves the process.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

// The Supabase client's refresh ticker must not hold the runner open.
const origSetInterval = globalThis.setInterval;
globalThis.setInterval = (...args) => {
  const t = origSetInterval(...args);
  t.unref?.();
  return t;
};

const bundle = build({
  entryPoints: [fileURLToPath(new URL("../electron/supabase.ts", import.meta.url))],
  bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent",
  plugins: [{
    name: "stub-electron-persist",
    setup(b) {
      b.onResolve({ filter: /^electron$|^\.\/persist$/ }, (a) => ({ path: a.path, namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({
        contents: a.path === "electron" ? "module.exports = globalThis.__electronStub;" : "module.exports = globalThis.__persistStub;",
        loader: "js",
      }));
    },
  }],
}).then((r) => r.outputFiles[0].text);

/** A fake Supabase: auth signs in `user`, and the two tables live in maps. */
function fakeSupabase() {
  const s = {
    user: { id: "A", meta: {} },
    profiles: new Map(), // id -> username
    names: new Map(), // user_id -> display name
    namesDown: false, // display_names isn't there (0003 not run yet)
    hold: null, // a promise display_names reads wait on
    calls: [],
  };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const session = () => ({
    access_token: "access-token", token_type: "bearer", expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: "refresh-token",
    user: { id: s.user.id, email: `${s.user.id}@users.bytune.local`, user_metadata: s.user.meta, app_metadata: {}, aud: "authenticated" },
  });
  const eq = (u, key) => u.searchParams.get(key)?.replace(/^eq\./, "");
  s.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = (init.method ?? "GET").toUpperCase();
    s.calls.push(`${method} ${u.pathname}`);
    if (u.pathname === "/auth/v1/signup" || u.pathname === "/auth/v1/token") return json(session());
    if (u.pathname === "/auth/v1/logout") return new Response(null, { status: 204 });
    if (u.pathname === "/rest/v1/profiles") {
      if (method === "POST") {
        for (const row of [].concat(JSON.parse(init.body))) s.profiles.set(row.id, row.username);
        return new Response(null, { status: 201 });
      }
      if (method === "PATCH") {
        s.profiles.set(eq(u, "id"), JSON.parse(init.body).username);
        return new Response(null, { status: 204 });
      }
      const rows = [...s.profiles]
        .filter(([id, username]) => (u.searchParams.has("username") ? username === eq(u, "username") : id === eq(u, "id")))
        .map(([id, username]) => ({ id, username }));
      return json(rows);
    }
    if (u.pathname === "/rest/v1/display_names") {
      if (s.hold) await s.hold;
      if (s.namesDown) return json({ code: "PGRST205", message: "Could not find the table 'public.display_names' in the schema cache" }, 404);
      if (method === "POST") {
        for (const row of [].concat(JSON.parse(init.body))) s.names.set(row.user_id, row.name);
        return new Response(null, { status: 201 });
      }
      const id = eq(u, "user_id");
      return json(s.names.has(id) ? [{ name: s.names.get(id) }] : []);
    }
    throw new Error(`Unexpected network call in test: ${method} ${u}`);
  };
  return s;
}

async function load(profile = null) {
  const server = fakeSupabase();
  const realFetch = globalThis.fetch;
  globalThis.fetch = server.fetch;
  const files = new Map([["profile", JSON.stringify(profile)]]);
  globalThis.__persistStub = {
    readData: (n) => (files.has(n) ? JSON.parse(files.get(n)) : null),
    writeData: async (n, v) => { files.set(n, JSON.stringify(v)); },
    writeDataSync: (n, v) => { files.set(n, JSON.stringify(v)); },
  };
  globalThis.__electronStub = {
    app: { getPath: () => os.tmpdir(), getAppPath: () => os.tmpdir() },
    shell: { openExternal: async () => {} },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (v) => Buffer.from(v), decryptString: (b) => b.toString() },
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bytune-names-"));
  const file = path.join(dir, "supabase.cjs");
  fs.writeFileSync(file, await bundle);
  const api = require(file);
  return {
    api, server, files,
    calls: (part) => server.calls.filter((c) => c.includes(part)).length,
    cleanup: () => { globalThis.fetch = realFetch; fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test("signing up sends the display name to the server; the username stays the sign-in name", async () => {
  const h = await load();
  try {
    await h.api.signUp("Rishi", "password1", "  Rishi   Teja ");
    assert.equal(h.server.names.get("A"), "Rishi Teja", "tidied, then saved for the account");
    const info = h.api.sessionInfo();
    assert.equal(info.displayName, "Rishi Teja");
    assert.equal(info.username, "rishi");
  } finally { h.cleanup(); }
});

test("a sign-up without a usable display name is refused before any account is made", async () => {
  const h = await load();
  try {
    await assert.rejects(h.api.signUp("rishi", "password1", " \n "), /Enter a display name/);
    await assert.rejects(h.api.signUp("rishi", "password1", "x".repeat(31)), /30 characters/);
    assert.equal(h.calls("/auth/v1/signup"), 0);
    assert.equal(h.server.profiles.size, 0);
  } finally { h.cleanup(); }
});

test("the server can't take the name yet: sign-up still works, the name goes up at the next sync", async () => {
  const h = await load();
  try {
    h.server.namesDown = true;
    await h.api.signUp("rishi", "password1", "Rishi");
    assert.equal(h.api.sessionInfo().displayName, "Rishi", "kept here meanwhile");
    assert.equal(h.server.names.size, 0);
    h.server.namesDown = false;
    assert.equal(await h.api.syncDisplayName(), false, "nothing changes on screen");
    assert.equal(h.server.names.get("A"), "Rishi", "sent at the next sync");
    // From then on the server's copy is the one that counts (another device may change it).
    h.server.names.set("A", "Rishi T");
    assert.equal(await h.api.syncDisplayName(), true);
    assert.equal(h.api.sessionInfo().displayName, "Rishi T");
  } finally { h.cleanup(); }
});

test("signing in brings the account's name from the server, and drops one the server doesn't have", async () => {
  const h = await load({ mode: "account", userId: "A", username: "rishi", displayName: "Left over", deviceId: "d", createdAt: 1 });
  try {
    await h.api.signIn("rishi", "password1");
    assert.equal(await h.api.syncDisplayName(), true);
    assert.equal(h.api.sessionInfo().displayName, null, "the server has none: not this account's");
    h.server.names.set("A", "Rishi");
    assert.equal(await h.api.syncDisplayName(), true);
    assert.equal(h.api.sessionInfo().displayName, "Rishi");
    assert.equal(await h.api.syncDisplayName(), false, "already in step");
  } finally { h.cleanup(); }
});

test("changing it in Settings goes to the server first; when that fails nothing changes", async () => {
  const h = await load();
  try {
    await h.api.signUp("rishi", "password1", "Rishi");
    const info = await h.api.setDisplayName(" Rishi  Teja ");
    assert.equal(info.displayName, "Rishi Teja");
    assert.equal(h.server.names.get("A"), "Rishi Teja");
    h.server.namesDown = true;
    await assert.rejects(h.api.setDisplayName("Someone else"), /Display names aren't set up on ByTune's server yet/);
    assert.equal(h.api.sessionInfo().displayName, "Rishi Teja", "unchanged");
    h.server.namesDown = false;
    await assert.rejects(h.api.setDisplayName(""), /Enter a display name/);
    await assert.rejects(h.api.setDisplayName("x".repeat(31)), /30 characters/);
  } finally { h.cleanup(); }
});

test("a guest's name stays on this computer, and is offered again when they go to create an account", async () => {
  const h = await load();
  try {
    await h.api.continueAsGuest("Guesty");
    assert.deepEqual([h.api.sessionInfo().mode, h.api.sessionInfo().displayName], ["guest", "Guesty"]);
    await h.api.continueAsGuest(); // the reinstall prompt's "Continue as guest"
    assert.equal(h.api.sessionInfo().displayName, "Guesty", "kept");
    await h.api.setDisplayName("Guest Two");
    assert.equal(h.api.sessionInfo().displayName, "Guest Two");
    assert.equal(h.calls("display_names"), 0, "a guest's name never leaves this computer");
    await h.api.clearGuestProfile(); // Settings → Create account
    assert.equal(h.api.sessionInfo().mode, null);
    assert.equal(h.api.sessionInfo().suggestedDisplayName, "Guest Two", "offered on the sign-up screen");
    await h.api.signUp("rishi", "password1", "Rishi");
    assert.equal(h.api.sessionInfo().displayName, "Rishi");
    await h.api.signOut();
    assert.equal(h.api.sessionInfo().displayName, null);
    assert.equal(h.api.sessionInfo().suggestedDisplayName, undefined, "offered once, for that sign-up");
  } finally { h.cleanup(); }
});

test("a new Google account is offered its Google name, and keeps the one chosen with its username", async () => {
  const h = await load();
  try {
    h.server.user.meta = { full_name: "Rishi Teja Thabeti", name: "Rishi Teja Thabeti" };
    const pending = h.api.signInGoogle();
    await h.api.handleOAuthCallback("bytune://oauth/callback?code=good");
    const info = await pending;
    assert.equal(info.needsUsername, true);
    assert.equal(h.api.sessionInfo().suggestedDisplayName, "Rishi Teja Thabeti");
    assert.equal(h.server.names.size, 0, "nothing saved until they choose");
    await h.api.setUsername("rishi_t", "Rishi Teja");
    const after = h.api.sessionInfo();
    assert.deepEqual([after.username, after.displayName, after.needsUsername, after.suggestedDisplayName], ["rishi_t", "Rishi Teja", false, undefined]);
    assert.equal(h.server.names.get("A"), "Rishi Teja");
  } finally { h.cleanup(); }
});

test("skipping the username choice still keeps the display name", async () => {
  const h = await load();
  try {
    h.server.user.meta = { full_name: "Rishi Teja Thabeti" };
    const pending = h.api.signInGoogle();
    await h.api.handleOAuthCallback("bytune://oauth/callback?code=good");
    await pending;
    await h.api.skipUsernameClaim("Rishi");
    assert.deepEqual([h.api.sessionInfo().needsUsername, h.api.sessionInfo().displayName], [false, "Rishi"]);
    assert.equal(h.server.names.get("A"), "Rishi");
  } finally { h.cleanup(); }
});

test("signing out mid-sync: the late answer can't sign the account back in", async () => {
  const h = await load();
  try {
    await h.api.signUp("rishi", "password1", "Rishi");
    h.server.names.set("A", "Renamed elsewhere");
    let release;
    h.server.hold = new Promise((r) => (release = r));
    const late = h.api.syncDisplayName();
    await new Promise((r) => setTimeout(r, 20));
    await h.api.signOut();
    release();
    await late;
    assert.equal(h.files.get("profile"), "null", "still signed out");
    assert.equal(h.api.sessionInfo().mode, null);
  } finally { h.cleanup(); }
});
