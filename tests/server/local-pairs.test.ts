// 段 16：背反の組の院内の知識の作る入口（design.md §14-2・§14-5）。G05 の計算し直しは、点検の結果を返す関数に差し替えて確かめる（実データの G05 は routes-local-pairs.test.ts）
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { APP_MIGRATIONS, migrate } from "../../src/db/migrate";
import { applyEvent, listKnowledge, readKnowledge } from "../../src/lifecycle/store";
import { evaluateTriggers } from "../../src/lifecycle/triggers";
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
  const sqlite = new Database(":memory:");
  migrate(sqlite, APP_MIGRATIONS);
  ctx = { sqlite, store: { knowledgeDir: path.join(root, "knowledge"), skillsDir: path.join(root, "skills") } } as unknown as AppContext;
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
  it("takenPolarities（フォームが選ばせない向き）は、作る入口が 409 で断る向きと同じ。保管にしたら外れる。ほかの組は数えない", () => {
    const ops = createLocalPairOps(ctx, clock, check);
    const pair = { a: A, b: B, tani: 1 as const };
    const refused = () => (["allow", "avoid"] as const).filter((p) => thrown(() => ops.createPair(input({ polarity: p, ...(p === "avoid" ? { basis: "その他" } : {}), condition: `${p} を作れるか` })))?.[0] === 409);
    expect(ops.takenPolarities(pair)).toEqual([]);
    const first = ops.createPair(input());
    expect(ops.takenPolarities(pair)).toEqual(["allow"]);
    expect(ops.takenPolarities({ ...pair, tani: 2 })).toEqual([]);
    ops.createPair(input({ polarity: "avoid" }));
    expect(ops.takenPolarities(pair)).toEqual(["allow", "avoid"]);
    expect(refused()).toEqual(["allow", "avoid"]);
    applyEvent(ctx.store, first.id, { type: "VERIFY_REJECT", reason: "テスト" }, T);
    expect(ops.takenPolarities(pair)).toEqual(["avoid"]);
  });
});

describe("USED（design.md §14-3。C-172・X-121）", () => {
  it("同じ請求・同じ知識は 1 日 1 回。使っている avoid の知識は idle で要再検証にならない（使っていない知識はなる）", () => {
    let at = T;
    const clockAt = { now: () => at } as unknown as Clock;
    const ops = createLocalPairOps(ctx, clockAt, check);
    const used = ops.createPair(input({ polarity: "avoid" }));
    const idle = ops.createPair(input({ polarity: "allow" }));
    for (const id of [used.id, idle.id]) applyEvent(ctx.store, id, { type: "VERIFY_APPROVE" }, T);
    at = "2027-03-01T09:00:00+09:00";
    ops.markUsed("U1-1", [used.id]);
    ops.markUsed("U1-1", [used.id]);
    expect((ctx.sqlite.prepare("SELECT count(*) AS n FROM local_used").get() as { n: number }).n).toBe(1);
    expect(readKnowledge(ctx.store, used.id)?.last_used_at).toBe(at);
    // 承認から 180 日を過ぎた会議：使った知識は idle にならず、使っていない知識はなる
    const fired = evaluateTriggers(listKnowledge(ctx.store), "2027-05-01T09:00:00+09:00", { revision: { parity: "even", monthDay: "06-01" }, shiharaiKikin: { parity: "odd", monthDay: "06-01" }, kokuhoren: {} });
    expect(fired.map((f) => [f.knowledgeId, f.event])).toEqual([[idle.id, { type: "TRIGGER", trigger: "idle" }]]);
  });
});
