/**
 * A playlist from outside ByTune, matched to YouTube Music as the page shows it: one from the
 * connected Spotify account, or one being imported (a Spotify link, a CSV, a pasted list). Each
 * row shows the song as its source lists it until a YouTube Music match is found; then it plays
 * that. A song YouTube Music doesn't have stays listed, dimmed. Save keeps the matched songs as a
 * ByTune playlist.
 */
import { useEffect, useState } from "react";
import { MoreHorizontal, Play, Plus, RotateCw, Shuffle } from "lucide-react";
import { Artwork, EqBars, ErrorState, ExplicitBadge, HeroSkeleton, ListSkeleton } from "../components/primitives";
import { HERO_PILL, HERO_ROUND, PlaylistHero } from "../components/PlaylistHero";
import { FitText } from "../components/FitText";
import { requireBridge } from "../lib/bridge";
import { useDrag } from "../lib/dnd";
import { downloadAll } from "../lib/downloads";
import { fmtTime, shortTitle } from "../lib/format";
import { pendingImport } from "../lib/importSongs";
import { useArtworkPalette } from "../lib/palette";
import { ipcMessage } from "../lib/spotify";
import { trackMenuItems } from "../lib/trackActions";
import { useSongMatches, type MatchState } from "../lib/useSongMatches";
import { useLibrary } from "../stores/library";
import { usePlayer, useTrackPlayback } from "../stores/player";
import { useSettings } from "../stores/settings";
import { useUI } from "../stores/ui";
import type { ImportedPlaylist, ImportSong, Track } from "../types";

const NO_TRACK: Track = { id: "", title: "", artist: "", duration: 0, thumb: "" };

const LANGUAGE_LABEL: Record<string, string> = {
  telugu: "Telugu", tamil: "Tamil", hindi: "Hindi", kannada: "Kannada", malayalam: "Malayalam", english: "English",
};

function MatchRow({ song, state, index, onPlay }: { song: ImportSong; state: MatchState | undefined; index: number; onPlay: () => void }) {
  const track = state?.state === "matched" ? state.track : null;
  const currentId = usePlayer((s) => s.queue[s.index]?.id ?? null);
  const playing = useTrackPlayback(track?.id ?? "");
  // An unmatched row has nothing to drag: its props are never spread.
  const drag = useDrag({ track: track ?? NO_TRACK });
  const current = !!track && currentId === track.id;
  const openMenu = (x: number, y: number): void => {
    if (track) useUI.getState().openContextMenu(x, y, trackMenuItems(track));
  };
  const status =
    !state || state.state === "matching" ? "Finding…" : state.state === "missing" ? "Not on YouTube Music" : state.state === "failed" ? "Couldn't check" : null;
  return (
    <div
      {...(track ? drag.props : {})}
      onClick={track ? onPlay : undefined}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY);
      }}
      title={track && (track.title !== song.title || track.artist !== song.artist) ? `Plays “${track.title}” by ${track.artist}` : undefined}
      className={`fit-host group flex items-center gap-3.5 h-[64px] px-3 rounded-lg select-none ${
        track ? "cursor-pointer" : "cursor-default"
      } ${current ? "bg-ink-hi/[0.14]" : track ? "hover:bg-ink-hi/[0.05]" : ""} ${
        state?.state === "missing" || state?.state === "failed" ? "opacity-45" : ""
      } ${drag.dragging ? "opacity-40" : ""}`}
    >
      <div className="w-7 shrink-0 grid place-items-center text-[13px] text-ink-faint tabular-nums">
        {current ? (
          playing === "playing" ? <EqBars /> : <span className="text-accent">▸</span>
        ) : (
          <span className={track ? "group-hover:hidden" : ""}>{index + 1}</span>
        )}
        {track && !current && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onPlay();
            }}
            className="hidden group-hover:block text-ink-hi"
            title={`Play ${song.title}`}
            aria-label={`Play ${song.title}`}
          >
            <Play className="w-3.5 h-3.5 fill-current" />
          </button>
        )}
      </div>
      <Artwork src={song.thumb ?? track?.thumb ?? ""} className="w-[52px] h-[52px] rounded-lg shrink-0" iconClassName="w-4 h-4" alt="" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 text-[16px] font-semibold tracking-[-0.2px] text-ink-hi">
          {song.explicit && <ExplicitBadge />}
          <FitText text={shortTitle(song.title)} full={song.title} />
        </div>
        <FitText text={song.artist || "Unknown artist"} className="text-[14px] text-ink-dim mt-0.5" />
      </div>
      <div className="shrink-0 text-[13px] text-ink-faint tabular-nums">
        {status ?? (track && track.duration > 0 ? fmtTime(track.duration) : "")}
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          openMenu(e.clientX, e.clientY);
        }}
        disabled={!track}
        title="More options"
        aria-label={`More options for ${song.title}`}
        className="p-1.5 rounded-md text-ink-faint hover:text-ink-hi hover:bg-ink-hi/[0.07] transition-colors disabled:invisible"
      >
        <MoreHorizontal className="w-4 h-4" />
      </button>
    </div>
  );
}

/** spotifyId: a connected account's playlist; otherwise importId names the import being shown. */
export function MatchedPlaylistView({ spotifyId, importId = "" }: { spotifyId: string | null; importId?: string }) {
  const prefer = useSettings((s) => s.matchLanguage);
  const [playlist, setPlaylist] = useState<(ImportedPlaylist & { fromSpotify: boolean }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setError(null);
    if (spotifyId === null) {
      setPlaylist(pendingImport(importId));
      return;
    }
    setPlaylist(null);
    requireBridge()
      .spotifyPlaylist(spotifyId)
      .then(
        (p) => live && setPlaylist({ ...p, fromSpotify: true }),
        (err: unknown) => live && setError(ipcMessage(err, "Couldn't load this playlist."))
      );
    return () => {
      live = false;
    };
  }, [spotifyId, importId, reload]);

  const states = useSongMatches(playlist?.songs ?? null, prefer, attempt);
  useArtworkPalette(playlist?.thumb ?? null);

  if (error) {
    return <ErrorState title="Couldn't load this playlist" body={error} onRetry={() => setReload((n) => n + 1)} className="pt-10" />;
  }
  if (spotifyId === null && !playlist) {
    return (
      <ErrorState
        title="Nothing to import"
        body="Import a playlist from the + in Your Library: a Spotify link, a CSV file, or a list of songs."
        className="pt-10"
      />
    );
  }
  if (!playlist) {
    return (
      <div className="px-8 pt-6">
        <HeroSkeleton />
        <ListSkeleton rows={7} />
      </div>
    );
  }

  const { songs } = playlist;
  const matched: Track[] = [];
  const position: number[] = [];
  let finding = 0;
  let missing = 0;
  let failed = 0;
  songs.forEach((_, i) => {
    const s = states[i];
    if (s?.state === "matched") {
      position[i] = matched.length;
      matched.push(s.track);
    } else if (!s || s.state === "matching") finding++;
    else if (s.state === "missing") missing++;
    else failed++;
  });
  const done = finding === 0;
  const playQueue = usePlayer.getState().playQueue;
  const play = (shuffle: boolean): void => {
    if (!matched.length) return;
    if (shuffle) usePlayer.setState({ shuffle: true });
    playQueue(matched, shuffle ? Math.floor(Math.random() * matched.length) : 0);
  };
  const save = (): void => {
    const p = useLibrary.getState().importPlaylist(playlist.name, matched);
    useUI.getState().toast(`Saved “${p.name}” to your library`, "success");
    useUI.getState().navigate({ name: "playlist", param: p.id });
  };

  const progress = !done
    ? `Finding ${songs.length - finding} of ${songs.length} songs on YouTube Music…`
    : `${matched.length} of ${songs.length} songs found on YouTube Music${missing ? `. ${missing === 1 ? "1 isn't" : `${missing} aren't`} there` : ""}${
        failed ? `. ${failed} couldn't be checked` : ""
      }.`;

  return (
    <div className="page-tint -mt-5">
      <PlaylistHero
        thumb={playlist.thumb}
        title={playlist.name}
        credit={playlist.owner ? `By ${playlist.owner}` : undefined}
        meta={`${playlist.fromSpotify ? "Spotify playlist" : "Imported list"} • ${songs.length} ${songs.length === 1 ? "song" : "songs"}`}
      >
        <button onClick={() => play(true)} disabled={!matched.length} title="Shuffle" aria-label="Shuffle" className={HERO_ROUND}>
          <Shuffle className="w-[18px] h-[18px]" />
        </button>
        <button onClick={() => play(false)} disabled={!matched.length} className={HERO_PILL}>
          <Play className="w-[18px] h-[18px] fill-current" />
          Play
        </button>
        <button
          onClick={save}
          disabled={!done || !matched.length}
          title={done ? "Save the matched songs as a playlist" : "Available once every song is checked"}
          className={HERO_PILL}
        >
          <Plus className="w-[18px] h-[18px]" />
          Save to library
        </button>
        <button
          onClick={(e) =>
            useUI.getState().openContextMenu(e.clientX, e.clientY, [
              {
                label: "Add all to queue",
                disabled: !matched.length,
                action: () => {
                  usePlayer.getState().addToQueue(matched);
                  useUI.getState().toast("Added to queue");
                },
              },
              { label: "Download all", disabled: !matched.length, action: () => downloadAll(matched, "this playlist") },
            ])
          }
          title="More options"
          aria-label="More options"
          className={HERO_ROUND}
        >
          <MoreHorizontal className="w-[18px] h-[18px]" />
        </button>
      </PlaylistHero>

      <div className="px-8 pb-12 pt-1">
        <div className="flex items-center gap-3 px-3 pb-3 text-[13px] text-ink-dim" aria-live="polite">
          <span>{progress}</span>
          {done && failed > 0 && (
            <button onClick={() => setAttempt((n) => n + 1)} className="inline-flex items-center gap-1.5 text-ink-hi hover:underline">
              <RotateCw className="w-3.5 h-3.5" /> Try again
            </button>
          )}
        </div>
        {playlist.total > songs.length && (
          <p className="px-3 pb-3 text-[13px] text-ink-dim">
            The playlist has {playlist.total} songs; ByTune could read the first {songs.length}.
          </p>
        )}
        {songs.map((song, i) => (
          <div key={`${song.spotifyId ?? song.title}-${i}`}>
            <MatchRow song={song} state={states[i]} index={i} onPlay={() => playQueue(matched, position[i])} />
            {i < songs.length - 1 && <div className="h-px bg-ink-hi/[0.05] ml-[112px] mr-3" />}
          </div>
        ))}
        <p className="px-3 pt-6 text-[12px] text-ink-faint leading-relaxed max-w-2xl">
          {prefer ? `Prefers ${LANGUAGE_LABEL[prefer] ?? prefer} versions of a song where YouTube Music has several (Settings › Connected services). ` : ""}
          {playlist.fromSpotify
            ? "Read from Spotify's own pages. That isn't an official Spotify feature, so it may stop working."
            : ""}
        </p>
      </div>
    </div>
  );
}
