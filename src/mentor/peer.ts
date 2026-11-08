// F6 メンター同士（spec FR-14・FR-15）：新人のメンターが答えられない問いを、ベテランのメンター（別セッション）に渡す。
// ベテランのメンターも解けなければ、ベテラン本人に届ける（本人への問いは本人のメンター経由のみ。CLAUDE.md）。
// 解決した問いは「ベテランの判断」層の知識候補（未検証）になる。状態を決めるのは決定的な F5 で、LLM ではない
import { createKnowledge, type StoreOptions } from "../lifecycle/store";
import type { KnowledgeMeta } from "../lifecycle/types";
import { modelOptions, type ModelChoice } from "./models";
import { runOnce, type RunStats } from "./run";
import { skillGuard } from "./workspace";

export const PEER_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    answerable: { type: "boolean" },
    body: { type: "string" },
    citedKnowledge: { type: "array", items: { type: "string" } },
  },
  required: ["answerable", "body", "citedKnowledge"],
  additionalProperties: false,
} as const;

export type PeerAnswer = { answerable: boolean; body: string; citedKnowledge: string[] };

export function parsePeerAnswer(raw: unknown): PeerAnswer {
  const o = raw as Partial<PeerAnswer> | null;
  if (!o || typeof o.answerable !== "boolean" || typeof o.body !== "string" || !Array.isArray(o.citedKnowledge)) throw new Error("ベテランのメンターの出力の形が違う");
  return { answerable: o.answerable, body: o.body, citedKnowledge: o.citedKnowledge.filter((x): x is string => typeof x === "string") };
}

export const PEER_SYSTEM_PROMPT = [
  "あなたはベテラン医療事務のメンターです。ほかの医療事務のメンターから、算定についての問いが届きます。",
  "スキル（iji- で始まる承認済みの知識）を読み、そこに根拠があるときだけ answerable を true にし、根拠のスキル名を citedKnowledge に入れて答える。",
  "根拠となる知識がない、または判断が分かれるときは answerable を false にする（推測で答えない）。その場合、問いはベテラン本人に届く。",
  "算定の正否はルールエンジン「ユスティ」の判定が正しい。点数・金額で多く取る方向に誘わない。診断・治療の判断をしない。",
  "本文はプレーンテキストで書く（マークダウンの記号を使わない）。",
].join("\n");

/** ベテランのメンター（別セッション）に問う。答えられなければ answerable=false。根拠は実際に読んだスキルに限る */
export async function askVeteranMentor(
  store: StoreOptions,
  question: string,
  sessionId: string | null,
  workspace: { cwd: string; skills: string[] },
  model?: ModelChoice,
): Promise<{ answer: PeerAnswer; sessionId: string; stats: RunStats }> {
  const guard = skillGuard(store);
  const r = await runOnce("veteranMentor", question, {
    systemPrompt: PEER_SYSTEM_PROMPT,
    cwd: workspace.cwd,
    settingSources: ["project"],
    tools: ["Skill"],
    skills: workspace.skills,
    allowedTools: [],
    hooks: guard.hooks,
    outputFormat: { type: "json_schema", schema: PEER_OUTPUT_SCHEMA as unknown as Record<string, unknown> },
    maxTurns: 8,
    ...(sessionId ? { resume: sessionId } : {}),
    ...modelOptions(model),
  });
  const a = parsePeerAnswer(r.structured);
  const cited = a.citedKnowledge.map((x) => guard.reads.find((id) => x === id || x === `iji-${id.replace("/", "-")}`)).filter((x): x is string => !!x);
  // 読んだ知識に根拠がないのに「答えられる」とした場合は、答えられないとして扱う（推測で答えない）
  const answer = { ...a, citedKnowledge: cited, answerable: a.answerable && cited.length > 0 };
  return { answer, sessionId: r.sessionId || (sessionId ?? ""), stats: r.stats };
}

/** 解決した問いを「ベテランの判断」層の知識候補にする（FR-15。生成元＝エスカレーション、未検証） */
export function escalationCandidate(store: StoreOptions, input: { id: string; question: string; answer: string; answeredBy: "veteran_mentor" | "veteran" }, now: string): KnowledgeMeta {
  const summary = input.question.replace(/\s+/g, " ").slice(0, 200);
  return createKnowledge(
    store,
    {
      layer: "ベテラン",
      slug: `esc-${input.id.toLowerCase().replace(/[^a-z0-9-]/g, "")}`,
      summary: `問い：${summary}`,
      body: [`# 問い`, "", input.question, "", `# 答え（${input.answeredBy === "veteran" ? "ベテラン本人" : "ベテランのメンター"}）`, "", input.answer].join("\n"),
      source: { type: "エスカレーション", ref: input.id },
      match: {},
    },
    now,
  );
}
