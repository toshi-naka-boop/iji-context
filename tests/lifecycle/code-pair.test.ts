// 段 16：背反の組の知識（match.codePair。design.md §14-1）の形。store の検査・メンターの Skill に入れない・組の差分と返戻のトリガーだけが効く
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { transition } from "../../src/lifecycle/machine";
import { applyEvent, createKnowledge, type CreateInput, type StoreOptions } from "../../src/lifecycle/store";
import { skillGuard } from "../../src/mentor/workspace";
import { makeMeta } from "./helpers";

const T = "2026-10-10T09:00:00+09:00";
let root: string;
let store: StoreOptions;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "iji-pair-"));
  store = { knowledgeDir: path.join(root, "knowledge"), skillsDir: path.join(root, "skills") };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const pair = (over: Partial<CreateInput> = {}): CreateInput => ({
  layer: "院内",
  slug: "pair-test",
  summary: "背反の組の知識",
  body: "本文",
  source: { type: "手動", ref: "uke:A1" },
  polarity: "allow",
  matchApprox: true,
  conditionNote: "根拠：審査で通った。条件の文",
  match: { codePair: { a: "112007410", b: "114001110", tani: 1 } },
  ...over,
});

describe("codePair の知識の形（store の検査）", () => {
  it("院内層の allow（手動）・avoid（手動・返戻）は作れて、未検証で始まる", () => {
    expect(createKnowledge(store, pair(), T).status).toBe("未検証");
    expect(createKnowledge(store, pair({ slug: "p2", polarity: "avoid" }), T).polarity).toBe("avoid");
    expect(createKnowledge(store, pair({ slug: "p3", polarity: "avoid", source: { type: "返戻", ref: "uke:A1" } }), T).source_event.type).toBe("返戻");
  });
  it("ほかの match のキー・コードの形と順・tani 4・近似でない・条件の文がない／200 字を超える・層・生成元が合わないものは作らない", () => {
    const bad: [Partial<CreateInput>, RegExp][] = [
      [{ match: { codePair: { a: "112007410", b: "114001110", tani: 1 }, kubunAll: ["C001"] } }, /ほかの match のキー/],
      [{ match: { codePair: { a: "114001110", b: "112007410", tani: 1 } } }, /小さい順/],
      [{ match: { codePair: { a: "11200741", b: "114001110", tani: 1 } } }, /9 桁/],
      [{ match: { codePair: { a: "112007410", b: "114001110", tani: 4 as 1 } } }, /tani 1〜3/],
      [{ matchApprox: false }, /近似/],
      [{ conditionNote: null }, /conditionNote/],
      [{ conditionNote: "あ".repeat(201) }, /1〜200 字/],
      [{ layer: "地域", source: { type: "返戻", ref: "x" } }, /地域層の match|院内層とベテラン層/],
      [{ source: { type: "返戻", ref: "x" } }, /allow は手動/],
      [{ source: { type: "提案", ref: "x" } }, /allow は手動/],
    ];
    for (const [over, re] of bad) expect(() => createKnowledge(store, pair(over), T)).toThrow(re);
  });
  it("ベテラン層（会議の修正版。生成元はエスカレーション）も codePair を持てる", () => {
    expect(createKnowledge(store, pair({ layer: "ベテラン", source: { type: "エスカレーション", ref: "item" }, relates_to: "local/x" }), T).layer).toBe("ベテラン");
  });
});

describe("メンター（外部の AI）に渡す Skill に入れない（design.md §14-1）", () => {
  it("承認済みのベテラン層の codePair の知識は同期しない。読む直前の照らしでも読ませない", async () => {
    const m = createKnowledge(store, pair({ layer: "ベテラン", source: { type: "エスカレーション", ref: "item" } }), T);
    applyEvent(store, m.id, { type: "VERIFY_APPROVE" }, T);
    expect(readdirSync(store.skillsDir).filter((n) => n.startsWith("iji-"))).toEqual([]);
    const { hooks } = skillGuard(store);
    const out = (await hooks.PreToolUse![0].hooks[0]({ tool_input: { skill: `iji-${m.id.replace("/", "-")}` } } as never, undefined, { signal: new AbortController().signal })) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });
});

describe("トリガー：localRevision・localReturn は codePair を持つ知識にだけ効く（design.md §14-4）", () => {
  it("codePair の承認済みは要再検証に。持たない知識・ほかのトリガーは拒否", () => {
    const m = makeMeta({ id: "local/p", layer: "院内", match: { codePair: { a: "112007410", b: "114001110", tani: 1 } } });
    for (const trigger of ["localRevision", "localReturn"] as const) {
      expect(transition(m, { type: "TRIGGER", trigger }, T).meta.status).toBe("要再検証");
      expect(transition(m, { type: "TRIGGER", trigger }, T).meta.history.at(-1)?.event).toBe(`TRIGGER{${trigger}}`);
      expect(() => transition(makeMeta({ layer: "院内", match: { kubunAll: ["C001"] } }), { type: "TRIGGER", trigger }, T)).toThrow(/効かないトリガー/);
    }
    expect(() => transition(m, { type: "TRIGGER", trigger: "revision" }, T)).toThrow(/効かないトリガー/);
  });
});
