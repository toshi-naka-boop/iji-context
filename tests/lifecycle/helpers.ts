// lifecycle テスト共通のヘルパー
import type { ClaimContext, ClaimLine, Facts } from "../../src/engine/types";
import type { KnowledgeMeta } from "../../src/lifecycle/types";

export function makeMeta(over: Partial<KnowledgeMeta> = {}): KnowledgeMeta {
  return {
    id: "regional/sample",
    layer: "地域",
    status: "承認済み",
    summary: "サンプル",
    rev: "aaaaaaaaaaaa",
    polarity: "allow",
    matchApprox: false,
    conditionNote: null,
    source_event: { type: "査定", ref: "ref-1", at: "2025-01-01T00:00:00+09:00" },
    relates_to: null,
    valid_from: "2025-01-01T00:00:00+09:00",
    review_by: null,
    hits: 0,
    misses: 0,
    last_hit_at: null,
    last_used_at: null,
    status_since: "2025-01-01T00:00:00+09:00",
    retired_reason: null,
    empathy: 0,
    match: { kubunAll: ["C001"], payer: "支払基金", prefecture: "東京都" },
    history: [],
    ...over,
  };
}

const known = <T>(value: T) => ({ known: true as const, value });

export function makeFacts(over: Partial<Facts> = {}): Facts {
  return {
    age: known(80),
    insurance: known("後期高齢者"),
    burdenRatio: known(0.1),
    careLevel: known(3),
    table7: known(false),
    table8_2: known(false),
    mainDisease: known("高血圧"),
    homeOxygen: known(false),
    deathPlace: known(null),
    visitsComplete: known(true),
    acuteExacerbation: known(false),
    emergencyEligible: known(true),
    ...over,
  };
}

export function makeCtx(over: Partial<ClaimContext> & { kubun?: string[] } = {}): ClaimContext {
  const { kubun, ...rest } = over;
  const lines: ClaimLine[] = (kubun ?? ["C001"]).map((k) => ({ kubun: k, count: 1, dates: ["2025-03-10"] }));
  return {
    claimId: "claim-1",
    yearMonth: "2025-03",
    facility: { zaishishin: true, kyokagata: false, hasBeds: false, prefecture: "東京都", notifications: {} },
    payer: "支払基金",
    prefecture: "東京都",
    facts: makeFacts(),
    events: [],
    lines,
    ...rest,
  };
}
