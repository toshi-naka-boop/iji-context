// §7 #5：結果の取り込み（記録だけ）とレセメン会議の整理（design.md §4-4、v20）
import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { answerItem, buildDigest, dueMeeting, effectOf } from "../../src/lifecycle/review";
import { applyEvent, createKnowledge } from "../../src/lifecycle/store";
import { harness } from "./review-helpers";

let h: ReturnType<typeof harness>;
beforeEach(() => {
  h = harness();
});
afterEach(() => h.cleanup());

const counts = (id: string) => {
  const m = h.get(id);
  return { status: m.status, hits: m.hits, misses: m.misses };
};
/** 同期先（.claude/skills）に SKILL.md があるか */
const synced = (id: string) => existsSync(path.join(h.deps.store.skillsDir, `iji-${id.replace("/", "-")}`, "SKILL.md"));

describe("変換表", () => {
  const rows: [Parameters<typeof effectOf>, string][] = [
    [["final", "allow", "通過", false], "hit"],
    [["final", "allow", "査定", false], "hit"],
    [["final", "allow", "返戻", true], "miss"],
    [["final", "allow", "査定", true], "miss"],
    [["final", "avoid", "返戻", true], "hit"],
    [["final", "avoid", "査定", true], "hit"],
    [["final", "avoid", "通過", false], "miss"],
    [["final", "avoid", "査定", false], "miss"],
    [["final", "allow", "返戻", false], "none"],
    [["final", "avoid", "返戻", false], "none"],
    [["avoided", "avoid", "通過", false], "none"],
    [["avoided", "avoid", "査定", true], "none"],
    [["ignored", "allow", "通過", false], "none"],
    [["ignored", "allow", "査定", true], "none"],
  ];
  for (const [args, want] of rows) it(`${args.join(" / ")} → ${want}`, () => expect(effectOf(...args)).toBe(want));
});

describe("取り込みと数", () => {
  it("同じ resultId を 2 回取り込んでも hits は 1", () => {
    const k = h.regional("a");
    h.submit("s1", "2025-03-10T00:00:00+09:00");
    h.result("s1", "通過", [], "2025-03-15T00:00:00+09:00", "原審査", "R-1");
    expect(h.result("s1", "通過", [], "2025-03-16T00:00:00+09:00", "原審査", "R-1").duplicate).toBe(true);
    h.review("2025-03-20T00:00:00+09:00");
    expect(counts(k)).toEqual({ status: "承認済み", hits: 1, misses: 0 });
  });

  it("superseded の版の結果は効かない（止めない）", () => {
    const k = h.regional("a");
    h.submit("s1", "2025-03-10T00:00:00+09:00", { claimId: "c" });
    h.submit("s2", "2025-03-11T00:00:00+09:00", { claimId: "c" });
    h.result("s1", "査定", ["C001"], "2025-03-15T00:00:00+09:00");
    h.review("2025-03-20T00:00:00+09:00");
    expect(counts(k)).toEqual({ status: "承認済み", hits: 0, misses: 0 });
  });

  it("kind=資格 は効果なし（止めない）", () => {
    const k = h.regional("a");
    h.submit("s1", "2025-03-10T00:00:00+09:00");
    h.result("s1", "返戻", ["C001"], "2025-03-15T00:00:00+09:00", "資格");
    h.review("2025-03-20T00:00:00+09:00");
    expect(counts(k)).toEqual({ status: "承認済み", hits: 0, misses: 0 });
  });

  it("関係のない査定は通過と同じ、関係のない返戻は効果なし", () => {
    const a = h.regional("a");
    h.submit("s1", "2025-03-10T00:00:00+09:00");
    h.submit("s2", "2025-03-10T00:00:00+09:00");
    h.result("s1", "査定", ["Z999"], "2025-03-15T00:00:00+09:00");
    h.result("s2", "返戻", ["Z999"], "2025-03-15T00:00:00+09:00");
    h.review("2025-03-20T00:00:00+09:00");
    expect(counts(a)).toEqual({ status: "承認済み", hits: 1, misses: 0 });
  });

  it("avoid の知識を助言どおり直した請求で、確定時に USED が出る", () => {
    const k = h.regional("avoid", { polarity: "avoid" });
    h.submit("s1", "2025-03-10T00:00:00+09:00", { kubun: ["C002"], earlier: [["C001", "C002"]] });
    expect(h.get(k).last_used_at).toBe("2025-03-10T00:00:00+09:00");
    expect(h.get(k).status).toBe("承認済み");
  });
});

describe("結果では更新しない（v20）", () => {
  it("(a) 承認済みの知識に外れが届いても承認済みのままで、同期先にも残る。misses は増える", () => {
    const k = h.regional("a");
    const av = h.regional("av", { polarity: "avoid" });
    h.submit("s1", "2025-03-10T00:00:00+09:00");
    h.result("s1", "査定", ["C001"], "2025-03-15T00:00:00+09:00");
    h.submit("s2", "2025-03-10T00:00:00+09:00");
    h.result("s2", "通過", [], "2025-03-15T00:00:00+09:00");
    h.review("2025-03-20T00:00:00+09:00");
    expect(counts(k)).toEqual({ status: "承認済み", hits: 1, misses: 1 });
    expect(counts(av)).toEqual({ status: "承認済み", hits: 1, misses: 1 });
    expect(synced(k)).toBe(true);
    expect(synced(av)).toBe(true);
  });

  it("(b) 要再検証・停止・contested・保管の知識も、結果では状態が変わらない", () => {
    const re = h.regional("re");
    const c = h.regional("c", { source: { type: "査定", ref: "x" } });
    const st = h.regional("st");
    const ar = h.regional("ar");
    h.submit("s1", "2025-03-10T00:00:00+09:00");
    applyEvent(h.deps.store, re, { type: "TRIGGER", trigger: "idle" }, "2025-03-11T00:00:00+09:00");
    applyEvent(h.deps.store, c, { type: "REEXAM_FILED" }, "2025-03-11T00:00:00+09:00");
    applyEvent(h.deps.store, st, { type: "TRIGGER", trigger: "idle" }, "2025-03-11T00:00:00+09:00");
    applyEvent(h.deps.store, st, { type: "IDLE_EXPIRED" }, "2025-03-11T01:00:00+09:00");
    applyEvent(h.deps.store, ar, { type: "TRIGGER", trigger: "idle" }, "2025-03-11T00:00:00+09:00");
    applyEvent(h.deps.store, ar, { type: "IDLE_EXPIRED" }, "2025-03-11T01:00:00+09:00");
    applyEvent(h.deps.store, ar, { type: "DISPOSAL_APPROVE", reason: "使わない" }, "2025-03-11T02:00:00+09:00");
    h.result("s1", "査定", ["C001"], "2025-03-15T00:00:00+09:00");
    h.submit("s2", "2025-03-16T00:00:00+09:00");
    h.result("s2", "通過", [], "2025-03-17T00:00:00+09:00");
    expect(() => h.review("2025-03-20T00:00:00+09:00")).not.toThrow();
    expect([h.get(re).status, h.get(c).status, h.get(st).status, h.get(ar).status]).toEqual(["要再検証", "contested", "停止", "保管"]);
  });

  it("X-55: ruleId を持つベテラン層の知識も、ルールの対象区分で関係を決める", () => {
    const k = createKnowledge(
      h.deps.store,
      { layer: "ベテラン", slug: "fix", summary: "R01 の修正版", body: "本文", source: { type: "エスカレーション", ref: "x" }, match: { ruleId: "R01" } },
      "2025-03-01T00:00:00+09:00",
    ).id;
    applyEvent(h.deps.store, k, { type: "VERIFY_APPROVE" }, "2025-03-01T00:00:00+09:00");
    h.submit("s1", "2025-03-10T00:00:00+09:00", { applied: ["R01"], kubun: ["C001", "C002"] });
    h.result("s1", "査定", ["C002"], "2025-03-15T00:00:00+09:00");
    h.review("2025-03-20T00:00:00+09:00");
    expect(counts(k)).toMatchObject({ hits: 0, misses: 1 });
  });
});

describe("会議の整理", () => {
  it("(h) 同じ now で 2 回回しても、状態・数・まとめは変わらない", () => {
    const k = h.regional("a");
    h.submit("s1", "2025-03-20T00:00:00+09:00");
    h.result("s1", "査定", ["C001"], "2025-03-20T00:00:00+09:00");
    h.review("2025-03-20T00:00:00+09:00");
    const first = { c: counts(k), d: buildDigest(h.deps) };
    h.review("2025-03-20T00:00:00+09:00");
    expect({ c: counts(k), d: buildDigest(h.deps) }).toEqual(first);
    expect(first.c).toEqual({ status: "承認済み", hits: 0, misses: 1 });
    expect(first.d.items.map((i) => i.kind)).toEqual(["miss"]);
  });

  it("(h) トリガーの途中で止めてもう一度回すと、1 回で回したのと同じになる", () => {
    const scenario = (x: ReturnType<typeof harness>) => {
      x.regional("a", {}, "2024-09-01T00:00:00+09:00");
      x.regional("b", {}, "2024-09-01T00:00:00+09:00");
      x.regional("c", { match: { kubunAll: ["C003"], payer: "国保連", prefecture: "東京都" } });
      x.submit("s1", "2025-03-10T00:00:00+09:00", { kubun: ["C003"] });
      x.result("s1", "査定", ["C003"], "2025-03-15T00:00:00+09:00");
    };
    const other = harness();
    try {
      scenario(other);
      other.review("2025-03-20T00:00:00+09:00");
      scenario(h);
      let n = 0;
      expect(() =>
        h.review("2025-03-20T00:00:00+09:00", {
          onStep: (step) => {
            if (step === "trigger" && ++n === 2) throw new Error("停止");
          },
        }),
      ).toThrow("停止");
      h.review("2025-03-20T00:00:00+09:00");
      for (const id of ["regional/a", "regional/b", "regional/c"]) {
        expect(counts(id)).toEqual({ status: other.get(id).status, hits: other.get(id).hits, misses: other.get(id).misses });
      }
      expect(buildDigest(h.deps)).toEqual(buildDigest(other.deps));
      expect(h.get("regional/a").status).toBe("要再検証");
      expect(h.get("regional/c").status).toBe("承認済み");
    } finally {
      other.cleanup();
    }
  });

  it("(i) 180 日近く当たりのない知識に通過が届くと、同じ整理で idle にならない", () => {
    const k = h.regional("a"); // 2025-03-01 から。180 日目は 2025-08-28
    h.submit("s1", "2025-08-20T00:00:00+09:00");
    h.result("s1", "通過", [], "2025-08-25T00:00:00+09:00");
    h.review("2025-08-29T00:00:00+09:00");
    expect(h.get(k).status).toBe("承認済み");
    expect(h.get(k).last_hit_at).toBe("2025-08-25T00:00:00+09:00");
  });

  it("(j) 改定（制度層）・改選（地域層）・idle のトリガーで要再検証になる", () => {
    const sys = h.system("r01");
    const reg = h.regional("shiharai", { match: { kubunAll: ["C001"], payer: "支払基金", prefecture: "東京都" } });
    const idle = h.regional("idle");
    h.review("2025-06-02T00:00:00+09:00");
    expect(h.get(reg).status).toBe("要再検証");
    h.review("2025-09-01T00:00:00+09:00");
    expect(h.get(idle).status).toBe("要再検証");
    h.review("2026-06-02T00:00:00+09:00");
    expect(h.get(sys).status).toBe("要再検証");
  });

  it("(k) 再審査は整理を待たずに動く", () => {
    const k = h.regional("a", { source: { type: "査定", ref: "x" } });
    applyEvent(h.deps.store, k, { type: "REEXAM_FILED" }, "2025-03-05T00:00:00+09:00");
    expect(h.get(k).status).toBe("contested");
    applyEvent(h.deps.store, k, { type: "REEXAM_RESULT", result: "原審どおり" }, "2025-03-21T00:00:00+09:00");
    expect(h.get(k).status).toBe("承認済み");
    const k2 = h.regional("b", { source: { type: "査定", ref: "y" } });
    applyEvent(h.deps.store, k2, { type: "REEXAM_FILED" }, "2025-03-05T00:00:00+09:00");
    applyEvent(h.deps.store, k2, { type: "REEXAM_RESULT", result: "復活" }, "2025-03-21T00:00:00+09:00");
    expect(h.get(k2).status).toBe("保管");
    expect(h.get("regional/b-reexam-allowed").status).toBe("承認済み");
  });
});

describe("(g) 会議の日", () => {
  // 2025-03-15 は土曜
  it("前回の整理の後に、その曜日の日本時間 0 時を過ぎていれば true", () => {
    expect(dueMeeting(null, "2025-03-01T00:00:00+09:00", 6)).toBe(true);
    expect(dueMeeting("2025-03-15T00:00:00+09:00", "2025-03-21T23:59:00+09:00", 6)).toBe(false);
    expect(dueMeeting("2025-03-15T00:00:00+09:00", "2025-03-22T00:00:00+09:00", 6)).toBe(true);
    expect(dueMeeting("2025-03-15T00:00:00+09:00", "2025-03-21T15:00:00Z", 6)).toBe(true); // 日本時間の土曜 0 時
    expect(dueMeeting("2025-03-15T00:00:00+09:00", "2025-03-21T14:59:00Z", 6)).toBe(false);
    expect(dueMeeting("2025-03-14T00:00:00+09:00", "2025-03-15T10:00:00+09:00", 6)).toBe(true);
  });

  it("曜日を変えると結果が変わる。0〜6 以外は例外", () => {
    expect(dueMeeting("2025-03-15T00:00:00+09:00", "2025-03-16T10:00:00+09:00", 0)).toBe(true);
    expect(dueMeeting("2025-03-15T00:00:00+09:00", "2025-03-16T10:00:00+09:00", 6)).toBe(false);
    for (const bad of [-1, 7, 1.5]) expect(() => dueMeeting(null, "2025-03-01T00:00:00+09:00", bad)).toThrow(/0〜6/);
  });
});

describe("(h) 時刻の形式（v16。round-11 C-52）", () => {
  const bad = ["2025-03-10", "2025-03-10T10:00:00", "2025/03/10 10:00", ""];

  it("日付だけ・タイムゾーンなしの時刻は submit・importResult・meetingReview・answerItem で例外", () => {
    h.regional("a");
    for (const at of bad) {
      expect(() => h.submit(`x-${at}`, at)).toThrow(/タイムゾーン付き/);
      expect(() => h.review(at)).toThrow(/タイムゾーン付き/);
    }
    h.submit("s1", "2025-03-05T00:00:00+09:00");
    for (const at of bad) expect(() => h.result("s1", "通過", [], at)).toThrow(/タイムゾーン付き/);
    h.result("s1", "査定", ["C001"], "2025-03-10T00:00:00+09:00");
    h.review("2025-03-12T00:00:00+09:00");
    const item = buildDigest(h.deps).items[0];
    for (const at of bad) expect(() => answerItem(h.deps, { itemId: item.itemId, answer: 1 }, at)).toThrow(/タイムゾーン付き/);
  });

  it("+09:00 と Z で同じ瞬間を表す時刻は同じ整理になる", () => {
    h.regional("a");
    const a = h.review("2025-03-12T00:00:00+09:00");
    const b = h.review("2025-03-11T15:00:00Z");
    expect(b.reviewId).toBe(a.reviewId);
  });
});

// ---------------------------------------------------------------------------
// 改定の版（design.md v22 §4-4 手順 1、§7 #5 (i)〜(n)）。ここから下は v22 で足したテスト
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { APP_MIGRATIONS, migrate } from "../../src/db/migrate";
import { digestItems, reviews } from "../../src/db/schema";
import { period } from "../../src/demo/period";
import { ruleKubun } from "../../src/engine";
import { meetingReview, type ReviewDeps } from "../../src/lifecycle/review";
import { listKnowledge, readBody } from "../../src/lifecycle/store";
import { reviewDepsOf } from "../../src/server/app";
import { FAKE_REVISIONS } from "../engine/fake-revisions";
import { CAL, T0 } from "./review-helpers";

describe("改定の版と会議の整理（v22）", () => {
  /** 版のない診療年月（全面移行の前のデータが残った場合） */
  const OLD = "2000-01";
  /** 版の有無を渡した配線。版のない年月で ruleKubun が呼ばれたら例外にして、呼ばれないことを確かめる */
  const withRevisions = (): ReviewDeps => ({
    ...h.deps,
    hasRevision: (ym) => ym !== OLD,
    ruleKubun: (id, ym) => {
      if (ym === OLD) throw new Error(`診療年月に当たる版がない: ${ym}`);
      return h.deps.ruleKubun(id, ym);
    },
  });
  const skippedOf = (reviewId: string) => JSON.parse(h.deps.db.select().from(reviews).where(eq(reviews.reviewId, reviewId)).get()!.skipped) as string[];
  const itemsOf = (deps: ReviewDeps) => buildDigest(deps).items;
  const AT = "2025-03-10T00:00:00+09:00";

  it("(i) ruleId を持つ知識の「関係あり」は、提出の診療年月の版のルールの kubun で決まる", () => {
    // 作り物の版：F01 の対象区分は 2030 年の版で X1、2031 年の版で X2
    const deps: ReviewDeps = { ...h.deps, ruleKubun: (id, ym) => ruleKubun(id, ym, FAKE_REVISIONS) };
    const k = createKnowledge(h.deps.store, { layer: "制度", slug: "f01", summary: "F01", body: "F01 本文", source: { type: "初期投入", ref: "init" }, match: { ruleId: "F01" } }, T0).id;
    h.submit("a", AT, { yearMonth: "2030-06", applied: ["F01"], kubun: ["X1", "X2"] });
    h.submit("b", AT, { yearMonth: "2031-06", applied: ["F01"], kubun: ["X1", "X2"] });
    // 同じ区分（X1）の査定でも、2030 年の提出では関係あり（外れ）、2031 年の提出では関係なし（当たり）
    h.result("a", "査定", ["X1"], "2025-03-11T00:00:00+09:00");
    h.result("b", "査定", ["X1"], "2025-03-11T00:00:00+09:00");
    meetingReview(deps, "2025-03-15T00:00:00+09:00");
    expect(counts(k)).toMatchObject({ hits: 1, misses: 1 });
    const miss = itemsOf(deps).find((i) => i.kind === "miss" && i.knowledgeId === k)!;
    expect(miss.reason).toMatchObject({ kind: "miss", misses: [{ submissionId: "a", kubun: ["X1"] }], sameApplied: [{ submissionId: "b", yearMonth: "2031-06", result: "査定" }] });
  });

  it("(j) 版のない提出が混ざっていても整理が最後まで回り、その提出は数え直しと議題に入らず、reviews.skipped に id が残る", () => {
    const deps = withRevisions();
    const k = h.regional("a");
    const sys = h.system();
    for (const [id, yearMonth] of [["old", OLD], ["new", "2025-03"], ["wait", "2025-03"], ["old-wait", OLD]] as const)
      h.submit(id, AT, { yearMonth, applied: ["R01"], kubun: ["C001", "C002"] });
    h.submit("old-ig", AT, { yearMonth: OLD, kubun: ["C002"], earlier: [["C001", "C002"]] });
    h.result("old", "査定", ["C001", "C002"], "2025-03-11T00:00:00+09:00");
    h.result("new", "査定", ["C001", "C002"], "2025-03-11T00:00:00+09:00");
    const { reviewId } = meetingReview(deps, "2025-03-15T00:00:00+09:00");
    expect(skippedOf(reviewId)).toEqual(["old", "old-ig", "old-wait"]);
    expect(counts(k)).toMatchObject({ hits: 0, misses: 1 });
    expect(counts(sys)).toMatchObject({ hits: 0, misses: 1 });
    const digest = buildDigest(deps);
    expect(digest.skippedCount).toBe(3);
    const text = JSON.stringify(digest.items);
    for (const id of ["old", "old-ig", "old-wait"]) expect(text).not.toContain(`"${id}"`);
    expect(digest.items.filter((i) => i.kind === "ignored")).toEqual([]);
    for (const id of [k, sys]) {
      const miss = digest.items.find((i) => i.kind === "miss" && i.knowledgeId === id)!;
      expect(miss.reason).toMatchObject({ misses: [{ submissionId: "new" }], sameApplied: [{ submissionId: "wait", result: "結果待ち" }] });
    }
    // もう一度回しても同じ
    meetingReview(deps, "2025-03-15T00:00:00+09:00");
    expect(counts(k)).toMatchObject({ hits: 0, misses: 1 });
    expect(skippedOf(reviewId)).toEqual(["old", "old-ig", "old-wait"]);
  });

  it("(k) hasRevision を渡さない ReviewDeps では、どの年月の提出も整理の対象になる", () => {
    expect(h.deps.hasRevision).toBeUndefined();
    const k = h.regional("a");
    h.submit("old", AT, { yearMonth: OLD });
    h.submit("new", AT);
    h.submit("old-ig", AT, { yearMonth: OLD, kubun: ["C002"], earlier: [["C001", "C002"]] });
    h.result("old", "査定", ["C001"], "2025-03-11T00:00:00+09:00");
    h.result("new", "査定", ["C001"], "2025-03-11T00:00:00+09:00");
    const { reviewId } = h.review("2025-03-15T00:00:00+09:00");
    expect(skippedOf(reviewId)).toEqual([]);
    expect(counts(k)).toMatchObject({ misses: 2 });
    const digest = buildDigest(h.deps);
    expect(digest).not.toHaveProperty("skippedCount");
    expect(digest.items.filter((i) => i.kind === "ignored").map((i) => i.submissionId)).toEqual(["old-ig"]);
    expect((digest.items.find((i) => i.kind === "miss")!.reason as { misses: { submissionId: string }[] }).misses.map((m) => m.submissionId)).toEqual(["new", "old"]);
  });

  it("(l) 版のない提出を指す回答は反映しない：拾い直しでも、その場の回答でも stale。候補を作らず、misses に数えない", () => {
    const k = h.regional("a");
    for (const id of ["ig1", "ig2", "ig3"]) h.submit(id, AT, { yearMonth: OLD, kubun: ["C002"], earlier: [["C001", "C002"]] });
    h.submit("m1", AT, { yearMonth: OLD });
    h.result("m1", "査定", ["C001"], "2025-03-11T00:00:00+09:00");
    // 版の有無を渡さない整理で、版のない提出の項目ができている（移行の前に作られた議題）
    h.review("2025-03-15T00:00:00+09:00");
    const item = (kind: string, submissionId: string | null) => itemsOf(h.deps).find((i) => i.kind === kind && i.submissionId === submissionId)!;
    const [ig1, ig2, ig3, miss] = [item("ignored", "ig1"), item("ignored", "ig2"), item("ignored", "ig3"), item("miss", null)];
    // ig2：移行の前に反映まで済んだ回答 2（applied=true）。外れに数えられている
    expect(answerItem(h.deps, { itemId: ig2.itemId, answer: 2, freeText: "ig2 の記述" }, "2025-03-16T00:00:00+09:00").status).toBe("applied");
    expect(counts(k)).toMatchObject({ misses: 2 });
    // ig1：回答 2 が記録済みで、まだ反映していない（途中まで反映もしていない）
    h.deps.db.update(digestItems).set({ answer: 2, freeText: "ig1 の記述", answeredAt: "2025-03-16T00:00:00+09:00", applied: false }).where(eq(digestItems.itemId, ig1.itemId)).run();

    const deps = withRevisions();
    // その場で届いた回答（answerItem）：ignored の回答 2 も、版のない提出を理由に含む miss の回答 2 も、記録だけ
    expect(answerItem(deps, { itemId: ig3.itemId, answer: 2, freeText: "ig3 の記述" }, "2025-03-17T00:00:00+09:00")).toEqual({ status: "stale" });
    expect(answerItem(deps, { itemId: miss.itemId, answer: 2, freeText: "miss の記述" }, "2025-03-17T00:00:00+09:00")).toEqual({ status: "stale" });
    expect(h.get(k).status).toBe("承認済み");

    const { reviewId } = meetingReview(deps, "2025-03-22T00:00:00+09:00");
    expect(skippedOf(reviewId)).toEqual(["ig1", "ig2", "ig3", "m1"]);
    const row = (itemId: string) => h.deps.db.select().from(digestItems).where(eq(digestItems.itemId, itemId)).get()!;
    for (const i of [ig1, ig3, miss]) expect(row(i.itemId)).toMatchObject({ answer: 2, applied: false, stale: true });
    // 候補は、移行の前に反映した ig2 の 1 件だけ。ig1・ig3・miss の記述は書き足されていない
    const candidates = listKnowledge(h.deps.store).filter((m) => m.relates_to === k);
    expect(candidates.length).toBe(1);
    const body = readBody(h.deps.store, candidates[0].id);
    expect(body).toContain("ig2 の記述");
    for (const s of ["ig1 の記述", "ig3 の記述", "miss の記述"]) expect(body).not.toContain(s);
    // 反映済み（applied=true）の ig2 も、版のない提出の外れ（m1）も misses に数えない。知識は動かない
    expect(counts(k)).toEqual({ status: "承認済み", hits: 0, misses: 0 });
    expect(itemsOf(deps).filter((i) => i.knowledgeId === k)).toEqual([]);
  });

  it("(m) 本番の配線が作る ReviewDeps は hasRevision を持ち、基準月で真、同梱の版のない年月で偽を返す", () => {
    const deps = reviewDepsOf({ db: h.deps.db, store: h.deps.store, calendar: CAL });
    expect(deps.hasRevision).toBeTypeOf("function");
    expect(deps.hasRevision!(period.yearMonth)).toBe(true);
    expect(deps.hasRevision!(OLD)).toBe(false);
    expect(deps.ruleKubun("R01", period.yearMonth).length).toBeGreaterThan(0);
    expect(() => deps.ruleKubun("R01", OLD)).toThrow(/版がない/);
  });

  it("(n) 旧い形の DB（reviews が 2 列）を migrate で開くと skipped の列が足され、整理が最後まで回って記録が残る。新しい DB でも同じ", () => {
    const columns = (db: Database.Database) => (db.prepare("PRAGMA table_info(reviews)").all() as { name: string }[]).map((c) => c.name);
    const old = new Database(":memory:");
    migrate(old, APP_MIGRATIONS.slice(0, 1));
    expect(columns(old)).toEqual(["review_id", "ran_at"]);
    old.prepare("INSERT INTO reviews (review_id, ran_at) VALUES ('review-before', '2025-03-01T00:00:00.000Z')").run();
    migrate(old, APP_MIGRATIONS);
    expect(columns(old)).toEqual(["review_id", "ran_at", "skipped"]);

    h.regional("a");
    const deps: ReviewDeps = { ...h.deps, db: drizzle(old) };
    const { reviewId } = meetingReview(deps, "2025-03-15T00:00:00+09:00");
    expect(old.prepare("SELECT review_id, skipped FROM reviews ORDER BY ran_at").all()).toEqual([
      { review_id: "review-before", skipped: "[]" },
      { review_id: reviewId, skipped: "[]" },
    ]);
    expect(buildDigest(deps).reviewId).toBe(reviewId);
    old.close();

    // 新しく作った DB（テストの土台）でも同じ形になる
    const fresh = h.review("2025-03-15T00:00:00+09:00");
    expect(skippedOf(fresh.reviewId)).toEqual([]);
  });
});
