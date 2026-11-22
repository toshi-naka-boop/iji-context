// 段 16：背反の組の知識を、レセメン会議の修正版（ベテラン層）で直す（design.md §14-1・§14-5。X-118）。
// 修正版は、回答の向き（polarity）と条件の文（conditionNote）を持つ（元からコピーしない）。承認すると、直した値で G05 に渡る
import { afterEach, describe, expect, it } from "vitest";
import { answerItem, buildDigest } from "../../src/lifecycle/review";
import { appendBody, applyEvent, createKnowledge, listKnowledge, readBody, readKnowledge } from "../../src/lifecycle/store";
import { createLocalPairs } from "../../src/server/app/local-pairs";
import type { AppContext } from "../../src/server/app/context";
import { harness } from "./review-helpers";

const T1 = "2026-10-10T09:00:00+09:00";
const T2 = "2026-10-17T09:00:00+09:00";
const PAIR = { a: "112007410", b: "114001110", tani: 1 as const };
let h: ReturnType<typeof harness>;
afterEach(() => h.cleanup());

/** 承認済みの院内層の allow を作り、この組の返戻で要再検証にして、会議の議題に載せる */
function recheckItem() {
  h = harness();
  const m = createKnowledge(h.deps.store, { layer: "院内", slug: "pair-x", summary: "組", body: "組", source: { type: "手動", ref: "uke:A1" }, polarity: "allow", matchApprox: true, conditionNote: "根拠：審査で通った。元の条件", match: { codePair: PAIR } }, T1);
  applyEvent(h.deps.store, m.id, { type: "VERIFY_APPROVE" }, T1);
  applyEvent(h.deps.store, m.id, { type: "TRIGGER", trigger: "localReturn" }, T1, { trigger: "localReturn", claimId: "U1-1", codePair: PAIR });
  h.review(T2);
  const item = buildDigest(h.deps).items.find((x) => x.knowledgeId === m.id)!;
  return { id: m.id, item };
}

describe("会議の修正版で polarity・conditionNote を直す（X-118）", () => {
  it("議題に組・今の向きと条件、返戻の請求 id と組を出す", () => {
    const { item } = recheckItem();
    expect([item.kind, item.pair, item.reason]).toEqual(["recheck", { codePair: PAIR, polarity: "allow", conditionNote: "根拠：審査で通った。元の条件" }, expect.objectContaining({ trigger: "localReturn", claimId: "U1-1", codePair: PAIR })]);
  });
  it("回答 2 で向きと条件の文がなければ 400（元からコピーしない）。1・3・4 や、組でない知識に付けると 400", () => {
    const { item } = recheckItem();
    const code = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return (e as { status?: number }).status;
      }
      return 200;
    };
    expect(code(() => answerItem(h.deps, { itemId: item.itemId, answer: 2, freeText: "直す" }, T2))).toBe(400);
    expect(code(() => answerItem(h.deps, { itemId: item.itemId, answer: 2, polarity: "avoid", conditionNote: "　" }, T2))).toBe(400);
    expect(code(() => answerItem(h.deps, { itemId: item.itemId, answer: 1, polarity: "avoid", conditionNote: "x" }, T2))).toBe(400);
    expect(buildDigest(h.deps).items.map((x) => x.itemId)).toContain(item.itemId);
  });
  it("回答 2 の修正版（ベテラン層・未検証）は、回答の向きと条件の文を持つ。承認すると、直した値で使われる（元の知識は停止）", () => {
    const { id, item } = recheckItem();
    const out = answerItem(h.deps, { itemId: item.itemId, answer: 2, freeText: "返戻されたので", polarity: "avoid", conditionNote: "根拠：返戻・査定された。直した条件" }, T2);
    expect(out.status).toBe("applied");
    const cand = listKnowledge(h.deps.store).find((m) => m.relates_to === id)!;
    expect([cand.layer, cand.status, cand.polarity, cand.conditionNote, cand.matchApprox, cand.match]).toEqual(["ベテラン", "未検証", "avoid", "根拠：返戻・査定された。直した条件", true, { codePair: PAIR }]);
    expect(readBody(h.deps.store, cand.id)).toContain("返戻されたので");
    // 承認する人が見る要約と本文に、実際に使われる扱いと条件を出す（元の「条件に当たれば…」を引き継がない。round-43 codex #3）
    expect(cand.summary).toBe(`背反の組 ${PAIR.a}・${PAIR.b}（背反関連テーブル（1 日につき））：併せて算定できない（修正の候補）`);
    expect(readBody(h.deps.store, cand.id)).toContain("修正版の扱い：併せて算定できない。条件：根拠：返戻・査定された。直した条件");
    applyEvent(h.deps.store, cand.id, { type: "VERIFY_APPROVE" }, T2);
    const used = createLocalPairs({ store: h.deps.store } as unknown as AppContext, { status: () => ({ level: 5, count: 0, streak: 0 }) }).knowledgeFor(PAIR);
    expect(used.map((k) => [k.id, k.status, k.polarity, k.conditionNote])).toEqual([[id, "停止", "allow", "根拠：審査で通った。元の条件"], [cand.id, "承認済み", "avoid", "根拠：返戻・査定された。直した条件"]]);
  });
  it("未検証の候補に書き足すときも、要約・向き・条件を書き足す値にする（rev は計算し直す）", () => {
    const { id, item } = recheckItem();
    answerItem(h.deps, { itemId: item.itemId, answer: 2, polarity: "avoid", conditionNote: "根拠：その他。一つ目" }, T2);
    const cand = listKnowledge(h.deps.store).find((m) => m.relates_to === id)!;
    const next = appendBody(h.deps.store, cand.id, "二つ目の回答", { polarity: "allow", conditionNote: "根拠：その他。二つ目", summary: "二つ目の要約" });
    expect([next.polarity, next.conditionNote, next.summary, next.rev === cand.rev]).toEqual(["allow", "根拠：その他。二つ目", "二つ目の要約", false]);
  });
});

describe("改定の棚卸の保留を、修正版に引き継ぐ（round-45 codex #1）", () => {
  it("保留のまま、別の理由（返戻）で修正版を作ると、保留が修正版に移り、修正版が承認されたあとの整理で比べられる", () => {
    h = harness();
    const T = "2026-05-01T09:00:00+09:00";
    const m = createKnowledge(h.deps.store, { layer: "院内", slug: "pair-hold", summary: "組", body: "組", source: { type: "手動", ref: "uke:A1" }, polarity: "allow", matchApprox: true, conditionNote: "根拠：審査で通った。元の条件", match: { codePair: PAIR } }, T);
    applyEvent(h.deps.store, m.id, { type: "VERIFY_APPROVE" }, T);
    let ready = false;
    const seen: string[] = [];
    h.deps.localRevision = () => (ready ? ["基本マスターの 114001110 の行（名称）"] : "pending");
    const D = "2026-06-01T00:00:00+09:00";
    h.review("2026-06-06T09:00:00+09:00");
    expect(readKnowledge(h.deps.store, m.id)?.revision_checks).toEqual({ [D]: "pending" });
    // 返戻 → 会議で直す（修正版を作る。元は停止）
    applyEvent(h.deps.store, m.id, { type: "TRIGGER", trigger: "localReturn" }, "2026-06-08T09:00:00+09:00", { trigger: "localReturn", claimId: "U1-1", codePair: PAIR });
    h.review("2026-06-13T09:00:00+09:00");
    const item = buildDigest(h.deps).items.find((x) => x.knowledgeId === m.id && x.kind === "recheck")!;
    answerItem(h.deps, { itemId: item.itemId, answer: 2, polarity: "allow", conditionNote: "根拠：その他。直した条件" }, "2026-06-13T09:00:00+09:00");
    const cand = listKnowledge(h.deps.store).find((x) => x.relates_to === m.id)!;
    expect([readKnowledge(h.deps.store, m.id)?.status, cand.revision_checks]).toEqual(["停止", { [D]: "pending" }]);
    // 修正版を承認（改定の後）→ そろったら比べて要再検証
    applyEvent(h.deps.store, cand.id, { type: "VERIFY_APPROVE" }, "2026-06-14T09:00:00+09:00");
    h.deps.localRevision = (pair, d) => {
      seen.push(d);
      return ready ? ["基本マスターの 114001110 の行（名称）"] : "pending";
    };
    ready = true;
    h.review("2026-06-20T09:00:00+09:00");
    const after = readKnowledge(h.deps.store, cand.id)!;
    expect([seen, after.status, after.history.at(-1)?.event, after.revision_checks]).toEqual([[D], "要再検証", "TRIGGER{localRevision}", { [D]: "changed" }]);
  });
});
