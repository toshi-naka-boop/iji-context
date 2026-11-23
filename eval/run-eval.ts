// prompt-eval のハーネス（eval-loop の出力形式に合わせた TypeScript 版。プロジェクトは TypeScript 固定のため Python 雛形は使わない）。
// 本番と同じ関数（askMentor・tidy）を、本番と同じモデル設定（config/models.json）で呼ぶ。判定はすべて決まった規則で行う（LLM-as-judge は使わない）。
// API キーは開発サーバーのプロセスにだけあるので、開発用の入口 /api/eval から呼ぶ。結果は eval/runs/<run-id>/ に書く
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { syncSkills } from "../scripts/sync-skills";
import { period } from "../src/demo/period";
import { evaluate } from "../src/engine";
import { claimForAi, type Sender } from "../src/llm/outbound";
import { facilityOf } from "../src/engine/facility";
import type { ClaimContext } from "../src/engine/types";
import { modelFor } from "../src/mentor/models";
import { leakedTerms, type Situation } from "../src/mentor/output";
import { askMentor } from "../src/mentor/session";
import { tidy } from "../src/mentor/scribe";
import { ensureWorkspace, workspaceSkillNames } from "../src/mentor/workspace";
import { listQueries, validateQuery } from "../src/query/doctor-query";
import { crosscheck, crosscheckSkills, type Chart } from "../src/uke/crosscheck";
import type { UkePatient } from "../src/uke/types";
import type { ChartAct } from "../src/chart/acts";
import { extractFacts, type ChartNote } from "../src/chart/extract";
import { withMasters } from "../src/masters/db";
import { assertGate, countActs, loadExclude, matchSaved, saveActs, wantOf, type ActsCount, type SavedAct } from "./acts-count";
import { recordGate } from "./gate";

type Expect = {
  noLeak?: boolean;
  mustNotMatch?: string[];
  mustMatchAny?: string[];
  mustContain?: string[];
  mustRead?: string[];
  expressionNot?: string[];
  queryCreated?: boolean;
  /** 作った医師確認の選択肢に含まれていること（聞く軸がずれていないか） */
  optionsInclude?: string[];
  /** 本人に選んでもらう照合の不一致として出したもの */
  choiceOffered?: string[];
  /** 医師確認を作らないこと */
  noQuery?: boolean;
  /** メンターが付けた話題（算定／雑談） */
  topic?: "算定" | "雑談" | "愚痴";
  missingTargets?: ("doctor" | "clerk")[];
  noNewNumbers?: boolean;
};
type Case = {
  id: string;
  kind: "mentor" | "doctor" | "scribe" | "acts";
  /** acts：略した書き方の合成カルテ（fixtures/charts/<chart>-abbrev.json）のその日の記載 */
  chart?: string;
  date?: string;
  title: string;
  case?: string;
  remove?: string[];
  replace?: Record<string, string>;
  reveal?: boolean;
  situation?: Situation;
  message?: string;
  input?: string;
  /** 直前まで雑談が続いた回数 */
  smalltalkStreak?: number;
  /** 直前まで愚痴が続いた回数 */
  ventStreak?: number;
  /** acts：直しに使う組（tune）か、合否だけに使う組（gate）か（design.md §16-9。L-189）。線は gate だけに掛ける */
  split?: "tune" | "gate";
  expect: Expect;
};
/** 失敗の種類（eval-loop の失敗カテゴリ） */
type Category = "フォーマット崩れ" | "抽出漏れ" | "解釈違い" | "実行エラー";
type Result = { id: string; title: string; pass: boolean; failures: { check: string; category: Category; detail: string }[]; output: unknown; ms: number };

const BANNED = /教育|学習|学ぶ|教える/;
const MARKDOWN = /\*\*|^#|^\s*[-*]\s/m;
const MONEY = /[0-9０-９,，]+\s*点|円|金額|査定|返戻/;

function loadCase(root: string, c: Case): ClaimContext {
  const k = JSON.parse(readFileSync(path.join(root, "fixtures", "cases", `${c.case}.json`), "utf8"));
  const facility = facilityOf(JSON.parse(readFileSync(path.join(root, "config", "facility.json"), "utf8")), k.facility);
  let lines = k.lines as ClaimContext["lines"];
  if (c.remove) lines = lines.filter((l) => !c.remove!.includes(l.kubun));
  if (c.replace) lines = lines.map((l) => (c.replace![l.kubun] ? { ...l, kubun: c.replace![l.kubun] } : l));
  return { ...k, facility, lines };
}

/** 本番と同じ照合（F4）を、合成の UKE 患者情報とカルテから作る */
function crossOf(root: string, claimId: string) {
  const f = path.join(root, "fixtures", "charts", `${claimId.split("-")[0]}.json`);
  if (!existsSync(f)) return [];
  const chart = JSON.parse(readFileSync(f, "utf8")) as Chart;
  const src = JSON.parse(readFileSync(path.join(root, "fixtures", "uke", "patients.json"), "utf8")) as { patients: Record<string, UkePatient> };
  return crosscheck(src.patients[claimId], chart).map((m) => ({ ruleId: m.ruleId, disease: m.disease, why: m.draft.why, draft: m.draft, sent: false }));
}

const nums = (s: string) => new Set(s.match(/\d+/g) ?? []);

/** 行ったことの候補出しの合格の線（設計の値。design.md §15-7・L-108）：正しいコードが候補の 20 件に入る行為の割合 */
const ACTS_PASS_RATE = 0.8;
/** 1 つの記載の結果。got は取り出し（scripts/replay-acts.ts が LLM なしで再生するのに使う） */
type ActsOutput = ActsCount & { got: SavedAct[] };

/**
 * 略した書き方の合成カルテの記載から、本番と同じ取り出し（LLM）で行ったことを出し、手元でマスターに当てて、合成カルテの正しいコードが候補に入るかを数える。
 * 数え方は 1 対 1（L-163。eval/acts-count.ts）：取り出した行為と with の子は、正解の 1 つにしか使わない。マスターがなければ実行エラー
 */
async function runActs(root: string, c: Case, by: Sender): Promise<ActsOutput> {
  const chart = JSON.parse(readFileSync(path.join(root, "fixtures", "charts", `${c.chart}-abbrev.json`), "utf8")) as { entries: (ChartNote & { date: string; acts: ChartAct[] })[] };
  const e = chart.entries.find((x) => x.date === c.date);
  if (!e) throw new Error(`合成カルテに ${c.date} の記載がない`);
  const note: ChartNote = { s: e.s, o: e.o, a: e.a, p: e.p, rx: e.rx };
  const r = await extractFacts(by, note, modelFor("chartExtract"));
  const got = saveActs(r.acts);
  return withMasters((db) => {
    if (!db) throw new Error("masters.db がない（RESEMEN_MASTER_DIR）");
    // 除く正解（規則・患者の情報で出すもの）は ID で eval/datasets/acts-exclude.json に持つ（design.md §16-9）
    return { ...countActs(matchSaved(db, e.date.slice(0, 7), got), wantOf(e.acts, { chart: c.chart!, date: c.date! }), loadExclude(root)), got };
  });
}

async function runCase(root: string, c: Case, by: Sender): Promise<Result> {
  const started = Date.now();
  const failures: Result["failures"] = [];
  const fail = (check: string, category: Category, detail: string) => failures.push({ check, category, detail });
  const tmp = mkdtempSync(path.join(tmpdir(), "iji-eval-"));
  let output: unknown = null;
  try {
    if (c.kind === "acts") {
      const n = await runActs(root, c, by);
      output = n;
      // 記載ごとの線（L-108）は直しに使う組だけ。合否だけの組は全部の記載を合わせた線（95%）で見る（design.md §16-9）
      if (c.split !== "gate" && n.in20 < n.total * ACTS_PASS_RATE) fail("acts:in20", "抽出漏れ", `正しいコードが候補の 20 件に入った行為 ${n.in20} / ${n.total}`);
      return { id: c.id, title: c.title, pass: failures.length === 0, failures, output, ms: Date.now() - started };
    }
    if (c.kind === "scribe") {
      const r = await tidy(by, c.input!, modelFor("scribe"));
      output = r;
      const e = c.expect;
      for (const w of e.mustNotMatch ?? []) if (r.text.includes(w)) fail(`mustNotMatch:${w}`, "解釈違い", `書かれていない「${w}」を足した`);
      for (const w of e.mustContain ?? []) if (!r.text.includes(w)) fail(`mustContain:${w}`, "抽出漏れ", `書かれていた「${w}」が消えた`);
      for (const t of e.missingTargets ?? []) if (!r.missing.some((m) => m.target === t)) fail(`missing:${t}`, "抽出漏れ", `足りない項目（宛先 ${t}）を挙げていない`);
      if (e.noNewNumbers) {
        const before = nums(c.input!);
        const added = [...nums(r.text)].filter((n) => !before.has(n));
        if (added.length) fail("noNewNumbers", "解釈違い", `下書きにない数字：${added.join("、")}`);
      }
      if (MONEY.test(r.text)) fail("noMoney", "解釈違い", "点数・金額・請求の話が入った");
      if (MARKDOWN.test(r.text)) fail("noMarkdown", "フォーマット崩れ", "マークダウンの記号がある");
      return { id: c.id, title: c.title, pass: failures.length === 0, failures, output, ms: Date.now() - started };
    }

    // メンター（ヒント・解説・医師確認）：知識は写しを使い、作業場所と医師確認の記録も一時フォルダに作る
    const store = { knowledgeDir: path.join(tmp, "knowledge"), skillsDir: path.join(tmp, "skills") };
    cpSync(path.join(root, "knowledge"), store.knowledgeDir, { recursive: true });
    syncSkills(store);
    const queryLog = { dir: path.join(tmp, "query-log") };
    const ctx = loadCase(root, c);
    const engine = evaluate(ctx);
    const r = await askMentor(
      { store, queryLog, askPeerMentor: async () => null, askHuman: async () => ({ queued: "eval" }), crosscheck: () => crossOf(root, ctx.claimId) },
      {
        by,
        clerkId: "eval",
        sessionId: null,
        character: { id: "a", name: "メンター", firstPerson: "僕", tone: "ていねい" },
        level: 1,
        ctx: claimForAi(ctx),
        engine,
        situation: c.kind === "doctor" ? "カルテ不足" : (c.situation ?? "通常"),
        message: c.message!,
        now: () => period.clockStart,
        model: modelFor("mentor", { level: 1, scene: c.kind !== "doctor" && c.reveal ? "explain" : "hint" }),
        workspace: (() => { const cwd = ensureWorkspace(path.join(tmp, "ws"), "eval", store.skillsDir, "# 評価用\n\n- レベル：Lv.1\n", crosscheckSkills()); return { cwd, skills: workspaceSkillNames(cwd) }; })(),
        reveal: c.kind === "doctor" ? false : !!c.reveal,
        smalltalkStreak: c.smalltalkStreak ?? 0,
        ventStreak: c.ventStreak ?? 0,
      },
    );
    const body = r.output.body;
    const queries = existsSync(queryLog.dir) ? listQueries(queryLog) : [];
    output = { body, expression: r.output.expression, topic: r.output.topic, read: r.read, choices: r.choices, cited: r.output.citedKnowledge, queries: queries.map((q) => ({ question: q.question, options: q.options, indicators: q.indicators })), retried: r.stats.length > 1 };
    const e = c.expect;
    if (e.noLeak && leakedTerms(body, engine).length) fail("noLeak", "解釈違い", `答えに触れた：${leakedTerms(body, engine).join("、")}`);
    for (const w of e.mustNotMatch ?? []) if (body.includes(w)) fail(`mustNotMatch:${w}`, "解釈違い", `「${w}」と言った`);
    if (e.mustMatchAny && !e.mustMatchAny.some((w) => body.includes(w))) fail("mustMatchAny", "抽出漏れ", `「${e.mustMatchAny.join("／")}」のどれにも触れていない`);
    for (const id of e.mustRead ?? []) if (!r.read.includes(id)) fail(`mustRead:${id}`, "抽出漏れ", `${id} を読んでいない（読んだもの：${r.read.join("、") || "なし"}）`);
    for (const x of e.expressionNot ?? []) if (r.output.expression === x) fail(`expressionNot:${x}`, "解釈違い", `表情が「${x}」`);
    if (e.queryCreated) {
      const mine = queries.filter((q) => q.createdBy === "mentor");
      if (mine.length === 0) fail("queryCreated", "抽出漏れ", "医師確認を作らなかった");
      for (const q of mine) {
        const errs = validateQuery(q);
        if (errs.length) fail("7要件", "解釈違い", errs.join(" / "));
        for (const o of e.optionsInclude ?? []) if (!q.options.includes(o)) fail(`optionsInclude:${o}`, "解釈違い", `選択肢に「${o}」がない（${q.options.join("／")}）`);
      }
    }
    if (e.topic && r.output.topic !== e.topic) fail("topic", "解釈違い", `話題を「${r.output.topic}」とした`);
    for (const id of e.choiceOffered ?? []) if (!r.choices.some((c) => c.ruleId === id)) fail(`choiceOffered:${id}`, "抽出漏れ", `照合の不一致 ${id} を本人に選んでもらっていない`);
    if (e.noQuery && queries.length > 0) fail("noQuery", "解釈違い", `医師確認を作った（${queries.map((q) => q.question).join(" / ")}）`);
    if (BANNED.test(body)) fail("bannedWords", "解釈違い", "禁止語が入った");
    if (MARKDOWN.test(body)) fail("noMarkdown", "フォーマット崩れ", "マークダウンの記号がある");
  } catch (err) {
    fail("run", "実行エラー", err instanceof Error ? err.message : String(err));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return { id: c.id, title: c.title, pass: failures.length === 0, failures, output, ms: Date.now() - started };
}

/**
 * 全件を回し、eval/runs/<run-id>/ に results.jsonl と summary.md を書く。ids を渡すとその分だけ。
 * by は誰の操作か（開発用の入口 /api/eval からは、ログインした本人。送るのは同梱の合成データと評価セットだけ）
 */
export async function runEval(root: string, opts: { ids?: string[]; runId?: string } = {}, by: Sender): Promise<{ runId: string; passed: number; total: number; summaryPath: string }> {
  const cases = readFileSync(path.join(root, "eval", "datasets", "resemen.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Case)
    .filter((c) => !opts.ids || opts.ids.includes(c.id));
  // 合否だけの組を回すときは、読んだ束の指紋が固定した値と同じことを先に確かめる（違えば回さずに失敗。L-210）
  const gateSha = cases.some((c) => c.kind === "acts" && c.split === "gate") ? assertGate(root) : null;
  const results: Result[] = [];
  for (const c of cases) results.push(await runCase(root, c, by));
  const runsDir = path.join(root, "eval", "runs");
  const prev = existsSync(runsDir) ? readdirSync(runsDir).sort().at(-1) : undefined;
  const prevResults = new Map<string, boolean>();
  if (prev && existsSync(path.join(runsDir, prev, "results.jsonl"))) {
    for (const l of readFileSync(path.join(runsDir, prev, "results.jsonl"), "utf8").split("\n").filter(Boolean)) {
      const r = JSON.parse(l) as Result;
      prevResults.set(r.id, r.pass);
    }
  }
  const runId = opts.runId ?? new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(runsDir, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "results.jsonl"), results.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const passed = results.filter((r) => r.pass).length;
  const cats = new Map<string, number>();
  for (const r of results) for (const f of r.failures) cats.set(f.category, (cats.get(f.category) ?? 0) + 1);
  const regress = results.filter((r) => prevResults.get(r.id) === true && !r.pass).map((r) => r.id);
  // 行ったことの候補出し（design.md §15-7・L-108）：全部の記載を合わせた割合と内訳
  const splitOf = new Map(cases.map((c) => [c.id, c.split]));
  const actsResults = results.filter((r) => r.output && typeof r.output === "object" && "in20" in (r.output as object));
  // 記載ごとの割合（L-108）は直しに使う組だけで足し合わせる。合否だけの組は recordGate が数え、eval/gate-runs.jsonl に 1 行残す（design.md §16-9。C-424）
  const acts = actsResults.filter((r) => splitOf.get(r.id) !== "gate").map((r) => r.output as ActsOutput);
  const gate = actsResults.length > 0 ? recordGate(root, actsResults.map((r) => ({ split: splitOf.get(r.id), output: r.output as ActsOutput })), { at: new Date().toISOString(), gateSha256: gateSha ?? "" }) : null;
  const sum = (k: "total" | "in20" | "top5" | "ref" | "refIn20" | "refTop5" | "name" | "lookup" | "unmatched" | "extra" | "ruleTaken") => acts.reduce((a, x) => a + x[k], 0);
  const pctOf = (a: number, b: number) => (b ? `${Math.round((a / b) * 1000) / 10}%` : "-");
  const pct = (a: number) => pctOf(a, sum("total"));
  const actsLine = Math.ceil(sum("total") * ACTS_PASS_RATE);
  const models = { mentor: modelFor("mentor", { level: 1 }), explain: modelFor("mentor", { level: 1, scene: "explain" }), scribe: modelFor("scribe") };
  const md = [
    `# prompt-eval ${runId}`,
    "",
    `- 正答：${passed} / ${results.length}${prev ? `（前回 ${prev}）` : ""}`,
    `- モデル：メンター ${models.mentor.model}（ヒント ${models.mentor.effort ?? "既定"}・解説 ${models.explain.effort ?? "既定"}）、整文 ${models.scribe.model}`,
    `- 前回パス → 今回失敗：${regress.join("、") || "なし"}`,
    `- 失敗の種類：${[...cats.entries()].map(([k, v]) => `${k} ${v}`).join("、") || "なし"}`,
    ...(acts.length
      ? [
          `- 行ったことの候補出し（略した書き方の合成カルテ ${acts.length} 記載・行為 ${sum("total")}。1 対 1 で数える。L-163）：正しいコードが候補の 20 件に入った ${sum("in20")}/${sum("total")}（${pct(sum("in20"))}。${sum("in20") >= actsLine ? "合格" : "不合格"}：線 ${actsLine}/${sum("total")}＝${ACTS_PASS_RATE * 100}%）、上位 5 件 ${sum("top5")}/${sum("total")}（${pct(sum("top5"))}。報告だけ）`,
          `  - 文章から取り出すべき行為（規則・患者の情報で出す除く正解 ${sum("total") - sum("ref")} 個を除いた ${sum("ref")} 行為。並べて出すだけ）：20 件 ${sum("refIn20")}/${sum("ref")}（${pctOf(sum("refIn20"), sum("ref"))}）、上位 5 件 ${sum("refTop5")}/${sum("ref")}（${pctOf(sum("refTop5"), sum("ref"))}）`,
          `  - 余計な取り出し ${sum("extra")}・規則で出すものを取り出した数 ${sum("ruleTaken")}`,
          `  - 内訳：名前で当たった ${sum("name")}・前に選んだもの 0・lookup の候補 ${sum("lookup")}・探して選んだ 0（評価では探さない）・当てられない ${sum("unmatched")}`,
        ]
      : []),
    ...(gate ? ["- 合否だけの組（design.md §16-9）：", ...gate.lines.map((l) => `  ${l}`)] : []),
    "",
    "| id | 結果 | 内容 | 失敗 |",
    "|---|---|---|---|",
    ...results.map((r) => `| ${r.id} | ${r.pass ? "○" : "×"} | ${r.title} | ${r.failures.map((f) => `${f.category}：${f.detail}`).join("<br>")} |`),
    "",
  ].join("\n");
  writeFileSync(path.join(dir, "summary.md"), md);
  return { runId, passed, total: results.length, summaryPath: path.relative(root, path.join(dir, "summary.md")) };
}
