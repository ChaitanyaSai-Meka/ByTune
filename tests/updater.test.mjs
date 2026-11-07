/**
 * Updates (electron/updater.ts): reading GitHub's latest-release redirect, comparing versions, and
 * the check: quiet when automatic, a notification once per version, Download on a Mac.
 * Electron, persist and electron-updater are stubbed; fetch is replaced per test.
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);

const STUBS = {
  electron: `
    export const app = { isPackaged: false, getVersion: () => "9.9.9" };
    export const shell = { openExternal: (url) => { globalThis.__opened.push(url); return Promise.resolve(); } };
    export class Notification {
      static isSupported() { return true; }
      constructor(o) { this.o = o; globalThis.__notes.push(o); }
      on() {}
      show() {}
    }`,
  "./persist": `
    export function readData(name) { return globalThis.__store[name] ?? null; }
    export async function writeData(name, data) { globalThis.__store[name] = data; }`,
  "electron-updater": `export const autoUpdater = {};`,
};

async function load() {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL("../electron/updater.ts", import.meta.url))],
    bundle: true, platform: "node", format: "cjs", write: false,
    plugins: [{ name: "stub", setup(b) {
      b.onResolve({ filter: /^(electron|electron-updater|\.\/persist)$/ }, (a) => ({ path: a.path, namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: STUBS[a.path], loader: "js" }));
    } }],
  });
  fs.mkdirSync(".test-build", { recursive: true });
  const outfile = path.resolve(".test-build", "updater.cjs");
  fs.writeFileSync(outfile, outputFiles[0].text);
  return require(outfile);
}

process.env.BYTUNE_UPDATE_TEST_VERSION = "1.0.1";
globalThis.__opened = [];
globalThis.__notes = [];
globalThis.__store = {};
const updater = await load();
const seen = [];
updater.startUpdates((s) => seen.push(s), () => undefined);

/** GitHub's /releases/latest, as fetch sees it with redirect: "manual". */
const github = (location, status = 302) => async () => ({ status, headers: { get: (h) => (h === "location" ? location : null) } });
const TAG = (v) => `https://github.com/rishiteja21/ByTune/releases/tag/${v}`;

test("versions: only a newer x.y.z counts", () => {
  assert.equal(updater.newerVersion("v1.1.0", "1.0.1"), "1.1.0");
  assert.equal(updater.newerVersion("1.0.10", "1.0.9"), "1.0.10", "numbers, not text");
  assert.equal(updater.newerVersion("v2.0.0", "1.9.9"), "2.0.0");
  assert.equal(updater.newerVersion("v1.0.1", "1.0.1"), null, "the same version");
  assert.equal(updater.newerVersion("v1.0.0", "1.0.1"), null, "an older one");
  assert.equal(updater.newerVersion("v1.1.0-beta.1", "1.0.1"), null, "not a release version");
  assert.equal(updater.newerVersion("latest", "1.0.1"), null);
});

test("the latest release's tag comes from where GitHub redirects", () => {
  assert.equal(updater.tagFromLocation(TAG("v1.2.0")), "v1.2.0");
  assert.equal(updater.tagFromLocation(`${TAG("v1.2.0")}/`), "v1.2.0");
  assert.equal(updater.tagFromLocation("https://github.com/rishiteja21/ByTune/releases"), null, "no release yet");
  assert.equal(updater.tagFromLocation(null), null);
});

test("Check for updates: up to date, then a newer one, with a notification only from the automatic check", async () => {
  globalThis.fetch = github(TAG("v1.0.1"));
  await updater.checkForUpdates(false);
  assert.equal(updater.updateState().status, "current");
  assert.ok(seen.some((s) => s.status === "checking"), "a check you asked for says it's checking");

  globalThis.fetch = github(TAG("v1.1.0"));
  await updater.checkForUpdates(false);
  assert.deepEqual([updater.updateState().status, updater.updateState().version], ["available", "1.1.0"]);
  assert.equal(globalThis.__notes.length, 0, "no notification for a check you asked for");

  await updater.checkForUpdates(true);
  await updater.checkForUpdates(true);
  assert.equal(globalThis.__notes.length, 1, "once per version");
  assert.match(globalThis.__notes[0].title, /1\.1\.0/);
});

test("an automatic check that fails stays quiet; one you asked for says why", async () => {
  globalThis.fetch = async () => { throw new Error("offline"); };
  const before = updater.updateState();
  await updater.checkForUpdates(true);
  assert.equal(updater.updateState().status, before.status, "nothing changes on screen");
  await updater.checkForUpdates(false);
  assert.equal(updater.updateState().status, "error");
  assert.match(updater.updateState().error, /offline/);
});

test("where it can't install itself (a Mac, a dev run), Update opens the download page", async () => {
  globalThis.fetch = github(TAG("v1.1.0"));
  await updater.checkForUpdates(false);
  assert.equal(updater.updateState().installs, false);
  await updater.installUpdate();
  assert.deepEqual(globalThis.__opened, [updater.DOWNLOAD_PAGE]);
  assert.equal(updater.updateState().status, "available", "nothing downloads");
});
