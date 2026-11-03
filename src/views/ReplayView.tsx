/**
 * Replay — your listening, pressed on wax. Fed only by what ByTune actually
 * recorded (electron/stats.ts; the last seven days from the listening
 * journal): no fake numbers, and an empty period says so.
 *
 * The page: a hero washed in your top song's cover — your minutes counting
 * up, your top song's record sliding out of your top album's sleeve (it
 * spins while your Replay plays) — then liner notes (your top artist, your
 * hour on the curve of your day), your top songs with the share of listening
 * each took, your top artists (each artist on a shared credit counts), your
 * top albums as a record wall, and your listening waveform with your biggest
 * day. Share draws a story-sized card (lib/replayCard).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Check, Clock3, Copy, Download, Play, Share2, X } from "lucide-react";
import { Artwork, Btn, EmptyState, ErrorState } from "../components/primitives";
import { extractPalette } from "../lib/ambient";
import { upgradeArtwork } from "../lib/artwork";
import { renderReplayCard } from "../lib/replayCard";
import {
  activityDays,
  biggestDay,
  creditArtists,
  creditNames,
  fmtHours,
  journalReplay,
  isoDay,
  peakHour,
  streaks,
  vividRgb,
  type ReplayData,
  type ReplayPeriod,
} from "../lib/replayFormat";
import { peekArtistMeta, resolveArtistMeta } from "../stores/artistMeta";
import { useJournal } from "../stores/journal";
import { useLibrary } from "../stores/library";
import { usePlayer } from "../stores/player";
import { useUI } from "../stores/ui";
import type { Track } from "../types";

const PERIODS: { key: ReplayPeriod; label: string }[] = [
  { key: "week", label: "This week" },
  { key: "month", label: "This month" },
  { key: "lastMonth", label: "Last month" },
  { key: "year", label: "This year" },
  { key: "all", label: "All time" },
];

/** The sidebar's Replay row: playing your Replay marks it (player.playingFrom). */
const REPLAY_ROW = "__replay__";
const NEUTRAL: [string, string] = ["60 60 64", "40 40 44"];

/** "6 PM" or "18" — whatever this computer's clock format is. */
const hourLabel = (h: number): string => new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: "numeric" });
const dayLabel = (iso: string, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }): string =>
  new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, opts);

/** What the period covers, in words: "November 2026", "Since Sep 2026". */
function periodLabel(period: ReplayPeriod, data: ReplayData | null, now = new Date()): string {
  const month = (d: Date): string => d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  if (period === "week") return "The last seven days";
  if (period === "month") return month(now);
  if (period === "lastMonth") return month(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  if (period === "year") return String(now.getFullYear());
  const first = data?.months[0];
  return first ? `Since ${new Date(`${first}-01T12:00:00`).toLocaleDateString(undefined, { month: "short", year: "numeric" })}` : "All time";
}

/**
 * The period's days for its charts. This month shows every day of it — the
 * ones still to come marked `ahead` — so a chart keeps its shape on the 3rd
 * as on the 30th.
 */
function chartDays(period: ReplayPeriod, days: ReplayData["days"]): { date: string; ms: number; ahead?: boolean }[] {
  const out: { date: string; ms: number; ahead?: boolean }[] = activityDays(period, days);
  if (period === "month" && out.length) {
    const last = new Date(`${out[out.length - 1].date}T12:00:00`);
    for (let d = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1, 12); d.getMonth() === last.getMonth(); d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 12)) {
      out.push({ date: isoDay(d), ms: 0, ahead: true });
    }
  }
  return out;
}

function reducedMotion(): boolean {
  return document.documentElement.classList.contains("reduce-motion") || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/** A number that counts up to its value once it changes (instant under Reduce animation). */
function useCountUp(value: number, ms = 1100): number {
  const [shown, setShown] = useState(value);
  const from = useRef(0);
  useEffect(() => {
    if (reducedMotion()) {
      setShown(value);
      return;
    }
    const start = performance.now();
    const base = from.current;
    let raf = 0;
    const tick = (t: number): void => {
      const k = Math.min(1, (t - start) / ms);
      const eased = 1 - Math.pow(1 - k, 4);
      setShown(Math.round(base + (value - base) * eased));
      if (k < 1) raf = requestAnimationFrame(tick);
      else from.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      from.current = value;
    };
  }, [value, ms]);
  return shown;
}

/** A cover's two colours as "R G B", made poster-bright; neutral until (or unless) they're read. */
function useCoverColors(url: string | null | undefined): [string, string] {
  const [colors, setColors] = useState<[string, string]>(NEUTRAL);
  useEffect(() => {
    let alive = true;
    if (!url) {
      setColors(NEUTRAL);
      return;
    }
    void extractPalette(url).then((p) => {
      if (alive && p) setColors([vividRgb(p.primary, 0.5, 0.36), vividRgb(p.secondary, 0.55, 0.48)]);
    });
    return () => {
      alive = false;
    };
  }, [url]);
  return colors;
}

/** Whether the catalogue's artist is this very name ("Simon and Garfunkel" = "Simon & Garfunkel"). */
function sameName(a: string, b: string): boolean {
  const norm = (s: string): string =>
    s.normalize("NFKC").toLowerCase().replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return norm(a) === norm(b);
}

/**
 * Top artists by artist, not by credit line: "Luis Fonsi & Daddy Yankee"
 * counts for both. A line the catalogue knows as one artist ("Mumford &
 * Sons") stays whole: known lines straight from the cache, new ones once
 * their lookup lands.
 */
function useCreditedArtists(lines: ReplayData["artists"] | undefined): ReplayData["artists"] {
  const [checked, setChecked] = useState(0);
  useEffect(() => {
    const unchecked = (lines ?? [])
      .slice(0, 20)
      .filter((a) => creditNames(a.name).length > 1 && peekArtistMeta(a.name)?.name === undefined);
    if (!unchecked.length) return;
    let alive = true;
    void Promise.all(unchecked.map((a) => resolveArtistMeta(a.name, true))).then(() => {
      if (alive) setChecked((n) => n + 1);
    });
    return () => {
      alive = false;
    };
  }, [lines]);
  return useMemo(() => {
    const whole = new Set<string>();
    for (const a of lines ?? []) {
      const found = peekArtistMeta(a.name)?.name;
      if (found && creditNames(a.name).length > 1 && sameName(found, a.name)) whole.add(a.name.trim().toLowerCase());
    }
    return creditArtists(lines ?? [], whole);
    // `checked` re-reads the cache once new lookups land.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, checked]);
}

// Kept across visits so Back lands on the same period, drawn at full height
// straight away — the app's scroll restore needs the content already there.
let lastPeriod: ReplayPeriod = "month";
const summaryCache = new Map<ReplayPeriod, ReplayData>();

/** Join key for an album row — the same shape the stats buckets use. */
const albumKey = (al: { name: string; artist?: string }): string => `${al.name.toLowerCase()}|${(al.artist || "unknown artist").toLowerCase()}`;

export function ReplayView() {
  const [period, setPeriodState] = useState<ReplayPeriod>(lastPeriod);
  const setPeriod = (k: ReplayPeriod): void => {
    lastPeriod = k;
    setPeriodState(k);
  };
  const [nonce, setNonce] = useState(0);
  const [stats, setStats] = useState<ReplayData | null>(() => (lastPeriod === "week" ? null : summaryCache.get(lastPeriod) ?? null));
  const [loading, setLoading] = useState(() => lastPeriod !== "week" && !summaryCache.has(lastPeriod));
  const [error, setError] = useState<string | null>(null);
  const [artistThumbs, setArtistThumbs] = useState<Record<string, string>>({});
  const [sharing, setSharing] = useState(false);
  const journal = useJournal((s) => s.entries);
  const playQueue = usePlayer((s) => s.playQueue);
  const { history, liked, playlists } = useLibrary();

  useEffect(() => {
    if (period === "week") {
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    const cached = summaryCache.get(period);
    setStats(cached ?? null);
    setLoading(!cached);
    setError(null);
    window.bytune
      ?.statsSummary(period)
      .then((res) => {
        summaryCache.set(period, res as ReplayData);
        if (!cancelled) setStats(res as ReplayData);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [period, nonce]);

  // The week comes from the journal, so it's always current.
  const data = useMemo(() => (period === "week" ? journalReplay(journal, Date.now()) : stats), [period, journal, stats]);
  const artists = useCreditedArtists(data?.artists);

  // Artist photos come from the (cloud-synced) identity cache; names it
  // doesn't know yet are resolved once and cached for the whole app.
  useEffect(() => {
    let alive = true;
    void Promise.all(
      artists.slice(0, 8).map(async (a) => {
        if (a.thumb || artistThumbs[a.name]) return;
        const meta = await resolveArtistMeta(a.name);
        if (meta?.thumb && alive && !artistThumbs[a.name]) {
          setArtistThumbs((prev) => ({ ...prev, [a.name]: meta.thumb as string }));
        }
      })
    );
    return () => {
      alive = false;
    };
    // artistThumbs intentionally excluded: re-running on our own writes would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artists]);

  // Album covers for buckets recorded before Replay stored artwork: the
  // listener's own library already knows what those albums look like.
  //
  // Local-file covers (localart://) point at extracted art on THIS machine —
  // a data reset deletes that folder and a cloud restore can never bring it
  // back, so such a reference is used only after the file is confirmed present.
  const albumCandidates = useMemo(() => {
    const web = new Map<string, string>();
    const local = new Map<string, string>();
    for (const t of [...history, ...liked, ...playlists.flatMap((p) => p.tracks)]) {
      if (!t.album || !t.thumb) continue;
      const key = albumKey({ name: t.album, artist: t.artist });
      if (/^(https?:\/\/|data:image\/|blob:)/i.test(t.thumb)) {
        if (!web.has(key)) web.set(key, t.thumb);
      } else if (t.thumb.startsWith("localart:") && !local.has(key)) {
        local.set(key, t.thumb);
      }
    }
    return { web, local };
  }, [history, liked, playlists]);

  const [presentCovers, setPresentCovers] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!data) return;
    let alive = true;
    void Promise.all(
      data.albums.slice(0, 8).map(async (al) => {
        const key = albumKey(al);
        if (al.thumb || albumCandidates.web.has(key) || presentCovers[key]) return;
        const candidate = albumCandidates.local.get(key);
        if (!candidate) return;
        try {
          const art = await window.bytune?.localArtBytes(candidate);
          if (alive && art?.data) setPresentCovers((prev) => ({ ...prev, [key]: candidate }));
        } catch {
          /* the extracted cover is gone — keep the placeholder */
        }
      })
    );
    return () => {
      alive = false;
    };
    // presentCovers is a cache this pass fills; re-running on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, albumCandidates]);

  const albumThumb = (al: ReplayData["albums"][number]): string => {
    const key = albumKey(al);
    return al.thumb || albumCandidates.web.get(key) || presentCovers[key] || "";
  };
  const artistThumb = (a: ReplayData["artists"][number]): string => a.thumb || artistThumbs[a.name] || "";

  // Top artists and albums open their pages; with no id to go on, a search.
  const searchFor = (q: string): void => {
    useUI.getState().setSearchQuery(q);
    useUI.getState().navigate({ name: "search" });
  };
  const openArtist = async (name: string): Promise<void> => {
    const meta = await resolveArtistMeta(name);
    if (meta?.id) useUI.getState().navigate({ name: "artist", param: meta.id });
    else searchFor(name);
  };
  const albumIds = useMemo(() => {
    const ids = new Map<string, string>();
    for (const t of [...history, ...liked, ...playlists.flatMap((p) => p.tracks)]) {
      const key = t.album && t.albumId ? albumKey({ name: t.album, artist: t.artist }) : null;
      if (key && !ids.has(key)) ids.set(key, t.albumId as string);
    }
    return ids;
  }, [history, liked, playlists]);
  const openAlbum = (al: ReplayData["albums"][number]): void => {
    const id = albumIds.get(albumKey(al));
    if (id) useUI.getState().navigate({ name: "album", param: id });
    else searchFor(`${al.name} ${al.artist ?? ""}`.trim());
  };

  // Songs as the player plays them: the library's full copy where it has one (length, album, local file).
  const known = useMemo(() => {
    const m = new Map<string, Track>();
    for (const t of [...playlists.flatMap((p) => p.tracks), ...liked, ...history]) m.set(t.id, t);
    for (const e of journal) if (!m.has(e.track.id)) m.set(e.track.id, e.track);
    return m;
  }, [history, liked, playlists, journal]);
  const topTracks: Track[] = useMemo(
    () => (data?.tracks ?? []).slice(0, 50).map((t) => known.get(t.id) ?? { id: t.id, title: t.title, artist: t.artist, thumb: t.thumb, duration: 0 }),
    [data, known]
  );
  const playReplay = (from = 0): void => {
    if (topTracks.length) playQueue(topTracks, from, REPLAY_ROW);
  };

  const topSong = data?.tracks[0];
  const topAlbum = data?.albums[0];
  const colors = useCoverColors(topSong?.thumb);
  const label = periodLabel(period, data);

  if (error) {
    return <ErrorState title="Replay didn't load" body="Give it another try." onRetry={() => setNonce((n) => n + 1)} />;
  }

  const hasData = !!data && data.totalMs > 0;

  return (
    <div className="rp-page space-y-10 pb-6">
      <div className="flex items-end justify-between gap-6 flex-wrap animate-slide-up">
        <div>
          <h1 className="font-display text-[44px] font-extrabold tracking-[-0.035em] text-ink-hi leading-none">Replay</h1>
          <p className="text-[14px] text-ink-dim mt-2">{label}</p>
        </div>
        <PeriodSwitch value={period} onChange={setPeriod} />
      </div>

      {loading && <div className="skeleton h-[340px] rounded-[26px]" />}

      {!loading && !hasData && (
        <EmptyState
          icon={Clock3}
          title="Nothing on this record yet"
          body={
            period === "week"
              ? "Your week fills in as you listen — every song you play from now on counts here."
              : "Play something first — Replay fills in as ByTune counts what you actually listen to."
          }
        />
      )}

      {!loading && hasData && data && (
        // Keyed by period: each period arrives fresh, its record sliding out again.
        <div key={period} className="space-y-12">
          <Hero
            data={data}
            colors={colors}
            sleeve={topAlbum ? albumThumb(topAlbum) || null : null}
            label={topSong?.thumb || null}
            onPlay={() => playReplay(0)}
            onShare={() => setSharing(true)}
          />
          <LinerNotes data={data} artists={artists} artistThumb={artistThumb} onOpenArtist={(n) => void openArtist(n)} />
          <TopSongs data={data} tracks={topTracks} colors={colors} onPlay={playReplay} />
          <TopArtists artists={artists} artistThumb={artistThumb} onOpen={(n) => void openArtist(n)} />
          {data.albums.length > 0 && <TopAlbums data={data} albumThumb={albumThumb} onOpen={openAlbum} />}
          <Pattern data={data} period={period} />
          <p className="text-[12.5px] text-ink-faint">Counted by ByTune on this device — nothing estimated.</p>
        </div>
      )}

      {sharing && hasData && data && (
        <ShareSheet
          onClose={() => setSharing(false)}
          fileName={`ByTune Replay — ${label}`}
          make={() => {
            const days = activityDays(period, data.days);
            const run = streaks(period === "all" || period === "year" ? data.days : days);
            return renderReplayCard({
              periodLabel: label,
              minutes: Math.round(data.totalMs / 60000),
              plays: data.plays,
              activeDays: run.active,
              streak: run.longest,
              songs: data.tracks.slice(0, 5).map((t) => ({ title: t.title, artist: t.artist, thumb: t.thumb })),
              artists: artists.slice(0, 5).map((a) => ({ name: a.name, thumb: artistThumb(a), detail: fmtHours(a.ms) })),
              sleeve: topAlbum ? albumThumb(topAlbum) || null : null,
              label: topSong?.thumb || null,
              colors,
            });
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------ period switch */

function PeriodSwitch({ value, onChange }: { value: ReplayPeriod; onChange: (k: ReplayPeriod) => void }) {
  const refs = useRef<Partial<Record<ReplayPeriod, HTMLButtonElement | null>>>({});
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);
  useLayoutEffect(() => {
    const el = refs.current[value];
    if (el) setThumb({ x: el.offsetLeft, w: el.offsetWidth });
  }, [value]);
  return (
    <div className="rp-seg" role="tablist" aria-label="Replay period">
      {thumb && <span className="rp-seg-thumb" style={{ transform: `translateX(${thumb.x}px)`, width: thumb.w }} aria-hidden />}
      {PERIODS.map((p) => (
        <button
          key={p.key}
          ref={(el) => {
            refs.current[p.key] = el;
          }}
          role="tab"
          aria-selected={p.key === value}
          onClick={() => onChange(p.key)}
          className={p.key === value ? "text-black" : "text-ink-dim hover:text-ink-hi"}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------------- hero */

function Hero({
  data,
  colors,
  sleeve,
  label,
  onPlay,
  onShare,
}: {
  data: ReplayData;
  colors: [string, string];
  sleeve: string | null;
  label: string | null;
  onPlay: () => void;
  onShare: () => void;
}) {
  const minutes = useCountUp(Math.round(data.totalMs / 60000));
  const spinning = usePlayer((s) => s.playing && s.playingFrom === REPLAY_ROW);
  const run = streaks(data.days);
  const style = { "--rp-a": colors[0], "--rp-b": colors[1] } as CSSProperties;
  return (
    <section className="rp-hero animate-slide-up" style={style}>
      <div className="rp-words">
        <div className="rp-eyebrow">Minutes listened</div>
        <div className="rp-minutes font-display">{minutes.toLocaleString()}</div>
        <p className="mt-4 text-[15px] text-white/85">
          {data.plays.toLocaleString()} {data.plays === 1 ? "play" : "plays"} · {run.active} {run.active === 1 ? "day" : "days"} of listening
          {run.longest > 1 ? ` · ${run.longest}-day streak` : ""}
        </p>
        <div className="mt-7 flex gap-2.5">
          <Btn variant="white" icon={Play} onClick={onPlay}>
            Play your Replay
          </Btn>
          <Btn variant="glass" icon={Share2} onClick={onShare}>
            Share
          </Btn>
        </div>
      </div>
      <div className={`rp-art ${sleeve ? "" : "is-alone"} ${spinning ? "is-spinning" : ""}`} aria-hidden>
        {label && (
          <img
            className="rp-wash"
            src={upgradeArtwork(label)}
            alt=""
            draggable={false}
            onError={(e) => {
              e.currentTarget.style.display = "none";
            }}
          />
        )}
        {sleeve && (
          <span className="rp-sleeve">
            <img src={sleeve} alt="" draggable={false} />
          </span>
        )}
        <span className="rp-record">
          <span className="rp-disc">
            {label && (
              <span className="rp-label">
                <img src={upgradeArtwork(label)} alt="" draggable={false} />
              </span>
            )}
          </span>
        </span>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------- liner notes */

/** The hour card's colour: the sky at that time of day (night, morning, afternoon, evening, late). */
const skyAt = (h: number): string =>
  h < 5 ? "84 80 214" : h < 11 ? "38 158 168" : h < 17 ? "58 132 226" : h < 21 ? "222 84 124" : "104 78 206";

function LinerNotes({
  data,
  artists,
  artistThumb,
  onOpenArtist,
}: {
  data: ReplayData;
  artists: ReplayData["artists"];
  artistThumb: (a: ReplayData["artists"][number]) => string;
  onOpenArtist: (name: string) => void;
}) {
  const artist = artists[0];
  const photo = artist ? artistThumb(artist) : "";
  const [artistColor] = useCoverColors(photo || undefined);
  const hour = peakHour(data.hours);
  const total = data.hours.reduce((sum, ms) => sum + ms, 0);
  return (
    <div className="rp-cards">
      {artist && (
        <button
          className={`rp-card animate-slide-up ${photo ? "rp-card-photo" : ""}`}
          style={{ "--c": artistColor, animationDelay: "60ms" } as CSSProperties}
          onClick={() => onOpenArtist(artist.name)}
        >
          {photo && <img className="rp-card-glow" src={upgradeArtwork(photo)} alt="" draggable={false} aria-hidden />}
          <div className="rp-eyebrow">Top artist</div>
          <div className="mt-auto flex items-center gap-4 pt-5">
            <Artwork src={photo} className="w-[108px] h-[108px] shrink-0 shadow-float" rounded="rounded-full" iconClassName="w-6 h-6" alt="" />
            <div className="min-w-0">
              <div className="font-display text-[24px] font-extrabold tracking-[-0.02em] text-white leading-[1.2] line-clamp-2 text-balance break-words">
                {artist.name}
              </div>
              <div className="text-[13.5px] text-white/75 mt-1.5">
                {fmtHours(artist.ms)} · {artist.plays.toLocaleString()} {artist.plays === 1 ? "play" : "plays"}
              </div>
            </div>
          </div>
        </button>
      )}
      {hour !== null && (
        <div className="rp-card animate-slide-up" style={{ "--c": skyAt(hour), animationDelay: "120ms" } as CSSProperties}>
          <div className="rp-eyebrow">Your hour</div>
          <div className="font-display text-[30px] font-extrabold tracking-[-0.02em] text-white mt-3 leading-none">{hourLabel(hour)}</div>
          <div className="text-[13.5px] text-white/75 mt-2">
            {Math.max(1, Math.round((data.hours[hour] / Math.max(1, total)) * 100))}% of all your listening
          </div>
          <DayCurve hours={data.hours} peak={hour} />
        </div>
      )}
    </div>
  );
}

/**
 * A smooth line through points evenly spaced in x that never overshoots them
 * (Steffen's monotone cubic), so it can't dip below zero or peak anywhere
 * but a real hour.
 */
function monotonePath(pts: readonly (readonly [number, number])[], low: number, high: number): string {
  const n = pts.length;
  const h = pts[1][0] - pts[0][0];
  const s = pts.slice(1).map((p, i) => (p[1] - pts[i][1]) / h);
  const m = pts.map((_, i) =>
    i === 0 ? s[0] : i === n - 1 ? s[n - 2] : (Math.sign(s[i - 1]) + Math.sign(s[i])) * Math.min(Math.abs(s[i - 1]), Math.abs(s[i]), Math.abs(s[i - 1] + s[i]) / 4)
  );
  // The end tangents are one-sided; holding the handles inside the chart keeps the ends in it too.
  const y = (v: number): number => Math.min(high, Math.max(low, v));
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    d += `C${x0 + h / 3},${y(y0 + (m[i] * h) / 3)} ${x1 - h / 3},${y(y1 - (m[i + 1] * h) / 3)} ${x1},${y1}`;
  }
  return d;
}

/** Your day, midnight to midnight: how much you listen in each hour as one line, your hour pinned on it. */
function DayCurve({ hours, peak }: { hours: number[]; peak: number }) {
  const W = 240;
  const H = 64;
  const max = Math.max(1, ...hours);
  const pts = hours.map((ms, h) => [((h + 0.5) / 24) * W, H - 1 - (ms / max) * (H - 9)] as const);
  const line = `M0,${pts[0][1]}L${monotonePath(pts, 1, H - 1).slice(1)}L${W},${pts[23][1]}`;
  const at = { left: `${((peak + 0.5) / 24) * 100}%`, top: `${(pts[peak][1] / H) * 100}%` };
  return (
    <div className="mt-auto pt-5" aria-hidden>
      <div className="rp-curve">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
          <defs>
            <linearGradient id="rp-curve-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#fff" stopOpacity="0.32" />
              <stop offset="1" stopColor="#fff" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={`${line}L${W},${H}L0,${H}Z`} fill="url(#rp-curve-fill)" />
          <path d={line} fill="none" stroke="rgb(255 255 255 / 0.9)" strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        </svg>
        <span className="rp-curve-drop" style={at} />
        <span className="rp-curve-pin" style={at} />
      </div>
      <div className="relative mt-2 h-4 text-[11px] text-white/55 tabular-nums">
        {[0, 6, 12, 18].map((h) => (
          <span key={h} className="absolute top-0 -translate-x-1/2 whitespace-nowrap first:translate-x-0" style={{ left: h ? `${((h + 0.5) / 24) * 100}%` : 0 }}>
            {hourLabel(h)}
          </span>
        ))}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- top songs */

function TopSongs({
  data,
  tracks,
  colors,
  onPlay,
}: {
  data: ReplayData;
  tracks: Track[];
  colors: [string, string];
  onPlay: (i: number) => void;
}) {
  const rows = data.tracks.slice(0, 10);
  const top = Math.max(1, rows[0]?.ms ?? 1);
  const playingId = usePlayer((s) => (s.playing ? s.queue[s.index]?.id ?? null : null));
  const style = { "--rp-a": colors[0], "--rp-b": colors[1] } as CSSProperties;
  return (
    <section className="animate-slide-up" style={style}>
      <h2 className="section-title text-[24px] mb-4">Top songs</h2>
      <ol className="rp-songs">
        {rows.map((t, i) => (
          <li key={t.id}>
            <button
              onClick={() => onPlay(i)}
              className="group w-full grid grid-cols-[40px_52px_minmax(0,1fr)_auto] items-center gap-3.5 rounded-xl px-2 py-2 text-left transition-colors hover:bg-ink-hi/[0.05]"
            >
              <span className={`font-display text-[22px] font-extrabold tabular-nums text-right ${i === 0 ? "text-ink-hi" : "text-ink-faint"}`}>
                {String(i + 1).padStart(2, "0")}
              </span>
              <Artwork src={tracks[i]?.thumb ?? t.thumb} className="w-[52px] h-[52px] rounded-lg" iconClassName="w-4 h-4" alt="" />
              <span className="min-w-0">
                <span className={`block truncate text-[14.5px] font-semibold ${playingId === t.id ? "text-accent" : "text-ink-hi"}`}>{t.title}</span>
                <span className="block truncate text-[13px] text-ink-dim">{t.artist}</span>
                <span className="rp-meter mt-2 block" aria-hidden>
                  <i style={{ width: `${Math.max(4, (t.ms / top) * 100)}%`, animationDelay: `${150 + i * 50}ms` }} />
                </span>
              </span>
              <span className="text-right text-[12.5px] text-ink-faint tabular-nums leading-relaxed">
                {fmtHours(t.ms)}
                <br />
                {t.plays.toLocaleString()} {t.plays === 1 ? "play" : "plays"}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

/* ------------------------------------------------------------- top artists */

function TopArtists({
  artists,
  artistThumb,
  onOpen,
}: {
  artists: ReplayData["artists"];
  artistThumb: (a: ReplayData["artists"][number]) => string;
  onOpen: (name: string) => void;
}) {
  // Full rows only: eight (two rows of four), else four.
  const rows = artists.slice(0, artists.length >= 8 ? 8 : 4);
  if (!rows.length) return null;
  return (
    <section className="animate-slide-up">
      <h2 className="section-title text-[24px] mb-5">Top artists</h2>
      <ol className="rp-artists" style={{ "--n": Math.max(4, rows.length) } as CSSProperties}>
        {rows.map((a, i) => (
          <li key={a.name} className="min-w-0">
            <button onClick={() => onOpen(a.name)} className="group flex w-full flex-col items-center text-center">
              <span className="relative block w-full max-w-[176px]">
                <Artwork
                  src={artistThumb(a)}
                  className="aspect-square w-full shadow-float transition-transform duration-300 group-hover:scale-[1.04]"
                  rounded="rounded-full"
                  iconClassName="w-7 h-7"
                  alt=""
                />
                <span
                  className={`absolute left-0 top-0 grid h-9 min-w-9 place-items-center rounded-full px-2 font-display text-[15px] font-extrabold shadow-elev ${
                    i === 0 ? "bg-white text-black" : "bg-[#1c1c1f] text-ink-hi"
                  }`}
                >
                  {i + 1}
                </span>
              </span>
              <span className="mt-3 w-full line-clamp-2 text-balance break-words text-[14.5px] font-semibold leading-snug text-ink-hi">{a.name}</span>
              <span className="mt-0.5 text-[12.5px] text-ink-faint">{fmtHours(a.ms)}</span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

/* -------------------------------------------------------------- top albums */

function TopAlbums({
  data,
  albumThumb,
  onOpen,
}: {
  data: ReplayData;
  albumThumb: (al: ReplayData["albums"][number]) => string;
  onOpen: (al: ReplayData["albums"][number]) => void;
}) {
  return (
    <section className="animate-slide-up">
      <h2 className="section-title text-[24px] mb-5">Top albums</h2>
      <div className="rw rp-albums">
        {data.albums.slice(0, 8).map((al, i) => {
          const thumb = albumThumb(al);
          return (
            <button key={`${al.name}-${i}`} className="rw-item" onClick={() => onOpen(al)}>
              <span className="rw-art" aria-hidden>
                <span className="rw-disc">
                  <span className="rw-label">{thumb && <img src={thumb} alt="" draggable={false} />}</span>
                </span>
                {thumb ? <img className="rw-sleeve" src={thumb} alt="" draggable={false} /> : <span className="rw-sleeve bg-ink-hi/[0.06]" />}
              </span>
              <span className="mt-3 block text-[14px] font-semibold text-ink-hi truncate">
                <span className="text-ink-faint tabular-nums mr-1.5">{i + 1}</span>
                {al.name}
              </span>
              <span className="block text-[13px] text-ink-dim truncate">
                {al.artist ? `${al.artist} · ` : ""}
                {fmtHours(al.ms)}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/* ----------------------------------------------------------------- pattern */

function Pattern({ data, period }: { data: ReplayData; period: ReplayPeriod }) {
  const days = chartDays(period, data.days);
  const max = Math.max(1, ...days.map((d) => d.ms));
  // The year and all time chart only their last four weeks; their biggest day is still the whole period's.
  const longPeriod = period === "year" || period === "all";
  const best = biggestDay(longPeriod ? data.days : days);
  const songs = useCountUp(data.counts?.tracks ?? data.tracks.length);
  const artists = useCountUp(data.counts?.artists ?? data.artists.length);
  const albums = useCountUp(data.counts?.albums ?? data.albums.length);
  return (
    <section className="animate-slide-up">
      <h2 className="section-title text-[24px] mb-4">Your listening</h2>
      <div className="grid grid-cols-3 gap-4 mb-6">
        {[
          [songs, "different songs"],
          [artists, "artists"],
          [albums, "albums"],
        ].map(([n, what]) => (
          <div key={what} className="rounded-2xl bg-ink-hi/[0.04] px-5 py-4">
            <div className="font-display text-[34px] font-extrabold tracking-[-0.03em] text-ink-hi tabular-nums">{Number(n).toLocaleString()}</div>
            <div className="text-[13px] text-ink-dim">{what}</div>
          </div>
        ))}
      </div>
      {days.length > 1 && (
        <div className="rounded-2xl bg-ink-hi/[0.04] px-5 pt-5 pb-3">
          {best && (
            <div className="mb-5 flex items-end justify-between gap-4">
              <div className="min-w-0">
                <div className="text-[13px] text-ink-dim">Your biggest day</div>
                <div className="mt-1 text-[18px] font-bold tracking-[-0.01em] text-ink-hi">
                  {dayLabel(best.date, { weekday: "long", month: "long", day: "numeric" })}
                  <span className="font-semibold text-ink-dim"> · {fmtHours(best.ms)}</span>
                </div>
              </div>
              {longPeriod && <div className="shrink-0 text-[12px] text-ink-faint">The last four weeks</div>}
            </div>
          )}
          <div className="rp-wave">
            {days.map((d, i) => (
              <span
                key={d.date}
                title={d.ahead ? undefined : `${dayLabel(d.date)} — ${fmtHours(d.ms)}`}
                className={d.ahead ? "bg-ink-hi/[0.06]" : d.date === best?.date ? "bg-accent" : d.ms ? "bg-ink-hi/40" : "bg-ink-hi/10"}
                style={{ height: `${Math.max(4, (d.ms / max) * 100)}%`, animationDelay: `${Math.min(i, 40) * 14}ms` }}
              />
            ))}
          </div>
          <div className="flex justify-between text-[11.5px] text-ink-faint mt-3">
            <span>{dayLabel(days[0].date)}</span>
            <span>{dayLabel(days[days.length - 1].date)}</span>
          </div>
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------- share sheet */

function ShareSheet({ make, fileName, onClose }: { make: () => Promise<Blob>; fileName: string; onClose: () => void }) {
  const [card, setCard] = useState<{ url: string; bytes: Uint8Array } | null>(null);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const toast = useUI((s) => s.toast);
  const makeRef = useRef(make);

  useEffect(() => {
    let alive = true;
    let url: string | null = null;
    void makeRef
      .current()
      .then(async (blob) => {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        url = URL.createObjectURL(blob);
        if (alive) setCard({ url, bytes });
        else URL.revokeObjectURL(url);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const copy = async (): Promise<void> => {
    if (!card) return;
    try {
      await window.bytune?.copyReplayImage(card.bytes);
      setCopied(true);
      toast("Copied — paste it into a story or a chat");
    } catch {
      toast("Couldn't copy the card", "error");
    }
  };
  const save = async (): Promise<void> => {
    if (!card) return;
    try {
      const res = await window.bytune?.saveReplayImage(card.bytes, fileName);
      if (res?.path) toast("Saved your Replay card");
    } catch {
      toast("Couldn't save the card", "error");
    }
  };

  return (
    <div className="rp-share-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()} role="dialog" aria-modal="true" aria-label="Share your Replay">
      <div className="rp-share">
        <div className="rp-share-preview">
          {card ? <img src={card.url} alt="Your Replay card" /> : failed ? null : <div className="skeleton h-full w-full" />}
        </div>
        <div className="flex min-w-0 flex-col">
          <div className="flex items-start justify-between gap-3">
            <h2 className="font-display text-[26px] font-extrabold tracking-[-0.02em] text-ink-hi leading-tight">Share your Replay</h2>
            <button onClick={onClose} className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-ink-dim hover:bg-ink-hi/[0.08] hover:text-ink-hi" aria-label="Close">
              <X className="h-5 w-5" />
            </button>
          </div>
          <p className="text-[14px] text-ink-dim mt-2 leading-relaxed">
            Your minutes, your top songs and artists, and your top song's record — one card, sized for a story.
          </p>
          {failed && <p className="text-[13.5px] text-red-300 mt-4">The card couldn't be drawn. Close this and try again.</p>}
          <div className="mt-7 flex flex-col gap-2.5">
            <Btn variant="white" icon={copied ? Check : Copy} onClick={() => void copy()} disabled={!card}>
              {copied ? "Copied" : "Copy image"}
            </Btn>
            <Btn variant="glass" icon={Download} onClick={() => void save()} disabled={!card}>
              Save image
            </Btn>
          </div>
          <p className="mt-auto pt-6 text-[12.5px] text-ink-faint leading-relaxed">
            A 1080 × 1920 picture, sized for a story. Copy it into a chat, or save it and post it from your phone.
          </p>
        </div>
      </div>
    </div>
  );
}
