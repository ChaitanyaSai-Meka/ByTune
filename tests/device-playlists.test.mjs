/**
 * Songs from this computer in playlists (src/lib/devicePlaylists.ts): they go in like any song, the
 * playlist keeps syncing, and when signed in a popup (then a toast) says they stay on this device.
 * A playlist made only of them stays here, worked out from its songs. Runs the real library, UI
 * and session stores.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const code = build({
  stdin: {
    contents: `export * from "./src/lib/devicePlaylists"; export { useLibrary } from "./src/stores/library";
      export { useUI } from "./src/stores/ui"; export { useSession } from "./src/lib/session";`,
    resolveDir: fileURLToPath(new URL("..", import.meta.url)),
    sourcefile: "device-playlists-entry.ts",
    loader: "ts",
  },
  bundle: true, platform: "node", format: "esm", write: false,
}).then((r) => r.outputFiles[0].text);

async function load() {
  // A fresh copy of the stores (and the once-a-session popup) per test.
  return import(`data:text/javascript;base64,${Buffer.from(`${await code}\n// ${Math.random()}`).toString("base64")}`);
}
const song = (id) => ({ id, title: `Song ${id}`, artist: "Artist", duration: 200, thumb: "" });

test("signed out: a song from this computer goes in quietly and the playlist stays the same playlist", async () => {
  const m = await load();
  const p = m.useLibrary.getState().createPlaylist("chills");
  m.addSongsToPlaylists([p.id], [song("yt1")]);
  const { added, told } = m.addSongsToPlaylists([p.id], [song("local:abc")]);
  assert.deepEqual({ added, told }, { added: 1, told: false });
  assert.equal(m.useUI.getState().dialog, null, "nothing syncs without an account, so nothing to say");
  const [same] = m.useLibrary.getState().playlists;
  assert.equal(same.id, p.id);
  assert.deepEqual(same.tracks.map((t) => t.id), ["yt1", "local:abc"]);
  assert.equal(m.staysOnDevice(same), false);
});

test("signed in: the song goes in, and a popup says it stays here while the playlist syncs", async () => {
  const m = await load();
  m.useSession.setState({ mode: "account" });
  const p = m.useLibrary.getState().createPlaylist("chills");
  m.addSongsToPlaylists([p.id], [song("yt1")]);
  const { added, told } = m.addSongsToPlaylists([p.id], [song("local:abc")]);
  assert.deepEqual({ added, told }, { added: 1, told: true });
  const dialog = m.useUI.getState().dialog;
  assert.equal(dialog.notice, true, "a notice: one button, nothing to decide");
  assert.equal(dialog.title, "Kept on this device");
  assert.match(dialog.body, /"Song local:abc" stays on this device\. Songs from this computer don't sync, so "chills" syncs to your account without it\./);
  const [same] = m.useLibrary.getState().playlists;
  assert.equal(same.id, p.id, "the playlist itself is untouched");
  assert.deepEqual(same.tracks.map((t) => t.id), ["yt1", "local:abc"]);

  // Later in the session: a toast, not another popup.
  m.useUI.getState().closeDialog();
  m.addSongsToPlaylists([p.id], [song("local:def")]);
  assert.equal(m.useUI.getState().dialog, null);
  assert.match(m.useUI.getState().toasts.at(-1).message, /"Song local:def" stays on this device/);
});

test("a playlist of nothing but songs from this computer stays here, and stops when it has others", async () => {
  const m = await load();
  m.useSession.setState({ mode: "account" });
  const p = m.newPlaylistWith("Mine", [song("local:a")]);
  assert.equal(m.staysOnDevice(p), true);
  assert.match(m.useUI.getState().dialog.body, /"Mine" stays on this device: all its songs are from this computer/);
  m.useUI.getState().closeDialog();
  const lib = () => m.useLibrary.getState();
  const now = () => lib().playlists.find((x) => x.id === p.id);
  m.addSongsToPlaylists([p.id], [song("yt1")]);
  assert.equal(m.staysOnDevice(now()), false, "with a streamed song in it, it syncs (without the local one)");
  lib().removeFromPlaylist(p.id, "yt1");
  assert.equal(m.staysOnDevice(now()), true);
  lib().removeFromPlaylist(p.id, "local:a");
  assert.equal(m.staysOnDevice(now()), false, "an empty playlist is an ordinary one");
});

test("streamed songs say nothing extra, and imports work like any playlist", async () => {
  const m = await load();
  m.useSession.setState({ mode: "account" });
  const p = m.newPlaylistWith("Streamed", [song("yt1")]);
  assert.equal(m.useUI.getState().dialog, null);
  assert.deepEqual(m.addSongsToPlaylists([p.id], [song("yt2")]), { added: 1, told: false });
  const imported = m.useLibrary.getState().importPlaylist("Folder", [song("yt3"), song("local:z")]);
  assert.equal(m.staysOnDevice(imported), false);
  assert.equal("device" in imported, false, "no stored flag: it's worked out from the songs");
});
