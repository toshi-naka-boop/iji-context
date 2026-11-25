// 公的情報レジストリ（FR-124〜127・131）：official/ の形の検査と、evidence-master §2-4「採用した公的文書」の表との突き合わせ
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { REVISIONS, resolveRevision } from "../../src/engine/revisions";
import { loadRegistry, officialInputOf, SUMMARY_MAX } from "../../src/official/registry";
import { YM } from "../helpers/period";
import { makeDoc } from "./helpers";

const repo = path.join(__dirname, "..", "..");
const docs = loadRegistry(path.join(repo, "official"));

/** EM §2-4 の節（見出しから次の見出しまで）。なければ例外（表のない EM では、レジストリに何も置けない） */
function emSection(): string {
  const em = readFileSync(path.join(repo, "design", "iji-context", "sources", "evidence-master-iji-context.md"), "utf8");
  const start = em.indexOf("### 2-4. 採用した公的文書");
  if (start < 0) throw new Error("evidence-master に「2-4. 採用した公的文書」の節がない");
  const end = em.indexOf("\n### ", start + 1);
  return em.slice(start, end < 0 ? undefined : end);
}
/** 表の行（先頭の欄が id の行）を、欄の配列にする */
const emRows = () =>
  emSection()
    .split("\n")
    .filter((l) => /^\| [A-Z]+-[A-Za-z0-9-]+ \|/.test(l))
    .map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));

describe("evidence-master との対応（FR-127）", () => {
  it("レジストリのすべての id が、EM §2-4 の表にある（EM にない文書は置けない）", () => {
    const emIds = new Set(emRows().map((r) => r[0]));
    expect(emIds.size).toBeGreaterThan(0);
    expect(docs.map((d) => d.id).filter((id) => !emIds.has(id))).toEqual([]);
  });
  it("種類・番号・立場・要旨の出どころ・確認日が、EM の行と食い違わない。URL は EM の節にある PDF で、足しているのはページの指定だけ", () => {
    const section = emSection();
    const rows = new Map(emRows().map((r) => [r[0], r]));
    for (const d of docs) {
      const [, kind, , number, , , , stance, , checkedOn] = rows.get(d.id)!;
      if (kind !== "同") expect(d.kind, d.id).toBe(kind);
      expect(d.number, d.id).toBe(number);
      // EM の立場は「認めない（その薬剤だけを処方する場合）」のように括弧の但し書きを持つことがある。但し書きは conditionNote に持つ
      expect(stance.startsWith(d.stance), d.id).toBe(true);
      expect(d.checkedOn, d.id).toBe(checkedOn);
      const [base, fragment] = d.url.split("#");
      expect(section.includes(base), d.id).toBe(true);
      if (fragment !== undefined) expect(fragment, d.id).toMatch(/^page=\d+$/);
    }
  });
});

describe("同梱のレジストリ（FR-124〜126・131）", () => {
  it("件数は 10〜20 件で、id の昇順", () => {
    expect(docs.length).toBeGreaterThanOrEqual(10);
    expect(docs.length).toBeLessThanOrEqual(20);
    expect(docs.map((d) => d.id)).toEqual([...docs.map((d) => d.id)].sort());
  });
  it("対象区分は、基準月の版の点数表にある区分だけ（架空コードの表にあるだけの古い区分を置かない）", () => {
    const points = resolveRevision(YM).points;
    for (const d of docs) expect(d.scope.kubun.filter((k) => !Object.hasOwn(points, k)), d.id).toEqual([]);
  });
  it("適用する改定は、同梱の版の generation にある", () => {
    const generations = new Set(REVISIONS.map((r) => r.generation));
    for (const d of docs) expect(d.generations.filter((g) => !generations.has(g)), d.id).toEqual([]);
  });
  it("要旨は 200 字までで、点数・金額を含まない。審査の取扱い・審査情報提供事例は支払基金、疑義解釈は審査支払機関を問わない", () => {
    for (const d of docs) {
      expect(d.summary.length, d.id).toBeLessThanOrEqual(SUMMARY_MAX);
      expect(d.summary, d.id).not.toMatch(/[0-9０-９]\s*(点|円)/);
      expect(d.scope.payer, d.id).toBe(d.kind === "疑義解釈" ? null : "支払基金");
    }
  });
  it("本番の配線が作る入力は、基準月で世代を返し、同梱の版のない年月では null を返す", () => {
    const input = officialInputOf(repo);
    expect(input.docs).toEqual(docs);
    expect(input.generationOf(YM)).toBe(resolveRevision(YM).generation);
    expect(input.generationOf("2000-01")).toBeNull();
    expect(input.ruleKubun?.("R11", YM)).toContain("D008_19");
  });
});

describe("読み込みの検査", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "iji-official-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const put = (name: string, doc: unknown) => writeFileSync(path.join(dir, name), JSON.stringify(doc));
  const good = () => makeDoc({ id: "X-1", scope: { kubun: ["D008_19"] } });

  it("形の合う文書は読める。JSON でないファイルは見ない", () => {
    put("X-1.json", good());
    writeFileSync(path.join(dir, "README.txt"), "x");
    expect(loadRegistry(dir)).toEqual([good()]);
  });
  it("架空コードの表にない区分・区分なし・知らない項目・https でない URL・長すぎる要旨・点数や金額を書いた要旨は拒否する", () => {
    const bad: unknown[] = [
      makeDoc({ scope: { kubun: ["XXXX"] } }),
      makeDoc({ scope: { kubun: [] } }),
      { ...good(), body: "原文" },
      { ...good(), url: "http://example.invalid/" },
      { ...good(), summary: "あ".repeat(SUMMARY_MAX + 1) },
      { ...good(), summary: "この検査は 130点 を算定する" },
      { ...good(), summary: "自己負担は 500 円" },
      { ...good(), stance: "不明" },
      { ...good(), generations: [] },
      { ...good(), issuedOn: "令和8年6月1日" },
    ];
    for (const doc of bad) {
      put("X-1.json", doc);
      expect(() => loadRegistry(dir), JSON.stringify(doc)).toThrow(/公的文書の形が違う/);
    }
  });
  it("ファイル名と id が違う文書は拒否する（同じ id を 2 つ置けない）", () => {
    put("X-2.json", good());
    expect(() => loadRegistry(dir)).toThrow(/ファイル名と id が違う/);
  });
});
