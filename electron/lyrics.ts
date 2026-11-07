/**
 * Lyrics providers for the desktop player — BitChord's lyrics system, in
 * ByTune's own code: the same sources, in the same order, asked and chosen
 * between the same way.
 *
 * The recording is settled first: the BiniLyrics search names it by ISRC
 * (identifyRecording), so lrc.red fetches that very recording's document and
 * LyricsPlus asks for it by code. Every source is asked at once (Genius, a
 * scraper, only when nothing else answered), and the answers are taken in
 * priority order (takeInPriorityOrder): a lower source finishing first never
 * beats one still pending above it, and the highest-priority source with
 * timed lyrics wins — word or line timing, BitChord's default. Plain text is
 * the fallback.
 *
 * One thing on top of BitChord: every source that searches by name must name
 * the playing recording before its words are used (namesRecording) — the same
 * song, the same version words ("Live", "Remix", "Sped Up", "Versión Pop"…)
 * and a shared artist. BitChord checks this for lrc.red's search only, and
 * trusts the rest; a miss is recoverable — the next source gets its turn —
 * and the wrong words scrolling in time with the right song are not. So the
 * check doesn't refuse what BitChord would rightly show, it reads names the
 * way catalogues write them: Traditional and Simplified Chinese alike, an
 * artist in another script by the entry's length, "(Album Version)" as a
 * label, "Artist - Song (Lyrics)" uploads by their dash, and the playing
 * release's own entry ("Despacito (Versión Pop)") for its title track. A music
 * video takes the identify step's recording at the album length, as BitChord's
 * identify does.
 *
 * The order: lrc.red → BiniLyrics → BetterLyrics (Apple TTML) → Portato (QQ
 * Music karaoke timings) → PaxSenix (Apple TTML via a public proxy) →
 * LyricsPlus (syllable mirrors) → Unison → the playing video's own captions →
 * YT Music's Lyrics tab → KuGou → LRCLIB → Musixmatch (signed the way its web
 * client signs) → Genius.
 *
 * All timings are SECONDS end-to-end — providers that serve milliseconds
 * convert at the parse boundary, which is exactly where the classic "lyrics
 * don't match" bug hides.
 */
import { createHmac, randomUUID } from "node:crypto";
import type { SyncedLyricLine, SyncedLyricWord } from "../src/types";
import { foldHan } from "./hanFold";

export interface LyricQuery {
  id: string;
  title: string;
  artist: string;
  album?: string;
  /** seconds, 0 = unknown */
  duration: number;
}

export interface ProviderResult {
  source: string;
  wordSynced: boolean;
  lines: SyncedLyricLine[];
  /** set when the provider only answered with untimed text */
  plainText?: string;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const LYRICS_AGENT = "ByTune (https://github.com/bytune-music)";

async function getText(
  url: string,
  timeoutMs = 6000,
  headers: Record<string, string> = {},
  /** Called when the host never answered at all — DNS, refused, timed out — rather than said no. */
  onUnreachable?: () => void,
  /** Called with the status when the host answered with an HTTP error. */
  onHttpError?: (status: number) => void
): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": LYRICS_AGENT, Accept: "application/json", ...headers },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.log(`[bytune][lyrics-net] HTTP ${res.status} ${url.slice(0, 90)}`);
      onHttpError?.(res.status);
      return null;
    }
    return await res.text();
  } catch (err) {
    console.log(`[bytune][lyrics-net] FAIL ${url.slice(0, 90)} :: ${err instanceof Error ? err.message : err}`);
    onUnreachable?.();
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------------------- shared parsing ---------------------------- */

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** [mm:ss.xx] or [mm:ss.xxx] → seconds. Hundredths get ×10 to ms first. */
function stampMs(min: string, sec: string, frac: string): number {
  const m = parseInt(min, 10);
  const s = parseInt(sec, 10);
  const f = parseInt(frac.padEnd(3, frac.length === 2 ? "0" : ""), 10);
  return (m * 60 + s) * 1000 + f;
}

/** Placeholders the mixed search page prints when a row carries no credit
 * links ("Unknown artist", same as BitChord mobile) — never a real credit,
 * so the lyric databases must not be asked with it: they key on artist +
 * title and miss every such track. An empty artist degrades each provider
 * to title-based matching instead. */
const PLACEHOLDER_ARTISTS = new Set(["", "unknown artist", "unknown", "various artists", "artist"]);

/** YouTube's auto-generated channels for licensed music are "Artist - Topic". */
function untopic(artist: string): string {
  return artist.replace(/\s+-\s+Topic\s*$/i, "");
}

/** The artist every source is asked with — BitChord's artistForLyricsSearch: the whole credit, " - Topic" off.
 * A " & " or "," inside it is usually one name ("Simon & Garfunkel", "Earth, Wind & Fire", "Tyler, The Creator"). */
function searchArtist(artist: string): string {
  const credit = untopic(artist).trim();
  return PLACEHOLDER_ARTISTS.has(credit.toLowerCase()) ? "" : credit;
}

/** The credit in both of BitChord's forms: off a search, album or playlist row it lists the names "A, B, C"; off the
 * queue it keeps YouTube's "A, B & C". BetterLyrics and Portato answer keyless clients only from what was asked
 * before, so both are tried, the list first — a band named with "&" ("Simon & Garfunkel") answers to the second. */
function creditForms(artist: string): string[] {
  const credit = searchArtist(artist);
  const list = credit.replace(/ & (?!.* & )/, ", ");
  return list === credit ? [credit] : [list, credit];
}

/** How far a matched rendition's own runtime may sit from the playing track
 * before the two are different edits: offset alignment repairs a constant
 * intro, never a different tempo. Generous on purpose — an upload that runs
 * a few seconds long still lines up. */
function withinTolerance(recordSec: number | null | undefined, playingSec: number): boolean {
  if (!recordSec || !playingSec) return true;
  return Math.abs(recordSec - playingSec) <= Math.max(12, playingSec * 0.08);
}

/**
 * Title for provider QUERIES: strips any parenthetical/bracket too — YT Music
 * titles carry credit noise like "WILDFLOWER (BILLIE BY FINNEAS)", and every
 * catalogue 401s or mismatches on it. The display title stays untouched.
 */
function queryTitle(title: string): string {
  const base = cleanTitle(title)
    .replace(/\([^)]*\)|\[[^\]]*]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return base || cleanTitle(title);
}

/** Strip the noise YouTube titles carry: "(Official Video)", "[HD]" … */
function cleanTitle(title: string): string {
  return (
    title
      .replace(/\((official\s+)?(music\s+)?(lyric[s]?\s+)?(video|audio|visualizer?|mv)\)/gi, "")
      .replace(/\[(official\s+)?(music\s+)?(lyric[s]?\s+)?(video|audio|hd|4k)\]/gi, "")
      // A label tail ("- Official Video HD", "- Lyrics (HD)"), never a song that starts with the word ("- Video Games").
      .replace(
        /\s*-\s*(?:official\s+)?(?:music\s+)?(?:lyrics?|lyrical|audio|video|visuali[sz]er|mv)\b(?=\s*(?:$|[-–—|(\[\/&+:]|(?:official|oficial|music|lyrics?|lyrical|audio|video|visuali[sz]er|song|mv|hd|hq|4k)\b)).*$/i,
        ""
      )
      .replace(/\|.*$/, "")
      // A K-pop upload's closing tag: "GANGNAM STYLE(강남스타일) M/V".
      .replace(/\s+(?:official\s+)?m\/?v\s*$/i, "")
      // An upload's unbracketed lyric label: "周杰倫 - 告白氣球 歌詞", "Artist - Song Lyrics".
      .replace(/^(.+\s-\s.+?)\s+(?:with\s+)?(?:lyrics?|letra|歌詞|歌词|가사)\s*$/i, "$1")
      .trim()
  );
}

/**
 * The title as a catalogue files it, for sources asked once and trusted:
 * credits ("(feat. …)", "ft. …") and upload labels ("(Official Video)",
 * "[Lyrics]") off, and everything else — "(Live)", "(Remix)", "(From …)" —
 * kept, so the search asks for this recording rather than another one.
 */
function searchTitle(title: string): string {
  const name = cleanTitle(title)
    .replace(/\s*[(\[]\s*(?:feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]/gi, " ")
    .replace(/\s(?:feat\.?|ft\.?|featuring)\s.*$/i, " ")
    .replace(
      /\s*[(\[]\s*(?:official\s*)?(?:music\s*)?(?:hd\s*)?(?:video|audio|visuali[sz]er|lyrics?\s*video|lyrics?|m\/?v|hd|hq|4k|full\s*song|official)\s*[)\]]/gi,
      " "
    )
    .replace(/\s+/g, " ")
    .replace(/[\s,–—-]+$/, "")
    .trim();
  return name || cleanTitle(title);
}

/* ---------------------- naming the playing recording --------------------- */

/**
 * Words that, in brackets or after a " - ", name a different recording rather
 * than a different label: "Song (Live)", "Song - Acoustic", "(Sped Up)",
 * "(Versión Pop)", a DJ's "(Hype Intro)" edit, "(TV ver.)", "(Japanese ver.)".
 * A remaster note, "(From …)", "(feat. …)", "(Explicit)", a release label —
 * "(Album/Main/Single Version)", 唱片版 — or a translated title name the same
 * recording and stay out of the comparison.
 */
const VERSION_WORDS = new Set([
  "live", "vivo", "directo", "concierto", "concert", "remix", "remixed", "rmx", "mix", "mixed", "mashup", "bootleg",
  "flip", "rework", "vip", "dj", "edit", "extended", "intro", "outro", "acoustic", "acustico", "acustica", "unplugged",
  "instrumental", "inst", "karaoke", "cappella", "acapella", "demo", "maqueta", "take", "outtake", "alternate",
  "rehearsal", "session", "sessions", "version", "ver", "cover", "sped", "speed", "slowed", "slow", "reverb",
  "nightcore", "daycore", "lofi", "chopped", "screwed", "8d", "orchestral", "symphonic", "reprise", "pt", "part",
]);

/** The same, as Chinese, Japanese and Korean catalogues write it: 现场版, 演唱会, DJ…版, 伴奏, 0.8x, ライブ, 라이브… */
const VERSION_MARKS =
  /演唱会|演唱會|音乐会|音樂會|라이브|版|现场|現場|混音|伴奏|翻唱|纯音乐|純音樂|片段|剪辑|剪輯|铃声|鈴聲|抖音|倍速|加速|降速|慢速|ライブ|リミックス|アコースティック|カラオケ|インスト|バージョン|\b\d+(?:\.\d+)?x\b/gi;

/** One token per kind of version, in any language: "(En Vivo)" meets "(Live)", "演唱會" meets "现场". */
const VERSION_SAME = new Map<string, string>([
  ["vivo", "live"], ["directo", "live"], ["concierto", "live"], ["concert", "live"], ["演唱会", "live"],
  ["演唱會", "live"], ["音乐会", "live"], ["音樂會", "live"], ["现场", "live"], ["現場", "live"], ["ライブ", "live"],
  ["라이브", "live"], ["acustico", "acoustic"], ["acustica", "acoustic"], ["maqueta", "demo"],
]);

/** Qualifiers that only label a release: "(Album Version)", "(Main Version - Clean)", "(Explicit Ver.)". */
const LABEL_WORDS = new Set(["album", "main", "single", "lp", "original", "explicit", "clean", "studio", "mono", "stereo"]);
/** The same before 版: 唱片版, 录音室版, 正式版, 原版. */
const LABEL_BAN = /^(?:唱片|录音室|錄音室|正式|原)$/;

/** A tempo edit sings the same words at another speed: "(Sped Up Version)", "(Slowed + Reverb)", "(Nightcore)". */
const TEMPO_EDIT = /\b(?:sped|speed|slowed|slow|reverb|nightcore|daycore|8d|lo-?fi|chopped|screwed)\b/i;

/** A bracket, one level of brackets inside it included: "[The Official 2010 FIFA World Cup (TM) Song]". */
const NAME_BRACKETS = /[(\[【「](?:[^()\[\]【】「」]|[(\[【「][^()\[\]【】「」]*[)\]】」])*[)\]】」]/g;
const CREDIT_GROUP = /^.\s*(?:feat\.?|ft\.?|featuring|with|from|prod\.?|produced\s+by)\s/i;
const LATIN = /\p{Script=Latin}/u;
const HAN = /\p{Script=Han}/u;

/** Lower case, Latin accents folded ("Versión" → "version", "Señorita" → "senorita"), Chinese in its Simplified
 * form ("周杰倫" → "周杰伦"), only letters, marks and digits — Indic vowel signs and kana marks stay. */
function plainWords(s: string): string {
  return foldHan(
    s
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
      .trim()
  );
}

interface RecordingName {
  /** The song's own name: brackets, an unbracketed "feat." and anything after " - " left out. */
  core: string;
  /** The same name in another script, from a bracket ("Échame La Culpa (把错都推给我吧)", "봄날 (Spring Day)"). */
  aliases: string[];
  /** Its version words, sorted — "" for the plain recording. */
  versions: string;
}

const isVer = (w: string): boolean => w === "version" || w === "ver";

/** "Song (Live) [feat. X] - 2011 Remaster" → core "song", versions "live". `plainText`: untimed words don't care
 * how fast they are sung, so a tempo edit's group ("[Sped Up Version]") names nothing. */
function recordingName(title: string, plainText = false): RecordingName {
  const name = cleanTitle(title).normalize("NFKC");
  const groups = name.match(NAME_BRACKETS) ?? [];
  let core = name.replace(NAME_BRACKETS, " ");
  const dash = core.indexOf(" - ");
  const tail = dash >= 0 ? core.slice(dash + 3) : "";
  if (dash >= 0) core = core.slice(0, dash);
  core = plainWords(core.replace(/\s(?:feat\.?|ft\.?|featuring)\s.*$/i, "")) || plainWords(name);
  const versions = new Set<string>();
  const aliases: string[] = [];
  for (const part of [...groups, tail]) {
    if (!part.trim() || CREDIT_GROUP.test(part)) continue;
    // "(2011 Remastered Version)" is still the same recording; "(Live … - Remastered)" is not.
    const remaster = /remaster/i.test(part);
    const tempo = plainText && TEMPO_EDIT.test(part);
    // "Live版" → "live 版", "Lo-Fi" → "lofi": a word glued to a mark, or split by a hyphen, still counts.
    const all = plainWords(part)
      .replace(/(\p{Script=Latin})(\p{Script=Han})/gu, "$1 $2")
      .replace(/(^| )lo fi(?= |$)/g, "$1lofi")
      .split(" ")
      .filter(Boolean);
    const found: string[] = part.match(VERSION_MARKS) ?? [];
    // "Live Version" is "Live" and "现场版" is "现场"; in plain text a tempo edit's words and filler drop out.
    const words = all.filter((w) => VERSION_WORDS.has(w) && !isVer(w) && !(tempo && (TEMPO_EDIT.test(w) || w === "edit")));
    const marks = found.filter((m) => m !== "版");
    if (!words.length && !marks.length && !remaster && !tempo) {
      // "(X Version)" alone: X names the version, unless it only labels the release.
      // shortcut: qualifiers compare as written ("Versión en Español" ≠ "Spanish Version"); map language names if catalogues mix them.
      const qualifier = [...new Set(all.filter((w) => !isVer(w) && !LABEL_WORDS.has(w)))].sort();
      if (qualifier.length && all.some(isVer)) words.push(`version:${qualifier.join("+")}`);
      // "(X版)" the same, X glued to 版: 粤语版 ≠ 国语版, and 唱片版 is a label.
      if (found.includes("版")) {
        for (const m of part.matchAll(/([^\s()\[\]【】「」]*?)版/g)) {
          const x = plainWords(m[1]).replace(/\s+/g, "");
          if (x && !LABEL_BAN.test(x)) marks.push(`版:${x}`);
        }
      }
    }
    for (const w of [...words, ...marks]) versions.add(VERSION_SAME.get(w.toLowerCase()) ?? w.toLowerCase());
    // A bracket in another script that names no version is the title, translated.
    const named = all.some((w) => VERSION_WORDS.has(w)) || found.length > 0;
    if (part !== tail && !named && /\p{L}/u.test(part) && LATIN.test(part) !== LATIN.test(core)) {
      const alias = plainWords(part);
      if (alias) aliases.push(alias);
    }
  }
  return { core, aliases, versions: [...versions].sort().join(" ") };
}

const ARTIST_SPLIT = /\s*(?:,|;|\/|&|\+|、|，|\s(?:and|x|×|with|feat\.?|ft\.?|featuring|vs\.?)\s)\s*/i;
const CREDIT_LEAD = /^\s*(?:feat\.?|ft\.?|featuring|with)\s+/i;
/** Bracket words that describe a credit rather than name one: "(Cover)", "(Originally Performed by …)", "(prod. …)". */
const NOT_A_NAME = new Set([...VERSION_WORDS, "originally", "performed", "famous", "style", "tribute", "prod", "produced", "official"]);

/** Credited artists, normalised: "A, B & C", "A x B", "A、B" (KuGou), "A feat. B". A bracket's names count too —
 * "(Ft. A & B)", the same artist in another script ("버스커 버스커 (Busker Busker)", "Ed Sheeran (艾德·希兰)") —
 * unless the bracket describes the recording ("(X Cover)") or is a bare mark (the "(G)" of "(G)I-DLE").
 * Placeholder credits drop out. */
function artistNames(artist: string): string[] {
  const name = untopic(artist).normalize("NFKC");
  const outside = name.replace(NAME_BRACKETS, " ").split(ARTIST_SPLIT).map(plainWords);
  const inside = (name.match(NAME_BRACKETS) ?? [])
    .map((b) => b.slice(1, -1))
    .filter((b) => CREDIT_LEAD.test(b) || !plainWords(b).split(" ").some((w) => NOT_A_NAME.has(w)))
    .flatMap((b) => b.replace(CREDIT_LEAD, "").split(ARTIST_SPLIT))
    .map(plainWords)
    .filter((a) => a.length > 1 && /\p{L}/u.test(a));
  return [...outside, ...inside].filter((a) => a && !PLACEHOLDER_ARTISTS.has(a));
}

/** Whether two credit lists share an artist — whole names, either way round
 * ("Daryl Hall & John Oates" shares "Hall"; "Pritam, Arijit Singh" shares "Arijit Singh"). Names are plainWords,
 * so a Traditional and a Simplified spelling are already the same ("周杰倫" / "周杰伦"). */
function shareArtist(a: string[], b: string[]): boolean {
  const within = (name: string, list: string[]): boolean => list.some((other) => ` ${other} `.includes(` ${name} `));
  return a.some((x) => within(x, b)) || b.some((y) => within(y, a));
}

function sameName(a: RecordingName, b: RecordingName): boolean {
  return a.versions === b.versions && [a.core, ...a.aliases].some((x) => [b.core, ...b.aliases].includes(x));
}

const CREDIT_SCRIPTS = [LATIN, HAN, /\p{Script=Hangul}/u, /[\p{Script=Hiragana}\p{Script=Katakana}]/u];

/** A bracket of upload labels only: "(Lyrics)", "(Letra/Lyrics)", "[Official Lyric Video HD]". */
const UPLOAD_LABEL =
  /\s*[(\[]\s*(?:(?:official|oficial|music|lyrics?|letra|lyrical|video|audio|visuali[sz]er|mv|hd|hq|4k|with|and|y)\b[\s\/&+,-]*)+[)\]]/gi;

/** Whether two credit lists share a script — "Eason Chan" and "陈奕迅" don't, so no test can compare them. */
function comparable(a: string[], b: string[]): boolean {
  const used = (names: string[]): RegExp[] => CREDIT_SCRIPTS.filter((re) => names.some((n) => re.test(n)));
  const x = used(a);
  const y = used(b);
  return !x.length || !y.length || x.some((re) => y.includes(re));
}

/** What else is known about the entry being checked. */
export interface NameCheck {
  /** The entry's own length in seconds. Within LRCRED_TOLERANCE_SEC of the playing track's, it stands in for
   * credits written in scripts that can't be compared ("Eason Chan" / "陈奕迅"). */
  length?: number | string | null;
  /** Untimed text: a tempo edit ("Sped Up", "Slowed") reads the same words as the song. */
  plainText?: boolean;
}

/**
 * Whether a catalogue entry names the playing recording: the same song once
 * credits and labels are gone, the same version words on both sides, and a
 * shared artist. The artist test is skipped when either side has no real
 * credit — the caller's length check has to carry the match then — and when
 * the credits are in scripts that can't be compared but the entry's own
 * length matches. An "Artist - Song" upload also reads as the song after the
 * dash, as long as the part before it is one of the entry's artists: from the
 * artist's own channel, or from anyone's when only labels ride along.
 */
export function namesRecording(
  name: string,
  artist: string,
  q: Pick<LyricQuery, "title" | "artist"> & { duration?: number },
  check: NameCheck = {}
): boolean {
  const title = cleanTitle(q.title || "").normalize("NFKC");
  const theirName = recordingName(name, check.plainText);
  const theirs = artistNames(artist);
  const mine = artistNames(q.artist || "");
  const length = Number(check.length);
  const uncheckable =
    !comparable(mine, theirs) && length > 0 && !!q.duration && Math.abs(length - q.duration) <= LRCRED_TOLERANCE_SEC;
  const credited = !mine.length || !theirs.length || uncheckable || shareArtist(mine, theirs);
  if (credited && sameName(recordingName(title, check.plainText), theirName)) return true;
  const dash = title.indexOf(" - ");
  if (dash <= 0 || !theirs.length) return false;
  const lead = artistNames(title.slice(0, dash));
  const rest = title.slice(dash + 3);
  // Someone else's upload ("Avicii - Wake Me Up (Lyrics)" by 7clouds) names the song only when nothing but credits
  // and labels ride along: "| Piano Tutorial", "(Glastonbury 2019)", "( s l o w e d )", "[1 HOUR]" are other recordings.
  // A bracket in another script ("(강남스타일)", "(가사)") is the title translated or a label; its version marks
  // still count, through the name comparison below.
  const labels = rest
    .replace(/\s(?:feat\.?|ft\.?|featuring)\s.*?(?=\s-\s|[(\[]|$)/i, " ")
    .replace(UPLOAD_LABEL, " ")
    .replace(/[(\[【「][^\p{Script=Latin}\d()\[\]【】「」]*[)\]】」]/gu, " ");
  const bare =
    !/[|｜]/.test(q.title || "") &&
    !/[(\[【「]| - /.test(searchTitle(labels)) &&
    !(title.slice(0, dash).match(NAME_BRACKETS) ?? []).some((g) => /[\p{Script=Latin}\d]/u.test(g));
  return (
    (credited || bare) &&
    lead.length > 0 &&
    shareArtist(lead, theirs) &&
    sameName(recordingName(rest, check.plainText), theirName)
  );
}

/** "Lyrics by：…", "作曲：…" — a credit stamped like a lyric. */
const CREDIT_LINE = /^[^:：]{1,40}[:：]\s*\S/;

/** The "Title - Artist" line QQ and KuGou stamp at the head of a file, split at its dash. */
function openingName(lines: SyncedLyricLine[]): [string, string] | null {
  const first = lines.find((l) => l.text.trim());
  if (!first || first.time > 2) return null;
  const text = first.text.trim();
  const cut = text.lastIndexOf(" - ");
  return cut > 0 ? [text.slice(0, cut), text.slice(cut + 3)] : null;
}

/** Whether a file's opening name line names the playing recording, read either way round
 * ("Title - Artist" or "Artist - Title"); null when the file has no such line. */
function openingNameFits(
  lines: SyncedLyricLine[],
  q: Pick<LyricQuery, "title" | "artist"> & { duration?: number },
  length?: number | null
): boolean | null {
  const name = openingName(lines);
  if (!name) return null;
  return namesRecording(name[0], name[1], q, { length }) || namesRecording(name[1], name[0], q, { length });
}

/** The lyrics without that opening name line and the credits stamped next to it or at the very end. */
function withoutOpening(lines: SyncedLyricLine[]): SyncedLyricLine[] {
  let start = openingName(lines) ? lines.findIndex((l) => l.text.trim()) + 1 : 0;
  while (start < lines.length && (!lines[start].text.trim() || CREDIT_LINE.test(lines[start].text))) start++;
  let end = lines.length;
  while (end > start && (!lines[end - 1].text.trim() || CREDIT_LINE.test(lines[end - 1].text))) end--;
  return lines.slice(start, end);
}

/** Insert gap markers where ≥5s of nobody sings — instrumental sections. */
function withInstrumentalGaps(lines: SyncedLyricLine[]): SyncedLyricLine[] {
  const out: SyncedLyricLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);
    const next = lines[i + 1];
    if (!next) break;
    const lineEnd = lineEndSec(line, next.time);
    if (next.time - lineEnd >= 5) {
      out.push({ time: lineEnd, text: "", gap: true });
    }
  }
  return out;
}

function lineEndSec(line: SyncedLyricLine, nextStart: number): number {
  if (line.end != null) return line.end;
  const lastWord = line.words?.[line.words.length - 1];
  if (lastWord) return lastWord.end;
  return line.time + Math.min(8, Math.max(2, nextStart - line.time));
}

function toResult(source: string, lines: SyncedLyricLine[]): ProviderResult | null {
  if (!lines.length) return null;
  // Every stamp at 0:00 is unsynced text in LRC form; BitChord reads it as plain (its timeMs > 0 test).
  if (!lines.some((l) => l.time > 0 || l.words?.length)) {
    const plainText = lines.map((l) => l.text.trim()).filter(Boolean).join("\n");
    return plainText ? { source, wordSynced: false, lines: [], plainText } : null;
  }
  return { source, wordSynced: lines.some((l) => (l.words?.length ?? 0) > 0), lines: withInstrumentalGaps(lines) };
}

/* ------------------------------ LRC parsing ----------------------------- */

/** Plain LRC → line-synced lines (seconds). Word stamps `<…>` are ignored. */
function parseLrc(lrc: string): SyncedLyricLine[] {
  const rows: { time: number; text: string }[] = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const m = /^\[(\d{1,3}):(\d{2})[.:](\d{2,3})](.*)$/.exec(raw.trim());
    if (!m) continue;
    const text = decodeEntities(m[4].replace(/<\d{1,3}:\d{2}[.:]\d{2,3}>/g, "").trim());
    rows.push({ time: stampMs(m[1], m[2], m[3]) / 1000, text });
  }
  rows.sort((a, b) => a.time - b.time);
  return rows;
}

/** Word-timed rich LRC: `[mm:ss.xx]<mm:ss.xx>word …` → seconds. */
function parseEnhancedLrc(lrc: string): SyncedLyricLine[] {
  const rows: { time: number; words: { start: number; text: string }[]; plain: string }[] = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const m = /^\[(\d{1,3}):(\d{2})[.:](\d{2,3})](.*)$/.exec(raw.trim());
    if (!m) continue;
    const time = stampMs(m[1], m[2], m[3]) / 1000;
    const rest = decodeEntities(m[4]);
    const words = [...rest.matchAll(/<(\d{1,3}):(\d{2})[.:](\d{2,3})>([^<]*)/g)].map((w) => ({
      start: stampMs(w[1], w[2], w[3]) / 1000,
      text: w[4].trim(),
    }));
    rows.push({ time, words, plain: rest.replace(/<\d{1,3}:\d{2}[.:]\d{2,3}>/g, "").trim() });
  }
  rows.sort((a, b) => a.time - b.time);
  if (!rows.some((r) => r.words.length > 0)) return []; // ordinary LRC, not rich
  const out: SyncedLyricLine[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.words.length === 0) {
      if (row.plain) out.push({ time: row.time, text: row.plain });
      continue;
    }
    const lineEnd = rows[i + 1]?.time ?? row.words[row.words.length - 1].start + 4;
    const words: SyncedLyricWord[] = row.words
      .filter((w) => w.text)
      .map((w, wi) => ({
        start: w.start,
        end: row.words[wi + 1]?.start ?? lineEnd,
        text: w.text,
      }));
    if (!words.length) continue;
    for (const w of words) if (w.end < w.start) w.end = w.start;
    out.push({
      time: Math.min(row.time, words[0].start),
      text: words.map((w) => w.text).join(" "),
      words,
      end: words[words.length - 1].end,
    });
  }
  return out;
}

/* ----------------------- Karaoke LRC (QRC / YRC) ------------------------ */

/**
 * QQ Music's karaoke format: millisecond line ranges `[start,dur]` with
 * per-word stamps, written either `(start,dur[,0])word` before the word or
 * `word(start,dur)` after it. Some producers wrap the whole thing in a
 * `LyricContent="…"` variable, which is peeled off first.
 */
const KARAOKE_LINE = /^\[(\d{1,8}),(\d{1,8})](.*)$/;
const KARAOKE_PREFIX_WORD = /\((\d{1,8}),(\d{1,8})(?:,\d{1,8})?\)([^()]*)/g;
const KARAOKE_SUFFIX_WORD = /([^()]*)\((\d{1,8}),(\d{1,8})(?:,\d{1,8})?\)/g;
const KARAOKE_WORD_TIME = /\(\d{1,8},\d{1,8}(?:,\d{1,8})?\)/g;
const LYRIC_CONTENT_VAR = /LyricContent\s*=\s*"([^"]*)"/i;

function karaokeContent(raw: string): string {
  const m = LYRIC_CONTENT_VAR.exec(raw);
  if (!m) return raw;
  return m[1]
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function karaokeLooksLike(raw: string): boolean {
  for (const source of karaokeContent(raw).split(/\r?\n/)) {
    const m = KARAOKE_LINE.exec(source.trim());
    if (m && (/\(\d{1,8},\d{1,8}(?:,\d{1,8})?\)[^()]/.test(m[3]) || /[^()]\(\d{1,8},\d{1,8}(?:,\d{1,8})?\)/.test(m[3]))) {
      return true;
    }
  }
  return false;
}

function parseKaraokeLrc(raw: string): SyncedLyricLine[] {
  const rows: SyncedLyricLine[] = [];
  for (const source of karaokeContent(raw).split(/\r?\n/)) {
    const m = KARAOKE_LINE.exec(source.trim());
    if (!m) continue;
    const lineStart = parseInt(m[1], 10) / 1000;
    const lineDur = parseInt(m[2], 10) / 1000;
    const body = m[3];
    // The stamp set that carries more text is the real convention of this
    // file; the other reading would scramble the word order.
    const prefixed = [...body.matchAll(KARAOKE_PREFIX_WORD)].map((w) => ({
      start: parseInt(w[1], 10) / 1000,
      dur: parseInt(w[2], 10) / 1000,
      text: decodeEntities(w[3]),
    }));
    const suffixed = [...body.matchAll(KARAOKE_SUFFIX_WORD)].map((w) => ({
      start: parseInt(w[2], 10) / 1000,
      dur: parseInt(w[3], 10) / 1000,
      text: decodeEntities(w[1]),
    }));
    const len = (list: { text: string }[]): number => list.reduce((a, w) => a + w.text.length, 0);
    const picked = len(prefixed) >= len(suffixed) ? prefixed : suffixed;
    const words: SyncedLyricWord[] = [];
    for (const w of picked) {
      const text = w.text.trim();
      if (!text) continue;
      words.push({ start: w.start, end: Math.max(w.start + w.dur, w.start), text });
    }
    if (!words.length) continue;
    const text = decodeEntities(body.replace(KARAOKE_WORD_TIME, "")).trim();
    if (!text) continue;
    rows.push({
      time: Math.min(lineStart, words[0].start),
      text,
      words,
      end: lineDur > 0 ? lineStart + lineDur : words[words.length - 1].end,
    });
  }
  rows.sort((a, b) => a.time - b.time);
  return rows;
}

/* --------------------- generic provider-envelope parse ------------------- */

/**
 * Several of the smaller backends answer with the same lyric payload in
 * different wrappers: bare TTML, an LRC file, plain text, or any of those
 * nested in one or two JSON envelopes. Unwrap, then hand the string to
 * whichever parser it actually is.
 */
const PROVIDER_CONTENT_KEYS = [
  "ttml", "ttmlContent", "lyrics", "lyricContent", "lrc", "content", "text",
  "plainLyrics", "syncedLyrics", "line", "lines", "lyric",
  "data", "result", "response",
];

function providerExtractString(el: unknown, depth = 0): string | null {
  if (depth > 6 || el == null) return null;
  if (typeof el === "string") {
    const text = el.trim();
    if (!text) return null;
    if ((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]"))) {
      try {
        return providerExtractString(JSON.parse(text), depth + 1);
      } catch {
        return text;
      }
    }
    return text;
  }
  if (Array.isArray(el)) {
    const parts = el.map((v) => providerExtractString(v, depth + 1)).filter((s): s is string => !!s);
    return parts.length ? parts.join("\n") : null;
  }
  if (typeof el === "object") {
    const obj = el as Record<string, unknown>;
    if (obj.isError === true || obj.ok === false) return null;
    const err = obj.error;
    if (err != null && err !== false && err !== "" && err !== "false") return null;
    for (const key of PROVIDER_CONTENT_KEYS) {
      if (key in obj) {
        const found = providerExtractString(obj[key], depth + 1);
        if (found) return found;
      }
    }
    if (obj.metadata && typeof obj.metadata === "object") {
      return providerExtractString(obj.metadata, depth + 1);
    }
    return null;
  }
  return null;
}

/** Synced lines, or plain text when the payload carried no timing at all. */
function parseProviderAny(raw: string): SyncedLyricLine[] | { plain: string } | null {
  let value = raw.replace(/^\uFEFF/, "").trim();
  if (value.startsWith("```")) {
    const lines = value.split(/\r?\n/);
    if (lines.length > 1 && lines[lines.length - 1].trim() === "```") lines.pop();
    value = lines.slice(1).join("\n").trim();
  }
  if (!value) return null;
  let content = value;
  try {
    const extracted = providerExtractString(JSON.parse(value));
    if (!extracted) return null;
    content = extracted;
  } catch {
    /* not JSON — parse as the raw text */
  }
  if (/&lt;(tt[\s>]|\/tt)/i.test(content)) content = decodeEntities(content);
  if (/<tt[\s>]/i.test(content) || content.toLowerCase().includes("http://www.w3.org/ns/ttml")) {
    const ttml = parseTtml(content);
    if (ttml.length) return ttml;
  }
  if (karaokeLooksLike(content)) {
    const karaoke = parseKaraokeLrc(content);
    if (karaoke.length) return karaoke;
  }
  if (content.trimStart().startsWith("<")) return null;
  const enhanced = parseEnhancedLrc(content);
  if (enhanced.length) return enhanced;
  const lrc = parseLrc(content);
  if (lrc.length) return lrc;
  if (/\b(lyrics? (?:not found|unavailable)|error)\b/i.test(content)) return null;
  const plain = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^\[[A-Za-z]+:.*]$/.test(l))
    .join("\n");
  return plain ? { plain } : null;
}

/* --------------------------------- TTML --------------------------------- */

/** TTML time → SECONDS: "27.395", "12.5s", "800ms", "H:MM:SS.mmm", "M:SS.mmm", "02:39", "1:3.188". */
function attrTimeSeconds(attrs: string, name: string): number | null {
  const m = new RegExp(`${name}\\s*=\\s*"([^"]+)"`).exec(attrs);
  if (!m) return null;
  const v = m[1].trim();
  const ms = /^(\d+(?:\.\d+)?)ms$/.exec(v);
  if (ms) return parseFloat(ms[1]) / 1000;
  const parts = v.replace(/s$/, "").split(":");
  if (parts.length > 3 || !parts.every((p) => /^\d+(\.\d+)?$/.test(p))) return null;
  return parts.reduce((sum, p) => sum * 60 + parseFloat(p), 0);
}

const TTML_TRANSLATION_ROLE = /(?:ttm:role|x-role)\s*=\s*"x-translation"/;
const TTML_ROMAN_ROLE = /(?:ttm:role|x-role)\s*=\s*"x-roman"/;
const TTML_SIDE_ROLE = /(?:ttm:role|x-role)\s*=\s*"(?:x-translation|x-roman)"/;
const TTML_BG_ROLE = /(?:ttm:role|x-role)\s*=\s*"x-bg"/;

type TimedPiece = { begin: number; end: number | null; text: string; boundary: boolean };

/**
 * Glue syllable pieces into words: a boundary is whitespace in the gap before
 * a piece or whitespace inside its text (Apple writes it inside,
 * Lyrically-generated TTML writes it between). A producer that emits no
 * whitespace at all gets one word per piece.
 */
function piecesToWords(timed: TimedPiece[]): SyncedLyricWord[] {
  const words: SyncedLyricWord[] = [];
  let cur: { start: number; end: number; text: string } | null = null;
  const closeWord = (): void => {
    if (cur) words.push({ start: cur.start, end: cur.end, text: cur.text.trim() });
    cur = null;
  };
  for (const sp of timed) {
    const text = sp.text;
    if (!text) continue;
    if (!cur || sp.boundary || /^\s/.test(text)) {
      closeWord();
      cur = { start: sp.begin, end: sp.end ?? sp.begin, text };
    } else {
      cur.text += text;
      cur.end = sp.end ?? cur.end;
    }
    if (/\s$/.test(cur.text)) closeWord();
  }
  closeWord();
  if (words.filter((w) => w.text).length <= 1 && timed.length > 1) {
    words.length = 0;
    for (const sp of timed) {
      if (!sp.text.trim()) continue;
      words.push({ start: sp.begin, end: Math.max(sp.end ?? sp.begin, sp.begin), text: sp.text.trim() });
    }
  }
  const clean = words.filter((w) => w.text.length > 0);
  for (const w of clean) if (w.end < w.start) w.end = w.start;
  return clean;
}

const plainText = (markup: string): string => decodeEntities(markup.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

/** Romanized lines from the head's first transliteration block, keyed by line (itunes:key). */
function ttmlTransliterations(ttml: string): Map<string, string> {
  const out = new Map<string, string>();
  const block = /<transliteration\b[^>]*>([\s\S]*?)<\/transliteration>/.exec(ttml)?.[1];
  if (!block) return out;
  for (const m of block.matchAll(/<text\b[^>]*\bfor\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/text>/g)) {
    const text = plainText(m[2]);
    if (text) out.set(m[1], text);
  }
  return out;
}

/**
 * Apple Music TTML, word-timed. A <p> per line, a timed <span> per syllable;
 * syllables of one word are adjacent spans with no whitespace between them,
 * so whitespace — not the span boundary — separates words. Kept per line:
 * background vocals (a ttm:role="x-bg" wrapper around their own timed spans)
 * as a separate part, and a romanized reading (head transliterations or an
 * inline x-roman span). All times in SECONDS.
 */
export function parseTtml(ttml: string): SyncedLyricLine[] {
  const lines: SyncedLyricLine[] = [];
  const romans = ttmlTransliterations(ttml);
  const pBlocks = ttml.match(/<p\b[^>]*>[\s\S]*?<\/p>|<p\b[^>]*\/>/g) ?? [];
  for (const block of pBlocks) {
    const open = /<p\b([^>]*)>/.exec(block);
    if (!open) continue;
    const attrs = open[1];
    if (TTML_SIDE_ROLE.test(attrs)) continue;
    const begin = attrTimeSeconds(attrs, "begin");
    if (begin == null) continue;
    const end = attrTimeSeconds(attrs, "end");
    const key = /itunes:key\s*=\s*"([^"]+)"/.exec(attrs)?.[1];

    // Walk the paragraph's tags in order. Text belongs to the innermost span
    // when that span is timed; anything else is gap text, where the word
    // boundary usually lives ("</span> <span>") - dropping it glued whole
    // lines into single mega-words. Spans nest (the x-bg wrapper), so a flat
    // span regex would glue the wrapper to its first child.
    type Span = { begin: number | null; end: number | null; skip: boolean; bg: boolean; inBg: boolean; roman: boolean };
    const main: TimedPiece[] = [];
    const backing: TimedPiece[] = [];
    const stack: Span[] = [];
    let owner: Span | null = null;
    let gap = "";
    let all = "";
    let roman = "";
    for (const t of block.matchAll(/<span\b([^>]*)>|<\/span>|<[^>]*>|[^<]+/g)) {
      const tag = t[0];
      if (tag.startsWith("<span")) {
        if (/\/\s*$/.test(t[1])) continue; // <span/>: nothing inside
        const parent = stack.at(-1);
        const span: Span = {
          begin: attrTimeSeconds(t[1], "begin"),
          end: attrTimeSeconds(t[1], "end"),
          skip: !!parent?.skip || TTML_SIDE_ROLE.test(t[1]),
          bg: TTML_BG_ROLE.test(t[1]),
          inBg: !!parent?.inBg || TTML_BG_ROLE.test(t[1]),
          roman: !!parent?.roman || TTML_ROMAN_ROLE.test(t[1]),
        };
        if (span.bg) gap += " ";
        stack.push(span);
      } else if (tag === "</span>") {
        if (stack.pop()?.bg) gap += " ";
      } else if (!tag.startsWith("<")) {
        const top = stack.at(-1);
        if (top?.roman) roman += tag;
        if (top?.skip) continue;
        all += tag;
        if (top?.begin == null) gap += tag;
        else {
          const into = top.inBg ? backing : main;
          if (owner === top && into.length) into[into.length - 1].text += decodeEntities(tag);
          else {
            into.push({ begin: top.begin, end: top.end, text: decodeEntities(tag), boundary: /\s/.test(gap) });
            owner = top;
            gap = "";
          }
        }
      } else if (stack.at(-1)?.begin == null) {
        gap += " "; // a <br/> or other tag between words still separates them
      }
    }
    const romanText = (key ? romans.get(key) : undefined) ?? (plainText(roman) || undefined);
    const extras = romanText ? { roman: romanText } : {};

    if (main.length === 0 && backing.length === 0) {
      // Line-synced TTML: bare text, no timed spans.
      const text = decodeEntities(all).trim();
      if (!text) continue;
      lines.push({ time: begin, text, end: end != null && end > begin ? end : undefined, ...extras });
      continue;
    }

    let words = piecesToWords(main);
    let bgWords = piecesToWords(backing);
    // A line that is only background vocals is shown as the line itself.
    if (!words.length) [words, bgWords] = [bgWords, []];
    if (words.length === 0) continue;
    const firstStart = Math.min(words[0].start, bgWords[0]?.start ?? Infinity);
    const lastEnd = Math.max(words[words.length - 1].end, bgWords.at(-1)?.end ?? 0);
    lines.push({
      time: Math.min(begin, firstStart),
      text: words.map((w) => w.text).join(" "),
      words,
      end: end != null && end > begin ? end : lastEnd,
      ...(bgWords.length ? { bg: { text: bgWords.map((w) => w.text).join(" "), words: bgWords } } : {}),
      ...extras,
    });
  }
  lines.sort((a, b) => a.time - b.time);
  return lines;
}

/* ------------------------------ LyricsPlus ------------------------------ */

/**
 * Syllable-level lyrics from the YouLy+ backend, on community mirrors that
 * come and go — so all of them are asked in turn and the first usable answer
 * wins; the winner is remembered for the next track.
 */
const LYRICSPLUS_MIRRORS = [
  "https://lyricsplus.prjktla.my.id",
  "https://lyricsplus.atomix.one",
  "https://lyricsplus.binimum.org",
  "https://lyricsplus.prjktla.workers.dev",
  "https://lyricsplus-seven.vercel.app",
  "https://lyrics-plus-backend.vercel.app",
];
let lyricsPlusLastGood: string | null = null;

/**
 * Mirrors that didn't answer at all last time — gone from DNS, or hanging to
 * the timeout — sit out for a while. Answers are taken in priority order, so
 * a mirror that never answers would hold every lookup below LyricsPlus to its
 * timeout; one that answers "not found" is quick and stays in.
 */
const lyricsPlusBenched = new Map<string, number>();
const LYRICSPLUS_BENCH_MS = 10 * 60_000;

interface PlusSyllable {
  time?: number; // ms
  duration?: number; // ms
  text?: string;
}
interface PlusLine {
  time?: number; // ms
  duration?: number; // ms
  text?: string;
  syllabus?: PlusSyllable[];
}

/** Glue syllables back into words — a trailing space marks the boundary.
 *  If a source emits no whitespace boundaries at all, each syllable is a word. */
function mergePlusSyllables(syllables: PlusSyllable[]): SyncedLyricWord[] {
  const words: SyncedLyricWord[] = [];
  let text = "";
  let start = 0;
  let end = 0;
  let boundary = false;
  for (const syl of syllables) {
    if (!syl.text?.trim() || syl.time == null) continue;
    if (!text) start = syl.time / 1000;
    text += syl.text.trim();
    end = syl.time / 1000 + (syl.duration ?? 0) / 1000;
    if (/\s$/.test(syl.text)) {
      words.push({ start, end: Math.max(end, start), text });
      text = "";
      boundary = true;
    }
  }
  if (text) {
    if (boundary) {
      words.push({ start, end: Math.max(end, start), text });
    } else {
      // Whole words with no spacing convention: keep them separate.
      for (const syl of syllables) {
        if (!syl.text?.trim() || syl.time == null) continue;
        const st = syl.time / 1000;
        words.push({ start: st, end: Math.max(st + (syl.duration ?? 0) / 1000, st), text: syl.text.trim() });
      }
    }
  }
  return words;
}

function parsePlusResponse(response: { lyrics?: PlusLine[] | null }): SyncedLyricLine[] {
  const out: SyncedLyricLine[] = [];
  for (const line of response.lyrics ?? []) {
    const startSec = line.time != null ? line.time / 1000 : null;
    if (startSec == null) continue;
    const words = mergePlusSyllables(line.syllabus ?? []);
    if (words.length > 0) {
      out.push({
        time: Math.min(startSec, words[0].start),
        text: words.map((w) => w.text).join(" "),
        words,
        end: words[words.length - 1].end,
      });
    } else if (line.text && line.text.trim()) {
      out.push({
        time: startSec,
        text: line.text.trim(),
        end: line.duration && line.duration > 0 ? startSec + line.duration / 1000 : undefined,
      });
    }
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

async function fetchLyricsPlusOne(host: string, q: LyricQuery, isrc?: string): Promise<SyncedLyricLine[] | null> {
  // One question, asked the way BitChord asks it: the catalogue name with its
  // version words, the length, the album and — once lrc.red has named it —
  // the recording's ISRC. The looser retries this used to make (bare title,
  // no length) were where other recordings came back.
  const params = new URLSearchParams({ title: searchTitle(q.title), artist: searchArtist(q.artist || "") });
  if (q.duration > 0) params.set("duration", String(Math.round(q.duration)));
  if (q.album) params.set("album", cleanTitle(q.album));
  // Sent alongside the name rather than instead of it: this backend
  // aggregates several catalogues, and the ones with no ISRC index still
  // need something to match on.
  if (isrc) params.set("isrc", isrc);
  const body = await getText(`${host}/v2/lyrics/get?${params.toString()}`, 6000, {}, () =>
    lyricsPlusBenched.set(host, Date.now() + LYRICSPLUS_BENCH_MS)
  );
  if (!body) return null;
  try {
    const json = JSON.parse(body);
    // The backend breaks ties on length, which can land on a remix or a
    // translated version; its own metadata says which recording it sent.
    const meta = json?.metadata;
    if (typeof meta?.title === "string" && meta.title && !namesRecording(meta.title, String(meta.artist ?? ""), q)) {
      return null;
    }
    const lines = parsePlusResponse(json);
    return lines.length ? lines : null;
  } catch {
    return null;
  }
}

async function fetchLyricsPlus(q: LyricQuery, isrc?: string): Promise<ProviderResult | null> {
  const now = Date.now();
  const awake = LYRICSPLUS_MIRRORS.filter((m) => (lyricsPlusBenched.get(m) ?? 0) <= now);
  const pool = awake.length ? awake : LYRICSPLUS_MIRRORS;
  const hosts = lyricsPlusLastGood && pool.includes(lyricsPlusLastGood)
    ? [lyricsPlusLastGood, ...pool.filter((m) => m !== lyricsPlusLastGood)]
    : pool;
  // All mirrors are asked at once; the first to answer with something usable
  // wins the moment it lands — completion order, not mirror order. A slow
  // mirror that will come back empty must not hold up one that already has
  // the track. The winner is remembered for the next track.
  return new Promise((resolve) => {
    let remaining = hosts.length;
    let settled = false;
    const done = (r: ProviderResult | null): void => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    for (const host of hosts) {
      void fetchLyricsPlusOne(host, q, isrc).then(
        (lines) => {
          remaining -= 1;
          if (lines) {
            lyricsPlusLastGood = host;
            done(toResult("LyricsPlus", lines));
          } else if (remaining === 0) done(null);
        },
        () => {
          remaining -= 1;
          if (remaining === 0) done(null);
        }
      );
    }
  });
}

/* ------------------------------ PaxSenix -------------------------------- */

/**
 * Word-timed lyrics via lyrics.paxsenix.org — a public proxy in front of
 * Apple Music's catalogue and lyrics. Apple's own search needs a bearer
 * token, which its web player carries inside one of its JS bundles; scrape
 * it the same way the player does and keep it until Apple says no.
 */
const PAXSENIX_PROXY = "https://lyrics.paxsenix.org";
const APPLE_SEARCH = "https://amp-api.music.apple.com/v1/catalog/us/search";
let appleToken: string | null = null;

function appleClean(s: string): string {
  return s
    .replace(
      /\s*[(\[](official|video|audio|lyrics?|visualizer|hd|hq|4k|remaster\w*|live|version|feat\.?|ft\.?)[^)\]]*[)\]]/gi,
      ""
    )
    .trim();
}

async function scrapeAppleToken(): Promise<string | null> {
  const home = await getText("https://music.apple.com/us/new", 8000, {
    "User-Agent": UA,
    Accept: "text/html",
  });
  if (!home) return null;
  const scriptPath = /\/assets\/index~[^"]+\.js/.exec(home)?.[0];
  if (!scriptPath) return null;
  const script = await getText(`https://music.apple.com${scriptPath}`, 8000, {
    "User-Agent": UA,
    Accept: "*/*",
  });
  if (!script) return null;
  return /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.exec(script)?.[0] ?? null;
}

async function getAppleToken(): Promise<string | null> {
  if (appleToken) return appleToken;
  appleToken = await scrapeAppleToken();
  return appleToken;
}

interface AppleCandidate {
  id: string;
  name: string;
  artist: string;
  durationSec: number | null;
}

async function appleSearch(query: string, token: string): Promise<AppleCandidate[] | null> {
  const url = `${APPLE_SEARCH}?term=${encodeURIComponent(query)}&types=songs&limit=10&l=en-US`;
  const body = await getText(url, 7000, {
    Authorization: `Bearer ${token}`,
    Origin: "https://music.apple.com",
    Referer: "https://music.apple.com/",
    "User-Agent": UA,
  });
  if (!body) return null;
  try {
    const json = JSON.parse(body);
    const data = json?.results?.songs?.data;
    if (!Array.isArray(data)) return null;
    return data.map((t) => ({
      id: String(t?.id ?? ""),
      name: String(t?.attributes?.name ?? ""),
      artist: String(t?.attributes?.artistName ?? ""),
      durationSec: t?.attributes?.durationInMillis
        ? Math.round(t.attributes.durationInMillis / 1000)
        : null,
    }));
  } catch {
    return null;
  }
}

interface PaxLyricsResponse {
  ttmlContent?: string | null;
  elrc?: string | null;
  elrcMultiPerson?: string | null;
}

/**
 * PaxSenix sometimes answers with a structured Apple payload instead of a
 * TTML document: a `content` array of rows, each carrying a millisecond
 * timestamp and a `text` array of per-word rows with their own timestamps.
 * Preserve the word timing rather than flattening it.
 */
function parsePaxStructured(root: unknown): SyncedLyricLine[] {
  const findContent = (node: unknown): any[] | null => {
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = findContent(item);
        if (found) return found;
      }
      return null;
    }
    if (!node || typeof node !== "object") return null;
    const obj = node as Record<string, unknown>;
    if (Array.isArray(obj.content) && obj.content.some((row) => row && typeof row === "object" && (row as any).timestamp != null)) {
      return obj.content as any[];
    }
    for (const value of Object.values(obj)) {
      const found = findContent(value);
      if (found) return found;
    }
    return null;
  };
  const rows = findContent(root);
  if (!rows?.length) return [];
  const out: SyncedLyricLine[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] as Record<string, unknown>;
    const start = typeof row.timestamp === "number" ? row.timestamp / 1000 : null;
    const wordRows = Array.isArray(row.text) ? row.text : null;
    if (start == null || !wordRows) continue;
    const nextStart =
      typeof (rows[i + 1] as Record<string, unknown> | undefined)?.timestamp === "number"
        ? (rows[i + 1] as Record<string, unknown>).timestamp as number / 1000
        : null;
    const words: SyncedLyricWord[] = [];
    for (let w = 0; w < wordRows.length; w++) {
      const word = wordRows[w] as Record<string, unknown>;
      const text = typeof word.text === "string" ? word.text.trim() : "";
      const wordStart = typeof word.timestamp === "number" ? word.timestamp / 1000 : null;
      if (!text || wordStart == null) continue;
      const nextWord = wordRows[w + 1] as Record<string, unknown> | undefined;
      const wordEnd =
        typeof nextWord?.timestamp === "number" ? nextWord.timestamp / 1000 : nextStart ?? wordStart + 0.8;
      words.push({ start: wordStart, end: Math.max(wordEnd, wordStart), text });
    }
    if (!words.length) continue;
    out.push({
      time: Math.min(start, words[0].start),
      text: words.map((w) => w.text).join(" "),
      words,
      end: nextStart ?? words[words.length - 1].end,
    });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

async function fetchPaxSenix(q: LyricQuery): Promise<ProviderResult | null> {
  const stripped = queryTitle(q.title);
  const artist = appleClean(searchArtist(q.artist || ""));
  if (!stripped) return null;
  // Apple indexes the actual edits — "Song (Sped Up)" is a real release — so
  // the rendition the upload names is queried before the stripped title.
  const full = searchTitle(q.title);
  const titles = full && full.toLowerCase() !== stripped.toLowerCase() ? [full, stripped] : [stripped];

  let token = await getAppleToken();
  if (!token) return null;

  const searchOnce = async (title: string): Promise<AppleCandidate[] | null> => {
    const query = [title, artist].filter(Boolean).join(" ");
    let results = await appleSearch(query, token!);
    if (!results) {
      // Apple said no — the token went stale. Mint a fresh one, once.
      appleToken = null;
      token = await getAppleToken();
      if (!token) return null;
      results = await appleSearch(query, token);
    }
    return results;
  };

  // Only a candidate that names the playing recording — the same song, the
  // same version words, a shared artist — may answer; of those, the closest in
  // length (a re-release, a remaster). The upload's length never vetoes the
  // song on its own: music videos with intros run longer than the catalogue
  // track.
  const durDelta = (t: AppleCandidate): number =>
    q.duration <= 0 || t.durationSec == null ? 99999 : Math.abs(t.durationSec - q.duration);

  let pool: AppleCandidate[] = [];
  for (const title of titles) {
    const named = (await searchOnce(title))?.filter((t) => t.id && namesRecording(t.name, t.artist, q, { length: t.durationSec })) ?? [];
    pool = named.sort((a, b) => durDelta(a) - durDelta(b));
    if (pool.length) break;
  }
  // The same recording is often listed under several releases (single, album,
  // soundtrack), and the proxy has lyrics for some of them only — releases of
  // the same length as the first, that is; "Faded (Restrung)" is another
  // arrangement. A release the proxy said no to (a 404, a busy 503) gives the
  // next its turn; one that didn't answer at all would only be waited on again.
  const sameRecording = pool.filter(
    (t) =>
      t === pool[0] ||
      (t.durationSec != null && pool[0].durationSec != null && Math.abs(t.durationSec - pool[0].durationSec) <= LRCRED_TOLERANCE_SEC)
  );
  for (const candidate of sameRecording.slice(0, 3)) {
    const lyrics = await paxSenixLyrics(candidate.id);
    if (lyrics !== null) return lyrics ?? null;
  }
  return null;
}

/** The proxy's lyrics for one Apple id: undefined when the host never answered, null when it answered without
 * lyrics (an HTTP error included). */
async function paxSenixLyrics(id: string): Promise<ProviderResult | null | undefined> {
  let unreachable = false;
  const body = await getText(`${PAXSENIX_PROXY}/apple-music/lyrics?id=${encodeURIComponent(id)}&ttml=true`, 8000, {}, () => {
    unreachable = true;
  });
  if (!body) return unreachable ? undefined : null;
  try {
    const json: PaxLyricsResponse = JSON.parse(body);
    const structured = parsePaxStructured(json);
    if (structured.length) return toResult("PaxSenix", structured);
    // ttml=true makes the `content` field the TTML document itself; older
    // responses carried it as `ttmlContent`.
    for (const ttml of [json.ttmlContent, (json as any).content]) {
      if (typeof ttml === "string" && ttml.trim() && /<tt[\s>]/i.test(ttml)) {
        const lines = parseTtml(ttml);
        if (lines.length) return toResult("PaxSenix", lines);
      }
    }
    for (const elrc of [json.elrcMultiPerson, json.elrc]) {
      if (elrc?.trim()) {
        const lines = parseEnhancedLrc(elrc);
        if (lines.length) return toResult("PaxSenix", lines);
      }
    }
    console.log(
      `[bytune][lyrics-net] paxsenix no synced content for ${id}: keys=${Object.keys(json).join(",")} ttmlLen=${(json.ttmlContent ?? "").length}`
    );
    return null;
  } catch {
    console.log(`[bytune][lyrics-net] paxsenix unparseable body: ${body.slice(0, 120)}`);
    return null;
  }
}

/* ---------------------------- BetterLyrics ------------------------------ */

async function fetchBetterLyrics(q: LyricQuery): Promise<ProviderResult | null> {
  // Asked the way BitChord asks: the catalogue name with its version words, at
  // the upload's length, under each form of the credit. The document carries
  // no name to check, so a looser retry (the bare title, no length) could only
  // ever bring back another recording.
  for (const a of creditForms(q.artist || "")) {
    const params = new URLSearchParams({ s: searchTitle(q.title), a });
    if (q.duration > 0) params.set("d", String(Math.round(q.duration)));
    if (q.album) params.set("al", cleanTitle(q.album));
    const body = await getText(`https://lyrics-api.boidu.dev/getLyrics?${params.toString()}`);
    if (!body) continue;
    try {
      const ttml = JSON.parse(body)?.ttml;
      const found = typeof ttml === "string" && ttml ? toResult("BetterLyrics", parseTtml(ttml)) : null;
      if (found) return found;
    } catch {
      /* unreadable: the next form */
    }
  }
  return null;
}

/* -------------------------------- KuGou --------------------------------- */

/**
 * Line-synced lyrics from KuGou's public endpoints — a Chinese catalogue
 * that also carries a great many English and Hindi tracks the western
 * sources don't. Three unauthenticated calls: search the song for its
 * fingerprint hash, search lyrics candidates for that hash, download the
 * winner; a keyword search is the fallback.
 */
const KUGOU_TOLERANCE = 8;

function kugouStripCredits(lrc: string): string {
  const STAMPED = /^\[\d{2}:\d{2}\.\d{2,3}].*/;
  const CREDIT = /.+][^\[]+[:：].+/;
  const lines = lrc.split(/\r?\n/).filter((l) => STAMPED.test(l));
  if (!lines.length) return "";
  const headLimit = Math.min(30, lines.length - 1);
  let headCut = 0;
  for (let i = headLimit; i >= 0; i--) {
    if (CREDIT.test(lines[i])) {
      headCut = i + 1;
      break;
    }
  }
  const body = lines.slice(headCut);
  let tailCut = 0;
  for (let i = 0; i <= Math.min(30, body.length - 1); i++) {
    if (CREDIT.test(body[body.length - 1 - i])) {
      tailCut = i + 1;
      break;
    }
  }
  return body.slice(0, body.length - tailCut).join("\n");
}

/**
 * A downloaded KuGou file as lyrics. Null for its "纯音乐，请欣赏" ("pure music,
 * please enjoy") notice, and when the file names another recording — in its
 * opening "Title - Artist" line, else in its [ti:]/[ar:] tags. A remix or a
 * DJ edit is filed under the plain title in the search, and only the file
 * itself says what it is. `mustName`: a file that names nothing is refused.
 * `length`: the candidate's own seconds, for credits in another script.
 */
export function kugouLines(lrc: string, q: LyricQuery, mustName: boolean, length?: number | null): SyncedLyricLine[] | null {
  const lines = parseLrc(kugouStripCredits(lrc));
  if (!lines.length || lines.every((l) => !l.text.trim() || /纯音乐|純音樂/.test(l.text))) return null;
  // The name line is read before the 词/曲 credits next to it are cut away together with it.
  let fits = openingNameFits(parseLrc(lrc), q, length);
  if (fits === null) {
    const tag = (key: string): string => new RegExp(`^\\[${key}:(.*)\\]\\s*$`, "im").exec(lrc)?.[1]?.trim() ?? "";
    if (tag("ti")) fits = namesRecording(tag("ti"), tag("ar"), q, { length });
  }
  if (fits === false || (mustName && fits !== true)) return null;
  const sung = withoutOpening(lines);
  return sung.length ? sung : null;
}

async function fetchKuGou(q: LyricQuery): Promise<ProviderResult | null> {
  const stripParen = (s: string): string => s.replace(/[(（].*?[)）]/g, "").trim() || s;
  // BitChord's keyword: "Title - Artist", then the album when there is one.
  const keyword = [
    [stripParen(searchTitle(q.title)), stripParen(searchArtist(q.artist || ""))].filter(Boolean).join(" - "),
    q.album ? cleanTitle(q.album) : "",
  ]
    .filter(Boolean)
    .join(" ");
  const seconds = Math.round(q.duration);

  const download = async (id: string, accessKey: string): Promise<string | null> => {
    const params = new URLSearchParams({
      fmt: "lrc",
      charset: "utf8",
      client: "pc",
      ver: "1",
      id,
      accesskey: accessKey,
    });
    const body = await getText(`https://lyrics.kugou.com/download?${params.toString()}`);
    if (!body) return null;
    try {
      const json = JSON.parse(body);
      if (typeof json?.content !== "string") return null;
      return Buffer.from(json.content, "base64").toString("utf-8");
    } catch {
      return null;
    }
  };

  const searchLyrics = async (opts: { hash?: string; keyword?: string; seconds?: number }) => {
    const params = new URLSearchParams({ ver: "1", man: "yes", client: "pc" });
    if (opts.hash) params.set("hash", opts.hash);
    else {
      if (!opts.keyword) return [];
      params.set("keyword", opts.keyword);
      if (opts.seconds && opts.seconds > 0) params.set("duration", String(opts.seconds * 1000));
    }
    const body = await getText(`https://lyrics.kugou.com/search?${params.toString()}`);
    if (!body) return [];
    try {
      const json = JSON.parse(body);
      const candidates = Array.isArray(json?.candidates) ? json.candidates : [];
      return (candidates as any[])
        .map((c: any) => {
          const d = Number(c?.duration) || 0;
          return {
            id: String(c?.id ?? ""),
            accesskey: String(c?.accesskey ?? ""),
            song: String(c?.song ?? ""),
            // Milliseconds, like the duration it was asked with.
            duration: d > 10000 ? d / 1000 : d,
          };
        })
        .filter((c) => c.id && c.accesskey);
    } catch {
      return [];
    }
  };

  // Path 1: hash chain, restricted to songs that name the playing recording
  // (the row's songname carries its version — "Despacito (DNMO Remix)",
  // "Despacito 缓缓 (Mandarin Version)") and run within tolerance of it.
  if (seconds > 0) {
    const songBody = await getText(
      `https://mobileservice.kugou.com/api/v3/search/song?${new URLSearchParams({
        version: "9108",
        plat: "0",
        pagesize: "8",
        showtype: "0",
        keyword,
      }).toString()}`
    );
    if (songBody) {
      try {
        const json = JSON.parse(songBody);
        const info: { hash?: string; duration?: number; songname?: string; singername?: string }[] =
          json?.data?.info ?? [];
        const rows = info
          .filter(
            (i) =>
              i.hash &&
              Math.abs((i.duration ?? -1) - seconds) <= KUGOU_TOLERANCE &&
              namesRecording(i.songname ?? "", i.singername ?? "", q, { length: i.duration })
          )
          .sort((a, b) => Math.abs((a.duration ?? 0) - seconds) - Math.abs((b.duration ?? 0) - seconds));
        for (const row of rows) {
          // The lyric files filed under a song's hash can be for its other cuts too.
          const song = recordingName(row.songname ?? "");
          const candidate = (await searchLyrics({ hash: row.hash })).find(
            (c) => !c.song || sameName(recordingName(c.song), song)
          );
          if (!candidate) continue;
          const lrc = await download(candidate.id, candidate.accesskey);
          const lines = lrc ? kugouLines(lrc, q, false, candidate.duration || row.duration) : null;
          if (lines) return toResult("KuGou", lines);
        }
      } catch {
        /* fall through to the keyword path */
      }
    }
  }

  // Path 2: keyword search fallback, scored by runtime proximity so the
  // studio cut doesn't outrank the sped-up edit that shares its name. Nothing
  // here has been checked against the playing recording, so the file has to
  // name it.
  const candidates = await searchLyrics({ keyword, seconds });
  if (candidates.length) {
    let pool = candidates;
    if (seconds > 0) {
      const near = pool.filter((c) => withinTolerance(c.duration, seconds));
      if (near.length) pool = near;
    }
    pool = [...pool].sort(
      (a, b) =>
        Math.abs((a.duration || 1e9) - seconds) - Math.abs((b.duration || 1e9) - seconds)
    );
    for (const candidate of pool.slice(0, 3)) {
      const lrc = await download(candidate.id, candidate.accesskey);
      const lines = lrc ? kugouLines(lrc, q, true, candidate.duration) : null;
      if (lines) return toResult("KuGou", lines);
    }
  }
  return null;
}

/* -------------------------------- LRCLIB -------------------------------- */

async function lrclibGet(path: string): Promise<any | null> {
  const body = await getText(`https://lrclib.net/api${path}`, 7000);
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function lyricsFromLrclibRecord(rec: any): ProviderResult | null {
  const synced = typeof rec?.syncedLyrics === "string" && rec.syncedLyrics.trim() ? parseLrc(rec.syncedLyrics) : null;
  if (synced && synced.length >= 3) return toResult("LRCLIB", synced);
  const plain = typeof rec?.plainLyrics === "string" && rec.plainLyrics.trim() ? rec.plainLyrics : null;
  if (plain) return { source: "LRCLIB", wordSynced: false, lines: [], plainText: plain };
  if (synced && synced.length) return toResult("LRCLIB", synced);
  return null;
}

async function fetchLrclib(q: LyricQuery): Promise<ProviderResult | null> {
  const artist = searchArtist(q.artist || "");
  const stripped = queryTitle(q.title || "");
  if (!stripped) return null;
  const enc = encodeURIComponent;
  // The rendition the upload names is queried first: "(Sped Up)" is a real
  // catalogue entry often enough, and the stripped title can only ever
  // answer with the normal cut.
  const full = cleanTitle(q.title || "").trim();
  const titles = full && full.toLowerCase() !== stripped.toLowerCase() ? [full, stripped] : [stripped];

  let plainOnly: ProviderResult | null = null;
  for (const title of titles) {
    if (artist && q.duration > 0) {
      const album = q.album ? `&album_name=${enc(cleanTitle(q.album))}` : "";
      const rec = await lrclibGet(
        `/get?artist_name=${enc(artist)}&track_name=${enc(title)}${album}&duration=${Math.round(q.duration)}`
      );
      // Asked with the stripped title, /get answers with the plain song for a
      // version upload ("Bailando" for "Bailando (English Version)").
      const exact = rec && namesRecording(String(rec.trackName ?? ""), String(rec.artistName ?? ""), q, { length: rec.duration })
        ? lyricsFromLrclibRecord(rec)
        : null;
      // BitChord's exactMatch takes synced lyrics only: a plain-only record can have a synced sibling the searches find.
      if (exact?.lines.length) return exact;
      plainOnly = plainOnly ?? exact;
    }
    if (artist) {
      const results = await lrclibGet(`/search?track_name=${enc(title)}&artist_name=${enc(artist)}`);
      const hit = pickLrclibSearchHit(results, q);
      if (hit) return hit;
    }
  }
  const qResults = await lrclibGet(`/search?q=${enc(`${artist} ${stripped}`.trim())}`);
  return pickLrclibSearchHit(qResults, q) ?? plainOnly;
}

/**
 * Of the search records carrying synced lyrics that name the playing
 * recording, take the one whose own runtime sits closest to the playing
 * track — BitChord mobile's rule, and the difference between the studio cut
 * and the sped-up edit that shares its name. With no credit to check, the
 * length has to carry the match: only a record within tolerance.
 */
function pickLrclibSearchHit(results: any, q: LyricQuery): ProviderResult | null {
  if (!Array.isArray(results)) return null;
  const synced = results.filter(
    (rec: any) =>
      typeof rec?.syncedLyrics === "string" &&
      rec.syncedLyrics.trim() &&
      namesRecording(String(rec?.trackName ?? ""), String(rec?.artistName ?? ""), q, { length: rec?.duration })
  );
  if (!synced.length) return null;
  const credited = artistNames(q.artist || "").length > 0;
  const seconds = Math.round(q.duration);
  if (seconds <= 0) return credited ? lyricsFromLrclibRecord(synced[0]) : null;
  const near = synced.filter((rec: any) => withinTolerance(rec?.duration, seconds));
  if (!credited && !near.length) return null;
  const pool = near.length ? near : synced;
  const best = pool.reduce((a: any, b: any) =>
    Math.abs((b?.duration ?? 1e9) - seconds) < Math.abs((a?.duration ?? 1e9) - seconds) ? b : a
  );
  return lyricsFromLrclibRecord(best);
}

/* -------------------------------- lrc.red -------------------------------- */

/**
 * lrc.red — Apple Music TTML, per syllable, filed by ISRC: every document
 * lives at https://lrc.red/s/{ISRC}.ttml, so a track whose recording is
 * already known costs one request and cannot come back as the wrong edit.
 * The recording comes from the identify step (BiniLyrics' search, below) or
 * from an earlier play of the same video. Without one, lrc.red's own search
 * is asked, and its hits are matched here rather than trusted in order — the
 * search is a free-text one and ranks "Bohemian Rhapsody (Operatic Section /
 * 2011 A Cappella Mix)" above the song itself. (BitChord's LrcRed, ported.)
 */
const LRCRED = "https://lrc.red";
const IDENTIFY_TIMEOUT_MS = 2500;

/**
 * How far a hit's length may be from the playing track's — BitChord's figure.
 * YouTube reports whole seconds and the same recording lists within one or
 * two of that; a radio edit sits further out, and the version words have to
 * tell the closer cases apart.
 */
const LRCRED_TOLERANCE_SEC = 3;

/** `CC-XXX-YY-NNNNN` without the dashes — and nothing else goes into a path. */
const ISRC_FORMAT = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;

/** The document a recording's lyrics live at, for a well-formed ISRC only. */
function lrcRedDocument(isrc: string | null | undefined): string | null {
  const code = (isrc ?? "").trim().toUpperCase();
  return ISRC_FORMAT.test(code) ? `${LRCRED}/s/${code}.ttml` : null;
}

/** How one lookup fetches a document — shared, because lrc.red and BiniLyrics want the very same file. */
type DocumentFetch = (url: string) => Promise<string | null>;

function sharedDocuments(): DocumentFetch {
  const inFlight = new Map<string, Promise<string | null>>();
  return (url) => {
    let doc = inFlight.get(url);
    if (!doc) {
      doc = getText(url, 7000, { Accept: "*/*" });
      inFlight.set(url, doc);
    }
    return doc;
  };
}

async function ttmlAnswer(source: string, url: string | null, get: DocumentFetch): Promise<ProviderResult | null> {
  if (!url) return null;
  const ttml = await get(url);
  return ttml ? toResult(source, parseTtml(ttml)) : null;
}

/** One lrc.red search hit (`/search.json`). */
export interface LrcRedHit {
  isrc?: string;
  title?: string;
  artist?: string;
  album?: string;
  /** seconds, fractional */
  duration?: number;
}

/**
 * The hit that is the playing recording, or null if none surely is. A miss is
 * recoverable — the sources behind this one get their turn — and the wrong
 * words scrolling in time with the right song are not, so every test is a
 * requirement rather than a score: a well-formed ISRC, the same song and
 * version words with a shared artist (namesRecording), and a length within
 * LRCRED_TOLERANCE_SEC when both are known. With no credit to check, a name
 * alone is not enough. Of the hits that pass: the playing album's, then the
 * closest in length, then the search's own order.
 */
export function pickLrcRedHit(
  hits: LrcRedHit[],
  q: Pick<LyricQuery, "title" | "artist" | "duration" | "album">
): LrcRedHit | null {
  const timed = q.duration > 0;
  if (!timed && !artistNames(q.artist || "").length) return null;
  const gap = (h: LrcRedHit): number => (timed && h.duration != null ? Math.abs(Number(h.duration) - q.duration) : 0);
  const album = plainWords(releaseName(q.album || ""));
  const fromAlbum = (h: LrcRedHit): number => (album && plainWords(releaseName(h.album ?? "")) === album ? 0 : 1);
  return (
    hits
      .filter(
        (h) =>
          !!lrcRedDocument(h?.isrc) &&
          (namesRecording(h.title ?? "", h.artist ?? "", q, { length: h.duration }) ||
            namesReleaseRecording(h.title ?? "", h.artist ?? "", h.album, q)) &&
          gap(h) <= LRCRED_TOLERANCE_SEC
      )
      .sort((a, b) => fromAlbum(a) - fromAlbum(b) || gap(a) - gap(b))[0] ?? null
  );
}

/** An album name without the store's " - Single" / " - EP" suffix. */
function releaseName(album: string): string {
  return cleanTitle(album).replace(/\s+[-–]\s+(?:single|ep)\s*$/i, "");
}

/**
 * An entry of the playing release named as the release is, when the playing
 * title is that name without its version words: YT Music files the single
 * "Despacito (Versión Pop)" as "Despacito", and Apple as "Despacito (Versión
 * Pop)". Only on the playing album, so a plain title never borrows another
 * release's version.
 */
function namesReleaseRecording(
  name: string,
  artist: string,
  album: string | undefined,
  q: Pick<LyricQuery, "title" | "artist" | "album">
): boolean {
  if (!q.album || plainWords(releaseName(album ?? "")) !== plainWords(releaseName(q.album))) return false;
  const release = releaseName(q.album);
  const r = recordingName(release);
  const t = recordingName(q.title || "");
  return !!r.versions && !t.versions && r.core === t.core && namesRecording(name, artist, { title: release, artist: q.artist });
}

async function lrcRedSearch(q: LyricQuery): Promise<LrcRedHit[]> {
  const term = [searchTitle(q.title), searchArtist(q.artist || "")].filter(Boolean).join(" ");
  const body = await getText(`${LRCRED}/search.json?${new URLSearchParams({ q: term }).toString()}`);
  if (!body) return [];
  try {
    const hits = JSON.parse(body)?.hits;
    return Array.isArray(hits) ? hits : [];
  } catch {
    return [];
  }
}

async function fetchLrcRed(
  q: LyricQuery,
  recording: Promise<RecordingHit | null>,
  get: DocumentFetch
): Promise<ProviderResult | null> {
  const identified = recording.then((hit) => lrcRedDocument(hit?.isrc));
  const search = (): Promise<string | null> =>
    lrcRedSearch(q).then((hits) => lrcRedDocument(pickLrcRedHit(hits, q)?.isrc));
  // BitChord's order: the recording identify named, and lrc.red's own search
  // only when it named none. The search starts alongside, so a miss costs no
  // extra round trip, but it never goes first: one song released in four
  // languages at one length ties every test, and the search's pick among them
  // is arbitrary. (A recording remembered from an earlier play needs no search.)
  const searched = q.id && isrcCache.has(q.id) ? null : search();
  const doc = (await identified) ?? (searched ? await searched : null);
  const answer = await ttmlAnswer("lrc.red", doc, get);
  if (answer) return answer;
  // A recording lrc.red has no document for is often filed under a sibling
  // release's code, so the other way of naming it still gets its turn.
  const other = (await Promise.all([identified, searched ?? search()])).find((d) => d && d !== doc) ?? null;
  return other ? ttmlAnswer("lrc.red", other, get) : null;
}

/* ------------------------------ BiniLyrics ------------------------------- */

/**
 * Apple Music TTML through the Bini backend — the one search here that will
 * answer to a recording rather than to a name, and that reports the ISRC of
 * what it matched. It runs first, as the identify step: its answer is a name
 * every other source can use (lrc.red fetches that recording's document,
 * LyricsPlus asks for it by ISRC), and it is remembered against the video id
 * so a track asked about twice pays for it once. It is asked with the album
 * too, which the backend takes as a strict filter: a hit is that very
 * release. BitChord takes the first row as it comes; here it must also name
 * the playing recording, the same test lrc.red's hits pass. Its document is
 * lrc.red's file, fetched once between the two. (BitChord's BiniLyrics.)
 */
const BINI = "https://lyrics-api.binimum.org/";

interface RecordingHit {
  isrc: string | null;
  lyricsUrl: string | null;
}

/** One row of a Bini search (the lrc.red catalogue behind it). */
export interface LrcRedRow {
  isrc?: string;
  lyricsUrl?: string;
  track_name?: string;
  artist_name?: string;
  album_name?: string;
  /** seconds, sent as a string */
  duration?: string | number;
  /** "word", "line" or "none" (no lyrics) */
  timing_type?: string;
}

const isrcCache = new Map<string, string>();
const ISRC_CACHE_MAX = 500;

function rememberIsrc(videoId: string, isrc: string): void {
  if (!videoId || !isrc) return;
  isrcCache.set(videoId, isrc);
  while (isrcCache.size > ISRC_CACHE_MAX) {
    const oldest = isrcCache.keys().next().value;
    if (oldest === undefined) break;
    isrcCache.delete(oldest);
  }
}

async function biniSearch(params: Record<string, string>): Promise<LrcRedRow[]> {
  const body = await getText(`${BINI}?${new URLSearchParams(params).toString()}`);
  if (!body) return [];
  try {
    const json = JSON.parse(body);
    return Array.isArray(json?.results) ? json.results : [];
  } catch {
    return [];
  }
}

/**
 * The row that IS the playing recording. The backend ranks on runtime —
 * "Despacito (Mandarin Version)" or "Baby (Acoustic)" comes first whenever it
 * runs a second closer — so a row must carry timed words, name the playing
 * recording and fit within LRCRED_TOLERANCE_SEC; with no credit to check, the
 * length is required. A music video — no album, no version words, a credit —
 * may run past the catalogue cut it was filmed to (BitChord's identify takes
 * its row at any length), and the renderer's onset alignment takes up the
 * intro; nothing repairs an upload shorter than the cut. Of the rows that
 * pass: one within tolerance, then the playing album's, then word timing over
 * line timing, then the closest length.
 */
export function pickLrcRedRow(
  rows: LrcRedRow[],
  q: Pick<LyricQuery, "title" | "artist" | "duration" | "album">
): LrcRedRow | null {
  const timed = q.duration > 0;
  if (!timed && !artistNames(q.artist || "").length) return null;
  const gap = (r: LrcRedRow): number => (timed ? Math.abs(Number(r.duration) - q.duration) : 0);
  const close = (r: LrcRedRow): boolean => !timed || gap(r) <= LRCRED_TOLERANCE_SEC;
  const video = !q.album && !recordingName(q.title || "").versions && artistNames(q.artist || "").length > 0;
  const fits = rows.filter(
    (r) =>
      !!lrcRedDocument(r?.isrc) &&
      !!r.lyricsUrl &&
      (r.timing_type === "word" || r.timing_type === "line") &&
      (namesRecording(r.track_name ?? "", r.artist_name ?? "", q, { length: r.duration }) ||
        namesReleaseRecording(r.track_name ?? "", r.artist_name ?? "", r.album_name, q)) &&
      (close(r) || (video && artistNames(r.artist_name ?? "").length > 0 && Number(r.duration) < q.duration))
  );
  const album = plainWords(releaseName(q.album || ""));
  const fromAlbum = (r: LrcRedRow): number => (album && plainWords(releaseName(r.album_name ?? "")) === album ? 0 : 1);
  fits.sort(
    (a, b) =>
      Number(close(b)) - Number(close(a)) ||
      fromAlbum(a) - fromAlbum(b) ||
      Number(b.timing_type === "word") - Number(a.timing_type === "word") ||
      gap(a) - gap(b)
  );
  return fits[0] ?? null;
}

/**
 * Which recording this is, before anybody is asked for words. `hit` is capped
 * at IDENTIFY_TIMEOUT_MS — knowing the recording makes every match better,
 * but a lyrics view held up by one slow host is a worse failure than a fuzzy
 * match; `full` is the same search uncapped, for BiniLyrics' own answer.
 */
function identifyRecording(q: LyricQuery): { hit: Promise<RecordingHit | null>; full: Promise<RecordingHit | null> } {
  const cached = q.id ? isrcCache.get(q.id) : undefined;
  if (cached) {
    const known = Promise.resolve({ isrc: cached, lyricsUrl: null });
    return { hit: known, full: known };
  }
  const params: Record<string, string> = { track: searchTitle(q.title || "") };
  const artist = searchArtist(q.artist || "");
  if (artist) params.artist = artist;
  if (q.album) params.album = cleanTitle(q.album);
  if (q.duration > 0) params.duration = String(Math.round(q.duration));
  const full = biniSearch(params)
    .then((rows): RecordingHit | null => {
      const row = pickLrcRedRow(rows, q);
      if (!row?.isrc) return null;
      // A pick made on title and length alone is a guess: used for this play,
      // never remembered for the next one.
      if (q.id && artistNames(q.artist || "").length) rememberIsrc(q.id, row.isrc);
      return { isrc: row.isrc, lyricsUrl: row.lyricsUrl ?? null };
    })
    .catch((): RecordingHit | null => null);
  const hit = Promise.race([
    full,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), IDENTIFY_TIMEOUT_MS)),
  ]);
  return { hit, full };
}

async function fetchBini(recording: Promise<RecordingHit | null>, get: DocumentFetch): Promise<ProviderResult | null> {
  const hit = await recording;
  let url = hit?.lyricsUrl ?? null;
  // A remembered recording carries no document address: ask for it by ISRC.
  // Nothing else is worth sending — a title alongside could only disagree.
  if (!url && hit?.isrc) {
    const isrc = hit.isrc;
    url = (await biniSearch({ isrc })).find((r) => r?.isrc === isrc)?.lyricsUrl ?? null;
  }
  return ttmlAnswer("BiniLyrics", url, get);
}

/* -------------------------- BetterLyrics Portato ------------------------- */

/**
 * QQ Music's karaoke timings through BetterLyrics' Portato endpoint — word
 * timing for the sizable slice of the catalogue (C-pop, J-pop, regional
 * releases) Apple doesn't carry. The endpoint now demands an API key for
 * queries its cache has never seen, so a 401 saying so parks the source for
 * the session rather than burning four dead requests on every track; cached
 * queries still answer keyless, and a new session asks again.
 */
let portatoKeyGated = false;

async function fetchPortato(q: LyricQuery): Promise<ProviderResult | null> {
  // Asked like BetterLyrics, once per form of the credit.
  for (const a of creditForms(q.artist || "")) {
    if (portatoKeyGated) return null;
    const params = new URLSearchParams({ s: searchTitle(q.title), a });
    if (q.duration > 0) params.set("d", String(Math.round(q.duration)));
    if (q.album) params.set("al", cleanTitle(q.album));
    const body = await getText(`https://lyrics-api.boidu.dev/qq/getLyrics?${params.toString()}`);
    if (!body) continue;
    if (/API key required/i.test(body)) {
      portatoKeyGated = true;
      return null;
    }
    const parsed = parseProviderAny(body);
    if (!parsed) continue;
    if ("plain" in parsed) return { source: "Portato", wordSynced: false, lines: [], plainText: parsed.plain };
    // QQ's file names its own recording in its opening line — the only place a
    // live cut or another singer's version says what it is.
    if (openingNameFits(parsed, q) === false) continue;
    // Still sung after the track has ended: another song's file (QQ answered "벚꽃 엔딩" with 孤星泪 by 刘德华).
    if (q.duration > 0 && parsed.some((l) => l.text.trim() && l.time > q.duration + LRCRED_TOLERANCE_SEC)) continue;
    const found = toResult("Portato", withoutOpening(parsed));
    if (found) return found;
  }
  return null;
}

/* -------------------------------- Unison --------------------------------- */

/**
 * Community-submitted lyrics — the only source here whose contents are
 * contributed rather than licensed, so it occasionally carries a track none
 * of the catalogues do. Three shapes come back, and the entry says which:
 * Apple-style TTML, stamped LRC, or plain text with no timing at all.
 */
async function fetchUnison(q: LyricQuery): Promise<ProviderResult | null> {
  const artist = searchArtist(q.artist || "");
  // The endpoint 400s on an empty artist rather than searching song-only.
  if (!artist) return null;
  const params = new URLSearchParams({
    song: searchTitle(q.title),
    artist,
  });
  if (q.album) params.set("album", cleanTitle(q.album));
  if (q.duration > 0) params.set("duration", String(Math.round(q.duration)));
  const body = await getText(`https://unison.boidu.dev/lyrics?${params.toString()}`);
  if (!body) return null;
  let entry: { lyrics?: unknown; format?: unknown; syncType?: unknown; song?: unknown; artist?: unknown; videoId?: unknown };
  try {
    const json = JSON.parse(body);
    if (json?.success !== true) return null;
    entry = json.data ?? {};
  } catch {
    return null;
  }
  // Contributed for a song by name, and matched within a couple of seconds:
  // it must name the playing recording, version words and all — unless it was
  // made for this very video.
  if (
    entry.videoId !== q.id &&
    typeof entry.song === "string" &&
    entry.song &&
    !namesRecording(entry.song, String(entry.artist ?? ""), q)
  ) {
    return null;
  }
  const text = typeof entry.lyrics === "string" ? entry.lyrics : "";
  if (!text.trim()) return null;
  const plain = (): ProviderResult | null => {
    const joined = text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .join("\n");
    return joined ? { source: "Unison", wordSynced: false, lines: [], plainText: joined } : null;
  };
  // A TTML document nobody can read is no answer — never its markup shown as text (BitChord's Unison).
  if (String(entry.format ?? "").toLowerCase() === "ttml") return toResult("Unison", parseTtml(text));
  if (String(entry.syncType ?? "").toLowerCase() === "plain") return plain();
  const enhanced = parseEnhancedLrc(text);
  if (enhanced.length) return toResult("Unison", enhanced);
  const lrc = parseLrc(text);
  if (lrc.length) return toResult("Unison", lrc);
  return plain();
}

/* --------------------- YouTube captions + YT Music ----------------------- */

/**
 * Timed captions for the exact playing video — innertube's get_transcript,
 * fetched by the caller (it needs the YouTube session). Not a catalogue
 * match: the timing is the caption track's, which is only as good as its
 * author. But it answers for the long tail the catalogues have never heard
 * of — covers, regionals, self-uploads — and it can never name the wrong
 * recording.
 */
async function fetchYouTubeTranscript(
  q: LyricQuery,
  fn?: (videoId: string) => Promise<SyncedLyricLine[] | null>
): Promise<ProviderResult | null> {
  if (!fn || !q.id || q.id.includes(":")) return null;
  const lines = await fn(q.id);
  return lines && lines.length ? toResult("YouTube Captions", lines) : null;
}

/** Plain lyrics from YT Music's own Lyrics tab, ranked as a source of its own. */
async function fetchYouTubeMusic(
  q: LyricQuery,
  fn?: (videoId: string) => Promise<string | null>
): Promise<ProviderResult | null> {
  if (!fn || !q.id || q.id.includes(":")) return null;
  const text = await fn(q.id);
  return text && text.trim()
    ? { source: "YouTube Music", wordSynced: false, lines: [], plainText: text }
    : null;
}

/* ------------------------------- Musixmatch ------------------------------ */

/**
 * Rich word timing, with a line-synced fallback, from Musixmatch's web API —
 * the biggest lyrics catalogue there is, and one none of the sources above
 * can stand in for.
 *
 * No user key: requests are signed the way Musixmatch's own web client signs
 * them — HMAC-SHA256 over `<url><UTC date>` with a rotating key scraped from
 * the client's JavaScript (a hardcoded copy stands in when the page is
 * briefly unavailable). The user token it issues is cached, and an auth
 * failure inside an otherwise-successful response mints a fresh pair once.
 */
const MUSIXMATCH_BASE = "https://apic.musixmatch.com/ws/1.1";
const MUSIXMATCH_APP_ID = "mobile-app-v1.0";
const MUSIXMATCH_FALLBACK_SECRET = "f09016176ba43a1cfd1031fbd6b3d26c";

let mxSecret: string | null = null;
let mxToken: string | null = null;
const mxGuid = randomUUID();

/** Signs `<url><UTC yyyyMMdd>` with HMAC-SHA256, matching the web client. */
function mxSign(url: string, secret: string): string {
  const normalized = url.replace(/%20/g, "+").replace(/ /g, "+");
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const signature = createHmac("sha256", secret).update(`${normalized}${date}`).digest("base64");
  return `${normalized}&signature=${encodeURIComponent(signature)}&signature_protocol=sha256`;
}

async function mxBrowserGet(url: string, accept: string): Promise<string | null> {
  return getText(url, 8000, {
    "User-Agent": UA,
    Accept: accept,
    "Accept-Language": "en-US,en;q=0.9",
    Cookie: "mxm_bab=AB",
  });
}

/** Reads the rotating signing key from the JavaScript linked by the web client. */
async function mxGetSecret(): Promise<string> {
  if (mxSecret) return mxSecret;
  try {
    const page = await mxBrowserGet("https://www.musixmatch.com/search", "text/html,application/xhtml+xml");
    if (page) {
      const script = /src=["']([^"']*\/_next\/static\/chunks\/pages\/_app-[^"']+\.js)["']/i.exec(page)?.[1];
      if (script) {
        const scriptUrl = new URL(script, "https://www.musixmatch.com").toString();
        const js = await mxBrowserGet(scriptUrl, "*/*");
        if (js) {
          const encoded = /from\(\s*["']([^"']+)["']\s*\.split/.exec(js)?.[1];
          if (encoded) {
            const secret = Buffer.from(encoded.split("").reverse().join(""), "base64").toString("utf-8");
            if (secret.trim()) {
              mxSecret = secret;
              return secret;
            }
          }
        }
      }
    }
  } catch {
    /* fall through to the baked-in key */
  }
  mxSecret = MUSIXMATCH_FALLBACK_SECRET;
  return mxSecret;
}

/** token.get answers some networks with a 403 for every client (BitChord's too): parked until restart, like Portato.
 * Only on that status — a timeout or a 5xx at startup must not switch the source off where it works. */
let mxBlocked = false;

async function mxGetToken(secret: string): Promise<string | null> {
  if (mxToken) return mxToken;
  if (mxBlocked) return null;
  const url = `${MUSIXMATCH_BASE}/token.get?${new URLSearchParams({
    app_id: MUSIXMATCH_APP_ID,
    guid: mxGuid,
    format: "json",
  })}`;
  const body = await getText(
    mxSign(url, secret),
    8000,
    { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
    undefined,
    (status) => {
      if (status === 403) mxBlocked = true;
    }
  );
  if (!body) return null;
  try {
    const json = JSON.parse(body);
    const token = json?.message?.body?.user_token;
    if (json?.message?.header?.status_code === 200 && typeof token === "string" && token) {
      mxToken = token;
      return token;
    }
    return null;
  } catch {
    return null;
  }
}

/** Musixmatch reports an expired token inside a successful HTTP response. */
function mxLooksUnauthorized(body: string): boolean {
  try {
    const status = JSON.parse(body)?.message?.header?.status_code;
    return status === 401 || status === 402;
  } catch {
    return false;
  }
}

async function mxSignedGet(buildUrl: (token: string) => string): Promise<string | null> {
  const secret = await mxGetSecret();
  const token = await mxGetToken(secret);
  if (!token) return null;
  const headers = { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" };
  const first = await getText(mxSign(buildUrl(token), secret), 8000, headers);
  if (first && !mxLooksUnauthorized(first)) return first;
  mxToken = null;
  mxSecret = null;
  const freshSecret = await mxGetSecret();
  const freshToken = await mxGetToken(freshSecret);
  if (!freshToken) return null;
  const second = await getText(mxSign(buildUrl(freshToken), freshSecret), 8000, headers);
  return second && !mxLooksUnauthorized(second) ? second : null;
}

interface MxTrack {
  trackId: number;
  trackName: string;
  artistName: string;
  trackLength: number | null;
  hasSubtitles: number | null;
  hasRichsync: number | null;
}

function mxScore(track: MxTrack, title: string, artist: string, seconds: number): number {
  let score = 0;
  const name = track.trackName.trim().toLowerCase();
  const wantTitle = title.trim().toLowerCase();
  if (name === wantTitle) score += 80;
  else if (name.includes(wantTitle) || wantTitle.includes(name)) score += 40;
  const haveArtist = track.artistName.trim().toLowerCase();
  const wantArtist = artist.trim().toLowerCase();
  if (wantArtist && haveArtist.includes(wantArtist)) score += 40;
  if (track.trackLength && seconds > 0) {
    const diff = Math.abs(track.trackLength - seconds);
    score += diff <= 2 ? 30 : diff <= 5 ? 15 : diff <= 10 ? 5 : -20;
  }
  return score;
}

/**
 * Decodes Musixmatch's rich-sync JSON without flattening it through line
 * LRC. Fragment order is retained — punctuation and syllable fragments may
 * share a stamp. All times arrive in seconds.
 */
function parseMusixmatchRichSync(body: string): SyncedLyricLine[] {
  let entries: any[];
  try {
    entries = JSON.parse(body);
  } catch {
    return [];
  }
  if (!Array.isArray(entries)) return [];
  const out: SyncedLyricLine[] = [];
  for (const entry of entries) {
    const lineStart = Number(entry?.ts) || 0;
    const lineEnd = Math.max(lineStart, Number(entry?.te) || lineStart);
    const fragments: any[] = Array.isArray(entry?.l) ? entry.l : [];
    const words: SyncedLyricWord[] = [];
    let cur: { start: number; end: number; text: string } | null = null;
    let prevStart = lineStart;
    const flush = (): void => {
      if (!cur) return;
      const text = cur.text.trim();
      if (text) words.push({ start: cur.start, end: Math.max(cur.start, cur.end), text });
      cur = null;
    };
    fragments.forEach((fragment, index) => {
      const raw = typeof fragment?.c === "string" ? fragment.c : "";
      if (!raw) return;
      const start = Math.max(lineStart, prevStart, lineStart + (Number(fragment.o) || 0));
      const nextOffset = fragments[index + 1] ? Number(fragments[index + 1].o) || 0 : null;
      const next = nextOffset != null ? lineStart + nextOffset : lineEnd;
      const end = Math.max(start, Math.min(lineEnd, next));
      prevStart = start;
      if (/^\s/.test(raw)) flush();
      const content = raw.trim();
      if (content) {
        if (!cur) cur = { start, end, text: content };
        else {
          cur.text += content;
          cur.end = end;
        }
      }
      if (/\s$/.test(raw)) flush();
    });
    flush();
    const text = String(entry?.x ?? "").trim() || words.map((w) => w.text).join(" ");
    if (!text) continue;
    out.push({
      time: Math.min(lineStart, words[0]?.start ?? lineStart),
      text,
      words,
      end: lineEnd > lineStart ? lineEnd : undefined,
    });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

/** Musixmatch's `mxm` subtitle JSON, converted only for the line-sync fallback. */
function mxSubtitleToLrc(body: string): string | null {
  let lines: any[];
  try {
    lines = JSON.parse(body);
  } catch {
    return null;
  }
  if (!Array.isArray(lines)) return null;
  const out: string[] = [];
  for (const line of lines) {
    const text = String(line?.text ?? "");
    if (!text.trim()) continue;
    const totalMs = Math.round((Number(line?.time?.total) || 0) * 1000);
    const mm = Math.floor(totalMs / 60000);
    const ss = Math.floor((totalMs % 60000) / 1000);
    const ms = totalMs % 1000;
    out.push(
      `[${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}.${String(ms).padStart(3, "0")}]${text}`
    );
  }
  return out.length ? out.join("\n") : null;
}

async function fetchMusixmatch(q: LyricQuery): Promise<ProviderResult | null> {
  const artist = searchArtist(q.artist || "");
  const seconds = Math.round(q.duration);
  const stripped = queryTitle(q.title);
  const full = cleanTitle(q.title).trim();
  const titles = full && full.toLowerCase() !== stripped.toLowerCase() ? [full, stripped] : [stripped];

  let best: MxTrack | null = null;
  for (const title of titles) {
    const body = await mxSignedGet((token) =>
      `${MUSIXMATCH_BASE}/track.search?${new URLSearchParams({
        app_id: MUSIXMATCH_APP_ID,
        format: "json",
        q_track: title,
        q_artist: artist,
        f_has_lyrics: "1",
        s_track_rating: "desc",
        quorum_factor: "1",
        page_size: "10",
        page: "1",
        usertoken: token,
      })}`
    );
    if (!body) continue;
    try {
      const list = JSON.parse(body)?.message?.body?.track_list ?? [];
      for (const wrapper of list) {
        const t = wrapper?.track;
        if (!t?.track_id) continue;
        const candidate: MxTrack = {
          trackId: t.track_id,
          trackName: String(t.track_name ?? ""),
          artistName: String(t.artist_name ?? ""),
          trackLength: t.track_length ?? null,
          hasSubtitles: t.has_subtitles ?? null,
          hasRichsync: t.has_richsync ?? null,
        };
        // The score only ranks real matches; it never makes one — a same-artist
        // live take near a music video's length used to outscore the song.
        if (!namesRecording(candidate.trackName, candidate.artistName, q, { length: candidate.trackLength })) continue;
        if (!best || mxScore(candidate, title, artist, seconds) > mxScore(best, title, artist, seconds)) {
          best = candidate;
        }
      }
    } catch {
      /* try the next title variant */
    }
    if (best) break;
  }
  if (!best) return null;

  // The subtitle endpoint is line-timed by design. Prefer the separate
  // rich-sync tier so tracks that have syllable data are not flattened on
  // ingestion.
  if (best.hasRichsync) {
    const body = await mxSignedGet((token) =>
      `${MUSIXMATCH_BASE}/track.richsync.get?${new URLSearchParams({
        app_id: MUSIXMATCH_APP_ID,
        format: "json",
        track_id: String(best!.trackId),
        usertoken: token,
      })}`
    );
    if (body) {
      try {
        const richsyncBody = JSON.parse(body)?.message?.body?.richsync?.richsync_body;
        if (typeof richsyncBody === "string" && richsyncBody.trim()) {
          const lines = parseMusixmatchRichSync(richsyncBody);
          if (lines.some((l) => l.words?.length)) return toResult("Musixmatch", lines);
        }
      } catch {
        /* fall through to the subtitle */
      }
    }
  }

  if (best.hasSubtitles) {
    const body = await mxSignedGet((token) =>
      `${MUSIXMATCH_BASE}/track.subtitle.get?${new URLSearchParams({
        app_id: MUSIXMATCH_APP_ID,
        format: "json",
        track_id: String(best!.trackId),
        subtitle_format: "mxm",
        usertoken: token,
      })}`
    );
    if (body) {
      try {
        const subtitleBody = JSON.parse(body)?.message?.body?.subtitle?.subtitle_body;
        if (typeof subtitleBody === "string" && subtitleBody.trim()) {
          const lrc = mxSubtitleToLrc(subtitleBody);
          if (lrc) {
            const lines = parseLrc(lrc);
            if (lines.length) return toResult("Musixmatch", lines);
          }
        }
      } catch {
        /* give up quietly */
      }
    }
  }
  return null;
}

/* --------------------------------- Genius -------------------------------- */

/**
 * Plain-text lyrics scraped from Genius — no timings, but a catalogue so
 * large it is the last resort that almost always answers.
 *
 * The User-Agent deliberately claims nothing: Genius sits behind Cloudflare,
 * which challenges a browser-claiming agent whose TLS fingerprint does not
 * back the claim. A plain one is answered; a Chrome one gets a 403 that
 * reads, one layer up, as "no lyrics for this track".
 */
const GENIUS_AGENT = "ByTune";

function geniusCleanQuery(text: string): string {
  const cleaned = text
    .replace(/[♪♫★☆【】《》「」~_]/g, " ")
    .replace(
      /\s*[(\[]\s*(?:from|feat\.?|ft\.?|featuring|with|prod\.?|produced by|official|lyrical|video|audio|remix|music video|visualizer|mv|hd|4k|hq|full song)[^)\]]*[)\]]/gi,
      " "
    )
    .replace(
      /\s*\b(?:official\s+(?:music\s+)?(?:video|audio)|lyrical(?:\s+video)?|full\s+song|4k\s+video|hd\s+video|music\s+video)\b/gi,
      " "
    )
    .replace(/\b(?:prod(?:uced)?\.?(?:\s+by)?)\s+.*$/i, "")
    .split(" | ")[0]
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || text.trim();
}

function geniusBestMatch(
  candidates: { url?: unknown; path?: unknown; title?: unknown; artistNames?: unknown }[],
  title: string,
  artist: string,
  q: LyricQuery
): string | null {
  const normTitle = title.toLowerCase();
  const normArtist = artist.toLowerCase();
  let bestUrl: string | null = null;
  let bestScore = 0;
  for (const item of candidates) {
    // Matched on the playing title with both names required: a title alone
    // gave Adele's "Hello" to a Hindi film song of the same name. Plain text:
    // a sped-up or slowed upload still reads the song's own page.
    if (!namesRecording(String(item.title ?? ""), String(item.artistNames ?? ""), q, { plainText: true })) continue;
    const t = String(item.title ?? "").toLowerCase();
    const a = String(item.artistNames ?? "").toLowerCase();
    const titleMatches = !!normTitle && (t === normTitle || t.includes(normTitle) || normTitle.includes(t));
    const artistMatches = !!normArtist && (a === normArtist || a.includes(normArtist) || normArtist.includes(a));
    let score = 0;
    if (t === normTitle) score += 50;
    else if (titleMatches) score += 25;
    if (artistMatches) score += a === normArtist ? 40 : 20;
    // Penalize translations, instrumentals and album pages unless asked for.
    const path = String(item.path ?? "").toLowerCase();
    if (path.includes("translation") && !normTitle.includes("translation")) score -= 30;
    if (path.includes("türkçe") || path.includes("polskie-tlumaczenie")) score -= 40;
    if (path.includes("tracklist") || path.includes("album-art")) score -= 50;
    if (score > bestScore) {
      bestScore = score;
      bestUrl = typeof item.url === "string" ? item.url : null;
    }
  }
  return bestScore > 0 ? bestUrl : null;
}

async function geniusExtractLyrics(html: string): Promise<string | null> {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM(html);
  try {
    const doc = dom.window.document;
    let containers = [...doc.querySelectorAll('div[data-lyrics-container="true"]')];
    if (!containers.length) containers = [...doc.querySelectorAll("div.lyrics")];
    if (!containers.length) return null;
    const parts: string[] = [];
    for (const container of containers) {
      container
        .querySelectorAll(
          '[data-exclude-from-selection="true"], .LyricsHeader__Container, .SongBioPreview__Container, .InreadAd__Container, button, script, style'
        )
        .forEach((node) => node.remove());
      container.querySelectorAll("br").forEach((br) => br.replaceWith(doc.createTextNode("\n")));
      container.querySelectorAll("p").forEach((p) => p.before("\n"));
      const text = container.textContent ?? "";
      if (text.trim()) parts.push(text);
    }
    const cleaned = parts
      .join("\n")
      .replace(/\u00A0/g, " ")
      .replace(/\u200B/g, " ")
      .replace(/\uFEFF/g, " ")
      .replace(/\d*You might also like/gi, "")
      .trim()
      .replace(/\d*Embed\s*$/i, "")
      .trim();
    return cleaned || null;
  } finally {
    dom.window.close();
  }
}

async function fetchGenius(q: LyricQuery): Promise<ProviderResult | null> {
  const artist = searchArtist(q.artist || "");
  const title = queryTitle(q.title);
  if (!title) return null;
  const cleanTitle2 = geniusCleanQuery(title);
  const attempts: { query: string; title: string; artist: string }[] = [];
  const push = (query: string, t: string, a: string): void => {
    query = query.trim();
    if (query && !attempts.some((x) => x.query === query)) attempts.push({ query, title: t, artist: a });
  };
  if (artist) {
    push(`${artist} ${title}`, title, artist);
    if (cleanTitle2.toLowerCase() !== title.toLowerCase()) {
      push(`${artist} ${cleanTitle2}`, cleanTitle2, artist);
    }
  }
  push(cleanTitle2 || title, cleanTitle2 || title, artist);

  const headers = {
    "User-Agent": GENIUS_AGENT,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  };
  let songUrl: string | null = null;
  for (const attempt of attempts) {
    const body = await getText(`https://genius.com/api/search/multi?q=${encodeURIComponent(attempt.query)}`, 8000, headers);
    if (!body) continue;
    try {
      const sections = JSON.parse(body)?.response?.sections;
      if (!Array.isArray(sections)) continue;
      const songSection = sections.find((s: any) => s?.type === "song");
      const hits: any[] = songSection?.hits ?? [];
      const candidates = hits
        .map((h) => h?.result)
        .filter(Boolean)
        .map((r) => ({ url: r.url, path: r.path, title: r.title, artistNames: r.artist_names }));
      const best = geniusBestMatch(candidates, attempt.title, attempt.artist, q);
      if (best) {
        songUrl = best;
        break;
      }
    } catch {
      /* next attempt */
    }
  }
  if (!songUrl) return null;
  const html = await getText(songUrl, 9000, headers);
  if (!html) return null;
  const text = await geniusExtractLyrics(html);
  return text ? { source: "Genius", wordSynced: false, lines: [], plainText: text } : null;
}

/* ------------------------------ repository ------------------------------ */

export interface FetchedLyrics {
  source: string;
  wordSynced: boolean;
  synced: SyncedLyricLine[] | null;
  plain: string | null;
}

/** A local file's own lyrics tag, when it is timed LRC — BitChord's EmbeddedLyrics, read before any source is
 * asked. Untimed text is no answer here: the sources are asked instead. */
export function embeddedLrc(raw: string): FetchedLyrics | null {
  const word = parseEnhancedLrc(raw);
  // Credited "Lyrics from this file".
  const r = toResult("this file", word.length ? word : parseLrc(raw));
  return r?.lines.some((l) => l.text.trim()) ? { source: r.source, wordSynced: r.wordSynced, synced: r.lines, plain: null } : null;
}

/**
 * The longest a lookup waits for the racing sources. BitChord waits on each
 * source only as long as that source's own requests allow; this is the safety
 * net under that — for a chain of slow requests, or a promise that never
 * settles. When it passes, the pick goes on with whatever has landed. Genius,
 * asked only when nothing answered, is bounded by its own request timeouts.
 */
const SWEEP_CEILING_MS = 12_000;

/**
 * Take the sources' answers in priority order — BitChord's loop. Every source
 * but the lazy ones is asked at once, and their answers are awaited one at a
 * time in order, so a lower source finishing first never beats one still
 * pending above it. A word-timed answer wins outright; with
 * `prioritizeWordSync` off (BitChord's default) so does any timed answer —
 * priority is priority. Otherwise the first answer is kept as the fallback
 * and the rest of the list is searched for word timing. A lazy source (Genius,
 * a scraper) is only asked when nothing above it answered at all.
 */
export async function takeInPriorityOrder(
  starts: (() => Promise<ProviderResult | null>)[],
  lazy: boolean[],
  prioritizeWordSync: boolean,
  ceilingMs = SWEEP_CEILING_MS
): Promise<{ pick: ProviderResult | null; settled: Map<number, ProviderResult | null> }> {
  const settled = new Map<number, ProviderResult | null>();
  const begin = (i: number): Promise<ProviderResult | null> =>
    starts[i]()
      .catch((): ProviderResult | null => null)
      .then((r) => {
        settled.set(i, r);
        return r;
      });
  const racing: (Promise<ProviderResult | null> | null)[] = starts.map((_, i) => (lazy[i] ? null : begin(i)));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ceiling = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ceilingMs);
  });
  try {
    let fallback: ProviderResult | null = null;
    for (let i = 0; i < starts.length; i++) {
      if (lazy[i] && fallback) continue;
      const job = racing[i] ?? (racing[i] = begin(i));
      // A lazy source runs whenever nothing answered (BitChord), however late that is.
      const found = lazy[i] ? await job : await Promise.race([job, ceiling]);
      if (!found) continue;
      if (found.wordSynced || (!prioritizeWordSync && found.lines.length > 0)) return { pick: found, settled };
      fallback = fallback ?? found;
    }
    return { pick: fallback, settled };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The sources, in BitChord's default order: the Apple hosts lead (lrc.red,
 * then BiniLyrics, which names the recording for the rest), then QQ's karaoke
 * timings, LyricsPlus' syllables and Unison's contributions; the playing
 * video's own captions and Lyrics tab; the line-synced workhorses; and
 * Genius's plain text last, asked only when nothing else answered. (BitChord
 * keeps SimpMusic and Megalobiz hidden — one answers every request with a
 * Cloudflare 403, the other's site lost its search page — and its two
 * PaxSenix variants need a PaxSenix API key.)
 */
const PROVIDERS: { name: string; lazy?: boolean }[] = [
  { name: "lrc.red" },
  { name: "BiniLyrics" },
  { name: "BetterLyrics" },
  { name: "Portato" },
  { name: "PaxSenix" },
  { name: "LyricsPlus" },
  { name: "Unison" },
  { name: "YouTube Captions" },
  { name: "YouTube Music" },
  { name: "KuGou" },
  { name: "LRCLIB" },
  { name: "Musixmatch" },
  { name: "Genius", lazy: true },
];

export interface FetchLyricsHelpers {
  /** Plain lyrics from YT Music's own Lyrics tab, ranked as a source of its own. */
  ytMusicPlain?: (videoId: string) => Promise<string | null>;
  /** Timed captions for the exact playing video, via the YouTube session. */
  ytTranscript?: (videoId: string) => Promise<SyncedLyricLine[] | null>;
}

export async function fetchLyrics(
  q: LyricQuery,
  opts: { prioritizeWordSync: boolean },
  helpers: FetchLyricsHelpers
): Promise<FetchedLyrics | null> {
  // Which recording is this? Settled before the sources that can name it are
  // asked: lrc.red fetches that recording's document, and LyricsPlus asks for
  // it by ISRC. The rest don't wait for it.
  const recording = identifyRecording(q);
  const cachedIsrc = q.id ? isrcCache.get(q.id) : undefined;
  const get = sharedDocuments();

  const starts: (() => Promise<ProviderResult | null>)[] = [
    () => fetchLrcRed(q, recording.hit, get),
    () => fetchBini(recording.full, get),
    () => fetchBetterLyrics(q),
    () => fetchPortato(q),
    () => fetchPaxSenix(q),
    () => recording.hit.then((hit) => fetchLyricsPlus(q, hit?.isrc ?? cachedIsrc)),
    () => fetchUnison(q),
    () => fetchYouTubeTranscript(q, helpers.ytTranscript),
    () => fetchYouTubeMusic(q, helpers.ytMusicPlain),
    () => fetchKuGou(q),
    () => fetchLrclib(q),
    () => fetchMusixmatch(q),
    () => fetchGenius(q),
  ];
  const began = Date.now();
  const took = new Map<number, number>();
  const { pick, settled } = await takeInPriorityOrder(
    starts.map((start, i) => () => start().finally(() => took.set(i, Date.now() - began))),
    PROVIDERS.map((p) => !!p.lazy),
    opts.prioritizeWordSync
  );

  // Temporary diagnostics: what each provider said by the time the pick was made.
  PROVIDERS.forEach(({ name }, i) => {
    if (!settled.has(i)) {
      console.log(`[bytune][lyrics] ${name}: still running at the deadline`);
      return;
    }
    const r = settled.get(i);
    if (r) {
      const last = r.lines.length ? r.lines[r.lines.length - 1].time : null;
      console.log(`[bytune][lyrics] ${name}: ${r.lines.length} lines last=${last?.toFixed(1)} plain=${!!r.plainText} word=${r.wordSynced} in ${took.get(i)}ms`);
    } else {
      console.log(`[bytune][lyrics] ${name}: rejected/failed in ${took.get(i)}ms`);
    }
  });
  console.log(`[bytune][lyrics] WINNER: ${pick?.source ?? "none"} lines=${pick?.lines.length ?? 0} plain=${!!pick?.plainText} after ${Date.now() - began}ms`);

  if (!pick) return null;
  if (pick.plainText) return { source: pick.source, wordSynced: false, synced: null, plain: pick.plainText };
  return { source: pick.source, wordSynced: pick.wordSynced, synced: pick.lines, plain: null };
}
