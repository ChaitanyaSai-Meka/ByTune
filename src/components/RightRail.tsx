/**
 * Right rail — the always-on song-details panel, Spotify-style.
 *
 * Default mode ("details"): a sharp artwork tile over the track title and an
 * About-the-artist card in Spotify's shape — photo header, verified name,
 * monthly listeners beside a View profile pill, and the editorial blurb — clicking
 * it opens that artist's page. The queue button in the player bar swaps the
 * body to the queue sheet ("Queue" / "Recently played" text tabs with the
 * underline treatment, X returns to details). Lyrics live in the centre pane
 * (see LyricsCenter.tsx), not here.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { BadgeCheck, Heart, Music2, ThumbsDown, X } from "lucide-react";
import { autoplayTail, isRadioSeed, usePlayer } from "../stores/player";
import { useSettings } from "../stores/settings";
import { useUI, type MenuItem } from "../stores/ui";
import { dontPlay, useAutoplayInfo } from "../lib/autoplay";
import { confirmClearHistory, historyMenuItems, trackMenuItems } from "../lib/trackActions";
import { Artwork, EqBars, IconBtn, Switch } from "./primitives";
import { upgradeArtwork, wideArtwork } from "../lib/artwork";
import { useDrag, useTrackDrop } from "../lib/dnd";
import { useSortable, type SortableRowProps } from "../lib/useSortable";
import { fmtTime } from "../lib/format";
import { useArtistImage } from "../lib/artistImage";
import { monthlyListenersLabel, useArtistAbout } from "../lib/artistAbout";
import { useLibrary } from "../stores/library";
import type { AudioDetails, Track } from "../types";
import { audioEngineInfo } from "../lib/audio";
import { LOUDNESS_LABEL } from "../stores/settings";

/** The queue's "Now playing" row — draggable like every other song row. */
function QueueCurrentRow({ track, playing }: { track: Track; playing: boolean }) {
  const drag = useDrag({ track });
  return (
    <div
      {...drag.props}
      onContextMenu={(e) => {
        e.preventDefault();
        useUI.getState().openContextMenu(e.clientX, e.clientY, trackMenuItems(track));
      }}
      className={`flex items-center gap-3 h-14 px-2 rounded-lg bg-ink-hi/[0.14] ${
        drag.dragging ? "opacity-40" : ""
      }`}
    >
      <Artwork src={track.thumb} className="w-11 h-11 rounded-md shrink-0" iconClassName="w-4 h-4" alt="" />
      <div className="flex-1 min-w-0">
        <div className="text-[14px] font-semibold truncate text-ink-hi flex items-center gap-2">
          <span className="truncate">{track.title}</span>
          {playing && <EqBars />}
        </div>
        <div className="text-[12px] truncate text-ink-hi/55 mt-0.5">{track.artist}</div>
      </div>
    </div>
  );
}

function TrackRow({
  track,
  isCurrent,
  isPlaying,
  onPlay,
  onRemove,
  actions,
  menu = () => trackMenuItems(track),
  sortable,
  style,
}: {
  track: Track;
  isCurrent?: boolean;
  isPlaying?: boolean;
  onPlay: () => void;
  onRemove?: () => void;
  /** hover-only buttons shown before the duration */
  actions?: ReactNode;
  /** right-click menu */
  menu?: () => MenuItem[];
  /** an upcoming queue row: grabbing it reorders the queue (instead of dragging it out) */
  sortable?: SortableRowProps;
  style?: CSSProperties;
}) {
  const drag = useDrag({ track });
  return (
    <div
      {...(sortable ?? drag.props)}
      style={style}
      tabIndex={sortable ? 0 : undefined}
      onKeyDown={
        sortable
          ? (e) => {
              if (e.key === "Enter" && e.target === e.currentTarget) {
                e.preventDefault();
                onPlay();
              } else sortable.onKeyDown(e);
            }
          : undefined
      }
      onClick={onPlay}
      onContextMenu={(e) => {
        e.preventDefault();
        useUI.getState().openContextMenu(e.clientX, e.clientY, menu());
      }}
      className={`group relative flex items-center gap-3 h-12 px-2 rounded-lg cursor-pointer select-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40 ${
        isCurrent ? "bg-ink-hi/[0.14]" : "hover:bg-ink-hi/[0.05]"
      } ${drag.dragging ? "opacity-40" : ""}`}
    >
      <Artwork src={track.thumb} className="w-9 h-9 rounded-md shrink-0" iconClassName="w-3.5 h-3.5" alt="" />
      <div className="flex-1 min-w-0">
        <div className={`text-[13px] truncate font-semibold ${isCurrent ? "text-ink-hi" : "text-ink-hi"}`}>
          {track.title}
        </div>
        <div className="text-[11.5px] truncate text-ink-hi/55 mt-0.5">{track.artist}</div>
      </div>
      {isCurrent && isPlaying && <EqBars />}
      {/* Hover buttons sit before the duration on every row, so durations line up. */}
      {(actions || onRemove) && (
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity shrink-0">
          {actions}
          {onRemove && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRemove();
              }}
              title="Remove from queue"
              aria-label="Remove from queue"
              className="p-1 rounded-md text-ink-hi/45 hover:text-red-400 hover:bg-ink-hi/[0.06] transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      )}
      {track.duration > 0 && (
        <div className="w-9 text-right text-[11px] text-ink-hi/45 tabular-nums shrink-0">{fmtTime(track.duration)}</div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ queue sheet */

/** Exported for the fullscreen player's Queue view — the same sheet, data
    and behavior as the right-rail queue; only the mount point differs. */
export function QueuePanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<"queue" | "recent">("queue");
  const queue = usePlayer((s) => s.queue);
  const index = usePlayer((s) => s.index);
  const playing = usePlayer((s) => s.playing);
  const repeat = usePlayer((s) => s.repeat);
  const jumpTo = usePlayer((s) => s.jumpTo);
  const removeAt = usePlayer((s) => s.removeAt);
  const tail = usePlayer(autoplayTail);
  const history = useLibrary((s) => s.history);
  const playTrack = usePlayer((s) => s.playTrack);
  const autoplay = useSettings((s) => s.autoplay);
  const setAutoplay = useSettings((s) => s.setAutoplay);
  const { seedTitle, loading } = useAutoplayInfo();
  const liked = useLibrary((s) => s.liked);
  const toggleLike = useLibrary((s) => s.toggleLike);
  const likedIds = useMemo(() => new Set(liked.map((l) => l.id)), [liked]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Songs dragged onto the queue join it (after your own upcoming songs).
  const queueDrop = useTrackDrop((track) => {
    const s = usePlayer.getState();
    if (track.id === s.queue[s.index]?.id) return; // e.g. the Now playing row dropped back on its own panel
    const added = s.addToQueue([track]);
    useUI.getState().toast(added ? `Added "${track.title}" to the queue` : `"${track.title}" is already in your queue`);
  });

  const current = queue[index] ?? null;
  // One list: your upcoming songs, the AutoPlay line, then AutoPlay's suggestions.
  const suggestionsAt = queue.length - tail;
  const own = queue.slice(index + 1, suggestionsAt);
  const suggestions = queue.slice(suggestionsAt);
  const line = own.length; // the AutoPlay line's place in the list
  const queueIndexOf = (p: number): number => (p < line ? index + 1 + p : suggestionsAt + p - line - 1);
  const sortable = useSortable({
    signature: `${index}:${tail}:${queue
      .slice(index)
      .map((t) => t.id)
      .join(",")}`,
    listRef,
    scrollRef,
    // Your songs and AutoPlay's suggestions each reorder on their own side of the line.
    clamp: (from, target) => (from < line ? Math.min(target, line - 1) : Math.max(target, line + 1)),
    canDrag: (p) => (p < line ? line > 1 : p > line && suggestions.length > 1),
    onCommit: (from, to) => usePlayer.getState().moveUpcoming(queueIndexOf(from), queueIndexOf(to)),
  });
  const note = suggestions.length
    ? `Suggested by AutoPlay${seedTitle ? ` \u00b7 similar to ${seedTitle}` : ""}`
    : !autoplay
      ? "AutoPlay is off: the music stops after your last song"
      : repeat !== "off"
        ? "AutoPlay is paused while repeat is on"
        : !isRadioSeed(queue[queue.length - 1]?.id)
          ? "AutoPlay isn't available after local files"
          : queue[queue.length - 1]?.episode
            ? "AutoPlay doesn't continue after podcast episodes"
            : loading
              ? "AutoPlay is finding similar songs\u2026"
              : "AutoPlay keeps the music going with similar songs";
  // Row keys must not depend on the current queue index: embedding `index`
  // shifted every key on each track advance, remounting the whole upcoming
  // list (new drag state, new <img> decode) per track. Key by id plus its
  // occurrence number within the queue — stable across playback. One array
  // for the whole list, so a suggestion that becomes yours moves, not remounts.
  const occurrence = new Map<string, number>();
  const stableKey = (id: string): string => {
    const n = occurrence.get(id) ?? 0;
    occurrence.set(id, n + 1);
    return `${id}#${n}`;
  };
  const rows = [
    ...own.map((t, p) => (
      <TrackRow
        key={stableKey(t.id)}
        track={t}
        style={sortable.styleFor(p)}
        sortable={sortable.rowProps(p)}
        onPlay={() => jumpTo(index + 1 + p)}
        onRemove={() => {
          // Removing a row shifts the list up under a stationary
          // pointer — the row now under it never fires mouseenter,
          // so clear the hover wash here (navigate() does the same
          // for view changes).
          useUI.getState().setTintThumb(null);
          removeAt(index + 1 + p);
        }}
      />
    )),
    <div
      key="autoplay-line"
      style={sortable.styleFor(line)}
      className="px-2 pt-2.5 pb-1 text-[12px] leading-snug font-semibold text-ink-hi/50"
    >
      {note}
    </div>,
    ...suggestions.map((t, k) => {
      const isLiked = likedIds.has(t.id);
      return (
        <TrackRow
          key={stableKey(t.id)}
          track={t}
          style={sortable.styleFor(line + 1 + k)}
          sortable={sortable.rowProps(line + 1 + k)}
          onPlay={() => jumpTo(suggestionsAt + k)}
          actions={
            <>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  toggleLike(t);
                }}
                title={isLiked ? "Remove from Liked Songs" : "Add to Liked Songs"}
                aria-label="Like"
                aria-pressed={isLiked}
                className="p-1 rounded-md text-ink-hi/55 hover:text-ink-hi hover:bg-ink-hi/[0.06] transition-colors"
              >
                <Heart className={`w-3.5 h-3.5 ${isLiked ? "fill-current" : ""}`} />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  useUI.getState().setTintThumb(null);
                  dontPlay(suggestionsAt + k);
                }}
                title="Don't play this"
                aria-label="Don't play this"
                className="p-1 rounded-md text-ink-hi/55 hover:text-ink-hi hover:bg-ink-hi/[0.06] transition-colors"
              >
                <ThumbsDown className="w-3.5 h-3.5" />
              </button>
            </>
          }
        />
      );
    }),
  ];

  const TabBtn = ({
    id,
    label,
  }: {
    id: "queue" | "recent";
    label: string;
  }) => (
    <button
      onClick={() => setTab(id)}
      aria-pressed={tab === id}
      className={`relative h-full px-1 text-[14px] font-bold tracking-[-0.2px] transition-colors ${
        tab === id ? "text-ink-hi" : "text-ink-hi/55 hover:text-ink-hi/85"
      }`}
    >
      {label}
      {/* Spotify's underline treatment — ours is white on the black canvas. */}
      <span
        className={`absolute left-0 right-0 bottom-0 h-[3px] rounded-full transition-opacity ${
          tab === id ? "bg-ink-hi opacity-100" : "opacity-0"
        }`}
      />
    </button>
  );

  return (
    <>
      {/* Header — Queue / Recently played tabs + close back to details. */}
      <div className="h-14 shrink-0 flex items-center gap-5 px-5 border-b border-ink-hi/[0.08]">
        <TabBtn id="queue" label="Queue" />
        <TabBtn id="recent" label="Recently played" />
        <div className="ml-auto">
          <IconBtn
            icon={X}
            title="Close queue"
            onClick={onClose}
            className="rounded-full text-ink-hi/55 hover:text-ink-hi"
          />
        </div>
      </div>

      {tab === "queue" ? (
        <div
          {...queueDrop.props}
          className={`flex-1 min-h-0 flex flex-col rounded-xl transition-shadow ${
            queueDrop.hovering ? "ring-2 ring-inset ring-primary/60" : ""
          }`}
        >
          <div className="px-4 pt-3 pb-2">
            <span className="micro-label text-ink-hi/55">Now playing</span>
          </div>
          <div className="px-2 pb-2">
            {current ? (
              <QueueCurrentRow track={current} playing={playing} />
            ) : (
              <div className="px-3 py-6 text-center text-[13px] text-ink-hi/45">
                Nothing playing — start a track to see your queue here.
              </div>
            )}
          </div>

          {current && (
            <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-2 pb-3">
              <div className="flex items-center gap-3 px-2 pt-2 pb-1.5">
                <h2 className="flex-1 text-[15px] font-bold tracking-[-0.2px] text-ink-hi">Up next</h2>
                {own.length > 0 && (
                  <button
                    onClick={() => usePlayer.getState().clearUpcoming()}
                    className="text-[13px] font-semibold text-ink-hi/75 hover:text-ink-hi transition-colors"
                    title="Clear your upcoming songs (AutoPlay's stay)"
                  >
                    Clear
                  </button>
                )}
                <span aria-hidden className="text-[12.5px] font-semibold text-ink-hi/70">
                  AutoPlay
                </span>
                <Switch checked={autoplay} onChange={setAutoplay} label="AutoPlay" />
              </div>
              {own.length === 0 && suggestions.length === 0 && (
                <div className="px-2 pb-1 text-[13px] text-ink-hi/45">Your queue is empty.</div>
              )}
              <div ref={listRef} className="space-y-0.5">
                {rows}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2 space-y-0.5">
          {history.length === 0 ? (
            <div className="px-3 py-6 text-center text-[13px] text-ink-hi/45">
              Nothing here yet — tracks you play land in Recently played.
            </div>
          ) : (
            <>
              <div className="flex justify-end px-2 pb-1">
                <button
                  onClick={confirmClearHistory}
                  className="text-[12px] text-ink-hi/55 hover:text-ink-hi transition-colors"
                >
                  Clear recently played
                </button>
              </div>
              {history.slice(0, 50).map((t, i) => (
                <TrackRow
                  key={`${t.id}-${i}`}
                  track={t}
                  onPlay={() => playTrack(t)}
                  menu={() => historyMenuItems(t)}
                  actions={
                    <IconBtn
                      icon={X}
                      size="sm"
                      danger
                      onClick={(e) => {
                        e.stopPropagation();
                        useLibrary.getState().removeFromHistory(t.id);
                      }}
                      title="Remove from Recently played"
                    />
                  }
                />
              ))}
            </>
          )}
        </div>
      )}
    </>
  );
}

/* ---------------------------------------------------------- song details */

function DetailsBody() {
  const track = usePlayer((s) => s.queue[s.index] ?? null);
  const { artistImage } = useArtistImage(track);
  const detailsDrag = useDrag({ track: track ?? { id: "", title: "", artist: "", duration: 0, thumb: "" } });

  if (!track) {
    return (
      <div className="flex-1 grid place-items-center px-6">
        <div className="text-center">
          <div className="w-14 h-14 rounded-2xl bg-ink-hi/[0.05] grid place-items-center mx-auto mb-4">
            <Music2 className="w-5 h-5 text-ink-hi/35" />
          </div>
          <p className="text-[14px] font-semibold text-ink-hi">Nothing playing</p>
          <p className="text-[12.5px] text-ink-hi/55 mt-1">Song details will show up here.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-3">
      {/* Full-width square artwork, Spotify-panel style — everything scrolls.
          The cover + title block is a drag source: drop it on a sidebar
          playlist. The whole header (art, title, artist) shares one drag
          origin so every pixel behaves the same. */}
      <div {...detailsDrag.props} className={detailsDrag.dragging ? "opacity-40" : ""}>
        <Artwork
          key={track.id}
          src={track.thumb}
          className="w-full aspect-square rounded-xl shadow-elev animate-art-in"
          iconClassName="w-10 h-10"
          alt=""
        />

        {/* Title + artist directly under the art. */}
        <div className="px-0.5 mt-2.5 animate-meta-in" key={`rrmeta-${track.id}`}>
          <div className="text-[24px] font-extrabold tracking-[-0.5px] text-ink-hi leading-tight" title={track.title}>
            {track.title}
          </div>
          <div className="text-[14px] text-ink-hi/70 mt-1">{track.artist}</div>
        </div>
      </div>

      <AboutArtistCard track={track} fallbackImage={artistImage ?? track.thumb ?? null} />
      <AudioDetailsCard track={track} />
    </div>
  );
}

/**
 * Audio details: what is actually playing and what ByTune does to it — the
 * source, its format, the rate it reaches your speakers at, leveling, EQ and
 * limiter, speed and transitions. Plain facts; it never claims "bit-perfect".
 */
function AudioDetailsCard({ track }: { track: Track }) {
  const [details, setDetails] = useState<AudioDetails | null>(null);
  const [, setTick] = useState(0);
  const eqOn = useSettings((s) => s.eqEnabled);
  const speed = useSettings((s) => s.playbackSpeed);
  const crossfade = useSettings((s) => s.crossfadeSeconds);
  const smart = useSettings((s) => s.smartFade);
  const level = useSettings((s) => s.loudnessLevel);

  useEffect(() => {
    let alive = true;
    setDetails(null);
    const load = (): void => {
      void window.bytune
        ?.audioDetails(track.id)
        .then((d) => {
          if (alive && d) {
            setDetails(d);
            window.clearInterval(retry);
          }
        })
        .catch(() => undefined);
    };
    // A stream's details land once it has resolved: keep asking until then.
    const retry = window.setInterval(load, 2000);
    load();
    return () => {
      alive = false;
      window.clearInterval(retry);
    };
  }, [track.id]);
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 1000); // leveling and limiter are live
    return () => window.clearInterval(id);
  }, []);

  const engine = audioEngineInfo(track.id);
  const khz = (hz: number): string => `${Math.round(hz / 100) / 10} kHz`;
  const isFile = details?.source === "file";
  const source = !details
    ? "Waiting for the stream…"
    : isFile
      ? "Your file"
      : details.source === "Piped"
        ? "YouTube, through a Piped mirror"
        : `YouTube Music (${details.source})`;
  const format = details
    ? [
        details.codec?.toUpperCase(),
        details.kbps ? `${details.kbps} kbps` : null,
        details.bitDepth ? `${details.bitDepth}-bit` : null,
        details.sampleRate ? khz(details.sampleRate) : null,
        details.channels === 1 ? "mono" : details.channels === 2 ? "stereo" : details.channels ? `${details.channels} channels` : null,
      ]
        .filter(Boolean)
        .join(" · ") || "Unknown"
    : null;
  const resampled = details?.sampleRate && engine.outputRate && details.sampleRate !== engine.outputRate;
  const output = engine.outputRate
    ? `${khz(engine.outputRate)}${resampled ? ` (resampled from ${khz(details!.sampleRate!)})` : ""}`
    : "Unknown";
  const leveling =
    level === "off"
      ? "Off"
      : isFile && typeof details?.gainDb !== "number"
        ? "Not applied — this file has no ReplayGain tag"
        : `${engine.levelingDb > -0.05 ? "0" : engine.levelingDb.toFixed(1)} dB (${LOUDNESS_LABEL[level]})`;
  const rows: [string, string][] = [
    ["Source", source],
    ...(format ? ([["Format", format]] as [string, string][]) : []),
    ["Output", output],
    ["Volume leveling", leveling],
    ["Equalizer", eqOn ? (engine.limitingDb < -0.1 ? `On, limiting ${engine.limitingDb.toFixed(1)} dB` : "On") : "Off"],
    ...(speed !== 1 ? ([["Speed", `${speed}×`]] as [string, string][]) : []),
    ["Transitions", smart ? "Automix" : crossfade ? `${crossfade} s crossfade` : "Off"],
  ];
  return (
    <section aria-label="Audio details" className="rounded-xl bg-ink-hi/[0.05] p-4">
      <h3 className="text-[14px] font-bold text-ink-hi mb-2">Audio details</h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[12.5px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-ink-hi/55">{k}</dt>
            <dd className="text-ink-hi/90 min-w-0 break-words">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * About the artist, Spotify-panel style: photo header with the section label
 * over its top edge, the artist's name with their verified seal, monthly
 * listeners beside a View profile pill, and the editorial blurb — the same
 * "About the artist" writing the artist page shows. Clicking it opens that
 * artist page; the whole card is also an artist drag source (the home page's
 * artist cards carry the identical payload), so dropping it on Your Library
 * follows the artist.
 */
function AboutArtistCard({
  track,
  fallbackImage,
}: {
  track: Track;
  fallbackImage: string | null;
}) {
  const about = useArtistAbout(track);
  const navigate = useUI((s) => s.navigate);
  const listeners = monthlyListenersLabel(about);
  const photo = about?.thumb ?? fallbackImage;
  // Hooks rule: called before the early return. The card renders only when
  // `about` exists, so the empty fallback payload can never begin a drag.
  const drag = useDrag({
    artist: { id: about?.artistId ?? "", name: about?.name ?? "", thumb: photo ?? undefined },
  });

  if (!about) return null;

  return (
    <button
      onClick={() => navigate({ name: "artist", param: about.artistId })}
      title={`Open ${about.name} — or drag into Your Library`}
      aria-label={`About the artist — open ${about.name}`}
      {...drag.props}
      className={`group rounded-xl bg-ink-hi/[0.04] overflow-hidden text-left cursor-pointer hover:bg-ink-hi/[0.06] transition-colors animate-fade-in ${
        drag.dragging ? "opacity-40" : ""
      }`}
    >
      {/* Photo header with the label over its top edge, Spotify-style — a tall
          3:2 frame showing the whole artist shot, not a cropped strip. */}
      <div className="relative aspect-[3/2] bg-ink-hi/[0.06]">
        {photo ? (
          <img src={wideArtwork(photo)} alt="" className="w-full h-full object-cover object-top art-hairline" />
        ) : (
          <div className="w-full h-full art-hairline" />
        )}
        <div className="absolute inset-0 bg-gradient-to-b from-black/55 via-black/10 to-transparent" />
        <div className="absolute top-2.5 left-3.5 text-[15px] font-bold text-ink-hi">About the artist</div>
      </div>

      <div className="p-3.5 pt-3">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-[15px] font-bold text-ink-hi truncate">{about.name}</span>
          <BadgeCheck className="w-[18px] h-[18px] shrink-0 text-[#4cb3ff]" fill="#4cb3ff" stroke="#0a0a0a" />
        </div>

        <div className="flex items-center justify-between gap-3 mt-2.5">
          <span className="text-[13px] text-ink-hi/70 truncate">
            {listeners ?? about.subscriberCount ?? "Artist"}
          </span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              navigate({ name: "artist", param: about.artistId });
            }}
            className="shrink-0 h-8 px-4 rounded-full border border-ink-hi/30 text-[13px] font-bold text-ink-hi hover:border-ink-hi/60 hover:bg-ink-hi/[0.06] transition-all active:scale-[0.98]"
          >
            View profile
          </button>
        </div>

        {about.description && (
          <p
            className="mt-2.5 text-[13px] leading-relaxed text-ink-hi/70"
            style={{
              display: "-webkit-box",
              WebkitLineClamp: 3,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {about.description}
          </p>
        )}
      </div>
    </button>
  );
}

/* ------------------------------------------------------------------ root */

export function RightRail() {
  const mode = useUI((s) => s.rightPanel);
  const closeQueue = () => useUI.setState({ rightPanel: "details" });

  return (
    <aside
      className="w-[328px] shrink-0 flex flex-col glass-pill rounded-2xl overflow-hidden"
      aria-label="Now playing panel"
    >
      {mode === "queue" ? <QueuePanel onClose={closeQueue} /> : <DetailsBody />}
    </aside>
  );
}
