// 改定の棚卸（design.md §14-4）：背反の組の院内の知識（match.codePair）ごとに、改定の前後でその組に差が出たかを見る。差が出た知識だけを要再検証にする（利用者の判断「差分が出たものだけ」）。
// 比べるもの：背反の表のその組の行（あるか・表・算定する側・特例条件）／2 つのコードの基本マスターの行（あるか・名称・所定の値・区分番号）／EM §2-12 のその組に当たる HP・例外。
// 比べるのは、masters.db の改定前の世代のいちばん新しい 1 枚と、改定後の世代のいちばん新しい 1 枚（§12-1）。EM は、世代ごとに残した版の行（HAIHAN_BY_GENERATION）。
// 比べる 1 枚・版の行がまだないときは、決めずに保留する（pending。C-181）
import type { Revision } from "../engine/revisions/types";
import type { CodePair } from "../lifecycle/types";
import { shinryoOf, snapshotsOf, type MastersDb } from "../masters/db";
import { HAIHAN_BY_GENERATION, type CodeSel, type HaihanConfig } from "./haihan";

/** 改定日（"YYYY-MM-DD..." の日本時間の日）から、改定前と改定後の世代。その日に始まる版がない・その前の世代の版がなければ null */
export function generationsAt(revisionDate: string, revisions: Revision[]): { before: string; after: string } | null {
  const ym = revisionDate.slice(0, 7);
  const after = revisions.find((r) => r.effectiveFrom === ym);
  if (!after) return null;
  const before = revisions.filter((r) => r.effectiveFrom < ym && r.generation !== after.generation).sort((x, y) => (x.effectiveFrom < y.effectiveFrom ? 1 : -1))[0];
  return before ? { before: before.generation, after: after.generation } : null;
}

/** その世代の、区分番号で選ぶ組の照らし方（その 1 枚の基本マスターで引く） */
const selectorAt = (db: MastersDb, snapshot: string) => (code: string, sel: CodeSel): boolean => {
  if (sel.codes?.includes(code)) return true;
  const s = sel.section;
  const r = s ? shinryoOf(db, snapshot, code) : null;
  return !!s && !!r && r.sho === s.sho && r.bu === s.bu && r.kubun_no === s.kubun && (s.eda === undefined || r.eda === s.eda) && (s.kou === undefined || r.kou === s.kou);
};

/** EM §2-12 のうち、その組（同じ表）に当たる HP と、その例外（比べる形） */
function emOf(config: HaihanConfig, pair: CodePair, selects: (code: string, sel: CodeSel) => boolean): string {
  const hp = config.patterns.filter((p) => (p.tani as number[]).includes(pair.tani) && ((selects(pair.a, p.a) && selects(pair.b, p.b)) || (selects(pair.a, p.b) && selects(pair.b, p.a))));
  const hx = [...new Set(hp.flatMap((p) => p.exceptions))].sort().map((id) => config.exceptions.find((x) => x.id === id));
  return JSON.stringify({ hp, hx });
}

/**
 * 改定の前後で、その組に差が出た項目（文。差がなければ空）。比べる 1 枚（電子点数表・医科診療行為マスター）か EM の版の行が、どちらかの世代にないときは "pending"
 */
export function pairRevisionDiff(db: MastersDb, pair: CodePair, gens: { before: string; after: string }, em: Record<string, HaihanConfig> = HAIHAN_BY_GENERATION): string[] | "pending" {
  const latest = (dataset: string, gen: string) => snapshotsOf(db, dataset, gen).at(-1) ?? null;
  const t = [latest("tensuhyo", gens.before), latest("tensuhyo", gens.after)];
  const s = [latest("shinryo", gens.before), latest("shinryo", gens.after)];
  if (t.includes(null) || s.includes(null) || !em[gens.before] || !em[gens.after]) return "pending";
  const changes: string[] = [];
  const haihanOf = (snapshot: string) =>
    (db.prepare("SELECT tani, code1, code2, kubun, tokurei, abolished_on FROM haihan WHERE snapshot = ? AND ((code1 = ? AND code2 = ?) OR (code1 = ? AND code2 = ?)) ORDER BY tani, code1, code2").all(snapshot, pair.a, pair.b, pair.b, pair.a) as Record<string, unknown>[]).map((r) => JSON.stringify(r)).join("\n");
  if (haihanOf(t[0]!) !== haihanOf(t[1]!)) changes.push("背反の表のこの組の行（あるか・表・算定する側・特例条件）");
  for (const code of [pair.a, pair.b]) {
    const [x, y] = [shinryoOf(db, s[0]!, code), shinryoOf(db, s[1]!, code)];
    if ((x === null) !== (y === null)) {
      changes.push(`基本マスターの ${code} の行（${x === null ? "新設" : "廃止"}）`);
      continue;
    }
    if (x === null || y === null) continue;
    const fields = [x.name !== y.name ? "名称" : "", x.points !== y.points ? "所定の値" : "", [x.sho, x.bu, x.kubun_no, x.eda, x.kou].join(".") !== [y.sho, y.bu, y.kubun_no, y.eda, y.kou].join(".") ? "区分番号" : "", x.abolished_on !== y.abolished_on ? "廃止年月日" : ""].filter((f) => f !== "");
    if (fields.length > 0) changes.push(`基本マスターの ${code} の行（${fields.join("・")}）`);
  }
  if (emOf(em[gens.before], pair, selectorAt(db, s[0]!)) !== emOf(em[gens.after], pair, selectorAt(db, s[1]!))) changes.push("EM §2-12 のこの組に当たる組・例外の決まり");
  return changes;
}
