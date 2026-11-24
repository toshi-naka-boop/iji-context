// 包括の群と告示の号の対応の確かめ（design.md §19-2・§19-12。反証 round-94 C-621）。scripts/check-bundles.ts と、check:masters（src/masters/verify.ts）が呼ぶ
import type { MastersDb } from "./db";

/** 確かめる群：マスターの包括対象検査の列の値、区分番号、告示の注の号の範囲、版の区分キーの頭 */
export type BundleGroup = { name: string; column: string; kubunNo: number; from: number; to: number; tierPrefix: string };
export const GROUPS: BundleGroup[] = [
  { name: "D008", column: "2", kubunNo: 8, from: 12, to: 51, tierPrefix: "D008_" },
  { name: "D013", column: "3", kubunNo: 13, from: 3, to: 14, tierPrefix: "D013_" },
];
/** 並べるだけの列（D009 は次の版） */
const LISTED_ONLY = ["5"];

type Row = { code: string; name: string; alpha: string; kubun_no: number; eda: number; kou: number; houkatsu_kensa: string };

/**
 * 群ごとの確かめ。members は版の bundles の members（版に群がなければ null）。
 * 戻り値の lines は人が読む行、ok は全部の群が (a)〜(c) を満たしたか
 */
export function checkBundles(db: MastersDb, snapshot: string, groups: { group: BundleGroup; members: string[] | null }[]): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  let ok = true;
  const bad = (text: string) => {
    ok = false;
    lines.push(`  NG ${text}`);
  };
  for (const { group, members } of groups) {
    const rows = db.prepare("SELECT code, name, alpha, kubun_no, eda, kou, houkatsu_kensa FROM shinryo WHERE snapshot = ? AND houkatsu_kensa = ? ORDER BY kubun_no, kou, code").all(snapshot, group.column) as Row[];
    lines.push(`${group.name}（包括対象検査 ${group.column}。告示の号 ${group.from}〜${group.to}）：マスターの群 ${rows.length} 行`);
    // (a) 区分番号
    const otherKubun = rows.filter((r) => r.alpha !== "D" || r.kubun_no !== group.kubunNo);
    if (otherKubun.length > 0) bad(`区分番号が ${group.name} でない行：${otherKubun.map((r) => `${r.code}（${r.alpha}${String(r.kubun_no).padStart(3, "0")}）`).join("・")}`);
    else lines.push(`  OK 区分番号がすべて一致`);
    // (b) 号が範囲の中か／範囲の中の号の行で群に入っていないもの
    const outside = rows.filter((r) => r.kou < group.from || r.kou > group.to);
    if (outside.length > 0) bad(`号が範囲の外の行：${outside.map((r) => `${r.code}（号 ${r.kou}）`).join("・")}`);
    else lines.push(`  OK 号がすべて範囲の中`);
    const missing = db
      .prepare("SELECT code, name, alpha, kubun_no, eda, kou, houkatsu_kensa FROM shinryo WHERE snapshot = ? AND alpha = 'D' AND kubun_no = ? AND kou BETWEEN ? AND ? AND houkatsu_kensa <> ? ORDER BY kou, code")
      .all(snapshot, group.kubunNo, group.from, group.to, group.column) as Row[];
    if (missing.length > 0) bad(`範囲の号の行で群に入っていないもの：${missing.map((r) => `${r.code}（号 ${r.kou}・包括対象検査 ${r.houkatsu_kensa}）`).join("・")}`);
    else lines.push(`  OK 範囲の号の抜けなし`);
    // (c) 版の members と 1 対 1
    if (members === null) bad(`版の bundles に ${group.name} の群がない`);
    else {
      const master = new Set(rows.map((r) => r.code));
      const mine = new Set(members);
      const onlyMaster = [...master].filter((c) => !mine.has(c));
      const onlyMine = [...mine].filter((c) => !master.has(c));
      if (onlyMaster.length + onlyMine.length > 0 || mine.size !== members.length) bad(`版の members とマスターの群が合わない（マスターだけ：${onlyMaster.join("・") || "なし"}／版だけ：${onlyMine.join("・") || "なし"}${mine.size !== members.length ? "／版に同じコードが 2 つ" : ""}）`);
      else lines.push(`  OK 版の members とマスターの群が 1 対 1（${members.length} 行）`);
    }
  }
  for (const column of LISTED_ONLY) {
    const n = (db.prepare("SELECT count(*) AS n FROM shinryo WHERE snapshot = ? AND houkatsu_kensa = ?").get(snapshot, column) as { n: number }).n;
    lines.push(`包括対象検査 ${column}：${n} 行（次の版。確かめない）`);
  }
  return { ok, lines };
}

/** 版の bundles から、区分キーの頭で群の members を引く（なければ null） */
export const membersOf = (bundles: { members: string[]; tiers: { kubun: string }[] }[], prefix: string): string[] | null => bundles.find((b) => b.tiers.some((t) => t.kubun.startsWith(prefix)))?.members ?? null;
