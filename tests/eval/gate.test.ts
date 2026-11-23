// 段 19g（design.md §16-9・16-10）：評価の組の分け方（split）、正解の ID（中身で振る）、除く正解と固定する束（GATE_SHA256）、余計な取り出しの数、
// 合否の組の回し方（eval/gate-runs.jsonl に 1 行ずつ。同じ条件で続けた最初の 2 回で決める）。AI は呼ばない（作り物の出力で数える）
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertGate, countActs, gateBundleSha, GATE_SHA256, loadExclude, wantOf, type ActsCount } from "../../eval/acts-count";
import { CODE_PATHS, codeSha, gateRunsPath, gateVerdict, readGateRuns, recordGate, type GateRun } from "../../eval/gate";
import type { ChartAct } from "../../src/chart/acts";
import type { ItemMatch } from "../../src/chart/match";

const repo = path.join(__dirname, "..", "..");
type Row = { id: string; kind: string; split?: string; chart?: string; date?: string };
const rows = (root = repo): Row[] =>
  readFileSync(path.join(root, "eval", "datasets", "resemen.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Row)
    .filter((r) => r.kind === "acts");
const entryOf = (r: Row, root = repo) => (JSON.parse(readFileSync(path.join(root, "fixtures", "charts", `${r.chart}-abbrev.json`), "utf8")) as { entries: { date: string; acts: ChartAct[] }[] }).entries.find((e) => e.date === r.date)!;
const wantsOf = (split: string) => rows().filter((r) => r.split === split).flatMap((r) => wantOf(entryOf(r).acts, { chart: r.chart!, date: r.date! }));

describe("評価の組の分け方と除く正解（16-9。L-189・L-190・L-191）", () => {
  it("acts の行はどれも split を持ち、直しに使う組は今の 8 記載（A-K8-1〜A-K11-2）、合否だけの組は E-14 の 14 記載", () => {
    expect(rows().every((r) => r.split === "tune" || r.split === "gate")).toBe(true);
    expect(rows().filter((r) => r.split === "tune").map((r) => r.id)).toEqual(["A-K8-1", "A-K8-2", "A-K9-1", "A-K9-2", "A-K10-1", "A-K10-2", "A-K11-1", "A-K11-2"]);
    expect(rows().filter((r) => r.split === "gate").map((r) => r.chart)).toEqual(["K14", "K15", "K16", "K16", "K16", "K17", "K18", "K19", "K20", "K21", "K22", "K23", "K24", "K24"]);
  });
  it("直しに使う組の除く正解が 10 個で、文章から取り出すべき行為が 64（74 から）。除く正解の ID はどれも正解にある", () => {
    const ex = loadExclude(repo);
    const tune = wantsOf("tune");
    expect(tune).toHaveLength(74);
    expect(ex).toHaveLength(10);
    const ids = new Set(tune.map((w) => w.id));
    expect(ex.filter((e) => !ids.has(e.id!))).toEqual([]);
    expect(tune.filter((w) => !ex.some((e) => e.id === w.id))).toHaveLength(64);
  });
  it("合否だけの組は 82 行為（訪問診療・往診を除くと 68）で、除く正解は 0（EM §5-1-2 の数）", () => {
    const gate = wantsOf("gate");
    expect(gate).toHaveLength(82);
    expect(gate.filter((w) => w.code === "114001110" || w.code === "114000110")).toHaveLength(14);
    const ex = new Set(loadExclude(repo).map((e) => e.id));
    expect(gate.filter((w) => ex.has(w.id))).toEqual([]);
    expect(new Set(gate.map((w) => w.id)).size).toBe(82);
  });
});

describe("正解の ID（中身で振る。C-404）", () => {
  const act = (code: string, children: string[] = []): ChartAct => ({
    category: "注射",
    written: code,
    lookup: [],
    quote: code,
    match: { tbl: "shinryo", code, name: code, by: "name" },
    ...(children.length ? { with: children.map((c) => ({ kind: "薬" as const, written: c, lookup: [], quote: c, match: { tbl: "iyakuhin" as const, code: c, name: c, by: "name" as const } })) } : {}),
  });
  const at = { chart: "K99", date: "2026-10-30" };
  it("行為は <症例>/<日付>/<tbl>:<code>#<n>、with の子は <親の ID>/<tbl>:<code>#<n>。同じ日の同じコードは並びの順に #1・#2", () => {
    expect(wantOf([act("A", ["x"]), act("A", ["x", "y"])], at).map((w) => w.id)).toEqual([
      "K99/2026-10-30/shinryo:A#1",
      "K99/2026-10-30/shinryo:A#1/iyakuhin:x#1",
      "K99/2026-10-30/shinryo:A#2",
      "K99/2026-10-30/shinryo:A#2/iyakuhin:x#1",
      "K99/2026-10-30/shinryo:A#2/iyakuhin:y#1",
    ]);
  });
  it("正解の途中に行為を 1 つ入れても、ほかの ID は変わらない", () => {
    const before = wantOf([act("A"), act("B", ["x"]), act("C")], at).map((w) => w.id);
    const after = wantOf([act("A"), act("D", ["z"]), act("B", ["x"]), act("C")], at).map((w) => w.id);
    expect(after.filter((id) => !id!.includes("shinryo:D"))).toEqual(before);
  });
});

describe("固定する束（GATE_SHA256。L-210・C-414）", () => {
  let tmp: string;
  const gateRows = rows().filter((r) => r.split === "gate");
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "iji-gate-"));
    mkdirSync(path.join(tmp, "eval", "datasets"), { recursive: true });
    mkdirSync(path.join(tmp, "fixtures", "charts"), { recursive: true });
    for (const f of ["acts-exclude.json", "resemen.jsonl"]) copyFileSync(path.join(repo, "eval", "datasets", f), path.join(tmp, "eval", "datasets", f));
    for (const c of new Set(gateRows.map((r) => r.chart!))) copyFileSync(path.join(repo, "fixtures", "charts", `${c}-abbrev.json`), path.join(tmp, "fixtures", "charts", `${c}-abbrev.json`));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));
  const edit = (rel: string, fn: (s: string) => string) => writeFileSync(path.join(tmp, rel), fn(readFileSync(path.join(tmp, rel), "utf8")));
  const editChart = (chart: string, fn: (c: { entries: Record<string, unknown>[] }) => void) => {
    const rel = path.join("fixtures", "charts", `${chart}-abbrev.json`);
    const c = JSON.parse(readFileSync(path.join(tmp, rel), "utf8"));
    fn(c);
    writeFileSync(path.join(tmp, rel), JSON.stringify(c, null, 2));
  };

  it("今の束の指紋は定数と同じ（評価は通る）。写しても同じ", () => {
    expect(gateBundleSha(repo)).toBe(GATE_SHA256);
    expect(assertGate(tmp)).toBe(GATE_SHA256);
  });
  it("acts-exclude.json を 1 行変えると、評価が失敗する", () => {
    edit("eval/datasets/acts-exclude.json", (s) => s.replace("K8/2026-10-14/shinryo:114001470#1", "K8/2026-10-14/shinryo:114001470#2"));
    expect(() => assertGate(tmp)).toThrow(/合否の組の束の指紋が固定した値と違います/);
  });
  it("gate の記載を 1 行消すと、評価が失敗する", () => {
    edit("eval/datasets/resemen.jsonl", (s) => s.split("\n").filter((l) => !l.includes('"id": "A-K22-1"')).join("\n"));
    expect(() => assertGate(tmp)).toThrow(/指紋/);
  });
  it("gate の記載が指すカルテの正解を 1 つ入れ替えると、評価が失敗する", () => {
    editChart("K21", (c) => {
      const acts = c.entries[0].acts as ChartAct[];
      [acts[1], acts[2]] = [acts[2], acts[1]];
    });
    expect(() => assertGate(tmp)).toThrow(/指紋/);
  });
  it("gate の記載が指すカルテの文章（s・o・a・p・rx）を 1 文字変えると、評価が失敗する", () => {
    for (const key of ["s", "o", "a", "p", "rx"]) {
      editChart("K15", (c) => {
        c.entries[0][key] = `${c.entries[0][key] as string}。`;
      });
      expect(() => assertGate(tmp), key).toThrow(/指紋/);
      copyFileSync(path.join(repo, "fixtures", "charts", "K15-abbrev.json"), path.join(tmp, "fixtures", "charts", "K15-abbrev.json"));
    }
    expect(assertGate(tmp)).toBe(GATE_SHA256);
  });
});

describe("余計な取り出しと、規則で出すものを取り出した数（L-192）", () => {
  const item = (codes: string[]): ItemMatch => ({ initial: null, candidates: codes.map((code) => ({ tbl: "shinryo", code, name: "", prior: false })) });
  it("作り物の出力で、正解（除く正解を含む）のどれにも組めない取り出しと、除く正解に組んだ取り出しを分けて数える", () => {
    const want = [
      { tbl: "shinryo" as const, code: "A", id: "K/d/shinryo:A#1" },
      { tbl: "shinryo" as const, code: "R", id: "K/d/shinryo:R#1" },
    ];
    const n = countActs([item(["A"]), item(["R"]), item(["Z"]), item(["Y"])], want, [{ id: "K/d/shinryo:R#1", why: "規則で出す" }]);
    expect([n.total, n.in20, n.ref, n.refIn20, n.extra, n.ruleTaken]).toEqual([2, 2, 1, 1, 2, 1]);
  });
});

describe("合否の組の回し方（eval/gate-runs.jsonl。C-424・L-217）", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "iji-gate-runs-"));
    mkdirSync(path.join(tmp, "eval"), { recursive: true });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));
  const out = (ref: number, refIn20: number, extra = 0, ruleTaken = 0): ActsCount => ({ total: ref, in20: refIn20, top5: refIn20, ref, refIn20, refTop5: refIn20, name: 0, lookup: 0, unmatched: 0, hits: [], extra, ruleTaken });
  const key = { designSha256: "d1", codeSha256: "c1" };

  it("合否の組を回すと gate-runs.jsonl に 1 行足され（追記だけ）、合格は同じ条件で続けた最初の 2 回だけで決まる", () => {
    const r1 = recordGate(tmp, [{ id: "g", split: "gate", output: out(82, 80, 3, 1) }, { id: "t", split: "tune", output: out(64, 10) }], { at: "t1", gateSha256: "g1", gateIds: ["g"], key });
    expect(readGateRuns(tmp)).toHaveLength(1);
    expect(r1.run).toEqual({ at: "t1", gateSha256: "g1", designSha256: "d1", codeSha256: "c1", records: 1, total: 82, in20: 80, top5: 80, extra: 3, ruleTaken: 1, pass: true, complete: true, missing: [] });
    expect(r1.lines).toContain("- 合否：未決（同じ条件で記載をそろえて回したのは 1 回です（最初の 2 回で決めます））。記録の全部の回 1・この条件で回した回 1");
    const r2 = recordGate(tmp, [{ id: "g", split: "gate", output: out(82, 79) }], { at: "t2", gateSha256: "g1", gateIds: ["g"], key });
    expect(readGateRuns(tmp)).toHaveLength(2);
    expect(r2.lines.find((l) => l.startsWith("- 合否："))).toMatch(/^- 合否：合格/);
    // 3 回目（線に届かない）は合否に使わない
    const r3 = recordGate(tmp, [{ id: "g", split: "gate", output: out(82, 70) }], { at: "t3", gateSha256: "g1", gateIds: ["g"], key });
    expect(r3.lines.find((l) => l.startsWith("- 合否："))).toMatch(/^- 合否：合格（.*3 回目以降の 1 回は合否に使いません）/);
    expect(readFileSync(gateRunsPath(tmp), "utf8").split("\n").filter(Boolean)).toHaveLength(3);
  });
  it("最初の 2 回のあいだに別の指紋の回があれば数えない。最初の 2 回の片方が線に届かなければ、あとで越えても不合格", () => {
    const run = (at: string, gateSha256: string, pass: boolean): GateRun => ({ at, gateSha256, designSha256: "d1", codeSha256: "c1", records: 14, total: 82, in20: pass ? 80 : 70, top5: 0, extra: 0, ruleTaken: 0, pass, complete: true, missing: [] });
    const k = { gateSha256: "g1", designSha256: "d1", codeSha256: "c1" };
    expect(gateVerdict([run("1", "g1", true), run("2", "g2", true), run("3", "g1", true)], k).result).toBe("未決");
    expect(gateVerdict([run("1", "g1", false), run("2", "g1", true), run("3", "g1", true)], k).result).toBe("不合格");
    expect(gateVerdict([run("0", "g2", false), run("1", "g1", true), run("2", "g1", true)], k).result).toBe("合格");
    // コミットが変われば、新しいコミットの最初の 2 回で決める
    expect(gateVerdict([run("1", "g1", false), run("2", "g1", false), { ...run("3", "g1", true), codeSha256: "c2" }, { ...run("4", "g1", true), codeSha256: "c2" }], { ...k, codeSha256: "c2" }).result).toBe("合格");
  });
  it("gate の記載が全部そろった回だけを「最初の 2 回」に数える。一部だけを回した回・例外で抜けた記載がある回は記録して報告するが、合否に使わない（C-431＝C-451）", () => {
    const ids = ["g-a", "g-b"];
    // 一部だけ（g-a だけ）を 2 回：記録はするが合否に使わない
    const p1 = recordGate(tmp, [{ id: "g-a", split: "gate", output: out(5, 5) }], { at: "p1", gateSha256: "g1", gateIds: ids, key });
    expect(p1.run).toMatchObject({ records: 1, complete: false, missing: ["g-b"] });
    const p2 = recordGate(tmp, [{ id: "g-a", split: "gate", output: out(5, 5) }], { at: "p2", gateSha256: "g1", gateIds: ids, key });
    expect(p2.lines.find((l) => l.startsWith("- 合否："))).toMatch(/^- 合否：未決/);
    expect(p2.lines).toContain("- この回は合否の組の記載がそろっていないので、合否に使いません（足りない記載：g-b）");
    // 例外で出力のない記載がある回も同じ
    const e1 = recordGate(tmp, [{ id: "g-a", split: "gate", output: out(5, 5) }, { id: "g-b", split: "gate", output: null }], { at: "e1", gateSha256: "g1", gateIds: ids, key });
    expect(e1.run).toMatchObject({ complete: false, missing: ["g-b"] });
    // 全部そろった 1 回だけでは未決。2 回目で決まる（一部だけの回は間に挟まっても数えない）
    const f1 = recordGate(tmp, [{ id: "g-a", split: "gate", output: out(5, 5) }, { id: "g-b", split: "gate", output: out(60, 57) }], { at: "f1", gateSha256: "g1", gateIds: ids, key });
    expect(f1.run).toMatchObject({ complete: true, missing: [] });
    expect(f1.lines.find((l) => l.startsWith("- 合否："))).toMatch(/^- 合否：未決/);
    const f2 = recordGate(tmp, [{ id: "g-a", split: "gate", output: out(5, 5) }, { id: "g-b", split: "gate", output: out(60, 50) }], { at: "f2", gateSha256: "g1", gateIds: ids, key });
    expect(f2.lines.find((l) => l.startsWith("- 合否："))).toMatch(/^- 合否：不合格/);
    expect(readGateRuns(tmp)).toHaveLength(5);
  });
  it("合否の鍵のコードは、取り出し・当て方・評価のコードのファイルの中身の sha256（コミットでない）。未コミットの変更も鍵に入り、関係しないファイルの変更では変わらない（C-453）", () => {
    expect(CODE_PATHS).toEqual(["src/chart", "src/masters", "src/llm", "eval/acts-count.ts", "eval/run-eval.ts", "eval/gate.ts"]);
    mkdirSync(path.join(tmp, "src", "chart"), { recursive: true });
    mkdirSync(path.join(tmp, "src", "server"), { recursive: true });
    writeFileSync(path.join(tmp, "src", "chart", "a.ts"), "export const a = 1;\n");
    writeFileSync(path.join(tmp, "eval", "acts-count.ts"), "export const b = 1;\n");
    writeFileSync(path.join(tmp, "src", "server", "x.ts"), "export const x = 1;\n");
    const s0 = codeSha(tmp);
    expect(s0).toMatch(/^[0-9a-f]{64}$/);
    expect(codeSha(tmp)).toBe(s0);
    writeFileSync(path.join(tmp, "src", "server", "x.ts"), "export const x = 2;\n");
    expect(codeSha(tmp)).toBe(s0);
    writeFileSync(path.join(tmp, "src", "chart", "a.ts"), "export const a = 2;\n");
    const s1 = codeSha(tmp);
    expect(s1).not.toBe(s0);
    writeFileSync(path.join(tmp, "src", "chart", "b.ts"), "export const c = 1;\n");
    expect(codeSha(tmp)).not.toBe(s1);
    // 記録の鍵は中身の指紋
    const r = recordGate(tmp, [{ id: "g", split: "gate", output: out(10, 10) }], { at: "t", gateSha256: "g1", gateIds: ["g"], key: { designSha256: "d1" } });
    expect(r.run!.codeSha256).toBe(codeSha(tmp));
  });
  it("線は gate の記載だけに掛かる（tune だけのときは合否を出さず「合否だけの組がありません」。記録もしない）", () => {
    const r = recordGate(tmp, [{ id: "t", split: "tune", output: out(64, 48) }], { at: "t", gateSha256: "g1", gateIds: ["g"], key });
    expect(r).toEqual({ lines: ["- 合否だけの組がありません（直しに使う組だけを回したので、合否は出しません）"], run: null });
    expect(existsSync(gateRunsPath(tmp))).toBe(false);
  });
});
