// 段 16：背反の組の院内の知識の作る入口（design.md §14-2・§14-5）。G05 の計算し直しは、点検の結果を返す関数に差し替えて確かめる（実データの G05 は routes-local-pairs.test.ts）
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyEvent, listKnowledge, readKnowledge } from "../../src/lifecycle/store";
import type { CodePair } from "../../src/lifecycle/types";
import { createLocalPairOps, type PairInput } from "../../src/server/app/local-pairs";
import type { AppContext } from "../../src/server/app/context";
import type { Clock } from "../../src/server/app/clock";

const T = "2026-10-10T09:00:00+09:00";
const A = "112007410";
const B = "114001110";
let root: string;
let ctx: AppContext;
let targets: CodePair[];
const clock = { now: () => T } as unknown as Clock;
const check = () => ({ generic: { findings: targets.map((p) => ({ check: "G05", localPair: p })) } });
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "iji-local-pairs-"));
  ctx = { store: { knowledgeDir: path.join(root, "knowledge"), skillsDir: path.join(root, "skills") } } as unknown as AppContext;
  targets = [{ a: A, b: B, tani: 1 }];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const input = (over: Partial<PairInput> = {}): PairInput => ({ claimId: "U1-1", a: A, b: B, tani: 1, polarity: "allow", basis: "審査で通った", condition: "同じ日の別の時間の診療", ...over });
const status = (e: unknown) => (e as { status?: number }).status;
const thrown = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return [status(e), (e as Error).message];
  }
  return null;
};

describe("作る入口（design.md §14-2）", () => {
  it("院内層・未検証・いつも近似で作り、条件の文の先頭に根拠を定型で付ける。avoid＋返戻・査定された は生成元が返戻", () => {
    const ops = createLocalPairOps(ctx, clock, check);
    const m = ops.createPair(input());
    expect([m.layer, m.status, m.polarity, m.matchApprox, m.conditionNote, m.source_event.type, m.match]).toEqual(["院内", "未検証", "allow", true, "根拠：審査で通った。同じ日の別の時間の診療", "手動", { codePair: { a: A, b: B, tani: 1 } }]);
    expect(m.summary).not.toMatch(/点数|金額|円/);
    const r = ops.createPair(input({ polarity: "avoid", basis: "返戻・査定された" }));
    expect([r.source_event.type, r.conditionNote]).toEqual(["返戻", "根拠：返戻・査定された。同じ日の別の時間の診療"]);
  });
  it("G05 を計算し直して対象でない組（tani 違いも）は 400、allow＋返戻は 400、コードの順が逆は 400", () => {
    const ops = createLocalPairOps(ctx, clock, check);
    expect(thrown(() => ops.createPair(input({ tani: 2 })))?.[0]).toBe(400);
    expect(thrown(() => ops.createPair(input({ b: "114000110" })))?.[0]).toBe(400);
    expect(thrown(() => ops.createPair(input({ basis: "返戻・査定された" })))?.[0]).toBe(400);
    expect(thrown(() => ops.createPair(input({ a: B, b: A })))?.[0]).toBe(400);
    expect(thrown(() => ops.createPair(input({ condition: "　" })))?.[0]).toBe(400);
    expect(thrown(() => ops.createPair(input({ condition: "あ".repeat(195) })))?.[0]).toBe(400);
    expect(listKnowledge(ctx.store)).toEqual([]);
  });
  it("同じ codePair・同じ polarity の 2 つ目は作らない（反対の polarity は作れる）。前のものが停止・保管なら作れる", () => {
    const ops = createLocalPairOps(ctx, clock, check);
    const first = ops.createPair(input());
    expect(thrown(() => ops.createPair(input({ condition: "別の文" })))).toEqual([409, expect.stringContaining(first.id)]);
    expect(ops.createPair(input({ polarity: "avoid" })).polarity).toBe("avoid");
    applyEvent(ctx.store, first.id, { type: "VERIFY_REJECT", reason: "テスト" }, T);
    const again = ops.createPair(input());
    expect([again.id, readKnowledge(ctx.store, first.id)?.status]).toEqual([`${first.id}-2`, "保管"]);
  });
});
