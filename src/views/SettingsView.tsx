import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  Activity,
  AppWindow,
  BarChart3,
  Check,
  ChevronRight,
  CloudDownload,
  CloudUpload,
  Download,
  Droplets,
  ExternalLink,
  Globe,
  Search,
  Timer,
  FileDown,
  FileUp,
  FolderOpen,
  Gauge,
  HardDrive,
  Image,
  Infinity as InfinityIcon,
  Languages,
  ListMusic,
  Maximize2,
  Music4,
  RefreshCw,
  SlidersHorizontal,
  SlidersVertical,
  Speaker,
  Sparkles,
  Trash2,
  User,
  UserRound,
  VolumeX,
  Wifi,
} from "lucide-react";
import {
  DOWNLOAD_QUALITY_LABEL,
  LOUDNESS_LABEL,
  STREAM_QUALITY_LABEL,
  useSettings,
} from "../stores/settings";
import { useSession } from "../lib/session";
import { connectSpotify, useSpotify } from "../lib/spotify";
import { SpotifyIcon } from "../components/SpotifyIcon";
import { MATCH_LANGUAGES, type MatchLanguage } from "../../electron/track-match";
import { describeLyricsShift } from "../lib/lyricsOffset";
import { setOnboardingIntent } from "../lib/onboardingIntent";
import { GuestDeleteModal } from "../components/AccountModals";
import { Switch } from "../components/primitives";
import { useUI, type MenuItem } from "../stores/ui";
import { EQ_BANDS, listOutputDevices } from "../lib/audio";
import type { OutputDeviceChoice } from "../lib/audio-output";

/* ============================================================ settings chrome
   Settings are inset cards of rows: an uppercase group header, a
   rounded card, glyph + title + optional subtitle on the left, a value/switch
   or chevron on the right, and hairline dividers inset to the text column. */

const GROUP_INSET = "px-0"; // page padding comes from the view container
const ROW_INSET = "px-4";
const TEXT_INSET = "pl-[52px]"; // icon (22) + gap (14) + row inset (16)

function SettingsGroup({
  header,
  footer,
  children,
}: {
  header?: string;
  footer?: string;
  children: ReactNode;
}) {
  return (
    <section data-setting-group className="animate-slide-up">
      {header && (
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-dim px-5 pt-7 pb-2">
          {header}
        </h2>
      )}
      {!header && <div className="pt-7" />}
      <div className={`mx-4 rounded-[14px] bg-panel overflow-hidden ${GROUP_INSET}`}>{children}</div>
      {footer && <p className="text-[12.5px] text-ink-dim px-5 pt-2 leading-relaxed">{footer}</p>}
    </section>
  );
}

function Divider() {
  return <div data-setting-divider className={`h-px bg-ink-hi/[0.08] ${TEXT_INSET}`} />;
}

function Chevron() {
  return <ChevronRight className="w-5 h-5 text-ink-dim/70 shrink-0" />;
}

function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="ml-2 text-[10px] font-semibold uppercase tracking-wide text-ink-hi/90 rounded-[5px] bg-ink-hi/[0.16] px-1.5 py-0.5">
      {children}
    </span>
  );
}

function SettingsRow({
  icon: Icon,
  title,
  subtitle,
  value,
  badge,
  disabled,
  onClick,
  onPointerDown,
  trailing,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle?: string;
  value?: string;
  badge?: string;
  disabled?: boolean;
  /** receives the event so rows can anchor a dropdown to themselves */
  onClick?: (e: React.MouseEvent) => void;
  /** dropdown rows stop the press here — the open menu survives until the
      click, letting the same row toggle it closed (playbar "+" pattern) */
  onPointerDown?: (e: React.PointerEvent) => void;
  trailing?: ReactNode;
}) {
  const interactive = onClick && !disabled;
  return (
    <div
      data-setting-row
      onPointerDown={onPointerDown}
      onClick={interactive ? (e) => onClick(e) : undefined}
      className={`flex items-center min-h-[52px] py-3 ${ROW_INSET} ${
        interactive ? "cursor-pointer hover:bg-ink-hi/[0.04] active:bg-ink-hi/[0.07] transition-colors" : ""
      } ${disabled ? "opacity-45" : ""}`}
    >
      <Icon className="w-[22px] h-[22px] shrink-0 text-ink-hi" />
      <div className="flex-1 min-w-0 ml-[14px]">
        <div className="flex items-center">
          <span className="text-[14px] text-ink-hi truncate">{title}</span>
          {badge && <Badge>{badge}</Badge>}
        </div>
        {subtitle && <div className="text-[12.5px] text-ink-dim mt-0.5 leading-snug">{subtitle}</div>}
      </div>
      <div className="flex items-center gap-1 shrink-0 ml-3">
        {trailing ?? (
          <>
            {value && <span className="text-[14px] text-ink-dim">{value}</span>}
            {onClick && <Chevron />}
          </>
        )}
      </div>
    </div>
  );
}

/** A toggle that reads as part of the option above it — no glyph, no divider. */
function SettingsSubRow({
  title,
  checked,
  onChange,
  badge,
}: {
  title: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  badge?: string;
}) {
  return (
    <div
      onClick={() => onChange(!checked)}
      className={`flex items-center ${ROW_INSET} pb-2.5 -mt-1 cursor-pointer`}
    >
      <div className="flex-1 flex items-center min-w-0">
        <span className="text-[14px] text-ink-hi truncate">{title}</span>
        {badge && <Badge>{badge}</Badge>}
      </div>
      <Switch checked={checked} onChange={onChange} />
    </div>
  );
}

/** Thumb width of the .slider CSS — the fill is computed so it ends exactly
    at the thumb's centre (the native input insets the thumb by half its
    width at both ends of the range). */
const SLIDER_THUMB_PX = 13;

function SliderRow({
  icon: Icon,
  title,
  subtitle,
  value,
  min,
  max,
  step,
  current,
  onChange,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle?: string;
  value: string;
  min: number;
  max: number;
  step: number;
  current: number;
  onChange: (v: number) => void;
}) {
  const frac = max > min ? Math.min(1, Math.max(0, (current - min) / (max - min))) : 0;
  return (
    <div data-setting-row className={`${ROW_INSET} py-3`}>
      <div className="flex items-center">
        <Icon className="w-[22px] h-[22px] shrink-0 text-ink-hi" />
        <div className="flex-1 min-w-0 ml-[14px]">
          <div className="text-[14px] text-ink-hi">{title}</div>
          {subtitle && <div className="text-[12.5px] text-ink-dim mt-0.5">{subtitle}</div>}
        </div>
        <span className="text-[14px] text-ink-dim ml-3 shrink-0">{value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={current}
        onChange={(e) => onChange(Number(e.target.value))}
        className="slider slider-dot w-full mt-3 ml-[36px]"
        style={
          {
            width: "calc(100% - 36px)",
            "--fill": `calc((100% - ${SLIDER_THUMB_PX}px) * ${frac} + ${SLIDER_THUMB_PX / 2}px)`,
          } as CSSProperties
        }
      />
    </div>
  );
}

const EQ_PRESETS: Record<string, number[]> = {
  Flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  Bass: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
  Treble: [0, 0, 0, 0, 0, 1, 2, 4, 5, 6],
  Vocal: [-2, -2, -1, 0, 2, 4, 4, 2, 0, -1],
  Loudness: [5, 4, 2, 0, -1, -1, 0, 2, 4, 5],
};

const bandLabel = (hz: number): string => (hz >= 1000 ? `${hz / 1000}k` : String(hz));

/** 10-band graphic EQ: switch, presets (built-in + your own), one vertical slider per band (±12 dB). */
function EqualizerRows() {
  const enabled = useSettings((st) => st.eqEnabled);
  const gains = useSettings((st) => st.eqGains);
  const saved = useSettings((st) => st.eqPresets);
  const autoHeadroom = useSettings((st) => st.eqAutoHeadroom);
  const { setEqEnabled, setEqGains, saveEqPreset, renameEqPreset, deleteEqPreset, setEqAutoHeadroom } =
    useSettings.getState();
  const same = (curve: number[]): boolean => curve.every((g, i) => g === gains[i]);
  const builtIn = Object.keys(EQ_PRESETS).find((k) => same(EQ_PRESETS[k]));
  const mine = saved.find((p) => same(p.gains))?.name;
  const preset = builtIn ?? mine;
  const chip = (active: boolean): string =>
    `text-[12px] rounded-full px-3 py-1 transition-colors ${
      active ? "bg-primary text-on-primary" : "bg-ink-hi/[0.08] text-ink-hi hover:bg-ink-hi/[0.14]"
    }`;
  const askName = (title: string, initialValue: string, confirmLabel: string, done: (name: string) => void, except = ""): void =>
    useUI.getState().openDialog({
      title,
      initialValue,
      placeholder: "Preset name",
      confirmLabel,
      onConfirm: (value) => {
        const name = value.trim().slice(0, 40);
        if (!name) return;
        if (EQ_PRESETS[name]) {
          useUI.getState().toast(`"${name}" is a built-in preset — pick another name`, "error");
          return;
        }
        if (name !== except && saved.some((p) => p.name === name)) {
          useUI.getState().toast(`You already have a preset called "${name}"`, "error");
          return;
        }
        done(name);
      },
    });
  return (
    <>
      <SettingsRow
        icon={SlidersVertical}
        title="Equalizer"
        subtitle={enabled ? `10-band, ${preset ?? "Custom"}` : "Shape the sound with a 10-band EQ"}
        trailing={<Switch checked={enabled} onChange={setEqEnabled} />}
        onClick={() => setEqEnabled(!enabled)}
      />
      {enabled && (
        <div className={`${TEXT_INSET} pr-4 pb-4`}>
          <div className="flex flex-wrap gap-1.5 mb-3">
            {Object.keys(EQ_PRESETS).map((name) => (
              <button key={name} onClick={() => setEqGains(EQ_PRESETS[name])} className={chip(name === preset)}>
                {name}
              </button>
            ))}
            {saved.map((p) => (
              <button
                key={`mine-${p.name}`}
                onClick={() => setEqGains(p.gains)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  useUI.getState().openContextMenu(e.clientX, e.clientY, [
                    { label: "Rename…", action: () => askName("Rename preset", p.name, "Rename", (to) => renameEqPreset(p.name, to), p.name) },
                    { label: "Update to current curve", disabled: same(p.gains), action: () => saveEqPreset(p.name, gains) },
                    { label: "Delete", danger: true, separatorBefore: true, action: () => deleteEqPreset(p.name) },
                  ]);
                }}
                title="Right-click to rename, update or delete"
                className={chip(p.name === preset)}
              >
                {p.name}
              </button>
            ))}
            {!preset && (
              <button
                onClick={() => askName("Save preset", "My preset", "Save", (name) => saveEqPreset(name, gains))}
                className="text-[12px] rounded-full px-3 py-1 border border-dashed border-ink-hi/25 text-ink-hi/80 hover:text-ink-hi hover:border-ink-hi/45 transition-colors"
              >
                Save as preset…
              </button>
            )}
          </div>
          <div className="flex justify-between gap-1 max-w-[520px]">
            {EQ_BANDS.map((hz, i) => (
              <label key={hz} className="flex flex-col items-center gap-1.5 min-w-0 flex-1">
                <span className="text-[11px] tabular-nums text-ink-dim">
                  {gains[i] > 0 ? `+${gains[i]}` : gains[i]}
                </span>
                <input
                  type="range"
                  min={-12}
                  max={12}
                  step={1}
                  value={gains[i] ?? 0}
                  aria-label={`${bandLabel(hz)} Hz`}
                  onChange={(e) => setEqGains(gains.map((g, j) => (j === i ? Number(e.target.value) : g)))}
                  onDoubleClick={() => setEqGains(gains.map((g, j) => (j === i ? 0 : g)))}
                  className="h-[120px] w-5 accent-[rgb(var(--primary))] cursor-pointer"
                  style={{ writingMode: "vertical-lr", direction: "rtl" }}
                />
                <span className="text-[11px] text-ink-dim">{bandLabel(hz)}</span>
              </label>
            ))}
          </div>
          <label data-setting-row className="mt-4 flex items-center gap-3 max-w-[520px] cursor-pointer">
            <span className="flex-1 min-w-0">
              <span className="block text-[13px] text-ink-hi">Prevent clipping</span>
              <span className="block text-[12px] text-ink-dim">
                Lowers the level only when your boosts would distort at the current volume
              </span>
            </span>
            <Switch checked={autoHeadroom} onChange={setEqAutoHeadroom} label="Prevent clipping" />
          </label>
        </div>
      )}
    </>
  );
}

/* ============================================================ view */

/** Builds the option list for the quality dropdowns. Every row carries the
    check glyph — filled on the current value, invisible on the rest so the
    labels keep their alignment — and picking one commits it immediately. */
function qualityMenu<T extends string>(
  order: T[],
  labels: Record<T, string>,
  current: T,
  onPick: (q: T) => void,
): MenuItem[] {
  return order.map((q) => ({
    label: labels[q],
    icon: Check,
    iconClassName: q === current ? "text-accent" : "opacity-0",
    action: () => onPick(q),
  }));
}

/** Opens the row's dropdown, right-aligned under the row's value — and
    toggles it closed when one is already open. Same contract as the playbar
    "+": the row's pointerdown keeps an open menu alive until this click (see
    SettingsRow's onPointerDown), so the click itself can close it. */
function toggleDropdownAt(e: React.MouseEvent, items: MenuItem[]): void {
  e.stopPropagation();
  const ui = useUI.getState();
  if (ui.contextMenu) {
    ui.closeContextMenu();
    return;
  }
  const rect = e.currentTarget.getBoundingClientRect();
  ui.openContextMenu(rect.right, rect.bottom + 6, items, { alignRight: true });
}

/** Output device — routes playback to a specific speaker/headset via
    setSinkId. Chromium hides device labels until the page has held capture
    permission once, so the first menu open asks for it on explicit intent;
    failure degrades to generic "Speaker N" names. */
function OutputDeviceGroup() {
  const sinkId = useSettings((st) => st.audioSinkId);
  const [devices, setDevices] = useState<OutputDeviceChoice[] | null>(null);
  useEffect(() => {
    let alive = true;
    const refresh = (): void => {
      void listOutputDevices().then((list) => {
        if (alive) setDevices(list);
      });
    };
    refresh();
    // Plugging or unplugging a device must update the row and the menu live.
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    md?.addEventListener?.("devicechange", refresh);
    return () => {
      alive = false;
      md?.removeEventListener?.("devicechange", refresh);
    };
  }, []);
  const current = devices?.find((d) => d.deviceId === sinkId);
  // Where sound is going RIGHT NOW: the pinned device, or — when following
  // the system default — whichever physical endpoint the OS currently routes
  // "default" to. Resolving this is what makes the row move when Windows
  // hands the default to a newly connected headset.
  const active = devices?.find((d) => d.deviceId !== "" && d.activeDefault);
  const value = sinkId ? (current?.label ?? "System default") : active ? active.label : "System default";
  const itemsFor = (list: OutputDeviceChoice[]): MenuItem[] =>
    list.map((d) => ({
      label: d.deviceId === "" && active ? `System default — ${active.label}` : d.label,
      icon: Check,
      iconClassName: d.deviceId === sinkId ? "text-accent" : "opacity-0",
      action: () => useSettings.getState().setAudioSinkId(d.deviceId),
    }));
  return (
    <SettingsGroup
      header="Audio output"
      footer="Playback follows the device you pick. If it disappears (headset unplugged, Bluetooth dropped), playback pauses and the setting falls back to the system default."
    >
      <SettingsRow
        icon={Speaker}
        title="Output device"
        subtitle={sinkId ? "Pinned to this device" : "Following the system default"}
        value={devices ? value : "System default"}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          // Same toggle contract as the quality rows: a click on the row
          // closes the open menu; otherwise the list resolves (async) and the
          // menu opens anchored to the row. The rect is captured
          // synchronously — React nulls currentTarget after the handler.
          const rect = e.currentTarget.getBoundingClientRect();
          const ui = useUI.getState();
          if (ui.contextMenu) {
            ui.closeContextMenu();
            return;
          }
          void listOutputDevices().then((list) => {
            setDevices(list);
            ui.openContextMenu(rect.right, rect.bottom + 6, itemsFor(list), { alignRight: true });
          });
        }}
      />
    </SettingsGroup>
  );
}

const MATCH_LANGUAGE_LABEL: Record<MatchLanguage | "", string> = {
  "": "Any",
  telugu: "Telugu",
  tamil: "Tamil",
  hindi: "Hindi",
  kannada: "Kannada",
  malayalam: "Malayalam",
  english: "English",
};

/**
 * Connect Spotify: the listener's own Spotify playlists and Liked Songs in the sidebar, matched
 * to YouTube Music. The session stays in main (electron/spotify.ts), sealed, never uploaded.
 * The language row applies to every import too.
 */
function ConnectedServicesGroup() {
  const status = useSpotify((s) => s.status);
  const connecting = useSpotify((s) => s.connecting);
  const language = useSettings((s) => s.matchLanguage);
  const ui = useUI.getState();
  const connect = (): void => void connectSpotify();
  return (
    <SettingsGroup
      header="Connected services"
      footer="Connect Spotify signs in to Spotify in a window of its own; ByTune keeps that session on this computer for this ByTune account, encrypted, and never uploads it. It reads your playlists the way Spotify's web player does, which isn't an official Spotify feature: it may stop working, and it isn't allowed by Spotify's terms. Songs are found on YouTube Music to play."
    >
      <SettingsRow
        icon={SpotifyIcon}
        title="Spotify"
        subtitle={
          status.connected
            ? status.problem ?? (status.name ? `Connected as ${status.name}` : "Connected")
            : connecting
              ? "Finish signing in in the Spotify window"
              : "Your playlists and Liked Songs, in your library"
        }
        trailing={
          status.connected ? (
            <div className="flex items-center gap-2">
              {status.problem && (
                <button onClick={connect} className="h-8 px-3.5 rounded-full text-[13px] font-semibold bg-ink-hi/[0.08] text-ink-hi hover:bg-ink-hi/[0.14] transition-colors">
                  Reconnect
                </button>
              )}
              <button
                onClick={() =>
                  ui.openDialog({
                    title: "Disconnect Spotify?",
                    body: "ByTune forgets your Spotify session and its playlists here. Playlists you saved to your library stay.",
                    confirmLabel: "Disconnect",
                    danger: true,
                    onConfirm: () => void useSpotify.getState().disconnect().then(() => ui.toast("Spotify disconnected")),
                  })
                }
                className="h-8 px-3.5 rounded-full text-[13px] font-semibold bg-ink-hi/[0.08] text-ink-hi hover:bg-ink-hi/[0.14] transition-colors"
              >
                Disconnect
              </button>
            </div>
          ) : (
            <button
              onClick={connect}
              disabled={connecting}
              className="h-8 px-3.5 rounded-full text-[13px] font-semibold bg-accent text-on-primary hover:brightness-110 transition disabled:opacity-50"
            >
              {connecting ? "Connecting…" : "Connect"}
            </button>
          )
        }
      />
      <Divider />
      <SettingsRow
        icon={Languages}
        title="Song versions"
        subtitle="When a song has versions in several languages, imports and Spotify playlists pick this one"
        value={MATCH_LANGUAGE_LABEL[language]}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) =>
          toggleDropdownAt(
            e,
            qualityMenu(["", ...MATCH_LANGUAGES] as (MatchLanguage | "")[], MATCH_LANGUAGE_LABEL, language, (l) =>
              useSettings.getState().setMatchLanguage(l)
            )
          )
        }
      />
    </SettingsGroup>
  );
}

/**
 * ByTune account — the cloud layer above the YouTube cookie. Guests keep
 * everything local; signed-in users get automatic cloud backup of library,
 * playlists, history and settings. Backups always run on top of the local
 * copy: restoring never deletes anything without writing a local backup
 * first (userData/data/backups).
 */
function CloudAccountGroup() {
  const toast = useUI((st) => st.toast);
  const openDialog = useUI((st) => st.openDialog);
  const session = useSession();
  const [status, setStatus] = useState<{
    lastSyncAt: number | null;
    state: "idle" | "syncing" | "pending" | "error";
    lastError: string | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  // Keep the sync-status line honest: poll while mounted (cheap local IPC),
  // plus refresh after every mode change.
  useEffect(() => {
    let cancelled = false;
    const poll = (): void => {
      void window.bytune
        ?.syncStatus()
        .then((st) => {
          if (!cancelled) {
            const s = st as { lastSyncAt: number | null; state?: string; lastError?: string | null } | undefined;
            setStatus({
              lastSyncAt: s?.lastSyncAt ?? null,
              state: (s?.state as "idle" | "syncing" | "pending" | "error") ?? "idle",
              lastError: s?.lastError ?? null,
            });
          }
        })
        .catch(() => undefined);
    };
    poll();
    const t = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [session.mode]);

  const run = async (fn: () => Promise<unknown>, done: string): Promise<void> => {
    setBusy(true);
    try {
      await fn();
      toast(done, "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Sync failed", "error");
    } finally {
      setBusy(false);
    }
  };

  const signOutWithConfirm = (): void => {
    openDialog({
      title: "Sign out of ByTune?",
      body: "Your account data is safely backed up to the cloud. You can sign in again any time to restore it.",
      confirmLabel: "Sign out",
      cancelLabel: "Cancel",
      onConfirm: () => void run(async () => { await window.bytune?.authSignOut(); }, "Signed out"),
    });
  };

  const changeUsername = (): void => {
    openDialog({
      title: "Change username",
      body: "Letters, numbers, _ and @. The new name must not already be taken.",
      initialValue: session.username ?? "",
      confirmLabel: "Rename",
      onConfirm: (value) => {
        const next = value.trim();
        if (!next || next === session.username) return;
        void run(async () => {
          await window.bytune?.authSetUsername(next);
          await useSession.getState().refresh();
        }, `Username changed to ${next}`);
      },
    });
  };

  const signedIn = session.mode === "account";
  const subtitle = !session.loaded
    ? "…"
    : signedIn
      ? status?.state === "syncing"
        ? "Syncing…"
        : status?.state === "error"
          ? `Sync error, will retry${status.lastError ? "" : ""}`
          : status?.state === "pending"
            ? "Pending changes"
            : status?.lastSyncAt
              ? `Synced ${new Date(status.lastSyncAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
              : "Signed in, backing up automatically"
      : session.mode === "guest"
        ? "Your data is stored only on this device"
        : "Not signed in";

  return (
    <SettingsGroup
      header="ByTune account"
      footer={
        signedIn
          ? "Backup runs automatically. Changes upload within seconds. Restore replaces this device's copy with the cloud version (a local backup is kept first)."
          : "Create an account to keep your library safe even if this PC's app data is wiped."
      }
    >
      <SettingsRow
        icon={signedIn ? UserRound : User}
        title={signedIn ? (session.username ?? "Account") : session.mode === "guest" ? "Guest" : "No account"}
        subtitle={subtitle}
        badge={session.mode === "guest" ? "Guest" : undefined}
        trailing={
          signedIn ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                changeUsername();
              }}
              className="h-7 px-2.5 rounded-md bg-ink-hi/[0.08] hover:bg-ink-hi/[0.14] text-[12px] font-semibold text-ink-hi transition-colors"
            >
              Change
            </button>
          ) : undefined
        }
      />
      <div className="px-4 pb-3 flex flex-wrap gap-2">
        {signedIn ? (
          <>
            <button
              onClick={() => void run(async () => { await window.bytune?.syncBackupNow(); }, "Backup complete")}
              disabled={busy}
              className="h-9 px-3.5 rounded-lg bg-ink-hi/[0.08] hover:bg-ink-hi/[0.14] text-[13px] font-semibold text-ink-hi transition-colors disabled:opacity-40 inline-flex items-center gap-1.5"
            >
              <CloudUpload className="w-4 h-4" /> Back up now
            </button>
            <button
              onClick={() => void run(async () => { await window.bytune?.syncRestoreNow(); }, "Restored from cloud")}
              disabled={busy}
              className="h-9 px-3.5 rounded-lg bg-ink-hi/[0.08] hover:bg-ink-hi/[0.14] text-[13px] font-semibold text-ink-hi transition-colors disabled:opacity-40 inline-flex items-center gap-1.5"
            >
              <CloudDownload className="w-4 h-4" /> Restore from cloud
            </button>
            <button
              onClick={signOutWithConfirm}
              disabled={busy}
              className="h-9 px-3.5 rounded-lg border border-red-500/30 text-red-400 hover:bg-red-500/10 text-[13px] font-semibold transition-colors disabled:opacity-40"
            >
              Sign out
            </button>
          </>
        ) : (
          <button
            onClick={async () => {
              // Guests upgrade by re-running onboarding; their local data
              // stays and merges into the account on the first sync.
              if (session.mode === "guest") {
                try {
                  await window.bytune?.authClearGuestProfile();
                } catch {
                  useUI.getState().toast("Couldn't open onboarding. Try again.", "error");
                  return;
                }
              }
              void useSession.getState().refresh();
            }}
            className="h-9 px-3.5 rounded-lg bg-accent text-[13px] font-semibold text-on-primary hover:brightness-110"
          >
            {session.mode === "guest" ? "Create account / sign in" : "Sign in or create account"}
          </button>
        )}
      </div>
    </SettingsGroup>
  );
}

export function SettingsView() {
  const s = useSettings();
  const toast = useUI((st) => st.toast);
  const openDialog = useUI((st) => st.openDialog);
  const versions = window.bytune?.versions;
  const session = useSession();
  const [guestDeleteOpen, setGuestDeleteOpen] = useState(false);
  const [folderSummary, setFolderSummary] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  // "Search settings": show the rows whose words match (a group header match
  // shows its whole group), after every render so conditional rows follow.
  // Inline display, not [hidden]: utility display classes outrank [hidden].
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const q = filter.trim().toLowerCase();
    const hits = (el: Element | null): boolean => !!el && (el.textContent ?? "").toLowerCase().includes(q);
    const show = (el: HTMLElement, on: boolean): void => {
      el.style.display = on ? "" : "none";
    };
    root.querySelectorAll<HTMLElement>("[data-setting-divider]").forEach((d) => show(d, !q));
    let anyGroup = false;
    root.querySelectorAll<HTMLElement>("[data-setting-group]").forEach((group) => {
      const rows = [...group.querySelectorAll<HTMLElement>("[data-setting-row]")];
      const headerHit = !!q && hits(group.querySelector("h2"));
      let anyRow = false;
      for (const row of rows) {
        const on = !q || headerHit || hits(row);
        show(row, on);
        anyRow ||= on;
      }
      const on = !q || (rows.length ? anyRow : hits(group));
      show(group, on);
      anyGroup ||= on;
    });
    const empty = root.querySelector<HTMLElement>("[data-settings-empty]");
    if (empty) show(empty, !!q && !anyGroup);
  });

  const refreshFolderSummary = async (): Promise<void> => {
    const lib = await window.bytune?.localLibrary();
    const n = lib?.folders?.length ?? 0;
    setFolderSummary(n === 0 ? "No folders imported yet" : `${n} folder${n === 1 ? "" : "s"} imported`);
  };

  useEffect(() => {
    void refreshFolderSummary();
  }, []);

  const browse = async (): Promise<void> => {
    if (!window.bytune) return;
    try {
      const dir = await window.bytune.pickFolder();
      if (dir) {
        s.setDownloadDir(dir);
        toast("Download folder updated", "success");
      }
    } catch {
      toast("Couldn't open the folder picker", "error");
    }
  };

  const chooseMusicFolder = async (): Promise<void> => {
    if (!window.bytune) return;
    try {
      const dir = await window.bytune.pickFolder();
      if (!dir) return;
      toast("Importing folder…", "info");
      const res = await window.bytune.addLibraryFolders([dir]);
      if (res.added.length === 0) {
        setFolderSummary(`${res.lib.folders.length} folders imported`);
        toast("That folder is already in your library", "info");
        return;
      }
      s.setLocalMusicFolder(dir);
      await window.bytune.scanLibrary(s.filterNonMusicAudio);
      setFolderSummary(`${res.lib.folders.length} folder${res.lib.folders.length === 1 ? "" : "s"} imported`);
      toast("Local library scanned", "success");
    } catch {
      toast("Couldn't import that folder", "error");
    }
  };

  const rescanMusic = async (): Promise<void> => {
    if (!window.bytune) return;
    const lib = await window.bytune.localLibrary();
    if (!lib?.folders?.length) {
      toast("Import a local folder first", "info");
      return;
    }
    toast("Rescanning local library…", "info");
    try {
      await window.bytune.scanLibrary(s.filterNonMusicAudio);
      toast("Local library updated", "success");
    } catch {
      toast("Rescan failed", "error");
    }
  };

  const exportData = async (): Promise<void> => {
    if (!window.bytune) return;
    try {
      const res = await window.bytune.backupExport();
      if (res?.path) toast("Backup saved", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Export failed", "error");
    }
  };

  const importData = async (): Promise<void> => {
    if (!window.bytune) return;
    try {
      const res = await window.bytune.backupImport();
      if (res?.restored) {
        toast(
          `Backup restored${typeof res.months === "number" && res.months > 0 ? ` (${res.months} months of history)` : ""}. Reloading…`,
          "success"
        );
        window.setTimeout(() => window.location.reload(), 900);
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : "Import failed", "error");
    }
  };

  const resetAppData = async (): Promise<void> => {
    if (!window.bytune) return;
    try {
      // Main-process wipe: every store, history buckets and derived caches.
      // Downloaded audio files are the user's files and stay on disk.
      await window.bytune.resetData();
      window.location.reload();
    } catch {
      toast("Couldn't reset app data", "error");
    }
  };

  return (
    <div ref={rootRef} className="max-w-2xl pb-14">
      <h1 className="font-display text-[34px] font-extrabold tracking-[-0.03em] text-ink-hi px-5 pt-2 pb-3.5">
        Settings
      </h1>
      <div className="mx-4 relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-dim pointer-events-none" />
        <input
          id="settings-filter"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && filter) {
              e.stopPropagation();
              setFilter("");
            }
          }}
          placeholder="Search settings"
          aria-label="Search settings"
          className="w-full h-10 rounded-full bg-panel pl-9 pr-4 text-[14px] text-ink-hi placeholder:text-ink-dim outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
        />
      </div>
      <p data-settings-empty style={{ display: "none" }} className="px-5 pt-8 text-[14px] text-ink-dim">
        No settings match “{filter.trim()}”.
      </p>

      <div data-setting-group>
        <CloudAccountGroup />
      </div>

      <ConnectedServicesGroup />

      <SettingsGroup header="Audio quality">
        <SettingsRow
          icon={Wifi}
          title="Streaming quality"
          subtitle="Ceiling for streamed audio"
          value={STREAM_QUALITY_LABEL[s.streamingQuality]}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) =>
            toggleDropdownAt(
              e,
              qualityMenu(
                ["low", "medium", "high", "lossless"],
                STREAM_QUALITY_LABEL,
                s.streamingQuality,
                s.setStreamingQuality
              )
            )
          }
        />
      </SettingsGroup>

      <SettingsGroup header="Volume">
        <SettingsRow
          icon={Gauge}
          title="Volume leveling"
          subtitle="Bring every song to a similar loudness"
          value={LOUDNESS_LABEL[s.loudnessLevel]}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) =>
            toggleDropdownAt(e, qualityMenu(["off", "quiet", "normal", "loud"], LOUDNESS_LABEL, s.loudnessLevel, s.setLoudnessLevel))
          }
        />
      </SettingsGroup>

      <OutputDeviceGroup />

      <SettingsGroup
        header="Downloads"
        footer="Export compatible saves into your Music library (Music/ByTune) so other players can use the files; otherwise downloads stay in the folder above."
      >
        <SettingsRow
          icon={FolderOpen}
          title="Download folder"
          subtitle={s.downloadDir ?? "Default: your system Downloads folder / ByTune"}
          onClick={() => void browse()}
        />
        <Divider />
        <SettingsRow
          icon={Download}
          title="Download quality"
          subtitle="What a saved track costs on disk"
          value={DOWNLOAD_QUALITY_LABEL[s.downloadQuality]}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) =>
            toggleDropdownAt(
              e,
              qualityMenu(
                ["standard", "high", "lossless"],
                DOWNLOAD_QUALITY_LABEL,
                s.downloadQuality,
                s.setDownloadQuality
              )
            )
          }
        />
        <SettingsSubRow
          title="Export compatible downloads"
          checked={s.exportDownloads}
          onChange={s.setExportDownloads}
          badge={s.exportDownloads ? "Music/ByTune" : undefined}
        />
      </SettingsGroup>

      <SettingsGroup header="Playback">
        {/* Also the Automix blend length, so it stays visible; at 0 Automix picks 6s. */}
        <SliderRow
          icon={Activity}
          title="Crossfade"
          subtitle="Blend the end of one track into the next"
          value={s.crossfadeSeconds === 0 ? (s.smartFade ? "Auto" : "Off") : `${s.crossfadeSeconds}s`}
          min={0}
          max={12}
          step={1}
          current={s.crossfadeSeconds}
          onChange={s.setCrossfadeSeconds}
        />
        <Divider />
        <SettingsRow
          icon={Sparkles}
          title="Automix"
          subtitle={
            s.smartFade
              ? "Blends where the music really ends and lines up beats when tempos match"
              : "Off: blends use the crossfade length above"
          }
          trailing={<Switch checked={s.smartFade} onChange={s.setSmartFade} />}
          onClick={() => s.setSmartFade(!s.smartFade)}
        />
        <Divider />
        <SettingsRow
          icon={VolumeX}
          title="Skip silence"
          subtitle="Skip the silence at the start and end of songs"
          trailing={<Switch checked={s.skipSilence} onChange={s.setSkipSilence} />}
          onClick={() => s.setSkipSilence(!s.skipSilence)}
        />
        <Divider />
        <SettingsRow
          icon={InfinityIcon}
          title="Autoplay"
          subtitle="When your songs run out, keep playing music like them"
          trailing={<Switch checked={s.autoplay} onChange={s.setAutoplay} />}
          onClick={() => s.setAutoplay(!s.autoplay)}
        />
        <Divider />
        <SliderRow
          icon={Gauge}
          title="Playback speed"
          subtitle="Pitch-preserving tempo for everything you play"
          value={`${s.playbackSpeed.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1")}x`}
          min={0.5}
          max={2}
          step={0.05}
          current={s.playbackSpeed}
          onChange={s.setPlaybackSpeed}
        />
        <Divider />
        <EqualizerRows />
      </SettingsGroup>

      <SettingsGroup header="Appearance">
        <SettingsRow
          icon={AppWindow}
          title="Reduce animation"
          subtitle="Cut crossfades and motion through the app"
          trailing={<Switch checked={s.reduceAnimation} onChange={s.setReduceAnimation} />}
          onClick={() => s.setReduceAnimation(!s.reduceAnimation)}
        />
        <Divider />
        <SettingsRow
          icon={Droplets}
          title="Reduce dynamic blur"
          subtitle="Fill glass surfaces solid instead of blurring"
          trailing={<Switch checked={s.reduceDynamicBlur} onChange={s.setReduceDynamicBlur} />}
          onClick={() => s.setReduceDynamicBlur(!s.reduceDynamicBlur)}
        />
        <Divider />
        <SettingsRow
          icon={Sparkles}
          title="Liquid glass"
          subtitle="Refractive glass on the floating chrome"
          trailing={<Switch checked={s.liquidGlass} onChange={s.setLiquidGlass} disabled={s.reduceDynamicBlur} />}
          onClick={() => s.setLiquidGlass(!s.liquidGlass)}
        />
        <Divider />
        <SettingsRow
          icon={Maximize2}
          title="Full-screen cover art"
          subtitle="Let the artwork bleed behind the status area"
          trailing={<Switch checked={s.fullBleedArtwork} onChange={s.setFullBleedArtwork} />}
          onClick={() => s.setFullBleedArtwork(!s.fullBleedArtwork)}
        />
        <Divider />
        <SettingsRow
          icon={Image}
          title="Legacy mesh gradient"
          subtitle="Use the older drifting-blob player backdrop"
          trailing={<Switch checked={s.legacyMeshGradient} onChange={s.setLegacyMeshGradient} />}
          onClick={() => s.setLegacyMeshGradient(!s.legacyMeshGradient)}
        />
        <Divider />
        <SettingsRow
          icon={Music4}
          title="Animated cover art"
          subtitle="Play canvas clips in place of the still cover"
          trailing={<Switch checked={s.animatedCanvas} onChange={s.setAnimatedCanvas} />}
          onClick={() => s.setAnimatedCanvas(!s.animatedCanvas)}
        />
        <Divider />
        <SettingsRow
          icon={ListMusic}
          title="Synced lyrics"
          subtitle="Highlight the current line and auto-scroll"
          trailing={<Switch checked={s.syncedLyrics} onChange={s.setSyncedLyrics} />}
          onClick={() => s.setSyncedLyrics(!s.syncedLyrics)}
        />
        {s.syncedLyrics && (
          <>
            <Divider />
            <SettingsRow
              icon={Droplets}
              title="Blur unfocused lyrics"
              subtitle="Keep the spotlight on the current line"
              trailing={<Switch checked={s.blurUnfocusedLyrics} onChange={s.setBlurUnfocusedLyrics} />}
              onClick={() => s.setBlurUnfocusedLyrics(!s.blurUnfocusedLyrics)}
            />
            <Divider />
            <SettingsRow
              icon={Languages}
              title="Romanized lyrics"
              subtitle="Show a Latin-letters reading under lyrics in other scripts, like Hindi, Telugu or Korean"
              trailing={<Switch checked={s.romanizeLyrics} onChange={s.setRomanizeLyrics} />}
              onClick={() => s.setRomanizeLyrics(!s.romanizeLyrics)}
            />
            <Divider />
            <SliderRow
              icon={Timer}
              title="Lyrics timing"
              subtitle="On this device, for headphones that lag. [ and ] adjust one song while lyrics are open"
              value={describeLyricsShift(s.lyricsOffset)}
              min={-3}
              max={3}
              step={0.05}
              current={s.lyricsOffset}
              onChange={s.setLyricsOffset}
            />
          </>
        )}
      </SettingsGroup>

      <SettingsGroup header="Local music">
        <SettingsRow
          icon={FolderOpen}
          title="Local music folders"
          subtitle={folderSummary ?? "Your imported collections"}
          onClick={() => useUI.getState().navigate({ name: "local" })}
        />
        <Divider />
        <SettingsRow
          icon={ListMusic}
          title="Add a folder"
          subtitle="Import music folders — a parent folder brings its music subfolders along"
          onClick={() => void chooseMusicFolder()}
        />
        <Divider />
        <SettingsRow
          icon={RefreshCw}
          title="Rescan library"
          subtitle="Re-read tags and artwork from every imported folder"
          onClick={() => void rescanMusic()}
        />
        <Divider />
        <SettingsRow
          icon={Music4}
          title="Filter non-music audio"
          subtitle="Hide clips, recordings and voice notes (applies on rescan)"
          trailing={<Switch checked={s.filterNonMusicAudio} onChange={(v) => { s.setFilterNonMusicAudio(v); void rescanMusic(); }} />}
          onClick={() => { s.setFilterNonMusicAudio(!s.filterNonMusicAudio); void rescanMusic(); }}
        />
      </SettingsGroup>



      <SettingsGroup header="Your data">
        <SettingsRow
          icon={BarChart3}
          title="Replay"
          subtitle="Your listening wrapped over time"
          onClick={() => useUI.getState().navigate({ name: "replay" })}
        />
        <Divider />
        <SettingsRow
          icon={FileUp}
          title="Export data"
          subtitle="Write a backup of your library and history"
          onClick={() => void exportData()}
        />
        <Divider />
        <SettingsRow
          icon={FileDown}
          title="Import data"
          subtitle="Restore a backup, replacing what's here"
          onClick={() =>
            openDialog({
              title: "Import a backup?",
              body: "Your current library, playlists and history will be replaced by the backup's.",
              confirmLabel: "Choose file",
              danger: true,
              onConfirm: () => void importData(),
            })
          }
        />
      </SettingsGroup>

      <SettingsGroup
        header="Miscellaneous"
        footer="These apply to this desktop client and are stored locally."
      >
        <SettingsRow
          icon={ListMusic}
          title="Don't repeat suggestions"
          subtitle="Keep recently played tracks out of the home feed"
          trailing={<Switch checked={s.dontRepeatSuggestions} onChange={s.setDontRepeatSuggestions} />}
          onClick={() => s.setDontRepeatSuggestions(!s.dontRepeatSuggestions)}
        />
        <Divider />
        <SettingsRow
          icon={VolumeX}
          title="Hide volume bar"
          subtitle="Keep the player bar free of the volume slider"
          trailing={<Switch checked={s.hideVolumeBar} onChange={s.setHideVolumeBar} />}
          onClick={() => s.setHideVolumeBar(!s.hideVolumeBar)}
        />
      </SettingsGroup>

      <SettingsGroup header="About">
        <SettingsRow
          icon={Globe}
          title="ByTune website"
          subtitle="bytune.space — downloads, news and help"
          trailing={<ExternalLink className="w-4 h-4 text-ink-dim" />}
          onClick={() => window.open("https://bytune.space", "_blank", "noopener")}
        />
      </SettingsGroup>



      <SettingsGroup header="Danger zone">
        <SettingsRow
          icon={Trash2}
          title="Reset app data"
          subtitle="Erase library, playlists, history and settings on this device"
          onClick={() => {
            // Guests have no cloud backup — deletion is unrecoverable, so
            // route through the dedicated protection modal instead.
            if (session.mode === "guest") {
              setGuestDeleteOpen(true);
              return;
            }
            openDialog({
              title: "Reset local data?",
              body: "Your local ByTune data will be removed from this device. Your account and cloud backup won't be deleted. Sign in again and everything restores. Downloaded audio files are not touched.",
              confirmLabel: "Reset local data",
              danger: true,
              onConfirm: () => void resetAppData(),
            });
          }}
        />
      </SettingsGroup>

      {guestDeleteOpen && (
        <GuestDeleteModal
          onClose={() => setGuestDeleteOpen(false)}
          onSignIn={async () => {
            setGuestDeleteOpen(false);
            try {
              await window.bytune?.authClearGuestProfile();
            } catch {
              useUI.getState().toast("Couldn't open onboarding. Try again.", "error");
              return;
            }
            setOnboardingIntent("signin");
            void useSession.getState().refresh();
          }}
          onCreateAccount={async () => {
            setGuestDeleteOpen(false);
            try {
              await window.bytune?.authClearGuestProfile();
            } catch {
              useUI.getState().toast("Couldn't open onboarding. Try again.", "error");
              return;
            }
            setOnboardingIntent("signup");
            void useSession.getState().refresh();
          }}
          onDeleteAnyway={() => {
            setGuestDeleteOpen(false);
            void resetAppData();
          }}
        />
      )}


      <div className="text-center text-[11px] text-ink-dim/80 pt-6 px-5 leading-relaxed">
        ByTune {versions?.app ?? "1.0.0"} · GPL-3.0
      </div>
    </div>
  );
}