// 版が持つ診療行為コードを、医科診療行為マスターの CSV と突き合わせる（design.md §11-1）。`npx tsx scripts/check-codes.ts <マスターの CSV>`
// マスターは同梱しない（厚生労働省 診療報酬情報提供サービスの「ファイルダウンロード」から、その改定の版を手で取ってくる。EM §2-8）。改定のたびに手で回す（docs/revision-howto.md）。
// 見ること：コードがマスターにある／省略漢字名称が EM §2-8 の「マスターの名称」と同じ（primary と包括の対象）／点数識別が 3（点数）で、新又は現点数が版の点数表と同じ（kind が「改定」の版だけ）／
// 変更年月日〜廃止年月日が版の適用期間に掛かっている／包括の検査の項目は「包括対象検査」が 0 でない。食い違いがあれば 1 行ずつ出して終了コード 1
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REVISIONS } from "../src/engine/revisions";
import type { Revision } from "../src/engine/revisions/types";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const EM = "design/iji-context/sources/evidence-master-iji-context.md";

/** マスターの列（1 起算。マスターファイル仕様説明書のファイルレイアウト） */
const COL = { code: 3, name: 5, pointKind: 11, points: 12, bundled: 16, changedOn: 87, abolishedOn: 88 } as const;

type MasterRow = { name: string; pointKind: string; points: number; bundled: string; changedOn: string; abolishedOn: string };

/** 引用符つきの CSV の 1 行を欄に分ける（欄の中の "" は " 1 つ） */
function cellsOf(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

export function parseMaster(text: string): Map<string, MasterRow> {
  const rows = new Map<string, MasterRow>();
  for (const line of text.split(/\r?\n/)) {
    if (line === "") continue;
    const c = cellsOf(line);
    const at = (n: number) => c[n - 1] ?? "";
    rows.set(at(COL.code), { name: at(COL.name), pointKind: at(COL.pointKind), points: Number(at(COL.points)), bundled: at(COL.bundled), changedOn: at(COL.changedOn), abolishedOn: at(COL.abolishedOn) });
  }
  return rows;
}

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
        if (!row || rev.kind !== "改定") continue;
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

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const file = process.argv[2];
  if (!file) {
    console.error("使い方：npx tsx scripts/check-codes.ts <医科診療行為マスターの CSV>");
    process.exit(2);
  }
  // マスターは Shift_JIS
  const master = parseMaster(new TextDecoder("shift_jis").decode(readFileSync(file)));
  const hits = checkCodes(master, emNames(readFileSync(path.join(root, EM), "utf8")));
  for (const h of hits) console.log(h);
  console.log(`マスター ${master.size} 行と突き合わせた。食い違い ${hits.length} 件`);
  process.exit(hits.length > 0 ? 1 : 0);
}
