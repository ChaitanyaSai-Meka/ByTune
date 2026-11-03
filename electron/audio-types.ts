/**
 * The audio files ByTune plays, in one table: the folder scan, the stream
 * proxy's content types, "Open with ByTune" and files dropped on the window
 * all read it (the installer's file associations in package.json list the same
 * extensions; a test keeps them in step).
 *
 * Measured against Electron's Chromium: these decode. WMA, AIFF and ALAC (which
 * hides inside .m4a) don't, so the scan recognises them only to say why they
 * were left out, never to play them.
 */
import * as path from "path";

export const PLAYABLE_AUDIO: Readonly<Record<string, string>> = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
};

const UNPLAYABLE_BY_EXT: Readonly<Record<string, string>> = { ".wma": "WMA", ".aiff": "AIFF", ".aif": "AIFF", ".aifc": "AIFF" };

const ext = (file: string): string => path.extname(file).toLowerCase();

export function isPlayableAudio(file: string): boolean {
  return Object.hasOwn(PLAYABLE_AUDIO, ext(file));
}

/** A file the scan should look at: one it plays, or one it can name as unplayable. */
export function isKnownAudio(file: string): boolean {
  return isPlayableAudio(file) || Object.hasOwn(UNPLAYABLE_BY_EXT, ext(file));
}

export function audioMime(file: string): string {
  return PLAYABLE_AUDIO[ext(file)] ?? "application/octet-stream";
}

/** The format name when this file can't play here ("WMA", "AIFF", "ALAC"), else null. `codec` is the
 *  tag reader's, lowercased — it catches ALAC, which shares the .m4a extension with AAC. */
export function unplayableFormat(file: string, codec?: string): string | null {
  if (codec === "alac") return "ALAC";
  return UNPLAYABLE_BY_EXT[ext(file)] ?? null;
}
