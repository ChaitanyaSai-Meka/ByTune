/**
 * Replay — the listening-statistics experience, fed exclusively by what
 * ByTune actually recorded (electron/stats.ts). No fake numbers: an empty
 * period says so.
 */
import { useEffect, useMemo, useState } from "react";
import { Clock3 } from "lucide-react";
import { Artwork, EmptyState, ErrorState, Pills } from "../components/primitives";
import { usePlayer } from "../stores/player";
import { useUI } from "../stores/ui";
import { resolveArtistMeta } from "../stores/artistMeta";
import { useLibrary } from "../stores/library";
import type { Track } from "../types";
import { activityDays, fmtHours } from "../lib/replayFormat";

interface Summary {
  totalMs: number;
  plays: number;
  tracks: { id: string; title: string; artist: string; thumb: string; ms: number; plays: number }[];
  artists: { name: string; thumb?: string; ms: number; plays: number }[];
  albums: { name: string; artist?: string; thumb?: string; ms: number; plays: number }[];
  hours: number[];
  days: { date: string; ms: number }[];
  period: string;
  months: string[];
}

const PERIODS = [
  { key: "month", label: "This month" },
  { key: "lastMonth", label: "Last month" },
  { key: "year", label: "This year" },
  { key: "all", label: "All time" },
] as const;

type PeriodKey = (typeof PERIODS)[number]["key"];

function fmtDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "6 PM" or "18" — whatever this computer's clock format is. */
const hourLabel = (h: number): string => new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: "numeric" });

// Kept across visits so Back lands on the same period, drawn at full height
// straight away — the app's scroll restore needs the content already there.
let lastPeriod: PeriodKey = "month";
const summaryCache = new Map<PeriodKey, Summary>();

/** Join key for an album row — the same shape the stats buckets use. */
const albumKey = (al: { name: string; artist?: string }): string =>
  `${al.name.toLowerCase()}|${(al.artist || "unknown artist").toLowerCase()}`;

export function ReplayView() {
  const [period, setPeriodState] = useState<PeriodKey>(lastPeriod);
  const setPeriod = (k: PeriodKey): void => {
    lastPeriod = k;
    setPeriodState(k);
  };
  const [nonce, setNonce] = useState(0);
  const [data, setData] = useState<Summary | null>(() => summaryCache.get(lastPeriod) ?? null);
  const [loading, setLoading] = useState(() => !summaryCache.has(lastPeriod));
  const [error, setError] = useState<string | null>(null);
  const [artistThumbs, setArtistThumbs] = useState<Record<string, string>>({});
  const playQueue = usePlayer((s) => s.playQueue);
  const toast = useUI((s) => s.toast);
  const { history, liked, playlists } = useLibrary();

  useEffect(() => {
    let cancelled = false;
    const cached = summaryCache.get(period);
    if (cached) setData(cached);
    setLoading(!cached);
    setError(null);
    window.bytune
      ?.statsSummary(period)
      .then((res) => {
        summaryCache.set(period, res as Summary);
        if (!cancelled) setData(res as Summary);
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

  // Artist photos come from the (cloud-synced) identity cache; names it
  // doesn't know yet are resolved once and cached for the whole app.
  useEffect(() => {
    if (!data) return;
    let alive = true;
    void Promise.all(
      data.artists.slice(0, 10).map(async (a) => {
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
  }, [data]);

  // Album covers for buckets recorded before Replay stored artwork: the
  // listener's own library already knows what those albums look like.
  //
  // Local-file covers (localart://) point at extracted art on THIS machine —
  // a data reset deletes that folder and a cloud restore can never bring it
  // back, so such a reference is used only after the file is confirmed present.
  // Trusting it blindly left every restored local-music album rendering as a
  // permanently broken image.
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
      data.albums.slice(0, 5).map(async (al) => {
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

  const albumThumb = (al: Summary["albums"][number]): string => {
    const key = albumKey(al);
    return al.thumb || albumCandidates.web.get(key) || presentCovers[key] || "";
  };

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
  const openAlbum = (al: Summary["albums"][number]): void => {
    const id = albumIds.get(albumKey(al));
    if (id) useUI.getState().navigate({ name: "album", param: id });
    else searchFor(`${al.name} ${al.artist ?? ""}`.trim());
  };

  if (error) {
    return <ErrorState title="Replay didn't load" body="Give it another try." onRetry={() => setNonce((n) => n + 1)} />;
  }

  const hasData = !!data && data.totalMs > 0;
  const recentDays = data ? activityDays(period, data.days) : [];
  const maxDay = Math.max(1, ...recentDays.map((d) => d.ms));
  const maxHour = Math.max(1, ...(data?.hours.map((h) => h) ?? [1]));
  const topTracks: Track[] = (data?.tracks ?? []).slice(0, 20).map((t) => ({
    id: t.id,
    title: t.title,
    artist: t.artist,
    thumb: t.thumb,
    duration: 0,
  }));

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between gap-4 flex-wrap animate-slide-up">
        <div>
          <h1 className="font-display text-[34px] font-bold tracking-[-0.03em] text-ink-hi">Replay</h1>
          <p className="text-[13.5px] text-ink-dim mt-1">Your listening, counted by ByTune — nothing estimated.</p>
        </div>
        <Pills options={PERIODS.map((p) => ({ key: p.key, label: p.label }))} value={period} onChange={(k) => setPeriod(k as PeriodKey)} />
      </div>

      {loading && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="skeleton h-28 rounded-2xl" />
          ))}
        </div>
      )}

      {!loading && !hasData && (
        <EmptyState
          icon={Clock3}
          title="Nothing here yet"
          body="Play something first — Replay fills in as ByTune counts what you actually listen to."
        />
      )}

      {!loading && hasData && data && (
        <>
          {/* Hero stats */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 animate-fade-in">
            <div className="glass-pill rounded-2xl p-5">
              <div className="text-[12px] uppercase tracking-[0.12em] text-ink-faint font-semibold">Listening time</div>
              <div className="font-display text-[30px] font-bold text-ink-hi mt-2">{fmtHours(data.totalMs)}</div>
            </div>
            <div className="glass-pill rounded-2xl p-5">
              <div className="text-[12px] uppercase tracking-[0.12em] text-ink-faint font-semibold">Plays</div>
              <div className="font-display text-[30px] font-bold text-ink-hi mt-2">{data.plays.toLocaleString()}</div>
            </div>
            <div className="glass-pill rounded-2xl p-5">
              <div className="text-[12px] uppercase tracking-[0.12em] text-ink-faint font-semibold">Top artist</div>
              <div className="font-display text-[19px] font-bold text-ink-hi mt-2 truncate">
                {data.artists[0]?.name ?? "—"}
              </div>
              {data.artists[0] && <div className="text-[12.5px] text-ink-dim mt-1">{fmtHours(data.artists[0].ms)}</div>}
            </div>
            <div className="glass-pill rounded-2xl p-5">
              <div className="text-[12px] uppercase tracking-[0.12em] text-ink-faint font-semibold">Top song</div>
              <div className="font-display text-[19px] font-bold text-ink-hi mt-2 truncate">
                {data.tracks[0]?.title ?? "—"}
              </div>
              {data.tracks[0] && <div className="text-[12.5px] text-ink-dim mt-1 truncate">{data.tracks[0].artist}</div>}
            </div>
          </div>

          {/* Listening activity */}
          {recentDays.length > 1 && (
            <section>
              <h2 className="section-title text-[21px] mb-4">Listening activity</h2>
              <div className="glass-pill rounded-2xl p-5">
                <div className="flex items-end gap-1.5 h-28">
                  {recentDays.map((d) => (
                    <div
                      key={d.date}
                      title={`${fmtDate(d.date)} — ${fmtHours(d.ms)}`}
                      className="flex-1 rounded-t-md bg-accent/70 hover:bg-accent transition-colors min-h-[3px]"
                      style={{ height: `${Math.max(3, (d.ms / maxDay) * 100)}%` }}
                    />
                  ))}
                </div>
                <div className="flex justify-between text-[11px] text-ink-faint mt-2">
                  <span>{fmtDate(recentDays[0].date)}</span>
                  <span>{fmtDate(recentDays[recentDays.length - 1].date)}</span>
                </div>
              </div>
            </section>
          )}

          {/* Listening clock */}
          <section>
            <h2 className="section-title text-[21px] mb-4">When you listen</h2>
            <div className="glass-pill rounded-2xl p-5">
              <div className="flex items-end gap-1 h-20">
                {data.hours.map((ms, h) => (
                  <div key={h} title={`${hourLabel(h)} — ${fmtHours(ms)}`} className="flex-1 flex flex-col items-center gap-1">
                    <div
                      className="w-full rounded-t-sm bg-ink-hi/25 hover:bg-ink-hi/50 transition-colors min-h-[2px]"
                      style={{ height: `${Math.max(2, (ms / maxHour) * 72)}px` }}
                    />
                  </div>
                ))}
              </div>
              <div className="flex justify-between text-[11px] text-ink-faint mt-2">
                {[0, 6, 12, 18, 23].map((h) => (
                  <span key={h}>{hourLabel(h)}</span>
                ))}
              </div>
            </div>
          </section>

          {/* Top tracks + artists */}
          <div className="grid lg:grid-cols-2 gap-8">
            <section>
              <h2 className="section-title text-[21px] mb-4">Top songs</h2>
              <div className="glass-pill rounded-2xl p-2">
                {topTracks.slice(0, 10).map((t, i) => (
                  <button
                    key={t.id}
                    onClick={() => {
                      playQueue(topTracks, i);
                      toast(`Playing ${t.title}`, "info");
                    }}
                    className="w-full flex items-center gap-3 p-2 rounded-xl hover:bg-ink-hi/[0.05] transition-colors text-left"
                  >
                    <span className="w-6 text-center text-[13px] font-bold text-ink-faint">{i + 1}</span>
                    <Artwork src={t.thumb} className="w-11 h-11 rounded-lg shrink-0" iconClassName="w-4 h-4" alt="" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[14px] font-semibold text-ink-hi truncate">{t.title}</span>
                      <span className="block text-[12.5px] text-ink-dim truncate">{t.artist}</span>
                    </span>
                    <span className="text-[12.5px] text-ink-faint shrink-0">
                      {fmtHours(data.tracks.find((x) => x.id === t.id)?.ms ?? 0)}
                    </span>
                  </button>
                ))}
              </div>
            </section>

            <section>
              <h2 className="section-title text-[21px] mb-4">Top artists</h2>
              <div className="glass-pill rounded-2xl p-4 space-y-3">
                {data.artists.slice(0, 10).map((a, i) => (
                  <button
                    key={a.name}
                    onClick={() => void openArtist(a.name)}
                    className="w-full flex items-center gap-3 rounded-xl text-left hover:bg-ink-hi/[0.05] transition-colors"
                  >
                    <span className="w-6 text-center text-[13px] font-bold text-ink-faint">{i + 1}</span>
                    <Artwork
                      src={a.thumb || artistThumbs[a.name] || ""}
                      className="w-9 h-9 rounded-full shrink-0"
                      iconClassName="w-4 h-4"
                      alt=""
                    />
                    <span className="min-w-0 flex-1 text-[14px] font-semibold text-ink-hi truncate">{a.name}</span>
                    <span className="text-[12.5px] text-ink-faint shrink-0">{fmtHours(a.ms)}</span>
                  </button>
                ))}
              </div>
              {data.albums.length > 0 && (
                <>
                  <h2 className="section-title text-[21px] mt-8 mb-4">Top albums</h2>
                  <div className="glass-pill rounded-2xl p-4 space-y-3">
                    {data.albums.slice(0, 5).map((al, i) => (
                      <button
                        key={`${al.name}-${i}`}
                        onClick={() => openAlbum(al)}
                        className="w-full flex items-center gap-3 rounded-xl text-left hover:bg-ink-hi/[0.05] transition-colors"
                      >
                        <span className="w-6 text-center text-[13px] font-bold text-ink-faint">{i + 1}</span>
                        <Artwork
                          src={albumThumb(al)}
                          className="w-9 h-9 rounded-lg shrink-0"
                          iconClassName="w-4 h-4"
                          alt=""
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[14px] font-semibold text-ink-hi truncate">{al.name}</span>
                          <span className="block text-[12.5px] text-ink-dim truncate">{al.artist}</span>
                        </span>
                        <span className="text-[12.5px] text-ink-faint shrink-0">{fmtHours(al.ms)}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
