/**
 * Songs downloaded to this device, by YouTube id → file, so playback uses the
 * file instead of streaming the song again. Rebuilt from the library store each
 * time the renderer saves it, and told about a download the moment it finishes
 * (the store's own save can trail by a couple of seconds).
 */
import * as fs from "fs";
import * as persist from "./persist";

let byId: Map<string, string> | null = null;

function fromLibrary(data: unknown): Map<string, string> {
  const files = new Map<string, string>();
  const downloads = (data as { state?: { downloads?: Record<string, { status?: unknown; path?: unknown } | null> } } | null)?.state
    ?.downloads;
  if (downloads && typeof downloads === "object") {
    for (const [id, d] of Object.entries(downloads)) {
      if (d?.status === "done" && typeof d.path === "string" && d.path) files.set(id, d.path);
    }
  }
  return files;
}

const index = (): Map<string, string> => (byId ??= fromLibrary(persist.readData("library")));

/** The library store as the renderer just saved it; null forgets everything (a data reset). */
export function noteLibrary(data: unknown): void {
  byId = data === null ? null : fromLibrary(data);
}

export function noteDownloaded(id: string, file: string): void {
  index().set(id, file);
}

/** The finished download's file for this id, while it's still on disk. */
export function downloadedFilePath(id: string): string | null {
  const file = index().get(id);
  if (!file) return null;
  try {
    return fs.statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}
