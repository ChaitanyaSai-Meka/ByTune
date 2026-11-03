import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../electron/", import.meta.url));

async function harness({ legacyStores = false } = {}) {
  let source = fs.readFileSync(path.join(root, "main.ts"), "utf8");
  // Negative control: remove only the exact-name gate, keeping sender protection intact.
  if (legacyStores) source = source.replaceAll("    assertRendererStore(name);", "");
  const { code } = await transform(source + "\nexport { registerIpc };", { loader: "ts", format: "cjs" });
  const handles = new Map(), calls = [];
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, console, URL, __dirname: root,
    process: { env: {}, on() {} },
    require(name) {
      if (name === "electron") return {
        app: { requestSingleInstanceLock: () => false, quit() {}, getPath: () => path.join(root, "userdata") },
        protocol: { registerSchemesAsPrivileged() {} },
        ipcMain: { handle: (n, fn) => handles.set(n, fn), on() {} },
      };
      if (name === "./pip") return { registerPipIpc() {}, isTrustedSender: e => e?.trusted === true };
      if (name === "./downloads") return { addDownloadListener() {}, defaultDownloadDir: async () => path.join(root, "downloads"), exportDownloadDir: () => path.join(root, "exports") };
      if (name === "./sync") return { noteLocalWrite() {} };
      if (name === "./stats") return { onStoreWrite() {}, HISTORY_STORE: "listening-history" };
      if (name === "./local-library") return {
        addLibraryFolders: (paths) => { calls.push(["addFolders", ...paths]); return Promise.resolve({ added: [], lib: { folders: [] } }); },
      };
      if (name === "./data-transition") return {
        serializeData: fn => Promise.resolve().then(fn),
        readForDocument: name => { calls.push(["read", name]); return null; },
        writeForDocument: async name => { calls.push(["write", name]); return true; },
      };
      if (name === "./music-service") return {
        localGainDb: (id) => { calls.push(["gain", id]); return -6.5; },
        retryStream: (id) => { calls.push(["retry", id]); },
        getPodcasts: (...args) => { calls.push(["podcasts", ...args]); return [{ title: "Popular shows", shows: [], episodes: [] }]; },
        getMoodCovers: (...args) => { calls.push(["moodCovers", ...args]); return ["https://cover"]; },
        getMoodPage: (...args) => { calls.push(["moodPage", ...args]); return { title: "Telugu", shelves: [] }; },
      };
      if (name === "./stream-proxy") return {
        startStreamProxy: async () => { calls.push(["proxy"]); return 4321; },
        proxyUrlFor: (id, retry, kbps) => { calls.push(["url", id, retry, kbps]); return `proxy:${id}`; },
        proxyUrlForLocalTrack: () => null,
        setDownloadedFileLookup() {},
      };
      if (name === "./downloaded-files") return { noteLibrary() {}, noteDownloaded() {}, downloadedFilePath: () => null };
      if (name.startsWith("./")) return {};
      return require(name);
    },
  });
  module.exports.registerIpc();
  return {
    calls,
    invoke: (channel, name, trusted = true) => Promise.resolve().then(() => handles.get(channel)({ trusted }, name, {}, "scope")),
    call: (channel, ...args) => Promise.resolve().then(() => handles.get(channel)({ trusted: true }, ...args)),
  };
}

test("reserved/noncanonical persistence names are rejected before storage on both channels", async () => {
  const h = await harness();
  for (const name of ["auth", "account", "profile", "approved-dirs", "local-library", "data-owner", "sync-meta", "owner-archive", "set.tings", "", null, {}]) {
    for (const channel of ["data:read", "data:write"]) await assert.rejects(h.invoke(channel, name), /Store not allowed/);
  }
  assert.equal(h.calls.length, 0);
  for (const name of ["settings", "library", "player", "recent-searches", "listening-signals", "artist-meta-cache"]) {
    await h.invoke("data:read", name);
    await h.invoke("data:write", name);
  }
  assert.equal(h.calls.length, 12);
  await assert.rejects(h.invoke("data:read", "settings", false), /Untrusted IPC sender/);
});

test("negative control detects the original missing persistence gate", async () => {
  const h = await harness({ legacyStores: true });
  await h.invoke("data:write", "approved-dirs");
  assert.deepEqual(h.calls, [["write", "approved-dirs"]]);
});

test("library:addFolders cannot mint filesystem approvals from renderer input", async () => {
  const h = await harness();
  // A renderer-supplied path that never went through the native picker is
  // rejected before reaching the local library — approvals are only minted
  // by app:pickFolder / default download locations.
  await assert.rejects(h.invoke("library:addFolders", ["C:\\Users\\victim\\Documents"]), /Folder not approved/);
  await assert.rejects(h.invoke("library:addFolders", ["C:\\approved\\..\\..\\escape"]), /Folder not approved/);
  await assert.rejects(h.invoke("library:addFolders", new Array(12).fill("C:\\x")), /Invalid folder list|Folder not approved/);
  assert.equal(h.calls.filter((c) => c[0] === "addFolders").length, 0);
  // An approved path (userData subtree) still flows through to the library.
  await h.invoke("library:addFolders", [path.join(root, "userdata", "music")]);
  assert.deepEqual(h.calls.at(-1), ["addFolders", path.resolve(path.join(root, "userdata", "music"))]);
});

const VIDEO = "dQw4w9WgXcQ";

test("music:stream takes only a bare 11-character YouTube id", async () => {
  const h = await harness();
  const refused = ["local:abc", "dQw4w9WgXc", "dQw4w9WgXcQQ", "dQw4w9WgXc!", "dQw4w9Wg&c=", "../../etc/x", " dQw4w9WgXc", "", null, 42, {}, [VIDEO]];
  for (const id of refused) await assert.rejects(h.call("music:stream", id), /Invalid track id/, JSON.stringify(id));
  assert.deepEqual(h.calls, [], "a refused id starts nothing and resolves nothing");
  assert.equal(await h.call("music:stream", VIDEO), `proxy:${VIDEO}`);
  assert.deepEqual(h.calls.filter((c) => c[0] !== "proxy"), [["url", VIDEO, false, undefined]]);
  await assert.rejects(h.invoke("music:stream", VIDEO, false), /Untrusted IPC sender/);
});

test("music:stream retry drops the song's cache before handing out the fresh URL", async () => {
  const h = await harness();
  await h.call("music:stream", VIDEO, true, "low");
  assert.deepEqual(h.calls.filter((c) => c[0] !== "proxy"), [["retry", VIDEO], ["url", VIDEO, true, 64]]);
  h.calls.length = 0;
  await h.call("music:stream", VIDEO, "true", "high"); // only a real `true` is a retry
  assert.deepEqual(h.calls.filter((c) => c[0] !== "proxy"), [["url", VIDEO, false, undefined]]);
});

test("local:gainDb answers only for a local file's id", async () => {
  const h = await harness();
  const longest = "local:" + "x".repeat(194); // 200 characters
  assert.equal(await h.call("local:gainDb", "local:abc"), -6.5);
  assert.equal(await h.call("local:gainDb", longest), -6.5);
  for (const id of [VIDEO, "LOCAL:abc", " local:abc", longest + "x", null, 42, {}, ["local:abc"]]) {
    assert.equal(await h.call("local:gainDb", id), null, JSON.stringify(id));
  }
  assert.deepEqual(h.calls, [["gain", "local:abc"], ["gain", longest]], "nothing else reached the library");
  await assert.rejects(h.invoke("local:gainDb", "local:abc", false), /Untrusted IPC sender/);
});

test("music:podcasts browses its one fixed page, whatever the renderer sends", async () => {
  const h = await harness();
  assert.deepEqual(await h.call("music:podcasts"), [{ title: "Popular shows", shows: [], episodes: [] }]);
  await h.call("music:podcasts", "FEmusic_library_landing", { browseId: "VLLM" }, "../x");
  assert.deepEqual(h.calls, [["podcasts"], ["podcasts"]], "no renderer argument reaches the service");
  await assert.rejects(h.invoke("music:podcasts", undefined, false), /Untrusted IPC sender/);
  assert.equal(h.calls.length, 2, "an untrusted sender reaches nothing");
});

test("music:moodCovers browses only a moods page's own category, with its params as sent", async () => {
  const h = await harness();
  const params = "ggMPOg1uX1JOQWZFeDByc2Jm";
  assert.deepEqual(await h.call("music:moodCovers", "FEmusic_moods_and_genres_category", params), ["https://cover"]);
  for (const [browseId, p] of [["VLLM", params], ["FEmusic_library_landing", params], ["FEmusic_moods_and_genres_category", "../x"], ["FEmusic_moods_and_genres_category", 7], ["FEmusic_moods_and_genres_category", "a".repeat(301)], ["FEmusic_moods_and_genres_category", ""]]) {
    await assert.rejects(h.call("music:moodCovers", browseId, p), /Not a mood page/);
  }
  assert.deepEqual(h.calls, [["moodCovers", "FEmusic_moods_and_genres_category", params]], "only the valid call reaches the service");
  await assert.rejects(h.invoke("music:moodCovers", undefined, false), /Untrusted IPC sender/);
});

test("music:moodPage takes the same checks: only a moods page's own category", async () => {
  const h = await harness();
  const params = "ggMPOg1uX1JOQWZFeDByc2Jm";
  assert.deepEqual(await h.call("music:moodPage", "FEmusic_moods_and_genres_category", params), { title: "Telugu", shelves: [] });
  for (const [browseId, p] of [["VLLM", params], ["FEmusic_moods_and_genres_category", "../x"], ["FEmusic_moods_and_genres_category", null]]) {
    await assert.rejects(h.call("music:moodPage", browseId, p), /Not a mood page/);
  }
  assert.deepEqual(h.calls, [["moodPage", "FEmusic_moods_and_genres_category", params]]);
  await assert.rejects(h.invoke("music:moodPage", undefined, false), /Untrusted IPC sender/);
});
