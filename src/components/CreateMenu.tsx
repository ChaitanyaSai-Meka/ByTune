/**
 * CreateMenu — the library "+" trigger and its Spotify-style dropdown:
 * Playlist and Folder (deliberately no Blend). Picking one asks for a name
 * first (the shared dialog, pre-filled with the numbered default) — nothing
 * is created until the name is confirmed, so cancel means no empty entry.
 * The menu is portal'd to <body> because the library pill clips
 * absolutely-positioned children, and outside-mousedown closes it while
 * honouring both the trigger ref and the portal'd menu ref.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ClipboardList, FileUp, Folder, ListPlus, Plus } from "lucide-react";
import { importPlaylistFile } from "../lib/playlistShare";
import { importFromText } from "../lib/importSongs";
import { askForNewFolder } from "../lib/collection";
import { useLibrary } from "../stores/library";
import { useUI } from "../stores/ui";
import { HERO_PLAY } from "./CollectionHero";

/** `pill`: Your Library's header button ("Create"); the left panel keeps the small +. */
export function CreateMenu({ variant = "icon" }: { variant?: "icon" | "pill" }) {
  const navigate = useUI((s) => s.navigate);

  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  /** viewport position of the portal'd menu (hosts clip) */
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !menuRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      // Capture phase: the popup is the topmost layer, but App's bubble-level
      // shortcut handler is registered first and would close whatever panel
      // sits underneath (queue, lyrics) in the same keystroke.
      e.stopPropagation();
      e.stopImmediatePropagation();
      setOpen(false);
    };
    window.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  /** Drop below the + and run rightward over the main pane, the way Spotify's
      create menu hangs off the sidebar; clamped so it never leaves the
      viewport. */
  const toggle = (): void => {
    const r = ref.current?.getBoundingClientRect();
    if (r) {
      const MENU_W = 264;
      const EDGE = 12;
      // The left panel's + hangs the menu out over the page; a header button lines up with it.
      const HANG = variant === "pill" ? 0 : 72;
      const left = Math.min(Math.max(r.left - HANG, EDGE), window.innerWidth - MENU_W - EDGE);
      setPos({ top: r.bottom + 8, left: Math.max(left, EDGE) });
    }
    setOpen((v) => !v);
  };

  const newPlaylist = (): void => {
    setOpen(false);
    // Fresh state, not the render-time count — the menu may have sat open
    // while other entries appeared. Blank confirm keeps the default name.
    const suggested = `My Playlist #${useLibrary.getState().playlists.length + 1}`;
    useUI.getState().openDialog({
      title: "New playlist",
      body: "Give your playlist a name.",
      initialValue: suggested,
      placeholder: "Playlist name",
      confirmLabel: "Create",
      onConfirm: (value) => {
        const p = useLibrary.getState().createPlaylist(value.trim() || suggested);
        navigate({ name: "playlist", param: p.id });
      },
    });
  };

  // The new folder opens in the middle panel, ready to be filled.
  const newFolder = (): void => {
    setOpen(false);
    askForNewFolder();
  };

  const importList = (): void => {
    setOpen(false);
    useUI.getState().openDialog({
      title: "Import a playlist",
      body: "Paste a Spotify playlist link, or songs one per line (Artist - Title). ByTune finds each song on YouTube Music before you save. Spotify links are read from Spotify's public page, which isn't an official feature and may stop working.",
      initialValue: "",
      placeholder: "https://open.spotify.com/playlist/…\n\nor\n\nTame Impala - Loser\nColdplay - Yellow",
      multiline: true,
      confirmLabel: "Import",
      onConfirm: (value) => void importFromText(value),
    });
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={toggle}
        title="Create playlist or folder"
        aria-label="Create playlist or folder"
        aria-expanded={open}
        className={
          variant === "pill"
            ? HERO_PLAY
            : `p-1.5 rounded-full transition-colors ${
                open ? "text-ink-hi bg-ink-hi/[0.10]" : "text-ink-hi/55 hover:text-ink-hi hover:bg-ink-hi/[0.06]"
              }`
        }
      >
        <Plus className={variant === "pill" ? "w-5 h-5" : "w-4 h-4"} />
        {variant === "pill" && "Create"}
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            className="fixed z-[130] w-[264px] glass-strong rounded-2xl p-1.5 shadow-float origin-top-left animate-menu-in"
            style={{ top: pos.top, left: pos.left }}
          >
            <button
              onClick={newPlaylist}
              className="w-full flex items-center gap-3 px-2.5 py-2.5 rounded-lg text-left hover:bg-ink-hi/[0.06] transition-colors"
            >
              <span className="w-10 h-10 rounded-full bg-ink-hi/[0.08] grid place-items-center shrink-0">
                <ListPlus className="w-5 h-5 text-ink-hi" />
              </span>
              <span className="min-w-0">
                <span className="block text-[14px] font-semibold text-ink-hi">Playlist</span>
                <span className="block text-[12px] text-ink-hi/55 truncate">Create a playlist with songs</span>
              </span>
            </button>
            <button
              onClick={newFolder}
              className="w-full flex items-center gap-3 px-2.5 py-2.5 rounded-lg text-left hover:bg-ink-hi/[0.06] transition-colors"
            >
              <span className="w-10 h-10 rounded-full bg-ink-hi/[0.08] grid place-items-center shrink-0">
                <Folder className="w-5 h-5 text-ink-hi" />
              </span>
              <span className="min-w-0">
                <span className="block text-[14px] font-semibold text-ink-hi">Folder</span>
                <span className="block text-[12px] text-ink-hi/55 truncate">Organize your playlists</span>
              </span>
            </button>
            <button
              onClick={importList}
              className="w-full flex items-center gap-3 px-2.5 py-2.5 rounded-lg text-left hover:bg-ink-hi/[0.06] transition-colors"
            >
              <span className="w-10 h-10 rounded-full bg-ink-hi/[0.08] grid place-items-center shrink-0">
                <ClipboardList className="w-5 h-5 text-ink-hi" />
              </span>
              <span className="min-w-0">
                <span className="block text-[14px] font-semibold text-ink-hi">Import from Spotify or a list</span>
                <span className="block text-[12px] text-ink-hi/55 truncate">Paste a playlist link or song names</span>
              </span>
            </button>
            <button
              onClick={() => {
                setOpen(false);
                void importPlaylistFile();
              }}
              className="w-full flex items-center gap-3 px-2.5 py-2.5 rounded-lg text-left hover:bg-ink-hi/[0.06] transition-colors"
            >
              <span className="w-10 h-10 rounded-full bg-ink-hi/[0.08] grid place-items-center shrink-0">
                <FileUp className="w-5 h-5 text-ink-hi" />
              </span>
              <span className="min-w-0">
                <span className="block text-[14px] font-semibold text-ink-hi">Import a file</span>
                <span className="block text-[12px] text-ink-hi/55 truncate">.csv, .txt, .m3u8 or ByTune .json</span>
              </span>
            </button>
          </div>,
          document.body
        )}
    </div>
  );
}
