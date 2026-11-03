/**
 * The connected Spotify account's playlists, opened from the Spotify row in Your Library. Each
 * card opens that playlist matched to YouTube Music (MatchedPlaylistView). Not connected yet,
 * the page offers to connect.
 */
import { useEffect, useState } from "react";
import { Heart, ListMusic, RefreshCw } from "lucide-react";
import { Btn } from "../components/primitives";
import { FitText } from "../components/FitText";
import { SpotifyIcon } from "../components/SpotifyIcon";
import { upgradeArtwork } from "../lib/artwork";
import { connectSpotify, useSpotify } from "../lib/spotify";
import { useUI } from "../stores/ui";
import type { SpotifyPlaylistInfo } from "../types";

function SpotifyPlaylistCard({ playlist }: { playlist: SpotifyPlaylistInfo }) {
  const navigate = useUI((s) => s.navigate);
  const liked = playlist.id === "liked";
  return (
    <button
      onClick={() => navigate({ name: "spotify", param: playlist.id })}
      title={playlist.name}
      className="group w-44 text-left rounded-xl bg-ink-hi/[0.03] p-3 card-lift duration-200 hover:bg-ink-hi/[0.07]"
    >
      <div
        className={`relative w-full aspect-square rounded-lg overflow-hidden border border-ink-hi/[0.05] grid place-items-center ${
          liked ? "bg-gradient-to-br from-accent/30 to-accent/[0.06]" : "bg-ink-hi/[0.04]"
        }`}
      >
        {liked ? (
          <Heart className="w-9 h-9 fill-accent text-accent" />
        ) : playlist.thumb ? (
          <img src={upgradeArtwork(playlist.thumb)} alt="" loading="lazy" decoding="async" className="absolute inset-0 w-full h-full object-cover" />
        ) : (
          <ListMusic className="w-8 h-8 text-ink-hi/25" />
        )}
      </div>
      <div className="mt-3">
        <FitText lines={2} text={playlist.name} className="text-sm font-medium text-ink leading-snug" />
        <div className="text-[13px] text-ink-faint mt-0.5 truncate">{liked ? "Your Spotify likes" : playlist.owner ?? "Playlist"}</div>
      </div>
    </button>
  );
}

export function SpotifyView() {
  const status = useSpotify((s) => s.status);
  const playlists = useSpotify((s) => s.playlists);
  const connecting = useSpotify((s) => s.connecting);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = (): void => {
    setRefreshing(true);
    void useSpotify
      .getState()
      .refresh()
      .finally(() => setRefreshing(false));
  };
  // Opening the page reads the library again: playlists made or removed in Spotify since show up.
  useEffect(() => {
    if (useSpotify.getState().status.connected) refresh();
  }, []);

  if (!status.connected || status.problem) {
    return (
      <div className="pt-24 px-8 flex flex-col items-center text-center animate-fade-in">
        <SpotifyIcon className="w-14 h-14 mb-5" />
        <h3 className="text-[15px] font-semibold text-ink-hi">{status.connected ? "Spotify needs reconnecting" : "Connect Spotify"}</h3>
        <p className="text-[13px] text-ink-dim mt-1.5 max-w-sm leading-relaxed">
          {status.problem ??
            "Sign in to Spotify in a window of its own, and your playlists and Liked Songs show up here, played from YouTube Music. ByTune reads them the way Spotify's web player does, which isn't an official Spotify feature, so it may stop working."}
        </p>
        <Btn variant="white" size="md" className="mt-5" onClick={() => void connectSpotify()} disabled={connecting}>
          {connecting ? "Finish signing in in the Spotify window" : status.connected ? "Reconnect" : "Connect Spotify"}
        </Btn>
      </div>
    );
  }

  return (
    <div className="pb-12">
      <div className="px-8 pt-8">
        <div className="flex items-end justify-between gap-4 animate-slide-up">
          <div className="flex items-center gap-4 min-w-0">
            <SpotifyIcon className="w-12 h-12 shrink-0" />
            <div className="min-w-0">
              <h1 className="font-display text-[28px] font-bold tracking-tight text-ink-hi">Spotify</h1>
              <p className="text-sm text-ink-dim mt-0.5 truncate">
                {status.name ? `Connected as ${status.name}` : "Connected"}
                {playlists.length ? ` · ${playlists.length} ${playlists.length === 1 ? "playlist" : "playlists"}` : ""}
              </p>
            </div>
          </div>
          <button
            onClick={refresh}
            disabled={refreshing}
            title="Read your Spotify playlists again"
            aria-label="Refresh Spotify playlists"
            className="p-2 rounded-full text-ink-hi/60 hover:text-ink-hi hover:bg-ink-hi/[0.07] transition-colors disabled:opacity-40"
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>
      <div className="px-8 mt-6 flex flex-wrap gap-5">
        {playlists.map((p) => (
          <SpotifyPlaylistCard key={p.id} playlist={p} />
        ))}
      </div>
      <p className="px-8 pt-8 text-[12px] text-ink-faint leading-relaxed max-w-2xl">
        Songs play from YouTube Music, matched by title, artist and length. Read from Spotify's web player, which isn't an official Spotify
        feature, so it may stop working. Disconnect in Settings › Connected services.
      </p>
    </div>
  );
}
