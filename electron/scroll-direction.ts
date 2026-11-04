/**
 * Which way the user's trackpad scrolls: true when content follows the fingers (the macOS default;
 * "Down motion scrolls up" on Windows), false when it moves against them ("Down motion scrolls
 * down"), null when it can't be told. Wheel deltas carry that setting, so the onboarding's drum of
 * covers asks for it to keep a two-finger roll moving the covers the way the fingers go.
 */
import { execFile } from "node:child_process";

/** `reg query …\PrecisionTouchPad /v ScrollDirection`: 0 is "Down motion scrolls up", content following the fingers. */
export function windowsNatural(out: string): boolean | null {
  const m = /ScrollDirection\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(out);
  return m ? parseInt(m[1], 16) === 0 : null;
}

/** `defaults read -g com.apple.swipescrolldirection`: "0" turns it off; unset (the default) is on. */
export function macNatural(out: string | null): boolean {
  return out === null || out.trim() !== "0";
}

let asked: Promise<boolean | null> | null = null;

/** Read once per run; the setting rarely changes, and the drum lives only on the first screens. */
export function naturalScrolling(): Promise<boolean | null> {
  asked ??= new Promise((resolve) => {
    const opts = { windowsHide: true, timeout: 3000 };
    if (process.platform === "win32") {
      execFile(
        "reg",
        ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\PrecisionTouchPad", "/v", "ScrollDirection"],
        opts,
        (err, out) => resolve(err ? null : windowsNatural(String(out)))
      );
    } else if (process.platform === "darwin") {
      execFile("defaults", ["read", "-g", "com.apple.swipescrolldirection"], opts, (err, out) =>
        resolve(macNatural(err ? null : String(out)))
      );
    } else {
      resolve(null);
    }
  });
  return asked;
}
