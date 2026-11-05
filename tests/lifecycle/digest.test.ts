// §7 #11：レセメン会議の議題と回答の反映（design.md §4-4、v20）
import { existsSync } from "node:fs";
import path from "node:path";
import { desc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { digestItems, reviews } from "../../src/db/schema";
import { answerItem, buildDigest, dueMeeting, markNotified, pendingNotifications, submit } from "../../src/lifecycle/review";
import { applyEvent, listKnowledge } from "../../src/lifecycle/store";
import { makeCtx, makeFacts } from "./helpers";
import { harness } from "./review-helpers";

let h: ReturnType<typeof harness>;
beforeEach(() => {
  h = harness();
});
afterEach(() => h.cleanup());

const items = () => buildDigest(h.deps).items;
const itemOf = (kind: string, knowledgeId: string) => items().find((i) => i.kind === kind && i.knowledgeId === knowledgeId);
const candidates = (relatesTo: string) => listKnowledge(h.deps.store).filter((m) => m.relates_to === relatesTo);
const answer = (itemId: string, a: 1 | 2 | 3 | 4, at: string, freeText?: string) =>
  answerItem(h.deps, { itemId, answer: a, freeText }, at);

/** 承認済みの知識をトリガー（idle）で要再検証にし、整理を回す（v20：結果では状態が変わらない） */
function toRecheck(slug: string, at = "2025-03-20T00:00:00+09:00"): string {
  const k = h.regional(slug);
  applyEvent(h.deps.store, k, { type: "TRIGGER", trigger: "idle" }, "2025-03-05T00:00:00+09:00");
  h.review(at);
  expect(h.get(k).status).toBe("要再検証");
  return k;
}

/** C001 を外した提出（allow の知識に ignored が付く） */
function ignoredSubmission(id: string, at: string, claimId = `claim-${id}`) {
  h.submit(id, at, { claimId, kubun: ["C002"], earlier: [["C001", "C002"]] });
}

describe("まとめの中身", () => {
  it("要再検証すべて・閉じていない ignored・停止すべてが入り、それ以外は入らない。点数・金額の欄がなく、選択肢は 4 つ", () => {
    const recheck = toRecheck("re");
    const ok = h.regional("ok");
    const stop = h.regional("stop");
    applyEvent(h.deps.store, stop, { type: "TRIGGER", trigger: "idle" }, "2025-03-21T00:00:00+09:00");
    applyEvent(h.deps.store, stop, { type: "IDLE_EXPIRED" }, "2025-03-22T00:00:00+09:00");
    ignoredSubmission("ig", "2025-03-23T00:00:00+09:00");
    h.review("2025-03-27T00:00:00+09:00");
    const got = items().map((i) => `${i.kind}:${i.knowledgeId}${i.submissionId ? `:${i.submissionId}` : ""}`).sort();
    // ignored は C001 を外した提出に、適用記録の対象（承認済み・要再検証）の allow の知識ごとに 1 件。停止の知識には付かない
    expect(got).toEqual([`disposal:${stop}`, `ignored:${ok}:ig`, `ignored:${recheck}:ig`, `recheck:${recheck}`]);
    const json = JSON.stringify(buildDigest(h.deps));
    expect(json).not.toMatch(/点数|金額|points|amount|price|yen/);
    for (const i of items()) {
      expect(i.choices).toHaveLength(4);
      expect(i.choices.map((c) => c.label)).toContain("その他");
      expect(i.choices.map((c) => c.label)).toContain("判定不能");
    }
  });

  it("区分を外した請求で ignored が 1 件でき、事実の訂正だけではできない", () => {
    const k = h.regional("care", { match: { kubunAll: ["C001"], payer: "国保連", prefecture: "東京都", facts: { careLevelMin: 3 } } });
    ignoredSubmission("ig", "2025-03-10T00:00:00+09:00");
    // 要介護度の訂正だけ（区分は同じ）
    const base = { claimId: "c-fact", payer: "国保連" as const, kubun: ["C001"] };
    submit(h.deps, {
      submissionId: "fact",
      final: { ctx: makeCtx({ ...base, facts: makeFacts({ careLevel: { known: true, value: 2 } }) }), applied: [] },
      earlier: [{ ctx: makeCtx(base), applied: [] }],
      now: "2025-03-10T00:00:00+09:00",
    });
    h.review("2025-03-20T00:00:00+09:00");
    expect(items().filter((i) => i.kind === "ignored").map((i) => [i.knowledgeId, i.submissionId])).toEqual([[k, "ig"]]);
  });
});

describe("ignored の回答", () => {
  const setup = () => {
    const k = h.regional("a");
    ignoredSubmission("ig", "2025-03-10T00:00:00+09:00");
    h.review("2025-03-20T00:00:00+09:00");
    return { k, item: itemOf("ignored", k)! };
  };

  it("回答 1 で USED（取り忘れを返す）、次の週のまとめから消える", () => {
    const { k, item } = setup();
    const out = answer(item.itemId, 1, "2025-03-22T00:00:00+09:00");
    expect(out).toEqual({ status: "applied", notify: { submissionId: "ig", knowledgeId: k, message: "取り忘れだった" } });
    expect(h.get(k).last_used_at).toBe("2025-03-22T00:00:00+09:00");
    h.review("2025-03-27T00:00:00+09:00");
    expect(itemOf("ignored", k)).toBeUndefined();
  });

  it("回答 2 で misses が 1 増え、relates_to 付きの候補ができ、状態は変わらない", () => {
    const { k, item } = setup();
    const out = answer(item.itemId, 2, "2025-03-22T00:00:00+09:00", "訪問診療が月 1 回のときは当てはまらない");
    expect(h.get(k)).toMatchObject({ status: "承認済み", misses: 1 });
    expect(candidates(k)).toHaveLength(1);
    expect(candidates(k)[0]).toMatchObject({ layer: "ベテラン", status: "未検証", source_event: { type: "エスカレーション" } });
    expect(out).toMatchObject({ status: "applied", candidateId: candidates(k)[0].id });
    h.review("2025-03-27T00:00:00+09:00");
    expect(h.get(k).misses).toBe(1);
    expect(itemOf("ignored", k)).toBeUndefined();
  });

  it("回答 3・4 では状態も数も変わらず、閉じる", () => {
    for (const a of [3, 4] as const) {
      const x = harness();
      try {
        const k = x.regional("a");
        x.submit("ig", "2025-03-10T00:00:00+09:00", { kubun: ["C002"], earlier: [["C001", "C002"]] });
        x.review("2025-03-20T00:00:00+09:00");
        const it = buildDigest(x.deps).items.find((i) => i.kind === "ignored")!;
        answerItem(x.deps, { itemId: it.itemId, answer: a }, "2025-03-22T00:00:00+09:00");
        expect(x.get(k)).toMatchObject({ status: "承認済み", hits: 0, misses: 0, last_used_at: null });
        x.review("2025-03-27T00:00:00+09:00");
        expect(buildDigest(x.deps).items.filter((i) => i.kind === "ignored")).toEqual([]);
      } finally {
        x.cleanup();
      }
    }
  });

  it("整理の後に知識の版（rev）が変わってから届いた回答は記録だけで、候補も misses も出ず、次の週のまとめにまた載る", () => {
    const { k, item } = setup();
    h.rewrite(k, (m) => {
      m.conditionNote = "条件を書き足した";
    });
    expect(answer(item.itemId, 2, "2025-03-22T00:00:00+09:00", "x")).toEqual({ status: "stale" });
    expect(candidates(k)).toEqual([]);
    expect(h.get(k).misses).toBe(0);
    h.review("2025-03-27T00:00:00+09:00");
    expect(itemOf("ignored", k)).toBeDefined();
    expect(itemOf("ignored", k)!.itemId).not.toBe(item.itemId);
  });

  it("提出が superseded になると次のまとめから消え、その回答は記録だけ", () => {
    const { k, item } = setup();
    h.submit("ig2", "2025-03-21T00:00:00+09:00", { claimId: "claim-ig", kubun: ["C001", "C002"] });
    expect(answer(item.itemId, 2, "2025-03-22T00:00:00+09:00", "x")).toEqual({ status: "stale" });
    h.review("2025-03-27T00:00:00+09:00");
    expect(itemOf("ignored", k)).toBeUndefined();
  });

  it("同じ項目への 2 回目の回答は無視", () => {
    const { k, item } = setup();
    answer(item.itemId, 3, "2025-03-22T00:00:00+09:00");
    expect(answer(item.itemId, 2, "2025-03-23T00:00:00+09:00", "x")).toEqual({ status: "duplicate" });
    expect(candidates(k)).toEqual([]);
  });

  it("照合に通った回答 2 が同じ知識に 2 回続いても、候補は 1 件だけ（書き足す）", () => {
    const k = h.regional("a");
    ignoredSubmission("ig1", "2025-03-10T00:00:00+09:00");
    ignoredSubmission("ig2", "2025-03-11T00:00:00+09:00");
    h.review("2025-03-20T00:00:00+09:00");
    const [i1, i2] = items().filter((i) => i.kind === "ignored");
    answer(i1.itemId, 2, "2025-03-22T00:00:00+09:00", "条件その 1");
    answer(i2.itemId, 2, "2025-03-22T00:00:00+09:00", "条件その 2");
    expect(candidates(k)).toHaveLength(1);
    expect(h.get(k).misses).toBe(2);
  });
});

describe("recheck の回答", () => {
  it("回答 1 で承認済み", () => {
    const k = toRecheck("a");
    answer(itemOf("recheck", k)!.itemId, 1, "2025-03-22T00:00:00+09:00");
    expect(h.get(k).status).toBe("承認済み");
  });

  it("回答 2 で停止になり、修正版の候補が添えられた disposal が次のまとめに載る", () => {
    const k = toRecheck("a");
    const out = answer(itemOf("recheck", k)!.itemId, 2, "2025-03-22T00:00:00+09:00", "C002 と同時のときだけ");
    expect(h.get(k).status).toBe("停止");
    const cand = candidates(k);
    expect(cand).toHaveLength(1);
    expect(out).toMatchObject({ candidateId: cand[0].id });
    h.review("2025-03-27T00:00:00+09:00");
    expect(itemOf("disposal", k)?.reason).toMatchObject({ event: "RECHECK_FAIL", candidateId: cand[0].id });
  });

  it("回答 3・4 では変わらず、次の週にまた載る", () => {
    const k = toRecheck("a");
    const first = itemOf("recheck", k)!;
    answer(first.itemId, 3, "2025-03-22T00:00:00+09:00", "わからない");
    expect(h.get(k).status).toBe("要再検証");
    h.review("2025-03-27T00:00:00+09:00");
    const next = itemOf("recheck", k);
    expect(next).toBeDefined();
    expect(next!.itemId).not.toBe(first.itemId);
  });

  it("改定日をまたいで届いた回答 1 は記録だけ", () => {
    const k = h.system("r01");
    h.submit("bad", "2026-05-01T00:00:00+09:00", { applied: ["R01"], kubun: ["C001", "C002"] });
    h.result("bad", "査定", ["C002"], "2026-05-10T00:00:00+09:00");
    h.review("2026-05-23T00:00:00+09:00");
    answer(itemOf("miss", k)!.itemId, 2, "2026-05-24T00:00:00+09:00", "x");
    h.review("2026-05-30T00:00:00+09:00");
    expect(h.get(k).status).toBe("要再検証");
    expect(answer(itemOf("recheck", k)!.itemId, 1, "2026-06-02T00:00:00+09:00")).toEqual({ status: "stale" });
    expect(h.get(k).status).toBe("要再検証");
  });

  it("照合に落ちた回答 2 では候補を作らない", () => {
    const k = toRecheck("a");
    const item = itemOf("recheck", k)!;
    applyEvent(h.deps.store, k, { type: "RECHECK_PASS", via: "veteran" }, "2025-03-21T00:00:00+09:00");
    expect(answer(item.itemId, 2, "2025-03-22T00:00:00+09:00", "x")).toEqual({ status: "stale" });
    expect(candidates(k)).toEqual([]);
    expect(h.get(k).status).toBe("承認済み");
  });
});

describe("disposal の回答", () => {
  const toStop = () => {
    const k = toRecheck("a");
    answer(itemOf("recheck", k)!.itemId, 2, "2025-03-22T00:00:00+09:00", "x");
    h.review("2025-03-27T00:00:00+09:00");
    return { k, item: itemOf("disposal", k)! };
  };
  it("回答 1 で保管", () => {
    const { k, item } = toStop();
    answer(item.itemId, 1, "2025-03-28T00:00:00+09:00");
    expect(h.get(k)).toMatchObject({ status: "保管" });
    expect(h.get(k).retired_reason).not.toBe("");
  });
  it("回答 2 で承認済み", () => {
    const { k, item } = toStop();
    answer(item.itemId, 2, "2025-03-28T00:00:00+09:00");
    expect(h.get(k).status).toBe("承認済み");
  });
});

describe("拾い直し（整理の手順 0）", () => {
  /** 回答を記録しただけで反映前に止まった状態を作る */
  const recordOnly = (itemId: string, a: number, freeText: string | null, at: string) =>
    h.deps.db.update(digestItems).set({ answer: a, freeText, answeredAt: at, applied: false }).where(eq(digestItems.itemId, itemId)).run();

  it("回答を記録して反映前に止めても、次の整理で反映される", () => {
    const k = toRecheck("a");
    recordOnly(itemOf("recheck", k)!.itemId, 1, null, "2025-03-22T00:00:00+09:00");
    h.review("2025-03-27T00:00:00+09:00");
    expect(h.get(k).status).toBe("承認済み");
  });

  it("recheck 回答 2 の記録後に止め、同じ週に通過が届いても、次の整理で停止になり承認済みには戻らない", () => {
    const k = toRecheck("a");
    recordOnly(itemOf("recheck", k)!.itemId, 2, "直す", "2025-03-22T00:00:00+09:00");
    h.submit("good", "2025-03-23T00:00:00+09:00");
    h.result("good", "通過", [], "2025-03-25T00:00:00+09:00");
    h.review("2025-03-27T00:00:00+09:00");
    expect(h.get(k).status).toBe("停止");
    expect(candidates(k)).toHaveLength(1);
    expect(itemOf("disposal", k)).toBeDefined();
  });

  it("状態の遷移の後・候補の作成の前で止めても、拾い直しで遷移は 1 回、候補は 1 件", () => {
    const k = toRecheck("a");
    const item = itemOf("recheck", k)!;
    recordOnly(item.itemId, 2, "直す", "2025-03-22T00:00:00+09:00");
    applyEvent(h.deps.store, k, { type: "RECHECK_FAIL" }, "2025-03-22T00:00:00+09:00", { itemId: item.itemId });
    h.review("2025-03-27T00:00:00+09:00");
    expect(h.get(k).history.filter((e) => e.event === "RECHECK_FAIL")).toHaveLength(1);
    expect(candidates(k)).toHaveLength(1);
    const row = h.deps.db.select().from(digestItems).where(eq(digestItems.itemId, item.itemId)).get();
    expect([row?.applied, row?.stale]).toEqual([true, false]);
  });
});

describe("項目 id（round-10 C-49）", () => {
  it("何も変わらない週は、未回答の項目の id が同じ", () => {
    const k = toRecheck("a");
    const first = itemOf("recheck", k)!.itemId;
    h.review("2025-03-27T00:00:00+09:00");
    expect(itemOf("recheck", k)!.itemId).toBe(first);
  });

  it("snapshot が変わった後に古い項目へ届いた回答は記録だけ（stale）", () => {
    const k = toRecheck("a");
    const old = itemOf("recheck", k)!.itemId;
    applyEvent(h.deps.store, k, { type: "RECHECK_PASS", via: "veteran" }, "2025-03-21T00:00:00+09:00");
    applyEvent(h.deps.store, k, { type: "TRIGGER", trigger: "idle" }, "2025-03-22T00:00:00+09:00");
    h.review("2025-03-27T00:00:00+09:00");
    expect(itemOf("recheck", k)!.itemId).not.toBe(old);
    expect(answer(old, 1, "2025-03-28T00:00:00+09:00")).toEqual({ status: "stale" });
    expect(h.get(k).status).toBe("要再検証");
  });
});

describe("反証 round-11 の回帰（実装）", () => {
  it("C-53: 候補の作成途中で残った meta.json のないディレクトリがあっても、拾い直しが進む", async () => {
    const { mkdirSync } = await import("node:fs");
    const path = await import("node:path");
    const k = toRecheck("a");
    const item = itemOf("recheck", k)!;
    h.deps.db.update(digestItems).set({ answer: 2, freeText: "x", answeredAt: "2025-03-22T00:00:00+09:00", applied: false }).where(eq(digestItems.itemId, item.itemId)).run();
    mkdirSync(path.join(h.deps.store.knowledgeDir, "veteran", `fix-${item.itemId.slice(0, 12)}`), { recursive: true });
    h.review("2025-03-27T00:00:00+09:00");
    expect(h.get(k).status).toBe("停止");
    expect(candidates(k)).toHaveLength(1);
  });

  it("X-43: 上限ちょうどの summary の知識でも、修正版の候補が作れる", () => {
    const k = h.regional("long", { summary: "a".repeat(1024) });
    applyEvent(h.deps.store, k, { type: "TRIGGER", trigger: "idle" }, "2025-03-05T00:00:00+09:00");
    h.review("2025-03-20T00:00:00+09:00");
    answer(itemOf("recheck", k)!.itemId, 2, "2025-03-22T00:00:00+09:00", "x");
    expect(candidates(k)[0].summary.length).toBeLessThanOrEqual(1024);
  });

  it("X-45: 拾い直した取り忘れの回答も、未配信の通知として取れる", () => {
    const k = h.regional("a");
    ignoredSubmission("ig", "2025-03-10T00:00:00+09:00");
    h.review("2025-03-20T00:00:00+09:00");
    const item = itemOf("ignored", k)!;
    h.deps.db.update(digestItems).set({ answer: 1, answeredAt: "2025-03-22T00:00:00+09:00", applied: false }).where(eq(digestItems.itemId, item.itemId)).run();
    h.review("2025-03-27T00:00:00+09:00");
    expect(pendingNotifications(h.deps)).toEqual([{ itemId: item.itemId, submissionId: "ig", knowledgeId: k, message: "取り忘れだった" }]);
    markNotified(h.deps, item.itemId, "2025-03-28T00:00:00+09:00");
    expect(pendingNotifications(h.deps)).toEqual([]);
  });

  it("C-54: ignored の回答 2 で候補を作った後に止まり、その間に知識が動いても stale にならず閉じる", () => {
    const k = h.regional("a");
    ignoredSubmission("ig", "2025-03-10T00:00:00+09:00");
    h.review("2025-03-20T00:00:00+09:00");
    const item = itemOf("ignored", k)!;
    answer(item.itemId, 2, "2025-03-22T00:00:00+09:00", "x");
    // applied=true を書く前に止まった状態を作る
    h.deps.db.update(digestItems).set({ applied: false }).where(eq(digestItems.itemId, item.itemId)).run();
    applyEvent(h.deps.store, k, { type: "TRIGGER", trigger: "idle" }, "2025-03-23T00:00:00+09:00");
    h.review("2025-03-27T00:00:00+09:00");
    const row = h.deps.db.select().from(digestItems).where(eq(digestItems.itemId, item.itemId)).get();
    expect([row?.applied, row?.stale]).toEqual([true, false]);
    expect(candidates(k)).toHaveLength(1);
    expect(h.get(k).misses).toBe(1);
  });
});

describe("v20（結果では更新せず、レセメン会議で外れを確認する）", () => {
  const missOf = (k: string) => itemOf("miss", k);

  /** 知識 a を同じように適用した提出を 4 件（外れ・通過・結果待ち・別の版）用意する */
  function setupMiss() {
    const k = h.regional("a");
    h.submit("bad", "2025-03-05T00:00:00+09:00", { yearMonth: "2025-03" });
    h.submit("ok", "2025-03-06T00:00:00+09:00");
    h.submit("wait", "2025-03-07T00:00:00+09:00");
    h.submit("old", "2025-03-08T00:00:00+09:00", { claimId: "c-old" });
    h.submit("new", "2025-03-09T00:00:00+09:00", { claimId: "c-old" }); // old は superseded
    ignoredSubmission("ig", "2025-03-09T00:00:00+09:00");
    h.result("ok", "通過", [], "2025-03-12T00:00:00+09:00");
    h.result("bad", "査定", ["C001"], "2025-03-13T00:00:00+09:00");
    h.review("2025-03-15T00:00:00+09:00");
    return k;
  }

  it("外れの確認に、外れと、同じ知識を適用したほかの提出（今の結果・結果待ち）が出る。状態は変わらない", () => {
    const k = setupMiss();
    expect(h.get(k).status).toBe("承認済み");
    const item = missOf(k)!;
    expect(item.choices.map((c) => c.label)).toEqual(expect.arrayContaining(["その他", "判定不能"]));
    expect(item.reason).toEqual({
      kind: "miss",
      misses: [{ submissionId: "bad", resultId: expect.any(String), kubun: ["C001"] }],
      sameApplied: [
        { submissionId: "new", claimId: "c-old", yearMonth: "2025-03", result: "結果待ち" },
        { submissionId: "ok", claimId: "claim-ok", yearMonth: "2025-03", result: "通過" },
        { submissionId: "wait", claimId: "claim-wait", yearMonth: "2025-03", result: "結果待ち" },
      ],
    });
  });

  it("外れのない週は外れの確認が出ない", () => {
    const k = h.regional("a");
    h.submit("ok", "2025-03-06T00:00:00+09:00");
    h.result("ok", "通過", [], "2025-03-12T00:00:00+09:00");
    h.review("2025-03-15T00:00:00+09:00");
    expect(missOf(k)).toBeUndefined();
  });

  it("回答 1 で状態は変わらず、その外れは次の会議に出ない", () => {
    const k = setupMiss();
    expect(answer(missOf(k)!.itemId, 1, "2025-03-16T00:00:00+09:00")).toEqual({ status: "applied" });
    h.review("2025-03-22T00:00:00+09:00");
    expect(h.get(k).status).toBe("承認済み");
    expect(missOf(k)).toBeUndefined();
  });

  it("回答 2 で要再検証（同期先から消える）、候補ができ、次の会議に recheck が出る", () => {
    const k = setupMiss();
    const dir = path.join(h.deps.store.skillsDir, `iji-${k.replace("/", "-")}`, "SKILL.md");
    expect(existsSync(dir)).toBe(true);
    const out = answer(missOf(k)!.itemId, 2, "2025-03-16T00:00:00+09:00", "条件が足りない");
    expect(h.get(k).status).toBe("要再検証");
    expect(existsSync(dir)).toBe(false);
    expect(candidates(k)).toHaveLength(1);
    expect(out).toMatchObject({ status: "applied", candidateId: candidates(k)[0].id });
    expect(h.get(k).history.at(-1)).toMatchObject({ event: "COUNTER_EXAMPLE", actor: "system", basis: { submissionIds: ["bad"], kubun: ["C001"] } });
    h.review("2025-03-22T00:00:00+09:00");
    expect(itemOf("recheck", k)).toBeDefined();
    expect(missOf(k)).toBeUndefined();
  });

  it("回答 3・4 では状態は変わらず、次の会議にまた出る", () => {
    const k = setupMiss();
    const first = missOf(k)!;
    answer(first.itemId, 3, "2025-03-16T00:00:00+09:00", "様子を見る");
    h.review("2025-03-22T00:00:00+09:00");
    expect(h.get(k).status).toBe("承認済み");
    expect(missOf(k)!.itemId).not.toBe(first.itemId);
  });

  it("回答の記録後・反映前に新しい外れが届いても、拾い直しで回答は反映され、新しい外れだけが次の会議に出る", () => {
    const k = setupMiss();
    const item = missOf(k)!;
    h.deps.db.update(digestItems).set({ answer: 1, answeredAt: "2025-03-16T00:00:00+09:00", applied: false }).where(eq(digestItems.itemId, item.itemId)).run();
    h.result("wait", "返戻", ["C001"], "2025-03-18T00:00:00+09:00");
    h.review("2025-03-22T00:00:00+09:00");
    const row = h.deps.db.select().from(digestItems).where(eq(digestItems.itemId, item.itemId)).get()!;
    expect(row.applied).toBe(true);
    expect((missOf(k)!.reason as { misses: { submissionId: string }[] }).misses.map((m) => m.submissionId)).toEqual(["wait"]);
  });

  it("同じ提出に種類だけ違う結果が届くと、もう一度出る（許容するずれ）", () => {
    const k = setupMiss();
    answer(missOf(k)!.itemId, 1, "2025-03-16T00:00:00+09:00");
    h.result("bad", "査定", ["C001"], "2025-03-18T00:00:00+09:00", "縦覧点検");
    h.review("2025-03-22T00:00:00+09:00");
    expect((missOf(k)!.reason as { misses: { submissionId: string }[] }).misses.map((m) => m.submissionId)).toEqual(["bad"]);
  });

  it("recheck の回答 1 で使用を再開する（承認済みに戻り、同期先に戻る）", () => {
    const k = toRecheck("a");
    const dir = `iji-${k.replace("/", "-")}`;
    expect(existsSync(path.join(h.deps.store.skillsDir, dir, "SKILL.md"))).toBe(false);
    answer(itemOf("recheck", k)!.itemId, 1, "2025-03-22T00:00:00+09:00");
    expect(h.get(k).status).toBe("承認済み");
    expect(existsSync(path.join(h.deps.store.skillsDir, dir, "SKILL.md"))).toBe(true);
  });

  it("C-51：同じ知識の recheck に先に答えても ignored の回答は反映され、逆の順でも同じ結果", () => {
    const results: unknown[] = [];
    for (const order of [["recheck", "ignored"], ["ignored", "recheck"]] as const) {
      const x = harness();
      try {
        const k = x.regional("a");
        x.submit("ig", "2025-03-14T00:00:00+09:00", { kubun: ["C002"], earlier: [["C001", "C002"]] });
        applyEvent(x.deps.store, k, { type: "TRIGGER", trigger: "idle" }, "2025-03-15T00:00:00+09:00");
        x.review("2025-03-20T00:00:00+09:00");
        const its = buildDigest(x.deps).items.filter((i) => i.knowledgeId === k);
        const outs = order.map((kind) =>
          answerItem(x.deps, { itemId: its.find((i) => i.kind === kind)!.itemId, answer: kind === "recheck" ? 1 : 2, freeText: "x" }, "2025-03-22T00:00:00+09:00").status,
        );
        expect(outs).toEqual(["applied", "applied"]);
        const m = x.get(k);
        results.push({ status: m.status, misses: m.misses, candidates: listKnowledge(x.deps.store).filter((c) => c.relates_to === k).length });
      } finally {
        x.cleanup();
      }
    }
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toEqual({ status: "承認済み", misses: 1, candidates: 1 });
  });

  it("保管になった知識の ignored は、回答が記録だけになり、まとめにも載らない", () => {
    const k = h.regional("a");
    ignoredSubmission("ig", "2025-03-10T00:00:00+09:00");
    h.review("2025-03-20T00:00:00+09:00");
    const item = itemOf("ignored", k)!;
    applyEvent(h.deps.store, k, { type: "TRIGGER", trigger: "idle" }, "2025-03-21T00:00:00+09:00");
    applyEvent(h.deps.store, k, { type: "IDLE_EXPIRED" }, "2025-03-21T01:00:00+09:00");
    applyEvent(h.deps.store, k, { type: "DISPOSAL_APPROVE", reason: "使わない" }, "2025-03-21T02:00:00+09:00");
    expect(answer(item.itemId, 2, "2025-03-22T00:00:00+09:00", "x")).toEqual({ status: "stale" });
    expect(candidates(k)).toEqual([]);
    expect(h.get(k).misses).toBe(0);
    h.review("2025-03-27T00:00:00+09:00");
    expect(itemOf("ignored", k)).toBeUndefined();
  });

  it("X-49: matchApprox の知識から作る修正版の候補は、近似の条件と向きを引き継ぐ", () => {
    const k = h.regional("ap", { polarity: "avoid", matchApprox: true, conditionNote: "月 2 回以上の訪問時だけ" });
    applyEvent(h.deps.store, k, { type: "TRIGGER", trigger: "idle" }, "2025-03-15T00:00:00+09:00");
    h.review("2025-03-20T00:00:00+09:00");
    answer(itemOf("recheck", k)!.itemId, 2, "2025-03-22T00:00:00+09:00", "条件が違う");
    expect(candidates(k)[0]).toMatchObject({ polarity: "avoid", matchApprox: true, conditionNote: "月 2 回以上の訪問時だけ" });
  });
});

describe("反証 round-14 の回帰（実装）", () => {
  it("X-56: 議題を作る直前で止まった整理は記録されず、前回の議題が残り、会議の日の判定も止まらない", () => {
    const k = toRecheck("a", "2025-03-10T00:00:00+09:00");
    const before = buildDigest(h.deps);
    expect(before.items.map((i) => i.knowledgeId)).toContain(k);
    expect(() =>
      h.review("2025-04-10T00:00:00+09:00", {
        onStep: (step) => {
          if (step === "digest") throw new Error("停止");
        },
      }),
    ).toThrow("停止");
    expect(buildDigest(h.deps)).toEqual(before);
    const last = h.deps.db.select().from(reviews).orderBy(desc(reviews.ranAt)).limit(1).get()!;
    expect(dueMeeting(last.ranAt, "2025-04-11T00:00:00+09:00", 6)).toBe(true);
    h.review("2025-04-11T00:00:00+09:00");
    expect(buildDigest(h.deps).items.map((i) => i.knowledgeId)).toContain(k);
  });
});

describe("反証 round-15 の回帰（実装）", () => {
  it("X-58: 議題から消えた古い miss への回答 2 は記録だけで、知識は降格しない", () => {
    const k = h.regional("a");
    h.submit("bad", "2025-03-05T00:00:00+09:00");
    h.result("bad", "査定", ["C001"], "2025-03-10T00:00:00+09:00");
    h.review("2025-03-15T00:00:00+09:00");
    const old = itemOf("miss", k)!;
    h.result("bad", "通過", [], "2025-03-18T00:00:00+09:00", "保険者再審査");
    h.review("2025-03-22T00:00:00+09:00");
    expect(itemOf("miss", k)).toBeUndefined();
    expect(answer(old.itemId, 2, "2025-03-23T00:00:00+09:00", "x")).toEqual({ status: "stale" });
    expect(h.get(k).status).toBe("承認済み");
    expect(candidates(k)).toEqual([]);
  });

  it("X-59: meta.json まで書いた一時ディレクトリが残っていても、会議は止まらない", async () => {
    const { cpSync } = await import("node:fs");
    const k = h.regional("a");
    const dir = path.join(h.deps.store.knowledgeDir, "regional", "a");
    cpSync(dir, `${path.join(h.deps.store.knowledgeDir, "veteran", "fix-x")}.tmp-123`, { recursive: true });
    expect(() => h.review("2025-03-15T00:00:00+09:00")).not.toThrow();
    expect(listKnowledge(h.deps.store).map((m) => m.id)).toEqual([k]);
  });
});

describe("v21（同じ会議の miss と recheck は査定側を優先。答えを待つ）", () => {
  /** idle で要再検証にした知識に外れが届き、同じ会議に miss と recheck が並ぶ */
  function both(x: ReturnType<typeof harness>) {
    const k = x.regional("a");
    x.submit("bad", "2025-03-05T00:00:00+09:00");
    applyEvent(x.deps.store, k, { type: "TRIGGER", trigger: "idle" }, "2025-03-06T00:00:00+09:00");
    x.result("bad", "査定", ["C001"], "2025-03-10T00:00:00+09:00");
    x.review("2025-03-15T00:00:00+09:00");
    const its = buildDigest(x.deps).items.filter((i) => i.knowledgeId === k);
    expect(its.map((i) => i.kind).sort()).toEqual(["miss", "recheck"]);
    return { k, miss: its.find((i) => i.kind === "miss")!.itemId, recheck: its.find((i) => i.kind === "recheck")!.itemId };
  }
  const cands = (x: ReturnType<typeof harness>, k: string) => listKnowledge(x.deps.store).filter((m) => m.relates_to === k).length;

  it("miss 2 と recheck 1 は、どちらの順でも停止・候補 1 件で、recheck の答えは記録だけ", () => {
    for (const order of ["miss-first", "recheck-first"] as const) {
      const x = harness();
      try {
        const { k, miss, recheck } = both(x);
        const at = "2025-03-16T00:00:00+09:00";
        if (order === "miss-first") {
          answerItem(x.deps, { itemId: miss, answer: 2, freeText: "x" }, at);
          expect(answerItem(x.deps, { itemId: recheck, answer: 1 }, at)).toEqual({ status: "stale" });
        } else {
          expect(answerItem(x.deps, { itemId: recheck, answer: 1 }, at)).toEqual({ status: "held" });
          answerItem(x.deps, { itemId: miss, answer: 2, freeText: "x" }, at);
        }
        expect(x.get(k).status).toBe("停止");
        expect(cands(x, k)).toBe(1);
        const row = x.deps.db.select().from(digestItems).where(eq(digestItems.itemId, recheck)).get()!;
        expect([row.applied, row.stale]).toEqual([false, true]);
      } finally {
        x.cleanup();
      }
    }
  });

  it("miss 1 と recheck 1 は、どちらの順でも承認済み", () => {
    for (const order of ["miss-first", "recheck-first"] as const) {
      const x = harness();
      try {
        const { k, miss, recheck } = both(x);
        const at = "2025-03-16T00:00:00+09:00";
        if (order === "miss-first") {
          answerItem(x.deps, { itemId: miss, answer: 1 }, at);
          answerItem(x.deps, { itemId: recheck, answer: 1 }, at);
        } else {
          answerItem(x.deps, { itemId: recheck, answer: 1 }, at);
          expect(x.get(k).status).toBe("要再検証");
          answerItem(x.deps, { itemId: miss, answer: 1 }, at);
        }
        expect(x.get(k).status).toBe("承認済み");
      } finally {
        x.cleanup();
      }
    }
  });

  it("miss に答えないまま次の会議になると、miss が waitingRecheck 付きで載り直し、recheck は新しく載らない。その後 miss に答えると recheck も反映される", () => {
    const { k, miss, recheck } = both(h);
    expect(answer(recheck, 1, "2025-03-16T00:00:00+09:00")).toEqual({ status: "held" });
    h.review("2025-03-22T00:00:00+09:00");
    const its = buildDigest(h.deps).items.filter((i) => i.knowledgeId === k);
    expect(its.map((i) => [i.kind, i.itemId, i.waitingRecheck])).toEqual([["miss", miss, true]]);
    answer(miss, 1, "2025-03-23T00:00:00+09:00");
    expect(h.get(k).status).toBe("承認済み");
    const row = h.deps.db.select().from(digestItems).where(eq(digestItems.itemId, recheck)).get()!;
    expect(row.applied).toBe(true);
  });

  it("待っている間に知識の状態が変わると、recheck の答えは記録だけ", () => {
    const { k, miss, recheck } = both(h);
    answer(recheck, 1, "2025-03-16T00:00:00+09:00");
    applyEvent(h.deps.store, k, { type: "IDLE_EXPIRED" }, "2025-03-17T00:00:00+09:00");
    h.review("2025-03-22T00:00:00+09:00");
    const row = h.deps.db.select().from(digestItems).where(eq(digestItems.itemId, recheck)).get()!;
    expect([row.applied, row.stale]).toEqual([false, true]);
    expect(h.get(k).status).toBe("停止");
    expect(answer(miss, 1, "2025-03-23T00:00:00+09:00")).toEqual({ status: "stale" });
  });
});

describe("反証 round-16 の回帰（実装）", () => {
  it("C-62・X-60: 制度層の知識の修正版も、改定日をまたいで届いた recheck の回答 1 は記録だけ", () => {
    const k = h.system("r01");
    h.submit("bad", "2026-05-01T00:00:00+09:00", { applied: ["R01"], kubun: ["C001", "C002"] });
    h.result("bad", "査定", ["C002"], "2026-05-10T00:00:00+09:00");
    h.review("2026-05-16T00:00:00+09:00");
    answer(itemOf("miss", k)!.itemId, 2, "2026-05-17T00:00:00+09:00", "条件が足りない");
    const fix = candidates(k)[0].id;
    applyEvent(h.deps.store, fix, { type: "VERIFY_APPROVE" }, "2026-05-18T00:00:00+09:00");
    applyEvent(h.deps.store, fix, { type: "TRIGGER", trigger: "idle" }, "2026-05-29T00:00:00+09:00");
    h.review("2026-05-30T00:00:00+09:00");
    expect(answer(itemOf("recheck", fix)!.itemId, 1, "2026-06-02T00:00:00+09:00")).toEqual({ status: "stale" });
    expect(h.get(fix).status).toBe("要再検証");
  });

  it("X-62: 最新の会議に載っていない項目への回答は、回答と stale の印が同時に残り、拾い直しでも反映されない", () => {
    const k = h.regional("a");
    h.submit("bad", "2025-03-05T00:00:00+09:00");
    h.result("bad", "査定", ["C001"], "2025-03-10T00:00:00+09:00");
    h.review("2025-03-15T00:00:00+09:00");
    const old = itemOf("miss", k)!;
    h.result("bad", "通過", [], "2025-03-18T00:00:00+09:00", "保険者再審査");
    h.review("2025-03-22T00:00:00+09:00");
    expect(answer(old.itemId, 2, "2025-03-23T00:00:00+09:00", "x")).toEqual({ status: "stale" });
    const row = h.deps.db.select().from(digestItems).where(eq(digestItems.itemId, old.itemId)).get()!;
    expect([row.answer, row.stale, row.applied]).toEqual([2, true, false]);
    h.review("2025-03-29T00:00:00+09:00");
    expect(h.get(k).status).toBe("承認済み");
  });
});

describe("v21 補足（round-16 C-61・X-61）", () => {
  function heldScenario() {
    const k = h.regional("a");
    h.submit("bad", "2025-03-05T00:00:00+09:00", { claimId: "c-bad" });
    applyEvent(h.deps.store, k, { type: "TRIGGER", trigger: "idle" }, "2025-03-06T00:00:00+09:00");
    h.result("bad", "返戻", ["C001"], "2025-03-10T00:00:00+09:00");
    h.review("2025-03-15T00:00:00+09:00");
    const recheck = itemOf("recheck", k)!.itemId;
    expect(answer(recheck, 1, "2025-03-16T00:00:00+09:00")).toEqual({ status: "held" });
    return { k, recheck };
  }

  it("待たせていた miss の提出が superseded になると、次の会議で recheck の答えが反映される", () => {
    const { k, recheck } = heldScenario();
    h.submit("bad2", "2025-03-17T00:00:00+09:00", { claimId: "c-bad" });
    h.review("2025-03-22T00:00:00+09:00");
    expect(h.get(k).status).toBe("承認済み");
    const row = h.deps.db.select().from(digestItems).where(eq(digestItems.itemId, recheck)).get()!;
    expect(row.applied).toBe(true);
  });

  it("待たせていた miss の外れが通過に訂正されても、次の会議で recheck の答えが反映される", () => {
    const { k } = heldScenario();
    h.result("bad", "通過", [], "2025-03-18T00:00:00+09:00", "保険者再審査");
    h.review("2025-03-22T00:00:00+09:00");
    expect(h.get(k).status).toBe("承認済み");
  });

  it("miss が議題に載り続けている間は待ち続ける", () => {
    const { k } = heldScenario();
    h.review("2025-03-22T00:00:00+09:00");
    expect(h.get(k).status).toBe("要再検証");
    expect(itemOf("miss", k)?.waitingRecheck).toBe(true);
  });
});
