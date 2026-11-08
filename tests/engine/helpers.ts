// テスト用：症例 JSON に施設設定を足して ClaimContext にする
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ClaimContext, ClaimEvent, ClaimLine } from "../../src/engine/types";

const root = join(__dirname, "..", "..");

export function loadCase(name: string): ClaimContext {
  const c = JSON.parse(readFileSync(join(root, "fixtures", "cases", `${name}.json`), "utf8"));
  const facility = JSON.parse(readFileSync(join(root, "config", "facility.json"), "utf8"));
  return { ...c, facility };
}

/** 区分を外す・足す・置き換えるための小道具（フィクスチャは症例から差分で作る） */
export function without(ctx: ClaimContext, ...kubuns: string[]): ClaimContext {
  return { ...ctx, lines: ctx.lines.filter((l) => !kubuns.includes(l.kubun)) };
}

export function withLines(ctx: ClaimContext, ...lines: ClaimLine[]): ClaimContext {
  return { ...ctx, lines: [...ctx.lines, ...lines] };
}

export function withEvents(ctx: ClaimContext, ...events: ClaimEvent[]): ClaimContext {
  return { ...ctx, events: [...ctx.events, ...events] };
}

export function withFact<K extends keyof ClaimContext["facts"]>(ctx: ClaimContext, key: K, value: ClaimContext["facts"][K]): ClaimContext {
  return { ...ctx, facts: { ...ctx.facts, [key]: value } };
}

export function line(kubun: string, count = 1, dates: string[] = ["2025-03-12"]): ClaimLine {
  return { kubun, count, dates };
}
