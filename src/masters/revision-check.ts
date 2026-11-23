// 版の表（Revision.points・codes・bundles）と、医科診療行為マスターの 1 枚の突き合わせ（design.md §11-1・§12-1）。
// どちらかを黙って優先しない：食い違いを全部並べ、masters.db を作る側（src/masters/verify.ts）が失敗にする。
// 見ること：コードがマスターにある／省略漢字名称が EM §2-8 の「マスターの名称」と同じ（primary と包括の対象）／点数識別が 3（点数）で、新又は現点数が版の点数表と同じ（kind が「改定」の版だけ。版で点数未収載の区分は比べない）／
// 変更年月日〜廃止年月日が版の適用期間に掛かっている／包括の検査の項目は「包括対象検査」が 0 でない
import { REVISIONS } from "../engine/revisions";
import type { Revision } from "../engine/revisions/types";

/** マスターの 1 行のうち、突き合わせに使う項目（医科診療行為マスターの項番 5・11・12・16・87・88） */
export type MasterRow = { name: string; pointKind: string; points: number; bundled: string; changedOn: string; abolishedOn: string };

/** EM §2-8 の表から、コード → マスターの名称（primary の行と、包括の対象の表） */
export function emNames(em: string): Map<string, string> {
  const start = em.indexOf("### 2-8. 採用した診療行為コード");
  if (start < 0) throw new Error("evidence-master に「2-8. 採用した診療行為コード」の節がない");
  const end = em.indexOf("\n### ", start + 1);
  const names = new Map<string, string>();
  for (const line of em.slice(start, end < 0 ? undefined : end).split("\n")) {
    const c = line.split("|").slice(1, -1).map((x) => x.trim());
    if (c.length === 8 && /^\d{9}$/.test(c[1])) names.set(c[1], c[3]);
    if (c.length === 9) for (const i of [1, 4, 7]) if (/^\d{9}$/.test(c[i])) names.set(c[i], c[i + 1]);
  }
  return names;
}

/** 食い違いの一覧（なければ空） */
export function checkCodes(master: Map<string, MasterRow>, names: Map<string, string>, revs: Revision[] = REVISIONS): string[] {
  const out: string[] = [];
  for (const rev of revs) {
    const from = `${rev.effectiveFrom.replace("-", "")}01`;
    const until = `${rev.effectiveUntil.replace("-", "")}31`;
    const common = (code: string, where: string): MasterRow | null => {
      const row = master.get(code);
      if (!row) {
        out.push(`${rev.id} ${where} ${code}：マスターにない`);
        return null;
      }
      if (row.changedOn > until || row.abolishedOn < from) out.push(`${rev.id} ${where} ${code}：有効期間（${row.changedOn}〜${row.abolishedOn}）が版の適用期間に掛からない`);
      const name = names.get(code);
      if (name !== undefined && name !== row.name) out.push(`${rev.id} ${where} ${code}：名称が EM と違う（マスター「${row.name}」／EM「${name}」）`);
      return row;
    };
    for (const [kubun, def] of Object.entries(rev.codes)) {
      for (const code of [def.primary, ...def.accept]) {
        const row = common(code, kubun);
        // 点数未収載の区分（注8 の減算。所定点数の割合で決まり、マスターは点数識別 6）は、版の点数表に比べる点数がない
        if (!row || rev.kind !== "改定" || rev.points[kubun].points === null) continue;
        if (row.pointKind !== "3") out.push(`${rev.id} ${kubun} ${code}：点数識別が 3（点数）でない`);
        else if (row.points !== rev.points[kubun].points) out.push(`${rev.id} ${kubun} ${code}：点数が違う（マスター ${row.points}／点数表 ${rev.points[kubun].points}）`);
      }
    }
    rev.bundles.forEach((b, i) => {
      for (const code of b.members) {
        const row = common(code, `bundles[${i}]`);
        if (row && (row.bundled === "" || Number(row.bundled) === 0)) out.push(`${rev.id} bundles[${i}] ${code}：マスターで包括対象検査になっていない`);
      }
    });
  }
  return out;
}
