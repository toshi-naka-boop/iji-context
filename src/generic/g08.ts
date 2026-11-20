// G08 傷病名の要件（design.md §12-3）：対象の傷病名が要る診療行為（医科診療行為マスターの傷病名関連区分。［基］p31 項番25）がレセプトにあるのに、
// その対象とされている傷病名（傷病名マスターの特定疾患等対象区分。［基］p8 項番21）のコードが、レセプトの傷病名（SY）に 1 つもないときに、条件つきで出す。言い切りには上げない。
// 区分の対応（どれも、原文＝特掲診療料の施設基準等の別表で確かめた錨が EM §2-11 にある）：
//   3 皮膚科特定疾患指導管理料(Ⅰ) ← 03／4 同(Ⅱ) ← 04／5 特定疾患療養管理料・特定疾患処方管理加算 ← 05・08／7 てんかん指導料 ← 07・08（08＝特定疾患療養管理料又はてんかん指導料の対象）
//   9 難病外来指導管理料は点検しない：傷病名マスターの難病外来対象区分（項番43）が、告示の対象（指定難病その他これに準ずる疾患、難病外来指導管理料 2 は別の対象）を
//   覆っていると確かめられない（EM §2-11「未確認のまま残した読み方」）
// 言わない場合（正しい請求に出さない側に倒す）：
//   未コード化の傷病名（0000999）が SY にあるレセプト（名前では当てない）、持っているマスターにない傷病名コードが SY にあるレセプト、傷病名を持たない請求（区分キーの行）
// 数え方：SY のコードと傷病名マスターのコードの完全一致。修飾語は見ない（疑い病名も当たりに数える。告示・通知に疑い病名の扱いの定めを見つけていない）。
//   転帰のある傷病名も数える（SY レコードに転帰の日付の項目がなく、診療年月より前に終わったかが決まらない。記録条件仕様 p15）。主病かどうかは見ない
import { pickSnapshot, shinryoOf, type MastersDb } from "../masters/db";
import { UNCODED_DISEASE } from "../uke/diseases";
import type { GenericAbout, GenericAboutMore, GenericCheck, GenericClaim, GenericFinding } from "./types";

/** 傷病名関連区分 → 当たりに数える特定疾患等対象区分と、文に入れる呼び名 */
const TARGET: Record<string, { flags: string[]; what: string }> = {
  "3": { flags: ["03"], what: "皮膚科特定疾患指導管理料（Ⅰ）" },
  "4": { flags: ["04"], what: "皮膚科特定疾患指導管理料（Ⅱ）" },
  "5": { flags: ["05", "08"], what: "特定疾患療養管理料・特定疾患処方管理加算" },
  "7": { flags: ["07", "08"], what: "てんかん指導料" },
};

/**
 * 点検できるかと、SY の傷病名の特定疾患等対象区分。点検しない理由：none＝傷病名を持たない／uncoded＝未コード化の傷病名がある／unknown＝マスターにないコードがある
 */
function diseaseFlags(masters: MastersDb, about: GenericAbout): { flags: Set<string> } | { why: "none" | "uncoded" | "unknown" } | { skip: string } {
  const diseases = (about as GenericAboutMore).diseases;
  if (diseases === undefined) return { why: "none" };
  if (diseases.some((d) => d.code === UNCODED_DISEASE)) return { why: "uncoded" };
  const pick = pickSnapshot(masters, "shobyo", about.yearMonth, about.generation);
  if (pick === null) return { skip: `診療年月の世代（${about.generation}）の傷病名のマスターがありません` };
  const flagOf = masters.prepare("SELECT tokutei_shikkan FROM shobyo WHERE snapshot = ? AND code = ?");
  const flags = new Set<string>();
  for (const d of diseases) {
    const r = flagOf.get(pick.snapshot, d.code) as { tokutei_shikkan: string } | undefined;
    if (!r) return { why: "unknown" };
    flags.add(r.tokutei_shikkan);
  }
  return { flags };
}

/** G08 が点検していないこと（点検の範囲の説明に出す） */
export function g08NotDone(masters: MastersDb, about: GenericAbout): string[] {
  const d = diseaseFlags(masters, about);
  const why = "why" in d ? { none: "ここの行には傷病名が付いていないので、傷病名の要件は点検していません", uncoded: "未コード化の傷病名（0000999）があるので、傷病名の要件は点検していません（名称では当てません）", unknown: "持っているマスターにない傷病名コードがあるので、傷病名の要件は点検していません" }[d.why] : null;
  return [...(why ? [why] : []), "傷病名の要件のうち、難病外来指導管理料の対象の傷病名、主病かどうか、疑い病名・転帰の扱いは、点検していません（疑い病名・転帰のある傷病名も、対象の傷病名として数えています）"];
}

export const g08: GenericCheck = {
  id: "G08",
  kind: "傷病名",
  run(claim: GenericClaim, masters, about) {
    const seen = new Map<string, number[]>();
    claim.units.forEach((u, i) => {
      for (const it of u.items) if (it.kind === "SI") seen.set(it.code, [...new Set([...(seen.get(it.code) ?? []), i])]);
    });
    const d = diseaseFlags(masters, about);
    if ("skip" in d) return d;
    if ("why" in d || seen.size === 0) return [];
    const pick = pickSnapshot(masters, "shinryo", about.yearMonth, about.generation);
    if (pick === null) return { skip: `診療年月の世代（${about.generation}）の診療行為のマスターがありません` };
    const out: GenericFinding[] = [];
    for (const [code, units] of seen) {
      const r = shinryoOf(masters, pick.snapshot, code);
      const target = r ? TARGET[r.shobyo_kanren] : undefined;
      if (!r || !target || target.flags.some((f) => d.flags.has(f))) continue;
      out.push({
        check: "G08",
        kind: "傷病名",
        certainty: "条件つき",
        units,
        codes: [code],
        messageKey: "G08.no_target",
        params: { code, name: r.name, what: target.what },
        source: { data: "医科診療行為マスター・傷病名マスター", ref: `診療行為コード=${code}, 傷病名関連区分=${r.shobyo_kanren}, 特定疾患等対象区分=${target.flags.join("・")}` },
      });
    }
    return out;
  },
};
