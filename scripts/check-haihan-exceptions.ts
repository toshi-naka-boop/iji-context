// 背反の特例条件の例外（EM §2-12。design.md §13-1）の引用が、告示・留意事項通知の本文に、その文字列であるかを機械で確かめる。
// 使い方：npx tsx scripts/check-haihan-exceptions.ts <本文テキストの置き場>
//   置き場には、001686842.txt（令和8年厚生労働省告示第69号 別表第一）と 001757385.txt（保医発0305第6号 別添1）を置く（手元で落とす。リポジトリに入れない）。
// 比べ方：本文も引用も、空白と改行を除いてから探す。表 1 の「文書」が告示・留意の行だけを確かめる。疑義解釈の行は機械では確かめない（PDF のページを人が確かめる）。
// 出すもの：例外ごとの結果、本文テキストの sha256（EM の冒頭に書いた値と違えば知らせる）、数。EM が「確かめた」とした行の引用が見つからなければ、終了コード 1。
// 確かめられない例外は、EM の行を残して分類をウにする（design.md §13-1。このスクリプトは EM を書き換えない）
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DOCS: Record<string, string> = { 告示: "001686842.txt", 留意: "001757385.txt" };

export type HxRow = { id: string; doc: string; quote: string; status: string; kind: string };

/** EM §2-12 の表 1（例外）の行。列は見出しの名前で探す */
export function hxRowsOf(em: string): HxRow[] {
  const start = em.indexOf("### 2-12. 背反の特例条件の例外");
  if (start < 0) throw new Error("evidence-master に「2-12. 背反の特例条件の例外」の節がない");
  const end = em.slice(start + 1).search(/\n#{2,3} /);
  const lines = em.slice(start, end < 0 ? undefined : start + 1 + end).split("\n");
  const cells = (l: string) => l.split("|").slice(1, -1).map((x) => x.trim());
  const head = lines.map(cells).find((c) => c[0] === "id" && c.includes("引用"));
  if (!head) throw new Error("EM §2-12 に、例外の表（id・引用の列）がない");
  const col = (name: string) => {
    const i = head.indexOf(name);
    if (i < 0) throw new Error(`EM §2-12 の例外の表に「${name}」の列がない`);
    return i;
  };
  const [doc, quote, status, kind] = [col("文書"), col("引用"), col("原文の確かめ"), col("分類")];
  return lines.map(cells).filter((c) => /^HX-\d{2}$/.test(c[0] ?? "")).map((c) => {
    const q = c[quote];
    const [i, j] = [q.indexOf("「"), q.lastIndexOf("」")];
    return { id: c[0], doc: c[doc], quote: i >= 0 && j > i ? q.slice(i + 1, j) : q, status: c[status], kind: c[kind] };
  });
}

const squash = (s: string) => s.replace(/\s/g, "");

/** 引用が本文にあるか。texts は文書の略号 → 本文。null は、機械では確かめない行（疑義解釈など） */
export function checkRow(row: HxRow, texts: Record<string, string>): boolean | null {
  const body = texts[row.doc];
  if (body === undefined) return null;
  return row.quote !== "" && squash(body).includes(squash(row.quote));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("使い方：npx tsx scripts/check-haihan-exceptions.ts <本文テキストの置き場（001686842.txt・001757385.txt）>");
    process.exit(2);
  }
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const em = readFileSync(path.join(root, "design/iji-context/sources/evidence-master-iji-context.md"), "utf8");
  const texts: Record<string, string> = {};
  for (const [doc, file] of Object.entries(DOCS)) {
    const p = path.join(dir, file);
    if (!existsSync(p)) {
      console.error(`本文テキストがない：${p}`);
      process.exit(2);
    }
    const bytes = readFileSync(p);
    const sha = createHash("sha256").update(bytes).digest("hex");
    console.log(`${doc}（${file}）sha256 ${sha}${em.includes(sha) ? "（EM §2-12 の値と同じ）" : "（EM §2-12 の値と違う。落とし直した本文なら、EM の冒頭を直してから確かめ直す）"}`);
    texts[doc] = bytes.toString("utf8");
  }
  const rows = hxRowsOf(em);
  let found = 0;
  let missing = 0;
  let manual = 0;
  let broken = 0;
  for (const r of rows) {
    const ok = checkRow(r, texts);
    const claimed = r.status.startsWith("確かめた");
    if (ok === null) manual++;
    else if (ok) found++;
    else missing++;
    if (claimed && ok !== true) broken++;
    const result = ok === null ? "機械では確かめない（疑義解釈など。PDF のページを人が確かめる）" : ok ? "本文に見つかった" : "本文に見つからない";
    console.log(`${r.id}　分類 ${r.kind}　${r.doc}「${r.quote}」→ ${result}　［EM：${r.status}］${claimed && ok !== true ? "　← EM は「確かめた」なのに確かめられない" : ""}`);
  }
  console.log(`例外 ${rows.length} 件：本文に見つかった ${found}・見つからない ${missing}・機械では確かめない ${manual}。確かめられない例外は、EM の行を残して分類をウにする`);
  process.exit(broken > 0 ? 1 : 0);
}
