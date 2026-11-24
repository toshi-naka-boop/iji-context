// masters.db の読み方を、採用値のファイル（EM §2-11）で確かめる（design.md §12-1。C-102・C-106）。scripts/build-masters.ts と scripts/check-masters.ts が呼ぶ。
// 1. 錨：原文（告示・通知・手引き・仕様書の記載例）で確かめた、データの中の具体的な事実。持っている 1 枚ごとに全部成り立つこと。1 つでも外れたら失敗
//    式の錨：原文の計算例（この行をこの数量で書くと、この点数）。点数の検算（G02）の式（src/generic/points.ts）で再計算して、原文の点数になること
// 2. 件数：判定に使う列の、値ごとの件数。読み方を確かめた版と同じ 1 枚では一致（違えば失敗）、ほかの 1 枚では 1 割を超えて違えば警告
// 3. 版の表との食い違い：Revision の points・codes と、診療年月に当たる 1 枚の医科診療行為マスター（src/masters/revision-check.ts）。1 件でもあれば失敗
// 4. 点検の準備（checks_ready）：点検 G01〜G11 ごとに、要る表がそろい、判定に使う列の値に錨があるか。錨のない表・列を使う点検は動かさない
import { readFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { REVISIONS } from "../engine/revisions";
import { recalcUnit, type RecalcItem } from "../generic/points";
import type { Revision } from "../engine/revisions/types";
import { MASTERS_CONFIG, type MastersConfig } from "./config";
import { checkBundles, GROUPS, membersOf } from "./bundle-check";
import { pickSnapshot } from "./db";
import { LAYOUTS, TABLE_COLUMNS } from "./layout";
import { checkCodes, emNames, type MasterRow } from "./revision-check";

export const EM_PATH = "design/iji-context/sources/evidence-master-iji-context.md";

type Pairs = Record<string, string>;
/** 錨：where で決まる行が 1 つ以上あり、その全部で expect の列が書いてある値であること */
export type Anchor = { id: string; table: string; where: Pairs; expect: Pairs };
/** 件数：where に当たる行の数 */
/** 式の錨：items の行を 1 つの単位として、診療識別 shikibetsu で再計算すると points 点になること（薬価・材料価格そのものでなく、式ごと縛る） */
export type FormulaAnchor = { id: string; shikibetsu: string; items: RecalcItem[]; points: number };
/** not は「列≠値」（その値でない行。design.md §15-3） */
export type CountRow = { table: string; where: Pairs; not?: Pairs; count: number };
export type Em = {
  /** データ名 → 読み方を確かめた版（更新日） */
  verified: Record<string, string>;
  anchors: Anchor[];
  formulas: FormulaAnchor[];
  counts: CountRow[];
  /** EM §2-8 の、コード → マスターの名称 */
  names: Map<string, string>;
};

/**
 * `列=値, 列≠値`（または「—」）を読む。eq は「列=値」、ne は「列≠値」。表にない列は、EM の書き誤りとして例外にする（SQL に書く名前は layout にあるものだけ）。
 * 「≠」は件数の表だけが使う（錨では断る。pairsOf）
 */
function condsOf(cell: string, table: string, where: string): { eq: Pairs; ne: Pairs } {
  const out = { eq: {} as Pairs, ne: {} as Pairs };
  // 「—」は、値を決めない（件数の表では全部の行、錨では行があることだけ）
  if (cell === "—") return out;
  for (const part of cell.replace(/`/g, "").split(",")) {
    // 値は、区切りの「,」と「`」のほかの文字（名称も書ける）
    const m = /^\s*([a-z_0-9]+)\s*(=|≠)\s*(\S(?:.*\S)?)\s*$/.exec(part);
    if (!m) throw new Error(`EM §2-11 ${where}：「列=値」の形でない: ${part.trim()}`);
    if (!TABLE_COLUMNS[table]?.includes(m[1])) throw new Error(`EM §2-11 ${where}：表 ${table} にない列: ${m[1]}`);
    (m[2] === "=" ? out.eq : out.ne)[m[1]] = m[3];
  }
  return out;
}

function pairsOf(cell: string, table: string, where: string): Pairs {
  const { eq, ne } = condsOf(cell, table, where);
  if (Object.keys(ne).length > 0) throw new Error(`EM §2-11 ${where}：「≠」は件数の表だけで使える: ${cell}`);
  return eq;
}

/**
 * EM §2-11 の表を読む。行の見分け方：1 列めが「`データ名` …」で 3 列めが 8 桁の数字＝データ源／1 列めが A と数字＝錨／1 列めが F と数字＝式の錨／3 列で、1 列めが「`表`」・3 列めが数＝件数
 */
export function parseEm(em: string): Em {
  const start = em.indexOf("### 2-11. 採用したデータ源");
  if (start < 0) throw new Error("evidence-master に「2-11. 採用したデータ源」の節がない");
  // 節の終わりは、次の「## 」か「### 」の見出し（「#### 」の小見出しは節の中）
  const end = em.slice(start + 1).search(/\n#{2,3} /);
  const section = em.slice(start, end < 0 ? undefined : start + 1 + end);
  const tableOf = (cell: string, where: string): string => {
    const t = /^`([a-z_]+)`$/.exec(cell)?.[1];
    if (!t || !TABLE_COLUMNS[t]) throw new Error(`EM §2-11 ${where}：知らない表: ${cell}`);
    return t;
  };
  const out: Em = { verified: {}, anchors: [], formulas: [], counts: [], names: emNames(em) };
  for (const line of section.split("\n")) {
    const c = line.split("|").slice(1, -1).map((x) => x.trim());
    const dataset = /^`([a-z_]+)`/.exec(c[0] ?? "")?.[1];
    if (c.length >= 6 && dataset && /^\d{8}$/.test(c[2])) out.verified[dataset] = c[2];
    else if (/^A\d{2,3}$/.test(c[0] ?? "")) {
      if (out.anchors.some((a) => a.id === c[0])) throw new Error(`EM §2-11 錨 ${c[0]}：番号が重複`);
      const table = tableOf(c[1], `錨 ${c[0]}`);
      const a = { id: c[0], table, where: pairsOf(c[2], table, `錨 ${c[0]}`), expect: pairsOf(c[3], table, `錨 ${c[0]}`) };
      if (Object.keys(a.where).length === 0) throw new Error(`EM §2-11 錨 ${c[0]}：行を決める値がない`);
      out.anchors.push(a);
    } else if (/^F\d{2}$/.test(c[0] ?? "")) {
      // 式の錨：| 錨 | 診療識別 | 行 | 点数 | …。行は「種類:コード*数量@単価」を空白で区切る（数量・単価は、要らなければ省く）
      if (out.formulas.some((f) => f.id === c[0])) throw new Error(`EM §2-11 式の錨 ${c[0]}：番号が重複`);
      const items = c[2].replace(/`/g, "").split(/\s+/).filter(Boolean).map((t): RecalcItem => {
        const m = /^(SI|IY|TO):(\d{9})(?:\*(\d+(?:\.\d+)?))?(?:@(\d+(?:\.\d+)?))?$/.exec(t);
        if (!m) throw new Error(`EM §2-11 式の錨 ${c[0]}：「種類:コード*数量@単価」の形でない: ${t}`);
        return { kind: m[1] as RecalcItem["kind"], code: m[2], ...(m[3] !== undefined ? { quantity: m[3] } : {}), ...(m[4] !== undefined ? { unitPrice: m[4] } : {}) };
      });
      if (items.length === 0 || new Set(items.map((it) => it.kind)).size !== 1 || !/^(\d{2}|—)$/.test(c[1]) || !/^\d+$/.test(c[3])) throw new Error(`EM §2-11 式の錨 ${c[0]}：行（1 種類）・診療識別（2 桁か「—」）・点数が読めない`);
      out.formulas.push({ id: c[0], shikibetsu: c[1] === "—" ? "" : c[1], items, points: Number(c[3]) });
    } else if (c.length === 3 && /^`[a-z_]+`$/.test(c[0]) && /^[\d,]+$/.test(c[2])) {
      const table = tableOf(c[0], "件数");
      const { eq, ne } = condsOf(c[1], table, "件数");
      out.counts.push({ table, where: eq, ...(Object.keys(ne).length > 0 ? { not: ne } : {}), count: Number(c[2].replace(/,/g, "")) });
    }
  }
  return out;
}

export const readEm = (root: string): Em => parseEm(readFileSync(path.join(root, EM_PATH), "utf8"));

/** 判定に使う列の値。値が null＝どの値でもよい（その列を読む錨が 1 つあればよい） */
type Need = { table: string; pairs: Record<string, string | null> };
const need = (table: string, pairs: Record<string, string | null>): Need => ({ table, pairs });
const each = (table: string, col: string, values: string[], more: Record<string, string> = {}): Need[] => values.map((v) => need(table, { ...more, [col]: v }));
/** 施設基準の組ごとの 3 列（design.md §15-3。錨 A109〜A116） */
const SHISETSU_NEEDS: Need[] = ["shisetsu_g1", "shisetsu_g2", "shisetsu_g3"].map((col) => need("shinryo", { [col]: null }));
/** 医科診療行為マスターの区分番号の列（章・部・区分番号・枝番・項番。design.md §15-3。code M-1。錨 A70・A72・A73） */
const KUBUN_NO_NEEDS: Need[] = ["sho", "bu", "kubun_no", "eda", "kou"].map((col) => need("shinryo", { [col]: null }));

export const CHECK_IDS = ["G01", "G02", "G03", "G04", "G05", "G06", "G07", "G08", "G09", "G10", "G11"] as const;
export type CheckId = (typeof CHECK_IDS)[number];

/**
 * 点検（design.md §12-3・§15-3）ごとの、判定に使う表・列・値。ここに挙げた組のそれぞれに、通った錨が 1 つ以上あるとき、その点検の準備ができている。
 * 値の区分で判定が分かれる列は値ごとに挙げる（C-106：値が 1 種類しかない列の隣を読み違えても通ってしまうのを防ぐ）
 */
export const CHECK_NEEDS: Record<CheckId, { label: string; needs: Need[] }> = {
  G01: { label: "コード", needs: [need("shinryo", { code: null }), need("iyakuhin", { code: null }), need("tokutei", { code: null }), need("comment", { code: null })] },
  G02: {
    label: "点数の検算",
    needs: [
      need("shinryo", { point_kind: "3", points: null }),
      ...each("shinryo", "point_kind", ["5", "6", "8"]),
      need("shinryo", { kizami_kind: "1", kizami_lower: null, kizami_upper: null, kizami_step: null, kizami_points: null }),
      ...each("shinryo", "kokuji1", ["1", "7"]),
      need("iyakuhin", { price_kind: "1", price: null }),
      need("tokutei", { price_kind: "1", price: null }),
      ...each("tokutei", "price_kind", ["2", "5", "9"]),
      ...each("tokutei", "sanso", ["0", "1", "2", "3", "4", "5", "9"]),
    ],
  },
  G03: {
    label: "行の属性",
    // 作ったのは、入外・病院診療所・年齢の上下限（数字）と、施設基準のある行の「届出が要ります」。後期高齢者医療適用区分・実日数・点数欄集計先識別（診療識別）・注加算の付け先は、
    // 点検を作っていないので挙げない（後期高齢者医療適用区分 1・2 と実日数 1 は、原文で確かめられる例がなく、錨を置けていない。EM §2-11）
    needs: [...each("shinryo", "nyugai", ["0", "1", "2"]), ...each("shinryo", "hospital_clinic", ["0", "1", "2"]), need("shinryo", { age_lower: null }), need("shinryo", { age_upper: null }), ...SHISETSU_NEEDS],
  },
  G04: {
    label: "包括",
    needs: [...each("hojo", "unit1", ["1", "2", "3", "5", "6"]), need("hojo", { group1: null }), need("houkatsu", { group_no: null, code: null }), ...each("houkatsu", "tokurei", ["0", "1"])],
  },
  G05: {
    label: "背反",
    needs: [...["1", "2", "3", "4"].flatMap((tani) => [...each("haihan", "tokurei", ["0", "1"], { tani }), ...each("haihan", "kubun", ["1", "2", "3"], { tani })]), ...KUBUN_NO_NEEDS],
  },
  G06: {
    label: "算定回数",
    needs: [...["121", "138", "131"].map((u) => need("kaisu", { unit_code: u, limit_count: null })), ...each("kaisu", "tokurei", ["0", "1"]), need("shinryo", { limit_count: null })],
  },
  G07: {
    label: "必須コメント",
    // 使うのは「算定すれば必要」（01）と、入院外のレセプトでの「入院外で算定した場合」（02・入外区分 2）。「それ以外」（00）は言わない側として読み分ける。03（複数回）は使わないので挙げない。
    // 記載要領の表（コメント記載通知等）は、別表Ⅰ 医科（1）・別表Ⅱ 医薬品（5）・別表Ⅳ 特定器材（8）。組にする項番・枝番、算定しなかった場合のコメント（使わない側）、変更年月日（診療年月に有効な行）、定型文（コメントマスターの名称）
    needs: [
      ...each("comment_kanren", "joken", ["00", "01"]),
      need("comment_kanren", { joken: "02", nyugai: "2" }),
      ...each("comment_kanren", "tsuchi", ["1", "5", "8"], { joken: "01" }),
      need("comment_kanren", { code: null, comment_code: null, kouban: null, edaban: null }),
      need("comment_kanren", { hisantei: "1" }),
      need("comment_kanren", { changed_on: null }),
      need("comment", { code: null, name: null }),
    ],
  },
  G08: {
    label: "傷病名の要件",
    // 難病外来指導管理料（傷病名関連区分 9・難病外来対象区分 09）と、保険請求の対象外の傷病名（保険請求外区分 1）は、点検を作っていないので挙げない（原文で確かめられていない。EM §2-11）。
    // 「対象でない」側（特定疾患等対象区分 00）も、値として読み分ける
    needs: [...each("shinryo", "shobyo_kanren", ["3", "4", "5", "7"]), ...each("shobyo", "tokutei_shikkan", ["00", "03", "04", "05", "07", "08"])],
  },
  G09: {
    label: "適応・併用",
    // 作ったのは、適応（医薬品・診療行為）と併用の組。判定に使う列：医薬品×傷病名の組、診療行為×傷病名の組と「疑い病名」の 0（確定・疑いとも）・1（確定のみ）、併用の組（両向き）。
    // 最大投与量・最長投与日数・入外区分は、点検を作っていないので挙げない（単位・数え方が仕様書に書かれていない。EM §2-11）。性別・年齢は読み分けず、条件つきの行があるコードの適応を見ない
    // ことにだけ使う（言わない側。変更区分 9 と同じ扱いで、値ごとの件数〔EM §2-11 表 3〕で読み方を縛る）。
    // 変更区分 9（廃止）は、言わない側にだけ使う（廃止の行だけのコード・廃止の組は言わない）。値ごとの件数（EM §2-11 表 3）で読み方を縛る
    needs: [need("cm_tekio", { code: null, shobyo: null }), need("cm_si_shobyo", { code: null, shobyo: null }), ...each("cm_si_shobyo", "utagai", ["0", "1"]), need("cm_heiyo_kinki", { code_l: null, code_r: null })],
  },
  G10: {
    label: "施設基準",
    // 組ごとの 3 列（グループの中は「どれか」、グループのあいだは「どれも」。design.md §15-3）と、同じ区分番号の行を引く区分番号の列（15-5 の正しい側。L-91）。点検そのものは段 17e で入る
    needs: [...SHISETSU_NEEDS, ...KUBUN_NO_NEEDS],
  },
  G11: {
    label: "取り忘れ",
    // 施設基準の要る行為を見分けるのに 3 列を使う（design.md §15-8。C-232）。判断料の候補（M-1）に、検査等実施判断区分の 1（実施）・2（判断料）と判断グループを使う（錨 A120・A73・A74）。
    // 単位の列（A117〜A119）は挙げない：単位の列のない古い masters.db でも G11 は止めず、量の比較だけを止める（design.md §15-3）
    needs: [...SHISETSU_NEEDS, need("shinryo", { kensa_kind: "1", kensa_group: null }), need("shinryo", { kensa_kind: "2", kensa_group: null })],
  },
};

const show = (p: Record<string, string | null>, ne: Pairs = {}) => [...Object.entries(p).map(([k, v]) => (v === null ? k : `${k}=${v}`)), ...Object.entries(ne).map(([k, v]) => `${k}≠${v}`)].join(", ");

/** 表の名前 → データ名（config/masters.json の files の layout から） */
function datasetOf(config: MastersConfig): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [dataset, ds] of Object.entries(config.datasets)) for (const f of ds.files) for (const l of LAYOUTS) if (l.id === f.layout) out[l.table] = dataset;
  return out;
}

export type VerifyResult = {
  /** 表示する行 */
  lines: string[];
  /** 失敗の数（錨の外れ・確かめた版の件数の違い・版の表との食い違い） */
  failures: number;
  warnings: number;
  /** 取り込んだファイルの数 */
  sources: number;
  /** missing は、足りないものの一覧（「データ:データ名」か「表:列=値」）。masters.db には書かない（アプリは読まない）。テストが、どの錨が足りないかを縛るのに使う */
  ready: { check: CheckId; label: string; ready: boolean; reason: string; missing: string[] }[];
};

/**
 * 錨・件数・版の表との食い違いを確かめ、点検の準備を決める。write が真のとき（作っている途中の masters.db）、結果を sources.verified・checks_ready に書く
 */
export function verifyMasters(db: Database.Database, em: Em, opt: { write: boolean; config?: MastersConfig; revisions?: Revision[] }): VerifyResult {
  const config = opt.config ?? MASTERS_CONFIG;
  const lines: string[] = [];
  let failures = 0;
  let warnings = 0;
  const ds = datasetOf(config);
  // 確かめるのは、いまの世代の 1 枚だけ。前の世代から残した 1 枚（src/masters/build.ts の carryOver）は、その世代のときに確かめてある（design.md §14-4。X-125）
  const src = db.prepare("SELECT DISTINCT dataset, tbl, snapshot FROM sources WHERE generation = ? ORDER BY tbl, snapshot").all(config.generation) as { dataset: string; tbl: string; snapshot: string }[];
  const snapshotsOf = (table: string): string[] => src.filter((s) => s.tbl === table).map((s) => s.snapshot);
  const where = (p: Pairs, ne: Pairs = {}) => [...Object.keys(p).map((k) => `${k} = ?`), ...Object.keys(ne).map((k) => `${k} != ?`)].join(" AND ") || "1 = 1";

  // 列を足す前に作った masters.db（例：医薬品マスターの麻薬等の区分・薬価基準収載医薬品コードの列。design.md §16-10 E-12）では、その列を読む錨と件数は確かめない。
  // 外れでも通ったのでもない（錨のない列として、使う側が「見ていません」にする）。masters:build で作り直せば確かめる
  const columnsOf = new Map<string, Set<string>>();
  const missingColumns = (table: string, pairs: Pairs[]): string[] => {
    if (!columnsOf.has(table)) columnsOf.set(table, new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)));
    return [...new Set(pairs.flatMap((p) => Object.keys(p)))].filter((k) => !columnsOf.get(table)!.has(k));
  };

  // 1. 錨
  const passed = new Set<string>();
  let anchorRuns = 0;
  for (const a of em.anchors) {
    const snaps = snapshotsOf(a.table);
    const absent = snaps.length > 0 ? missingColumns(a.table, [a.where, a.expect]) : [];
    if (absent.length > 0) {
      lines.push(`錨 ${a.id} は確かめていない（${a.table} に列 ${absent.join("・")} がない古い masters.db。masters:build で作り直す）`);
      continue;
    }
    let ok = snaps.length > 0;
    for (const s of snaps) {
      anchorRuns++;
      const r = db.prepare(`SELECT count(*) AS total, coalesce(sum(CASE WHEN ${where(a.expect)} THEN 1 ELSE 0 END), 0) AS ok FROM ${a.table} WHERE snapshot = ? AND ${where(a.where)}`).get(...Object.values(a.expect), s, ...Object.values(a.where)) as { total: number; ok: number };
      if (r.total === 0 || r.ok !== r.total) {
        ok = false;
        failures++;
        lines.push(`錨 ${a.id} が外れた（${a.table} ${s}）：${show(a.where)} の行は ${r.total} 件、そのうち ${show(a.expect)} は ${r.ok} 件`);
      }
    }
    if (ok) passed.add(a.id);
  }
  lines.push(`錨：${em.anchors.length} 個のうち ${passed.size} 個が通った（データがなくて確かめていない ${em.anchors.filter((a) => snapshotsOf(a.table).length === 0).length} 個）。確かめた回数 ${anchorRuns}`);

  // 式の錨（その行の種類のマスターの、持っている 1 枚ごと）
  const TABLE_OF = { SI: "shinryo", IY: "iyakuhin", TO: "tokutei" } as const;
  const passedFormulas: FormulaAnchor[] = [];
  for (const f of em.formulas) {
    const snaps = snapshotsOf(TABLE_OF[f.items[0].kind]);
    let ok = snaps.length > 0;
    for (const s of snaps) {
      const r = recalcUnit(db, { SI: s, IY: s, TO: s }, f.items, { shikibetsu: f.shikibetsu, shikibetsuSure: true, bundles: [] });
      if (!("points" in r) || r.points !== f.points) {
        ok = false;
        failures++;
        lines.push(`式の錨 ${f.id} が外れた（${TABLE_OF[f.items[0].kind]} ${s}）：原文は ${f.points} 点、再計算は ${"points" in r ? `${r.points} 点` : `できない（${r.reason}）`}`);
      }
    }
    if (ok) passedFormulas.push(f);
  }
  if (em.formulas.length > 0) lines.push(`式の錨：${em.formulas.length} 個のうち ${passedFormulas.length} 個が通った`);

  // 2. 件数
  let countRuns = 0;
  for (const c of em.counts) {
    const verified = em.verified[ds[c.table]];
    if (snapshotsOf(c.table).length > 0 && missingColumns(c.table, [c.where, c.not ?? {}]).length > 0) continue;
    for (const s of snapshotsOf(c.table)) {
      countRuns++;
      const ne = c.not ?? {};
      const n = (db.prepare(`SELECT count(*) AS n FROM ${c.table} WHERE snapshot = ? AND ${where(c.where, ne)}`).get(s, ...Object.values(c.where), ...Object.values(ne)) as { n: number }).n;
      if (s === verified && n !== c.count) {
        failures++;
        lines.push(`件数が違う（${c.table} ${s}）：${show(c.where, ne)} は ${n} 件、EM §2-11 は ${c.count} 件`);
      } else if (s !== verified && Math.abs(n - c.count) > c.count * 0.1) {
        warnings++;
        lines.push(`警告：件数が 1 割を超えて違う（${c.table} ${s}）：${show(c.where, ne)} は ${n} 件、確かめた版（${verified ?? "なし"}）は ${c.count} 件`);
      }
    }
  }
  lines.push(`件数：${em.counts.length} 行を照合した（確かめた回数 ${countRuns}）`);

  // 読み方を確かめた版より新しいデータ（止めない。設定の画面にも出す）
  for (const [dataset, verified] of Object.entries(em.verified)) {
    const newer = [...new Set(src.filter((s) => s.dataset === dataset && s.snapshot > verified).map((s) => s.snapshot))];
    if (newer.length > 0) {
      warnings++;
      lines.push(`警告：読み方を確かめた版（${verified}）より新しいデータです：${dataset} ${newer.join("、")}`);
    }
  }

  // 3. 版の表との食い違い
  const generation = config.generation;
  if (snapshotsOf("shinryo").length === 0) lines.push("版の表との突き合わせ：医科診療行為マスターがないので飛ばした");
  else {
    let hits = 0;
    for (const rev of (opt.revisions ?? REVISIONS).filter((r) => r.generation === generation)) {
      // その版の診療年月のどれかで使う 1 枚：最初の月に当たる 1 枚と、期間の中の更新日の 1 枚
      const first = pickSnapshot(db, "shinryo", rev.effectiveFrom, generation);
      const inRange = snapshotsOf("shinryo").filter((s) => `${s.slice(0, 4)}-${s.slice(4, 6)}` > rev.effectiveFrom && `${s.slice(0, 4)}-${s.slice(4, 6)}` <= rev.effectiveUntil);
      for (const s of new Set([...(first ? [first.snapshot] : []), ...inRange])) {
        const master = new Map<string, MasterRow>();
        for (const r of db.prepare("SELECT code, name, point_kind, points, houkatsu_kensa, changed_on, abolished_on FROM shinryo WHERE snapshot = ?").iterate(s) as Iterable<{ code: string; name: string; point_kind: string; points: number; houkatsu_kensa: string; changed_on: string; abolished_on: string }>) {
          master.set(r.code, { name: r.name, pointKind: r.point_kind, points: r.points, bundled: r.houkatsu_kensa, changedOn: r.changed_on, abolishedOn: r.abolished_on });
        }
        for (const h of checkCodes(master, em.names, [rev])) {
          hits++;
          lines.push(`版の表と食い違う（shinryo ${s}）：${h}`);
        }
      }
    }
    failures += hits;
    lines.push(`版の表との食い違い：${hits} 件`);
  }

  // 3-1. 包括の群と告示の号の対応（design.md §19-12。反証 round-94 C-621）：版の bundles の群（D008・D013）の members が、マスターの群の行と 1 対 1 で、区分番号・号の範囲が合うこと。
  // マスターの次の世代で群が変わったら（号の新設・列の移り）、ここで止める
  if (snapshotsOf("shinryo").length === 0) lines.push("包括の群と号の対応：医科診療行為マスターがないので飛ばした");
  else {
    let diff = 0;
    for (const rev of (opt.revisions ?? REVISIONS).filter((r) => r.generation === generation && r.bundles.length > 0)) {
      for (const s of snapshotsOf("shinryo")) {
        const r = checkBundles(db, s, GROUPS.map((group) => ({ group, members: membersOf(rev.bundles, group.tierPrefix) })));
        if (!r.ok) {
          diff++;
          for (const l of r.lines.filter((x) => x.includes("NG"))) lines.push(`包括の群がマスターと合わない（${rev.id} shinryo ${s}）：${l.trim()}`);
        }
      }
    }
    failures += diff;
    lines.push(`包括の群と号の対応：食い違い ${diff} 件`);
  }

  // 3-2. 撮影部位のコメントの許可リスト（design.md §19-1・§19-10 完了条件 4）：コメントマスターの「撮影部位（」の行と、版の imagingSiteComments が同じこと
  if (snapshotsOf("comment").length === 0) lines.push("撮影部位のコメントの許可リスト：コメントマスターがないので飛ばした");
  else {
    let diff = 0;
    for (const rev of (opt.revisions ?? REVISIONS).filter((r) => r.generation === generation && r.imagingSiteComments.length > 0)) {
      const mine = new Set(rev.imagingSiteComments);
      for (const s of snapshotsOf("comment")) {
        const master = new Set((db.prepare("SELECT code FROM comment WHERE snapshot = ? AND name LIKE '撮影部位（%'").all(s) as { code: string }[]).map((r) => r.code));
        const onlyMaster = [...master].filter((x) => !mine.has(x));
        const onlyMine = [...mine].filter((x) => !master.has(x));
        if (onlyMaster.length + onlyMine.length > 0) {
          diff++;
          lines.push(`撮影部位のコメントの許可リストがマスターと違う（${rev.id} comment ${s}）：マスターだけ ${onlyMaster.join("・") || "なし"}／版だけ ${onlyMine.join("・") || "なし"}`);
        }
      }
    }
    failures += diff;
    lines.push(`撮影部位のコメントの許可リスト：食い違い ${diff} 件`);
  }

  // 4. 点検の準備
  // 医薬品の式の錨は、薬価（金額種別 1 の新又は現金額）の読み方を縛る：薬価 × 使用量が、原文の点数になる
  const priced = passedFormulas.some((f) => f.items[0].kind === "IY");
  const covered = (n: Need): boolean =>
    (priced && n.table === "iyakuhin" && Object.entries(n.pairs).every(([k, v]) => (k === "price_kind" && v === "1") || (k === "price" && v === null))) ||
    em.anchors.some((a) => {
      if (a.table !== n.table || !passed.has(a.id)) return false;
      const all = { ...a.where, ...a.expect };
      return Object.entries(n.pairs).every(([k, v]) => k in all && (v === null || all[k] === v));
    });
  const ready = CHECK_IDS.map((check) => {
    const { label, needs } = CHECK_NEEDS[check];
    const noData = [...new Set(needs.filter((n) => snapshotsOf(n.table).length === 0).map((n) => ds[n.table] ?? n.table))];
    const noAnchor = needs.filter((n) => snapshotsOf(n.table).length > 0 && !covered(n)).map((n) => `${n.table}（${show(n.pairs)}）`);
    const reason = [noData.length > 0 ? `データがない：${noData.join("、")}` : "", noAnchor.length > 0 ? `錨がない：${noAnchor.join("、")}` : ""].filter(Boolean).join("／");
    return { check, label, ready: reason === "", reason, missing: [...noData.map((d) => `データ:${d}`), ...needs.filter((n) => snapshotsOf(n.table).length > 0 && !covered(n)).map((n) => `${n.table}:${show(n.pairs)}`)] };
  });
  for (const r of ready) lines.push(`点検 ${r.check}（${r.label}）：${r.ready ? "準備できている" : `動かさない（${r.reason}）`}`);

  if (opt.write) {
    for (const [dataset, verified] of Object.entries(em.verified)) db.prepare("UPDATE sources SET verified = ? WHERE dataset = ? AND generation = ?").run(verified, dataset, config.generation);
    const put = db.prepare("INSERT OR REPLACE INTO checks_ready (check_id, ready, reason) VALUES (?, ?, ?)");
    for (const r of ready) put.run(r.check, r.ready ? 1 : 0, r.reason);
  }
  return { lines, failures, warnings, sources: (db.prepare("SELECT count(*) AS n FROM sources").get() as { n: number }).n, ready };
}
