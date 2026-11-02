// Writes electron/hanFold.ts: Windows' own Traditional → Simplified table (gen-han-fold.ps1, LCMapStringEx over
// the CJK blocks) plus hand-picked variants. Windows only. Usage: node scripts/gen-han-fold.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dest = path.join(here, "..", "electron", "hanFold.ts");
const table = path.join(os.tmpdir(), `han-fold-${process.pid}.json`);
execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(here, "gen-han-fold.ps1"), table], { stdio: "inherit" });
const { from, to } = JSON.parse(fs.readFileSync(table, "utf8"));
fs.rmSync(table);
const map = new Map([...from].map((c, i) => [c, [...to][i]]));
// Variants Windows leaves alone, in the form catalogues write; Japanese shinjitai that differ from Simplified.
const extra =
  "後后 乾干 於于 徵征 藉借 夥伙 鍾钟 锺钟 爲为 綫线 衆众 啓启 峯峰 羣群 裏里 桜樱 気气 広广 歩步 黒黑 涙泪 駆驱 栄荣 帰归 様样 " +
  "変变 戦战 伝传 楽乐 読读 図图 対对 売卖 駅驿 鉄铁 竜龙 実实 歳岁 浜滨 沢泽 緑绿 聴听 転转 続续 険险 剣剑 鶏鸡 撃击 発发 " +
  "髪发 単单 弾弹 円圆 縄绳 譲让 壊坏 懐怀 価价 圧压 営营 覚觉 関关 観观 歓欢 権权 験验 厳严 蔵藏 総总 騒骚 臓脏 豊丰 満满 " +
  "黙默 訳译 薬药 揺摇 頼赖 覧览 両两 猟猎 霊灵 齢龄 歴历 労劳 録录 悪恶 亜亚 囲围 応应 穏稳 仮假 絵绘 拡扩 巻卷 勧劝 寛宽 " +
  "偽伪 戯戏 拠据 挙举 暁晓 勲勋 恵惠 継继 軽轻 芸艺 県县 倹俭 圏圈 検检 鉱矿 済济 砕碎 斎斋 剤剂 雑杂 賛赞 糸丝 歯齿 児儿 " +
  "釈释 収收 従从 渋涩 獣兽 縦纵 粛肃 処处 焼烧 証证 奨奖 乗乘 浄净 剰剩 畳叠 壌壤 嬢娘 醸酿 粋粹 酔醉 穂穗 髄髓 瀬濑 斉齐 " +
  "摂摄 専专 銭钱 繊纤 荘庄 捜搜 挿插 巣巢 増增 帯带 滝泷 択择 団团 遅迟 鋳铸 庁厅 徴征 鎮镇 逓递 闘斗 徳德 弐贰 悩恼 脳脑 " +
  "覇霸 廃废 拝拜 抜拔 晩晚 賓宾 仏佛 併并 並并 辺边 毎每 謡谣 塁垒 戻戾 暦历 獲获 穫获 隠隐 滙汇 紮扎 " +
  // Taiwan / Hong Kong usage Windows leaves alone or folds to a rare form (麼 → 麽, 鹼 → 硷).
  "麼么 麽么 蹟迹 慾欲 盃杯 嚐尝 牠它 鷄鸡 麪面 綉绣 鈎钩 牀床 廻回 竝并 嫺娴 竈灶 鵰雕 鹼碱 礆碱 硷碱 昇升 綑捆 凃涂 衞卫 " +
  "経经 説说 姫姬 縁缘 戸户 渉涉 隣邻 頬颊 蛍萤 塩盐 郷乡 亀龟 値值 呉吴 稲稻 痩瘦 醤酱 粧妆 顕显 姉姊 鋭锐 艶艳 掲揭 渓溪 " +
  "錬炼 曽曾 舗铺 麺面 壱壹 殻壳 陥陷 犠牺 薫薰 効效 桟栈 塚冢 払拂 讃赞 鴎鸥 駄驮 鬪斗 鬭斗 竪竖 姸妍 劒剑 釼剑 氷冰";
for (const pair of extra.split(" ")) {
  const [a, b] = [...pair];
  if (a && b && a !== b) map.set(a, b);
}
// Resolve chains so every character folds in one step.
for (const [k, v] of map) {
  let t = v;
  for (let n = 0; map.has(t) && map.get(t) !== t && n < 5; n++) t = map.get(t);
  map.set(k, t);
}
const keys = [...map.keys()].filter((k) => k.length === 1 && map.get(k).length === 1).sort((a, b) => a.codePointAt(0) - b.codePointAt(0));
const F = keys.join("");
const T = keys.map((k) => map.get(k)).join("");
if (F.length !== T.length) throw new Error("misaligned");
const chunk = (s) => s.match(/[\s\S]{1,100}/g).map((p) => `  "${p}"`).join(" +\n");
const out = `/**
 * Traditional Chinese (and Japanese shinjitai) folded to Simplified, one character at a time, so a
 * catalogue that writes "龍捲風" / "周杰倫" and one that writes "龙卷风" / "周杰伦" name the same song.
 * Generated from Windows' own converter (LCMapStringEx with LCMAP_SIMPLIFIED_CHINESE) over the CJK
 * blocks, plus the variants it leaves alone (後, 於, 爲, 綫, 衆…) and the shinjitai that differ from
 * Simplified (桜, 気, 涙, 戦…). Regenerate with scripts/gen-han-fold.mjs rather than hand-edit: the
 * two strings are index-aligned.
 */
const FROM =
${chunk(F)};
const TO =
${chunk(T)};

const FOLD = new Map<string, string>();
for (let i = 0; i < FROM.length; i++) FOLD.set(FROM[i], TO[i]);

/** Every Han character in its Simplified form; everything else untouched. */
export function foldHan(s: string): string {
  return s.replace(/\\p{Script=Han}/gu, (c) => FOLD.get(c) ?? c);
}
`;
fs.writeFileSync(dest, out);
console.log("pairs", keys.length, "bytes", Buffer.byteLength(out));
