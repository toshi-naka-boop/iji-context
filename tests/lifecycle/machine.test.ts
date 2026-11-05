import { describe, expect, it } from "vitest";
import { transition } from "../../src/lifecycle/machine";
import { ALL_STATUSES, type KnowledgeStatus, type LifecycleEvent } from "../../src/lifecycle/types";
import { makeMeta } from "./helpers";

const NOW = "2025-07-01T00:00:00+09:00";

const EVENTS: { key: string; event: LifecycleEvent }[] = [
  { key: "VERIFY_APPROVE", event: { type: "VERIFY_APPROVE" } },
  { key: "VERIFY_REJECT", event: { type: "VERIFY_REJECT", reason: "誤り" } },
  { key: "EMPATHY", event: { type: "EMPATHY" } },
  { key: "REEXAM_FILED", event: { type: "REEXAM_FILED" } },
  { key: "REEXAM_RESULT:原審どおり", event: { type: "REEXAM_RESULT", result: "原審どおり" } },
  { key: "REEXAM_RESULT:復活", event: { type: "REEXAM_RESULT", result: "復活" } },
  { key: "TRIGGER:revision", event: { type: "TRIGGER", trigger: "revision" } },
  { key: "TRIGGER:reappointment", event: { type: "TRIGGER", trigger: "reappointment" } },
  { key: "TRIGGER:idle", event: { type: "TRIGGER", trigger: "idle" } },
  { key: "COUNTER_EXAMPLE", event: { type: "COUNTER_EXAMPLE" } },
  { key: "USED", event: { type: "USED" } },
  { key: "RECHECK_PASS:claim", event: { type: "RECHECK_PASS", via: "claim" } },
  { key: "RECHECK_PASS:veteran", event: { type: "RECHECK_PASS", via: "veteran" } },
  { key: "RECHECK_FAIL", event: { type: "RECHECK_FAIL" } },
  { key: "IDLE_EXPIRED", event: { type: "IDLE_EXPIRED" } },
  { key: "DISPOSAL_APPROVE", event: { type: "DISPOSAL_APPROVE", reason: "不要" } },
  { key: "DISPOSAL_REJECT", event: { type: "DISPOSAL_REJECT" } },
];

// §4-2 の全行（「現在|イベント」→ 次の状態）。ここにない組み合わせはすべて例外
const ALLOWED: Record<string, KnowledgeStatus> = {
  "未検証|VERIFY_APPROVE": "承認済み",
  "未検証|VERIFY_REJECT": "保管",
  "未検証|EMPATHY": "未検証",
  "未検証|REEXAM_FILED": "contested",
  "承認済み|REEXAM_FILED": "contested",
  "contested|REEXAM_RESULT:原審どおり": "承認済み",
  "contested|REEXAM_RESULT:復活": "保管",
  "承認済み|TRIGGER:revision": "要再検証",
  "承認済み|TRIGGER:reappointment": "要再検証",
  "承認済み|TRIGGER:idle": "要再検証",
  "承認済み|COUNTER_EXAMPLE": "要再検証",
  "承認済み|USED": "承認済み",
  "要再検証|RECHECK_PASS:claim": "承認済み",
  "要再検証|RECHECK_PASS:veteran": "承認済み",
  "要再検証|RECHECK_FAIL": "停止",
  "要再検証|COUNTER_EXAMPLE": "停止",
  "要再検証|IDLE_EXPIRED": "停止",
  "要再検証|USED": "要再検証",
  "停止|DISPOSAL_APPROVE": "保管",
  "停止|DISPOSAL_REJECT": "承認済み",
};

/** revision は制度層にだけ効くので、その組み合わせだけ制度層の知識で試す */
const metaFor = (status: KnowledgeStatus, key: string) =>
  makeMeta({
    status,
    layer: key === "TRIGGER:revision" ? "制度" : "地域",
    match: key === "TRIGGER:revision" ? { ruleId: "R01" } : { kubunAll: ["C001"], payer: "支払基金", prefecture: "東京都" },
  });

describe("transition: 6 状態 × 全イベント", () => {
  for (const status of ALL_STATUSES) {
    for (const { key, event } of EVENTS) {
      const to = ALLOWED[`${status}|${key}`];
      if (to) {
        it(`${status} + ${key} -> ${to}`, () => {
          const before = metaFor(status, key);
          const r = transition(before, event, NOW);
          expect(r.meta.status).toBe(to);
          if (to !== status) expect(r.meta.status_since).toBe(NOW);
          else expect(r.meta.status_since).toBe(before.status_since);
        });
      } else {
        it(`${status} + ${key} は例外`, () => {
          expect(() => transition(metaFor(status, key), event, NOW)).toThrow();
        });
      }
    }
  }
  it("組み合わせの総数が想定どおり（102 件中 20 件が許可）", () => {
    expect(ALL_STATUSES.length * EVENTS.length).toBe(102);
    expect(Object.keys(ALLOWED).length).toBe(20);
  });
});

describe("付随処理", () => {
  it("入力の meta を書き換えない", () => {
    const before = makeMeta({ status: "未検証" });
    const snapshot = JSON.stringify(before);
    transition(before, { type: "VERIFY_APPROVE" }, NOW);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("状態が変わる遷移は history に追記する", () => {
    const r = transition(makeMeta({ status: "未検証" }), { type: "VERIFY_APPROVE" }, NOW);
    expect(r.meta.history).toEqual([{ at: NOW, from: "未検証", to: "承認済み", event: "VERIFY_APPROVE", actor: "veteran", basis: null }]);
  });

  it("history に根拠（basis）と枝分かれ付きのイベント名を残す（v15）", () => {
    const r = transition(makeMeta({ status: "要再検証" }), { type: "RECHECK_PASS", via: "claim" }, NOW, { submissionIds: ["s1"] });
    expect(r.meta.history.at(-1)).toMatchObject({ event: "RECHECK_PASS{claim}", basis: { submissionIds: ["s1"] } });
  });

  it("EMPATHY は empathy だけ増やし状態を変えない", () => {
    const r = transition(makeMeta({ status: "未検証", empathy: 2 }), { type: "EMPATHY" }, NOW);
    expect(r.meta.empathy).toBe(3);
    expect(r.meta.status).toBe("未検証");
    expect(r.meta.history).toEqual([]);
  });

  it("VERIFY_REJECT と DISPOSAL_APPROVE は reason が必須で retired_reason に残る", () => {
    expect(() => transition(makeMeta({ status: "未検証" }), { type: "VERIFY_REJECT", reason: " " }, NOW)).toThrow();
    expect(() => transition(makeMeta({ status: "停止" }), { type: "DISPOSAL_APPROVE", reason: "" }, NOW)).toThrow();
    expect(transition(makeMeta({ status: "未検証" }), { type: "VERIFY_REJECT", reason: "誤り" }, NOW).meta.retired_reason).toBe("誤り");
    expect(transition(makeMeta({ status: "停止" }), { type: "DISPOSAL_APPROVE", reason: "不要" }, NOW).meta.retired_reason).toBe("不要");
  });

  it("REEXAM_FILED は査定由来の知識だけ", () => {
    const m = makeMeta({ status: "承認済み", source_event: { type: "返戻", ref: "x", at: "2025-01-01T00:00:00+09:00" } });
    expect(() => transition(m, { type: "REEXAM_FILED" }, NOW)).toThrow();
  });

  it("復活は保管にし、地域層の承認済み知識を 1 件生成する effect を返す", () => {
    const r = transition(makeMeta({ status: "contested" }), { type: "REEXAM_RESULT", result: "復活" }, NOW);
    expect(r.effects).toEqual([{ type: "CREATE_REEXAM_ALLOWED", sourceId: "regional/sample" }]);
    const r2 = transition(makeMeta({ status: "contested" }), { type: "REEXAM_RESULT", result: "原審どおり" }, NOW);
    expect(r2.effects).toEqual([]);
  });

  it("層に効かないトリガーは例外（地域に revision、制度に reappointment・idle、ベテラン・院内に revision・reappointment）", () => {
    const t = (layer: "制度" | "地域" | "ベテラン" | "院内", trigger: "revision" | "reappointment" | "idle") =>
      transition(makeMeta({ layer }), { type: "TRIGGER", trigger }, NOW);
    expect(() => t("地域", "revision")).toThrow();
    expect(() => t("制度", "reappointment")).toThrow();
    expect(() => t("制度", "idle")).toThrow();
    expect(() => t("ベテラン", "reappointment")).toThrow();
    expect(() => t("院内", "revision")).toThrow();
    expect(t("ベテラン", "idle").meta.status).toBe("要再検証");
  });

  it("制度層の要再検証は IDLE_EXPIRED で停止しない", () => {
    expect(() => transition(makeMeta({ layer: "制度", status: "要再検証" }), { type: "IDLE_EXPIRED" }, NOW)).toThrow();
  });

  it("IDLE_EXPIRED・COUNTER_EXAMPLE・RECHECK_FAIL による停止で、どれも廃棄提案が出る", () => {
    const a = transition(makeMeta({ status: "要再検証" }), { type: "IDLE_EXPIRED" }, NOW);
    expect(a.meta.status).toBe("停止");
    expect(a.effects).toEqual([{ type: "DISPOSAL_PROPOSAL", knowledgeId: "regional/sample", cause: "IDLE_EXPIRED" }]);
    const b = transition(makeMeta({ status: "要再検証" }), { type: "COUNTER_EXAMPLE" }, NOW);
    expect(b.meta.status).toBe("停止");
    expect(b.meta.misses).toBe(0); // misses は store が数え直す（v8）
    expect(b.effects).toEqual([{ type: "DISPOSAL_PROPOSAL", knowledgeId: "regional/sample", cause: "COUNTER_EXAMPLE" }]);
    const c = transition(makeMeta({ status: "要再検証" }), { type: "RECHECK_FAIL" }, NOW, { itemId: "i1" });
    expect(c.meta.status).toBe("停止");
    expect(c.meta.history.at(-1)).toMatchObject({ event: "RECHECK_FAIL", actor: "veteran", basis: { itemId: "i1" } });
    expect(c.effects).toEqual([{ type: "DISPOSAL_PROPOSAL", knowledgeId: "regional/sample", cause: "RECHECK_FAIL" }]);
  });

  it("USED は last_used_at と last_hit_at だけ、承認済みの COUNTER_EXAMPLE は要再検証にし数は変えない（C-31）", () => {
    const used = transition(makeMeta(), { type: "USED" }, NOW).meta;
    expect([used.hits, used.last_used_at, used.last_hit_at]).toEqual([0, NOW, NOW]);
    const ce = transition(makeMeta(), { type: "COUNTER_EXAMPLE" }, NOW).meta;
    expect([ce.misses, ce.status, ce.last_hit_at]).toEqual([0, "要再検証", null]);
  });

  it("要再検証の USED は再承認しない", () => {
    const r = transition(makeMeta({ status: "要再検証" }), { type: "USED" }, NOW).meta;
    expect([r.status, r.last_hit_at, r.status_since]).toEqual(["要再検証", NOW, "2025-01-01T00:00:00+09:00"]);
  });

  it("DISPOSAL_REJECT で承認済みに戻ると status_since が更新される", () => {
    const r = transition(makeMeta({ status: "停止" }), { type: "DISPOSAL_REJECT" }, NOW).meta;
    expect([r.status, r.status_since]).toEqual(["承認済み", NOW]);
  });
});
