/**
 * Connect Spotify is kept per ByTune owner (electron/spotify.ts, the real module; only Electron and
 * YouTube search are stand-ins): signing out and back in finds it, another account never sees it,
 * a guest who creates an account brings theirs, Disconnect drops only the current owner's, and a
 * data reset drops everyone's. Its playlists are kept with it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("..", import.meta.url));
const plain = (v) => JSON.parse(JSON.stringify(v));

function load(dir) {
  const modules = new Map();
  const electron = {
    app: { getPath: () => dir },
    safeStorage: { isEncryptionAvailable: () => false },
    session: { fromPartition: () => ({ clearStorageData: async () => {} }) },
    BrowserWindow: { getAllWindows: () => [] },
  };
  function get(file) {
    if (modules.has(file)) return modules.get(file).exports;
    const module = { exports: {} };
    modules.set(file, module);
    const { code } = transformSync(fs.readFileSync(file, "utf8"), { loader: "ts", format: "cjs" });
    vm.runInNewContext(code, {
      module, exports: module.exports, console, Buffer, URL, setTimeout, clearTimeout,
      process: { env: {}, on() {} },
      require(name) {
        if (name === "electron") return electron;
        if (name === "./music-service") return { searchPage: async () => ({ rows: [], continuation: null }) };
        if (name.startsWith(".")) return get(path.resolve(path.dirname(file), `${name}.ts`));
        return require(name);
      },
    }, { filename: file });
    return module.exports;
  }
  const transition = get(path.join(root, "electron", "data-transition.ts"));
  transition.initializeOwner();
  return { spotify: get(path.join(root, "electron", "spotify.ts")), transition, disk: get(path.join(root, "electron", "persist.ts")) };
}

const connected = (name) => ({ cookie: `plain:${"c".repeat(40)}`, name, playlists: [{ id: "liked", name: "Liked Songs" }] });

test("Spotify is kept per ByTune owner, through sign-out and back in", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bytune-spowners-"));
  const { spotify, transition, disk } = load(dir);
  try {
    assert.equal(transition.currentOwner(), "guest");
    await disk.writeData("spotify", { owners: { guest: connected("Guest listener") } });
    assert.deepEqual(plain(spotify.spotifyStatus()), { connected: true, name: "Guest listener" });

    // The guest creates account A: main moves their Spotify along with their library.
    await transition.changeOwner("A", true);
    assert.equal(spotify.spotifyStatus().connected, false, "not A's until it's moved");
    await spotify.moveGuestSpotify("A");
    assert.deepEqual(plain(spotify.spotifyStatus()), { connected: true, name: "Guest listener" });
    assert.equal(plain(disk.readData("spotify")).owners.guest, undefined, "the guest no longer has it");
    assert.deepEqual(plain(disk.readData("spotify")).owners.A.playlists, [{ id: "liked", name: "Liked Songs" }], "its playlists came too");

    // Signing out, another account, and A back again.
    await transition.changeOwner("guest", false);
    assert.equal(spotify.spotifyStatus().connected, false);
    await transition.changeOwner("B", false);
    assert.equal(spotify.spotifyStatus().connected, false, "another account never sees A's");
    await transition.changeOwner("A", false);
    assert.equal(spotify.spotifyStatus().name, "Guest listener", "A signs back in: there it is");

    // Moving never overwrites an account's own Spotify.
    await disk.writeData("spotify", { owners: { guest: connected("Someone else"), A: connected("A's own") } });
    await spotify.moveGuestSpotify("A");
    assert.equal(spotify.spotifyStatus().name, "A's own");

    // Disconnect drops only the current owner's; a data reset drops everyone's.
    await spotify.disconnectSpotify();
    assert.equal(spotify.spotifyStatus().connected, false);
    assert.equal(plain(disk.readData("spotify")).owners.guest.name, "Someone else");
    await spotify.forgetSpotify();
    assert.deepEqual(plain(disk.readData("spotify")), {});
  } finally {
    await disk.drainWrites();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
