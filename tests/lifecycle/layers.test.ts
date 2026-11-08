import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultPolarity, initialStatus, isAllowedSource, LAYER_TRIGGERS } from "../../src/lifecycle/layers";
import { applyEvent, createKnowledge, listKnowledge, readKnowledge, type CreateInput, type StoreOptions } from "../../src/lifecycle/store";
import { evaluateTriggers } from "../../src/lifecycle/triggers";
import type { Calendar } from "../../src/lifecycle/calendar";
import type { Layer, SourceType } from "../../src/lifecycle/types";

/** 改選日が来ない設定（idle だけを見る） */
const CAL: Calendar = { revision: { parity: "even", monthDay: "06-01" }, shiharaiKikin: { parity: "odd", monthDay: "06-01" }, kokuhoren: { 東京都: null } };

let root: string;
let opts: StoreOptions;
const NOW = "2025-03-31T00:00:00+09:00";

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "iji-layers-"));
  opts = { knowledgeDir: path.join(root, "knowledge"), skillsDir: path.join(root, "skills") };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const regional = (over: Partial<CreateInput> = {}): CreateInput => ({
  layer: "地域",
  slug: "c001-return",
  summary: "C001 の返戻",
  body: "本文",
  source: { type: "返戻", ref: "ret-1" },
  match: { kubunAll: ["C001"], payer: "支払基金", prefecture: "東京都" },
  ...over,
});

describe("層×生成元（§4-1）", () => {
  const allowed: [SourceType, Layer[]][] = [
    ["初期投入", ["制度"]],
    ["返戻", ["地域", "院内"]],
    ["査定", ["地域"]],
    ["再審査", ["地域"]],
    ["エスカレーション", ["ベテラン"]],
    ["提案", ["院内"]],
    ["手動", ["院内"]],
  ];
  for (const [source, layers] of allowed) {
    for (const layer of ["制度", "地域", "ベテラン", "院内"] as Layer[]) {
      it(`${source} -> ${layer}: ${layers.includes(layer) ? "許可" : "拒否"}`, () => {
        expect(isAllowedSource(layer, source)).toBe(layers.includes(layer));
      });
    }
  }

  it("提案から制度層・ベテラン層を作ろうとすると拒否される", () => {
    expect(() => createKnowledge(opts, { layer: "制度", slug: "x", summary: "s", body: "b", source: { type: "提案", ref: "p" }, match: { ruleId: "R01" } }, NOW)).toThrow();
    expect(() => createKnowledge(opts, { layer: "ベテラン", slug: "x", summary: "s", body: "b", source: { type: "提案", ref: "p" }, match: {} }, NOW)).toThrow();
    expect(listKnowledge(opts)).toEqual([]);
  });

  it("初期状態", () => {
    expect(initialStatus("制度", "初期投入")).toBe("承認済み");
    expect(initialStatus("地域", "返戻")).toBe("未検証");
    expect(initialStatus("院内", "返戻")).toBe("未検証");
    expect(initialStatus("地域", "査定", { reexamFiled: true })).toBe("contested");
    expect(initialStatus("地域", "査定")).toBe("未検証");
    expect(initialStatus("地域", "再審査")).toBe("承認済み");
    expect(initialStatus("ベテラン", "エスカレーション")).toBe("未検証");
    expect(initialStatus("院内", "提案")).toBe("未検証");
    expect(initialStatus("院内", "手動")).toBe("未検証");
  });

  it("polarity の既定", () => {
    expect(defaultPolarity("制度", "初期投入")).toBe("allow");
    expect(defaultPolarity("地域", "返戻")).toBe("avoid");
    expect(defaultPolarity("地域", "査定")).toBe("avoid");
    expect(defaultPolarity("地域", "再審査")).toBe("allow");
    expect(defaultPolarity("ベテラン", "エスカレーション")).toBe("allow");
    expect(defaultPolarity("院内", "返戻")).toBe("avoid");
    expect(defaultPolarity("院内", "手動")).toBe("allow");
  });

  it("層ごとに効くトリガー（FR-66）", () => {
    expect(LAYER_TRIGGERS).toEqual({
      制度: { revision: true, reappointment: false, idle: false },
      地域: { revision: false, reappointment: true, idle: true },
      ベテラン: { revision: false, reappointment: false, idle: true },
      院内: { revision: false, reappointment: false, idle: true },
    });
  });
});

describe("match の必須項目（§3・C-8）", () => {
  it("地域層は payer・prefecture・kubunAll がないと拒否される", () => {
    expect(() => createKnowledge(opts, regional({ match: { kubunAll: ["C001"], prefecture: "東京都" } }), NOW)).toThrow();
    expect(() => createKnowledge(opts, regional({ match: { kubunAll: ["C001"], payer: "支払基金" } }), NOW)).toThrow();
    expect(() => createKnowledge(opts, regional({ match: { payer: "支払基金", prefecture: "東京都" } }), NOW)).toThrow();
    expect(() => createKnowledge(opts, regional({ match: { kubunAll: [], payer: "支払基金", prefecture: "東京都" } }), NOW)).toThrow();
    expect(createKnowledge(opts, regional(), NOW).id).toBe("regional/c001-return");
  });
  it("制度層は ruleId が必須", () => {
    const base: CreateInput = { layer: "制度", slug: "r01", summary: "s", body: "b", source: { type: "初期投入", ref: "i" }, match: {} };
    expect(() => createKnowledge(opts, base, NOW)).toThrow();
    expect(createKnowledge(opts, { ...base, match: { ruleId: "R01" } }, NOW).status).toBe("承認済み");
  });
  it("ベテラン・院内層は match が空でもよい", () => {
    expect(createKnowledge(opts, { layer: "ベテラン", slug: "v1", summary: "s", body: "b", source: { type: "エスカレーション", ref: "e" }, match: {} }, NOW).status).toBe("未検証");
    expect(createKnowledge(opts, { layer: "院内", slug: "l1", summary: "s", body: "b", source: { type: "手動", ref: "m" }, match: {} }, NOW).layer).toBe("院内");
  });
  it("matchApprox の知識は conditionNote がないと拒否される", () => {
    expect(() => createKnowledge(opts, regional({ matchApprox: true }), NOW)).toThrow();
    expect(() => createKnowledge(opts, regional({ matchApprox: true, conditionNote: "  " }), NOW)).toThrow();
    const m = createKnowledge(opts, regional({ matchApprox: true, conditionNote: "訪問が週 3 回超のとき" }), NOW);
    expect([m.matchApprox, m.conditionNote]).toEqual([true, "訪問が週 3 回超のとき"]);
  });
  it("slug は英小文字・数字・ハイフンのみ、Skill 名は 64 文字以内", () => {
    expect(() => createKnowledge(opts, regional({ slug: "Bad_Slug" }), NOW)).toThrow();
    expect(() => createKnowledge(opts, regional({ slug: "a".repeat(60) }), NOW)).toThrow();
  });
  it("同じ id は作り直せない", () => {
    createKnowledge(opts, regional(), NOW);
    expect(() => createKnowledge(opts, regional(), NOW)).toThrow();
  });
});

describe("store", () => {
  it("rev は本文か match を変えると変わる", () => {
    const a = createKnowledge(opts, regional({ slug: "a" }), NOW);
    const b = createKnowledge(opts, regional({ slug: "b", body: "別の本文" }), NOW);
    const c = createKnowledge(opts, regional({ slug: "c", match: { kubunAll: ["C002"], payer: "支払基金", prefecture: "東京都" } }), NOW);
    const d = createKnowledge(opts, regional({ slug: "d" }), NOW);
    expect(new Set([a.rev, b.rev, c.rev]).size).toBe(3);
    expect(a.rev).toBe(d.rev);
    expect(a.rev).toMatch(/^[0-9a-f]{12}$/);
  });

  it("状態が変わる遷移を書き込んだ直後に同期が走る", () => {
    createKnowledge(opts, regional(), NOW);
    const skill = path.join(opts.skillsDir, "iji-regional-c001-return", "SKILL.md");
    expect(existsSync(skill)).toBe(false);
    applyEvent(opts, "regional/c001-return", { type: "VERIFY_APPROVE" }, NOW);
    expect(existsSync(skill)).toBe(true);
    applyEvent(opts, "regional/c001-return", { type: "TRIGGER", trigger: "reappointment" }, "2025-06-01T00:00:00+09:00");
    expect(existsSync(skill)).toBe(false);
    expect(readKnowledge(opts, "regional/c001-return")?.status).toBe("要再検証");
  });

  it("不正な遷移は meta.json を書き換えない", () => {
    createKnowledge(opts, regional(), NOW);
    expect(() => applyEvent(opts, "regional/c001-return", { type: "RECHECK_PASS", via: "claim" }, NOW)).toThrow();
    expect(readKnowledge(opts, "regional/c001-return")?.status).toBe("未検証");
  });

  it("再審査で復活すると保管になり、地域層の承認済み知識が別に作られて同期される", () => {
    createKnowledge(opts, regional({ slug: "assessed", source: { type: "査定", ref: "a-1" }, reexamFiled: true }), NOW);
    expect(readKnowledge(opts, "regional/assessed")?.status).toBe("contested");
    applyEvent(opts, "regional/assessed", { type: "REEXAM_RESULT", result: "復活" }, "2025-05-01T00:00:00+09:00");
    expect(readKnowledge(opts, "regional/assessed")?.status).toBe("保管");
    const created = readKnowledge(opts, "regional/assessed-reexam-allowed");
    expect(created?.status).toBe("承認済み");
    expect(created?.source_event.type).toBe("再審査");
    expect(created?.polarity).toBe("allow");
    expect(existsSync(path.join(opts.skillsDir, "iji-regional-assessed-reexam-allowed", "SKILL.md"))).toBe(true);
    expect(readFileSync(path.join(opts.knowledgeDir, "regional", "assessed-reexam-allowed", "meta.json"), "utf8")).toContain("再審査");
  });
});

describe("反証 round-11 の回帰（store）", () => {
  it("X-44: 長い slug の査定知識が復活しても、地域層の承認済み知識が作られる。作成に失敗したら保管にしない", () => {
    const slug = "a".repeat(40);
    createKnowledge(opts, regional({ slug, source: { type: "査定", ref: "a-1" }, reexamFiled: true }), NOW);
    applyEvent(opts, `regional/${slug}`, { type: "REEXAM_RESULT", result: "復活" }, "2025-05-01T00:00:00+09:00");
    expect(readKnowledge(opts, `regional/${slug}`)?.status).toBe("保管");
    const derived = listKnowledge(opts).filter((m) => m.relates_to === `regional/${slug}`);
    expect(derived.map((m) => m.status)).toEqual(["承認済み"]);
  });
});

describe("§7 #6：USED と idle（round-5 C-23・round-6 C-32）", () => {
  it("store 経由で USED を受け続けた知識は、結果の取り込みがなくても idle の要再検証にならない", () => {
    // 国保連（東京都）は改選日が未設定なので、② は発火しない
    createKnowledge(opts, regional({ slug: "used", match: { kubunAll: ["C001"], payer: "国保連", prefecture: "東京都" } }), NOW);
    applyEvent(opts, "regional/used", { type: "VERIFY_APPROVE" }, "2025-03-31T00:00:00+09:00");
    for (const at of ["2025-07-01T00:00:00+09:00", "2025-11-01T00:00:00+09:00", "2026-03-01T00:00:00+09:00"]) applyEvent(opts, "regional/used", { type: "USED" }, at);
    const meta = readKnowledge(opts, "regional/used")!;
    expect(meta.last_used_at).toBe("2026-03-01T00:00:00+09:00");
    expect(evaluateTriggers([meta], "2026-05-01T00:00:00+09:00", CAL)).toEqual([]);
    // 使われなくなると 180 日で要再検証
    expect(evaluateTriggers([meta], "2026-08-29T00:00:00+09:00", CAL)).toEqual([{ knowledgeId: "regional/used", event: { type: "TRIGGER", trigger: "idle" } }]);
  });

  it("rev は polarity・matchApprox・conditionNote を変えても変わる（round-7 X-27）", () => {
    const a = createKnowledge(opts, regional({ slug: "p1" }), NOW);
    const b = createKnowledge(opts, regional({ slug: "p2", polarity: "allow" }), NOW);
    const c = createKnowledge(opts, regional({ slug: "p3", matchApprox: true, conditionNote: "条件" }), NOW);
    expect(new Set([a.rev, b.rev, c.rev]).size).toBe(3);
  });
});
