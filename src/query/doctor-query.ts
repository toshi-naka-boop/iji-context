// 医師確認（F1）と ask_missing（F1/F3 の振り分け）。spec FR-30〜37、EM 19-2（AHIMA/ACDIS 2026 年版の 7 要件）
// 質問の文面はメンター（LLM）が作ってよいが、ここで決まった規則で検証し、通らないものは医師に届けない
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertTime, ms } from "../lifecycle/time";
import type { ClerkTask, ConfirmedDisease, DoctorQuery } from "./types";

export const OTHER = "その他";
export const UNDETERMINABLE = "判定不能";

/** ④ 点数・金額・請求への言及（医師への質問・選択肢・引用に出さない） */
const MONEY = /点数|[0-9０-９,，]+\s*点|円|金額|報酬|算定|請求|査定|返戻|加算/;
/** ② 誘導（答えを示して同意を求める言い回し） */
const LEADING = /ではないでしょうか|ではありませんか|ですよね|でよろしいですか|と考えてよいですか|と診断してよい|にしてください|を追記してください/;

/** 7 要件のうち、決まった規則で確かめられるもの（①②③④）。⑤ は作り手を問わず同じ検証を通すことで満たす */
export function validateQuery(q: Pick<DoctorQuery, "question" | "indicators" | "options">): string[] {
  const errors: string[] = [];
  if (q.indicators.length === 0 || q.indicators.some((i) => i.text.trim() === "" || i.source.trim() === ""))
    errors.push("①臨床指標の引用がない（出典と本文が必要）");
  if (LEADING.test(q.question)) errors.push("②誘導する言い回しがある");
  const clinical = q.options.filter((o) => o !== OTHER && o !== UNDETERMINABLE);
  if (clinical.length < 2) errors.push("②臨床的な選択肢が 2 つ以上ない（1 つだけだと誘導になる）");
  if (new Set(q.options).size !== q.options.length) errors.push("③選択肢が重複している");
  if (!q.options.includes(OTHER) || !q.options.includes(UNDETERMINABLE)) errors.push("③選択肢に「その他」「判定不能」がない");
  const texts = [q.question, ...q.options, ...q.indicators.map((i) => i.text)];
  if (texts.some((t) => MONEY.test(t))) errors.push("④点数・金額・請求に触れている");
  return errors;
}

// ---------------------------------------------------------------------------
// 営業日（FR-34：翌営業日にリマインド、3 営業日で保留）

export type BusinessDays = { closedWeekdays: number[]; holidays: string[] };

const JST = 9 * 3_600_000;
const DAY = 86_400_000;

/** at の後から now まで（含む）に始まった営業日（日本時間 0 時）の数 */
export function businessDaysElapsed(at: string, now: string, cal: BusinessDays): number {
  const from = ms(at);
  const to = ms(now);
  let n = 0;
  // at の翌日 0 時（日本時間）から
  for (let d = Math.floor((from + JST) / DAY) * DAY + DAY; d - JST <= to; d += DAY) {
    const date = new Date(d);
    const iso = date.toISOString().slice(0, 10);
    if (cal.closedWeekdays.includes(date.getUTCDay()) || cal.holidays.includes(iso)) continue;
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// 記録（FR-35：query-log/ に 1 質問 1 ファイル、Markdown と JSON を併記）

export type QueryLog = { dir: string };

function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

function markdown(q: DoctorQuery): string {
  const lines = [
    `# 医師確認 ${q.id}`,
    "",
    `- 請求: ${q.claimId}`,
    `- 確認したいこと: ${q.field}`,
    `- 作成: ${q.createdBy === "mentor" ? "メンター（AI）" : "医療事務"} ${q.createdAt}`,
    `- 状態: ${q.status}`,
    "",
    "## 質問",
    "",
    q.question,
    "",
    "## カルテ等の記載（臨床指標）",
    "",
    ...q.indicators.map((i) => `- ${i.source}: ${i.text}`),
    "",
    "## 選択肢",
    "",
    ...q.options.map((o) => `- [${q.answer?.option === o ? "x" : " "}] ${o}`),
    "",
    "## 記録",
    "",
    `- 回答: ${q.answer ? `${q.answer.option}${q.answer.freeText ? `（${q.answer.freeText}）` : ""} / ${q.answer.answeredBy} / ${q.answer.at}` : "なし"}`,
    `- 承認: ${q.approval ? `${q.approval.approver} / ${q.approval.at}` : "なし"}`,
    `- リマインド: ${q.remindedAt ?? "なし"}`,
    `- 保留: ${q.heldAt ?? "なし"}`,
    "",
  ];
  return lines.join("\n");
}

function save(log: QueryLog, q: DoctorQuery): void {
  mkdirSync(log.dir, { recursive: true });
  writeAtomic(path.join(log.dir, `${q.id}.json`), `${JSON.stringify(q, null, 2)}\n`);
  writeAtomic(path.join(log.dir, `${q.id}.md`), markdown(q));
}

export function readQuery(log: QueryLog, id: string): DoctorQuery {
  const file = path.join(log.dir, `${id}.json`);
  if (!existsSync(file)) throw new Error(`医師確認が見つからない: ${id}`);
  return JSON.parse(readFileSync(file, "utf8")) as DoctorQuery;
}

export function listQueries(log: QueryLog): DoctorQuery[] {
  if (!existsSync(log.dir)) return [];
  return readdirSync(log.dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(log.dir, f), "utf8")) as DoctorQuery);
}

// ---------------------------------------------------------------------------
// 作成・回答・承認

export type QueryDraft = Pick<DoctorQuery, "claimId" | "field" | "why" | "question" | "indicators" | "options" | "createdBy">;

/** 質問を作る。7 要件の検証に落ちたら例外（医師に届けない） */
export function createQuery(log: QueryLog, draft: QueryDraft, now: string): DoctorQuery {
  assertTime(now, "now");
  const errors = validateQuery(draft);
  if (errors.length) throw new Error(`医師確認の要件を満たさない: ${errors.join(" / ")}`);
  const id = `q-${createHash("sha256").update([draft.claimId, draft.field, now].join("\0")).digest("hex").slice(0, 12)}`;
  if (existsSync(path.join(log.dir, `${id}.json`))) throw new Error(`同じ医師確認がすでにある: ${id}`);
  const q: DoctorQuery = { ...draft, id, createdAt: now, status: "未回答", answer: null, approval: null, remindedAt: null, heldAt: null };
  save(log, q);
  return q;
}

/** 医師の回答。選択肢から 1 つ。「その他」は自由記述が必須 */
export function answerQuery(log: QueryLog, id: string, a: { option: string; freeText?: string; answeredBy: string }, now: string): DoctorQuery {
  assertTime(now, "now");
  const q = readQuery(log, id);
  if (q.status !== "未回答" && q.status !== "保留") throw new Error(`回答できない状態: ${q.status}`);
  if (!q.options.includes(a.option)) throw new Error(`選択肢にない回答: ${a.option}`);
  if (a.option === OTHER && !a.freeText?.trim()) throw new Error("「その他」には自由記述が必要");
  const next: DoctorQuery = { ...q, status: "回答済み", answer: { option: a.option, freeText: a.freeText?.trim() || null, answeredBy: a.answeredBy, at: now } };
  save(log, next);
  return next;
}

/**
 * 医師の承認（確認ボタン）。承認者名と日時を残す（FR-33）。
 * 傷病名が確定するのは回答と承認がそろったときだけ（FR-32）。「判定不能」では確定しない
 */
export function approveQuery(log: QueryLog, id: string, approver: string, now: string): { query: DoctorQuery; confirmed: ConfirmedDisease | null } {
  assertTime(now, "now");
  if (!approver.trim()) throw new Error("承認者名が必要");
  const q = readQuery(log, id);
  if (q.status !== "回答済み" || !q.answer) throw new Error(`承認できない状態: ${q.status}`);
  const next: DoctorQuery = { ...q, status: "承認済み", approval: { approver, at: now } };
  save(log, next);
  // 傷病名を確かめる質問（field が "SY:" で始まる）だけが傷病名を確定する。代行入力の確認などは確定しない
  const name = !q.field.startsWith("SY:") || q.answer.option === UNDETERMINABLE ? null : q.answer.option === OTHER ? q.answer.freeText : q.answer.option;
  return { query: next, confirmed: name ? { claimId: q.claimId, queryId: q.id, name, approver, at: now } : null };
}

/** 未回答の質問に、翌営業日のリマインドと 3 営業日での保留を付ける（⑦）。何度呼んでも同じ結果 */
export function tickQueries(log: QueryLog, now: string, cal: BusinessDays): { reminded: string[]; held: string[] } {
  assertTime(now, "now");
  const reminded: string[] = [];
  const held: string[] = [];
  for (const q of listQueries(log)) {
    if (q.status !== "未回答") continue;
    const n = businessDaysElapsed(q.createdAt, now, cal);
    if (n >= 3) {
      save(log, { ...q, status: "保留", heldAt: now, remindedAt: q.remindedAt ?? now });
      held.push(q.id);
    } else if (n >= 1 && q.remindedAt === null) {
      save(log, { ...q, remindedAt: now });
      reminded.push(q.id);
    }
  }
  return { reminded, held };
}

// ---------------------------------------------------------------------------
// ask_missing（FR-36）：宛先が医師なら F1、医療事務なら F3

export type AskMissing =
  | { target: "doctor"; claimId: string; field: string; why: string; question: string; indicators: DoctorQuery["indicators"]; options: string[]; createdBy: DoctorQuery["createdBy"] }
  | { target: "clerk"; claimId: string; field: string; why: string };

export function askMissing(log: QueryLog, req: AskMissing, now: string): { route: "F1"; query: DoctorQuery } | { route: "F3"; task: ClerkTask } {
  assertTime(now, "now");
  if (!req.field.trim() || !req.why.trim()) throw new Error("ask_missing には field と why が必要");
  if (req.target === "doctor") {
    const { target: _t, ...draft } = req;
    return { route: "F1", query: createQuery(log, draft, now) };
  }
  const id = `t-${createHash("sha256").update([req.claimId, req.field, now].join("\0")).digest("hex").slice(0, 12)}`;
  return { route: "F3", task: { id, claimId: req.claimId, field: req.field, why: req.why, createdAt: now } };
}
