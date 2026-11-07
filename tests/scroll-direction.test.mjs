/**
 * Reading which way the trackpad scrolls (electron/scroll-direction.ts), from what the OS tools
 * print: Windows' registry value (0 means content follows the fingers), macOS's defaults key (unset
 * means it does), and nothing to go on.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL("../electron/scroll-direction.ts", import.meta.url))],
  bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent",
});
const module = { exports: {} };
new Function("require", "module", "exports", outputFiles[0].text)(require, module, module.exports);
const { windowsNatural, macNatural } = module.exports;

const reg = (value) =>
  `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\PrecisionTouchPad\r\n    ScrollDirection    REG_DWORD    ${value}\r\n\r\n`;

test("Windows: 0 is content following the fingers, any other value is against them", () => {
  assert.equal(windowsNatural(reg("0x0")), true);
  assert.equal(windowsNatural(reg("0xffffffff")), false);
  assert.equal(windowsNatural(reg("0xFFFFFFFF")), false);
});

test("Windows: no value (no precision touchpad) can't be told", () => {
  assert.equal(windowsNatural("ERROR: The system was unable to find the specified registry key or value.\r\n"), null);
  assert.equal(windowsNatural(""), null);
});

test("macOS: on unless the key says 0", () => {
  assert.equal(macNatural("1\n"), true);
  assert.equal(macNatural("0\n"), false);
  assert.equal(macNatural(null), true, "unset is the default, which follows the fingers");
});
