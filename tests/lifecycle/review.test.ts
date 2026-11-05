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
