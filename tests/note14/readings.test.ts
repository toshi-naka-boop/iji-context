// 注14 の計算の道具の定数を EM の行と照らす（design.md §15-13「値は EM の行を版の定数に写し、テストで EM の行と照らす」）。
// 読みの軸（readings.ts）は EM §7-2 の下の表「注14 の割れる読み」の行と、照会の番号は U の行と照らす。守ること（import の向き・数の直書き）もここで縛る
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REVISIONS, resolveRevision } from "../../src/engine/revisions";
import { toolConstsOf } from "../../src/note14/evaluate";
import { AXES } from "../../src/note14/readings";
import { month } from "../helpers/period";

const repo = path.join(__dirname, "..", "..");
const EM = readFileSync(path.join(repo, "design/iji-context/sources/evidence-master-iji-context.md"), "utf8").split("\n");
const row = (id: string) => EM.find((l) => l.startsWith(`| ${id} |`))!;
const cells = (l: string) => l.split("|").slice(1, -1).map((c) => c.trim());
const K = toolConstsOf(resolveRevision(month(1)).consts.note14)!;

describe("版の定数 rev.consts.note14 が EM R8-194〜R8-201 と合う", () => {
  it("回数の門（R8-194）・期間（R8-196）・除く機関の境の日（R8-195）", () => {
    expect(row("R8-194")).toContain(`**合算が ${K.visitThreshold.toLocaleString("en-US")} 回未満**`);
    expect(row("R8-196")).toMatch(new RegExp(`\\*\\*直近 ${K.periodMonths.short} 月間\\*\\*`));
    expect(K.periodMonths.long).toBe(12);
    expect(row("R8-196")).toContain("**直近 1 年間**");
    // 令和6年3月31日（R8-195）。令和 n 年＝2018＋n 年
    const m = /令和(\d+)年(\d+)月(\d+)日以前に開設したものを除く/.exec(row("R8-195"))!;
    expect(K.excludeOpenedOnOrBefore).toBe(`${2018 + Number(m[1])}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`);
  });
  it("紹介（R8-197）・看取りと重症児（R8-198）・割合の整数の形（R8-199・R8-200）・確認月（R8-201）", () => {
    expect(row("R8-197")).toContain(`**${K.referralMin} つ以上の保険医療機関**`);
    expect(row("R8-198")).toContain(`**在宅における看取り ${K.mitoriMin} 件以上**`);
    expect(row("R8-198")).toContain(`**${K.jushojiMin} 件以上**`);
    expect(row("R8-199")).toContain(`整数で比べる形：(②−③)×${K.ratio199.den} ≦ ${K.ratio199.num}×(①＋②)`);
    expect(row("R8-200")).toContain(`整数で比べる形：⑤×${K.ratio200.den / K.ratio200.num} ≧ ①＋②`);
    expect(row("R8-201")).toContain(`毎年 **${K.checkMonths.join("・")} 月**`);
  });
  it("数える行の別表（EM §2-8 の「数えるためだけの行」）と同じコード・同じ読み。版の区分には入れていない", () => {
    const start = EM.findIndex((l) => l.startsWith("**数えるためだけの行（注14 の訪問診療回数"));
    const table = EM.slice(start).filter((l) => /^\| (甲・乙|乙だけ) \|/.test(l)).map(cells);
    expect(table).toHaveLength(9);
    expect(K.countRows).toEqual(table.map((c) => ({ code: c[1], reading: c[0] === "甲・乙" ? "both" : "otsu" })));
    for (const rev of REVISIONS) for (const r of rev.consts.note14?.countRows ?? []) if (r.reading === "otsu") expect(Object.values(rev.codes).some((d) => d.primary === r.code), r.code).toBe(false);
  });
});

describe("読みの軸（readings.ts）が EM の「注14 の割れる読み」と合う", () => {
  const start = EM.findIndex((l) => l.startsWith("#### 注14 の割れる読み"));
  const axisRows = EM.slice(start).filter((l) => /^\| U-\d+[a-c]? \|/.test(l)).map(cells);
  it("軸の並びと数、読み甲・読み乙の語が EM の欄にある", () => {
    expect(AXES.map((a) => a.id)).toEqual(axisRows.map((c) => c[0]));
    for (const a of AXES) {
      const c = axisRows.find((x) => x[0] === a.id)!;
      expect(c[2], `${a.id} 甲`).toContain(a.a);
      expect(c[3], `${a.id} 乙`).toContain(a.b);
    }
  });
  it("照会の番号が EM §7-2 の U の行と同じ（U-31a・U-31b は U-31 の行）", () => {
    for (const a of AXES) {
      const u = EM.find((l) => l.startsWith(`| ${a.id} |`) && l.includes("照会 #")) ?? EM.find((l) => l.startsWith(`| ${a.id.replace(/[ab]$/, "")} |`) && l.includes("照会 #"))!;
      expect(/照会 #(\d+)/.exec(u)![1], a.id).toBe(String(a.inquiry));
    }
  });
});

describe("守ること（design.md §15-13。段 17i）", () => {
  const files = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(d, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(d, e.name)] : []));
  const importsOf = (f: string) => [...readFileSync(f, "utf8").matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  it("src/engine・src/generic は src/note14 と道具の処理を import しない。src/note14 は LLM の SDK・mentor・llm を import しない", () => {
    for (const d of ["src/engine", "src/generic"]) for (const f of files(path.join(repo, d))) for (const i of importsOf(f)) expect(/note14\/|app\/note14/.test(i) && !/revisions/.test(i), `${f}: ${i}`).toBe(false);
    const mine = files(path.join(repo, "src/note14"));
    expect(mine.length).toBeGreaterThan(2);
    for (const f of mine) for (const i of importsOf(f)) expect(/@anthropic-ai|claude-agent-sdk|mentor|\/llm/.test(i), `${f}: ${i}`).toBe(false);
  });
  it("AI に送る文脈を作るところ（src/llm・src/mentor）は道具を import しない", () => {
    for (const d of ["src/llm", "src/mentor"]) for (const f of files(path.join(repo, d))) for (const i of importsOf(f)) expect(/note14/.test(i), `${f}: ${i}`).toBe(false);
  });
  it("src/note14 に門の回数・件数・割合・境の日を直書きしない（版の定数から受け取る）", () => {
    for (const f of files(path.join(repo, "src/note14"))) {
      const code = readFileSync(f, "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const v of [K.visitThreshold, K.excludeOpenedOnOrBefore, `${K.ratio199.num} *`, `* ${K.ratio199.den}`]) expect(code.includes(String(v)), `${f}: ${v}`).toBe(false);
    }
  });
});

describe("同じ月のレセプトの鍵と重なりの判定は 1 か所（round-61 C-374）", () => {
  const src = (f: string) => readFileSync(path.join(repo, f), "utf8");
  it("取り込みの一覧（段 17g）は src/note14/count.ts の sameMonthKey を使い、鍵を自分で組まない", () => {
    expect(src("src/server/app/uke.ts")).toMatch(/import \{[^}]*\bsameMonthKey\b[^}]*\} from "\.\.\/\.\.\/note14\/count"/);
    expect(src("src/server/app/uke.ts")).not.toMatch(/replace\(\/\\s\/g, ""\)/);
  });
  it("重なりの判定は count.ts の overlapMonths だけ（1 段目と 2 段目の下書きが同じ関数を使う）", () => {
    for (const f of ["src/note14/count.ts", "src/note14/drafts.ts"]) expect(src(f), f).toMatch(/overlapMonths\(/);
    expect(src("src/note14/drafts.ts")).not.toMatch(/new Set\(keys\)\.size/);
    expect(src("src/note14/count.ts").match(/new Set\(keys\)\.size/g) ?? []).toHaveLength(1);
  });
});
