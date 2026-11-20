// masters.db の読み方を、採用値のファイル（EM §2-11）で確かめる（design.md §12-1。C-102・C-106）。scripts/build-masters.ts と scripts/check-masters.ts が呼ぶ。
// 1. 錨：原文（告示・通知・手引き・仕様書の記載例）で確かめた、データの中の具体的な事実。持っている 1 枚ごとに全部成り立つこと。1 つでも外れたら失敗
// 2. 件数：判定に使う列の、値ごとの件数。読み方を確かめた版と同じ 1 枚では一致（違えば失敗）、ほかの 1 枚では 1 割を超えて違えば警告
// 3. 版の表との食い違い：Revision の points・codes と、診療年月に当たる 1 枚の医科診療行為マスター（src/masters/revision-check.ts）。1 件でもあれば失敗
// 4. 点検の準備（checks_ready）：点検 G01〜G09 ごとに、要る表がそろい、判定に使う列の値に錨があるか。錨のない表・列を使う点検は動かさない
import { readFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { REVISIONS } from "../engine/revisions";
import type { Revision } from "../engine/revisions/types";
import { MASTERS_CONFIG, type MastersConfig } from "./config";
import { pickSnapshot } from "./db";
import { LAYOUTS, TABLE_COLUMNS } from "./layout";
import { checkCodes, emNames, type MasterRow } from "./revision-check";

export const EM_PATH = "design/iji-context/sources/evidence-master-iji-context.md";

type Pairs = Record<string, string>;
/** 錨：where で決まる行が 1 つ以上あり、その全部で expect の列が書いてある値であること */
export type Anchor = { id: string; table: string; where: Pairs; expect: Pairs };
/** 件数：where に当たる行の数 */
export type CountRow = { table: string; where: Pairs; count: number };
export type Em = {
  /** データ名 → 読み方を確かめた版（更新日） */
  verified: Record<string, string>;
  anchors: Anchor[];
  counts: CountRow[];
  /** EM §2-8 の、コード → マスターの名称 */
  names: Map<string, string>;
};

/** `列=値, 列=値`（または「—」）を読む。表にない列は、EM の書き誤りとして例外にする（SQL に書く名前は layout にあるものだけ） */
function pairsOf(cell: string, table: string, where: string): Pairs {
  const out: Pairs = {};
  // 「—」は、値を決めない（件数の表では全部の行、錨では行があることだけ）
  if (cell === "—") return out;
  for (const part of cell.replace(/`/g, "").split(",")) {
    // 値は、区切りの「,」と「`」のほかの文字（名称も書ける）
    const m = /^\s*([a-z_0-9]+)\s*=\s*(\S(?:.*\S)?)\s*$/.exec(part);
    if (!m) throw new Error(`EM §2-11 ${where}：「列=値」の形でない: ${part.trim()}`);
    if (!TABLE_COLUMNS[table]?.includes(m[1])) throw new Error(`EM §2-11 ${where}：表 ${table} にない列: ${m[1]}`);
    out[m[1]] = m[2];
  }
  return out;
}

/**
 * EM §2-11 の 3 つの表を読む。行の見分け方：1 列めが「`データ名` …」で 3 列めが 8 桁の数字＝データ源／1 列めが A と数字＝錨／3 列で、1 列めが「`表`」・3 列めが数＝件数
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
  const out: Em = { verified: {}, anchors: [], counts: [], names: emNames(em) };
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
    } else if (c.length === 3 && /^`[a-z_]+`$/.test(c[0]) && /^[\d,]+$/.test(c[2])) {
      const table = tableOf(c[0], "件数");
      out.counts.push({ table, where: pairsOf(c[1], table, "件数"), count: Number(c[2].replace(/,/g, "")) });
    }
  }
  return out;
}

export const readEm = (root: string): Em => parseEm(readFileSync(path.join(root, EM_PATH), "utf8"));

/** 判定に使う列の値。値が null＝どの値でもよい（その列を読む錨が 1 つあればよい） */
type Need = { table: string; pairs: Record<string, string | null> };
const need = (table: string, pairs: Record<string, string | null>): Need => ({ table, pairs });
const each = (table: string, col: string, values: string[], more: Record<string, string> = {}): Need[] => values.map((v) => need(table, { ...more, [col]: v }));

export const CHECK_IDS = ["G01", "G02", "G03", "G04", "G05", "G06", "G07", "G08", "G09"] as const;
export type CheckId = (typeof CHECK_IDS)[number];

/**
 * 点検（design.md §12-3）ごとの、判定に使う表・列・値。ここに挙げた組のそれぞれに、通った錨が 1 つ以上あるとき、その点検の準備ができている。
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
    ],
  },
  G03: {
    label: "行の属性",
    needs: [
      ...each("shinryo", "nyugai", ["0", "1", "2"]),
      ...each("shinryo", "hospital_clinic", ["0", "1", "2"]),
      ...each("shinryo", "kouki", ["0", "1", "2"]),
      need("shinryo", { age_lower: null }),
      need("shinryo", { age_upper: null }),
      need("shinryo", { shukei_gai: null }),
      need("shinryo", { chu_code: null, chu_seq: "0" }),
      need("shinryo", { chu_code: null, kokuji1: "7" }),
      ...each("shinryo", "jitsunissu", ["1", "2"]),
    ],
  },
  G04: {
    label: "包括",
    needs: [...each("hojo", "unit1", ["1", "2", "3", "5", "6"]), need("hojo", { group1: null }), need("houkatsu", { group_no: null, code: null }), ...each("houkatsu", "tokurei", ["0", "1"])],
  },
  G05: {
    label: "背反",
    needs: ["1", "2", "3", "4"].flatMap((tani) => [...each("haihan", "tokurei", ["0", "1"], { tani }), ...each("haihan", "kubun", ["1", "2", "3"], { tani })]),
  },
  G06: {
    label: "算定回数",
    needs: [...["121", "138", "131"].map((u) => need("kaisu", { unit_code: u, limit_count: null })), ...each("kaisu", "tokurei", ["0", "1"]), need("shinryo", { limit_count: null })],
  },
  G07: {
    label: "必須コメント",
    // 使うのは「算定すれば必要」（01）だけ。「それ以外」（00）は言わない側として読み分ける。02・03（入院か入院外か・複数回）は design.md §12-3 の G07 が使わないので挙げない
    needs: [...each("comment_kanren", "joken", ["00", "01"]), need("comment_kanren", { code: null, comment_code: null }), need("comment", { code: null })],
  },
  G08: {
    label: "傷病名の要件",
    needs: [...each("shinryo", "shobyo_kanren", ["3", "4", "5", "7", "9"]), ...each("shobyo", "tokutei_shikkan", ["03", "04", "05", "07", "08"]), need("shobyo", { nanbyo: "09" }), need("shobyo", { hoken_gai: "1" })],
  },
  G09: {
    label: "適応・禁忌・量と日数",
    needs: [need("cm_tekio", { code: null, shobyo: null }), need("cm_tekio", { max_dose: null }), need("cm_tekio", { max_days: null }), need("cm_si_shobyo", { code: null, shobyo: null }), need("cm_heiyo_kinki", { code_l: null, code_r: null })],
  },
};

const show = (p: Record<string, string | null>) => Object.entries(p).map(([k, v]) => (v === null ? k : `${k}=${v}`)).join(", ");

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
  /** missing は、足りないものの一覧（「データ:データ名」か「表:列=値」）。次の段が、列ごとに点検の一部を止めるのに使える */
  ready: { check: CheckId; label: string; ready: boolean; reason: string; missing: string[] }[];
};

/**
 * 錨・件数・版の表との食い違いを確かめ、点検の準備を決める。write が真のとき（作っている途中の masters.db）、結果を sources.verified・checks_ready・meta に書く
 */
export function verifyMasters(db: Database.Database, em: Em, opt: { write: boolean; config?: MastersConfig; revisions?: Revision[] }): VerifyResult {
  const config = opt.config ?? MASTERS_CONFIG;
  const lines: string[] = [];
  let failures = 0;
  let warnings = 0;
  const ds = datasetOf(config);
  const src = db.prepare("SELECT DISTINCT dataset, tbl, snapshot FROM sources ORDER BY tbl, snapshot").all() as { dataset: string; tbl: string; snapshot: string }[];
  const snapshotsOf = (table: string): string[] => src.filter((s) => s.tbl === table).map((s) => s.snapshot);
  const where = (p: Pairs) => Object.keys(p).map((k) => `${k} = ?`).join(" AND ") || "1 = 1";

  // 1. 錨
  const passed = new Set<string>();
  let anchorRuns = 0;
  for (const a of em.anchors) {
    const snaps = snapshotsOf(a.table);
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

  // 2. 件数
  let countRuns = 0;
  for (const c of em.counts) {
    const verified = em.verified[ds[c.table]];
    for (const s of snapshotsOf(c.table)) {
      countRuns++;
      const n = (db.prepare(`SELECT count(*) AS n FROM ${c.table} WHERE snapshot = ? AND ${where(c.where)}`).get(s, ...Object.values(c.where)) as { n: number }).n;
      if (s === verified && n !== c.count) {
        failures++;
        lines.push(`件数が違う（${c.table} ${s}）：${show(c.where)} は ${n} 件、EM §2-11 は ${c.count} 件`);
      } else if (s !== verified && Math.abs(n - c.count) > c.count * 0.1) {
        warnings++;
        lines.push(`警告：件数が 1 割を超えて違う（${c.table} ${s}）：${show(c.where)} は ${n} 件、確かめた版（${verified ?? "なし"}）は ${c.count} 件`);
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

  // 4. 点検の準備
  const covered = (n: Need): boolean =>
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
    for (const [dataset, verified] of Object.entries(em.verified)) db.prepare("UPDATE sources SET verified = ? WHERE dataset = ?").run(verified, dataset);
    const put = db.prepare("INSERT OR REPLACE INTO checks_ready (check_id, ready, reason, missing) VALUES (?, ?, ?, ?)");
    for (const r of ready) put.run(r.check, r.ready ? 1 : 0, r.reason, JSON.stringify(r.missing));
  }
  return { lines, failures, warnings, sources: (db.prepare("SELECT count(*) AS n FROM sources").get() as { n: number }).n, ready };
}
