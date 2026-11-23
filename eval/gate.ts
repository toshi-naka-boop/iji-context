// 合否の組の回し方（design.md §16-9。round-66 C-424・round-67。L-217）。合否の組を回すたびに、追記だけの記録 eval/gate-runs.jsonl に 1 行残す
// （日時・GATE_SHA256・設計の指紋・取り出しと当て方のコードのコミット・結果の数）。合格は、同じ設計の指紋・同じ GATE_SHA256・同じコミットで回した最初の 2 回が
// 続けて回され（間に別の条件の回がない）、どちらも線を越えたときだけ。3 回目以降は合否に使わず、記録と報告だけにする。判定は決まった規則で、LLM は使わない
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ActsCount } from "./acts-count";

/** 合否の線（設計の値。design.md §16-9）：合否だけの組で、文章から取り出すべき行為のうち 20 件に入った割合 */
export const GATE_PASS_RATE = 0.95;
/** v32 の 74 行為の、実際の AI での結果（段 18d の 2 回。報告に並べるだけで、線にしない） */
export const V32_RESULTS = ["60/74", "62/74"] as const;

/** 記録の 1 行。total・in20・top5 は文章から取り出すべき行為（除く正解を外した数）の側 */
export type GateRun = { at: string; gateSha256: string; designSha256: string; commit: string; records: number; total: number; in20: number; top5: number; extra: number; ruleTaken: number; pass: boolean };
/** 合否を決める条件の組 */
export type GateKey = Pick<GateRun, "gateSha256" | "designSha256" | "commit">;

export const gateRunsPath = (root: string) => path.join(root, "eval", "gate-runs.jsonl");

export function readGateRuns(root: string): GateRun[] {
  const f = gateRunsPath(root);
  return existsSync(f)
    ? readFileSync(f, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as GateRun)
    : [];
}

/** 設計の指紋（設計書の sha256。設計の版が変われば変わる） */
export function designSha(root: string): string {
  const f = path.join(root, "design", "iji-context", "design.md");
  return existsSync(f) ? createHash("sha256").update(readFileSync(f)).digest("hex") : "none";
}

/** 取り出しと当て方のコードのコミット（その場所を最後に変えたコミット。git がなければ unknown） */
export function codeCommit(root: string): string {
  try {
    return execFileSync("git", ["log", "-1", "--format=%H", "--", "src/chart", "src/masters", "src/llm", "eval/acts-count.ts"], { cwd: root, encoding: "utf8" }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

/** 合否だけの組の結果を足し合わせる（文章から取り出すべき行為の側。除く正解を外した数） */
export function sumGate(outputs: ActsCount[]): Pick<GateRun, "records" | "total" | "in20" | "top5" | "extra" | "ruleTaken" | "pass"> {
  const s = (k: "ref" | "refIn20" | "refTop5" | "extra" | "ruleTaken") => outputs.reduce((a, x) => a + x[k], 0);
  const total = s("ref");
  const in20 = s("refIn20");
  return { records: outputs.length, total, in20, top5: s("refTop5"), extra: s("extra"), ruleTaken: s("ruleTaken"), pass: total > 0 && in20 >= total * GATE_PASS_RATE };
}

/** 記録に 1 行足す（追記だけ） */
export function appendGateRun(root: string, run: GateRun): void {
  appendFileSync(gateRunsPath(root), `${JSON.stringify(run)}\n`);
}

const sameKey = (r: GateRun, k: GateKey) => r.gateSha256 === k.gateSha256 && r.designSha256 === k.designSha256 && r.commit === k.commit;

/**
 * 合否：同じ条件の組（設計の指紋・GATE_SHA256・コミット）で回した最初の 2 回だけを見る。2 回に満たなければ未決。
 * 最初の 2 回のあいだに別の条件の回があれば、続けた 2 回ではないので数えない（未決のまま。回し直しはコミットが変わったときだけ）。3 回目以降は使わない
 */
export function gateVerdict(runs: GateRun[], key: GateKey): { result: "合格" | "不合格" | "未決"; text: string; counted: GateRun[] } {
  const idx = runs.flatMap((r, i) => (sameKey(r, key) ? [i] : []));
  if (idx.length < 2) return { result: "未決", text: `同じ条件で回したのは ${idx.length} 回です（最初の 2 回で決めます）`, counted: [] };
  const [a, b] = idx;
  if (b !== a + 1) return { result: "未決", text: "同じ条件の最初の 2 回のあいだに別の条件の回があるので、数えません", counted: [] };
  const counted = [runs[a], runs[b]];
  const later = idx.length - 2;
  const tail = later > 0 ? `。3 回目以降の ${later} 回は合否に使いません` : "";
  return counted.every((r) => r.pass)
    ? { result: "合格", text: `同じ条件で続けた最初の 2 回がどちらも線（${GATE_PASS_RATE * 100}%）を越えました${tail}`, counted }
    : { result: "不合格", text: `同じ条件で続けた最初の 2 回のうち、線（${GATE_PASS_RATE * 100}%）に届かない回があります${tail}`, counted };
}

/**
 * 合否の組を回した結果を記録し、報告の行を返す。gate の記載がなければ記録せず「合否だけの組がありません」。
 * key を渡さなければ、今の設計の指紋とコミットで記録する
 */
export function recordGate(root: string, outputs: { split: string | undefined; output: ActsCount }[], opt: { at: string; gateSha256: string; key?: Omit<GateKey, "gateSha256"> }): { lines: string[]; run: GateRun | null } {
  const gate = outputs.filter((x) => x.split === "gate").map((x) => x.output);
  if (gate.length === 0) return { lines: ["- 合否だけの組がありません（直しに使う組だけを回したので、合否は出しません）"], run: null };
  const key: GateKey = { gateSha256: opt.gateSha256, designSha256: opt.key?.designSha256 ?? designSha(root), commit: opt.key?.commit ?? codeCommit(root) };
  const run: GateRun = { at: opt.at, ...key, ...sumGate(gate) };
  appendGateRun(root, run);
  const runs = readGateRuns(root);
  const v = gateVerdict(runs, key);
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 1000) / 10}%` : "-");
  return {
    run,
    lines: [
      `- 合否だけの組（${run.records} 記載・文章から取り出すべき行為 ${run.total} 件で測った）：20 件に入った ${run.in20}/${run.total}（${pct(run.in20, run.total)}。線 ${GATE_PASS_RATE * 100}%）・上位 5 件 ${run.top5}/${run.total}（${pct(run.top5, run.total)}）`,
      `- 余計な取り出し ${run.extra}・規則で出すものを取り出した数 ${run.ruleTaken}（どちらも線にしない）`,
      `- 合否：${v.result}（${v.text}）。記録の全部の回 ${runs.length}・この条件で回した回 ${runs.filter((r) => sameKey(r, key)).length}`,
      ...runs.map((r, i) => `  - ${i + 1}：${r.at} ${r.in20}/${r.total} ${r.pass ? "越えた" : "届かない"}（束 ${r.gateSha256.slice(0, 12)}・設計 ${r.designSha256.slice(0, 12)}・コミット ${r.commit.slice(0, 12)}）`),
      `- v32 の 74 行為の結果（参考）：${V32_RESULTS.join("・")}`,
      "- 合成カルテは作成手引きの事例文の書き方で、95% を越えても実物のカルテの略し方の証明ではありません",
    ],
  };
}
