// F2 メンターの決定的な部分（出力の検査・表情の制約・プロンプト・ツールの中身）
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import characters from "../../config/characters.json";
import { evaluate } from "../../src/engine";
import { applyEvent, createKnowledge, readKnowledge } from "../../src/lifecycle/store";
import { guardExpression, parseMentorOutput } from "../../src/mentor/output";
import { buildSystemPrompt, levelBehavior } from "../../src/mentor/prompt";
import { askPeerThenHuman, markCited, queryHistory, querySkills } from "../../src/mentor/tools";
import { loadCase, without } from "../engine/helpers";

const T = "2025-03-10T09:00:00+09:00";

describe("出力の検査と表情（FR-21〜24）", () => {
  it("形が正しい出力は通り、引用 id は重複を除く", () => {
    expect(parseMentorOutput({ body: "在医総管の区分を見直してみて", expression: "考え中", citedKnowledge: ["a", "a"] }, "通常")).toEqual({ body: "在医総管の区分を見直してみて", expression: "考え中", citedKnowledge: ["a"] });
  });
  it("本文なし・表情が範囲外・引用が配列でない出力は例外", () => {
    expect(() => parseMentorOutput({ body: "", expression: "通常", citedKnowledge: [] }, "通常")).toThrow(/本文/);
    expect(() => parseMentorOutput({ body: "x", expression: "怒り", citedKnowledge: [] }, "通常")).toThrow(/表情/);
    expect(() => parseMentorOutput({ body: "x", expression: "通常", citedKnowledge: "a" }, "通常")).toThrow(/引用/);
  });
  it("「困り」は新人の誤りには出さず、カルテ不足と審査が難しい場面だけ。喜ぶのは正方向だけ", () => {
    expect(guardExpression("困り", "新人の誤り")).toBe("考え中");
    expect(guardExpression("困り", "カルテ不足")).toBe("困り");
    expect(guardExpression("困り", "審査が難しい")).toBe("困り");
    expect(guardExpression("称賛", "新人の誤り")).toBe("通常");
    expect(guardExpression("笑顔", "正方向")).toBe("笑顔");
  });
});

describe("プロンプト（キャラ × レベル）", () => {
  const c = characters.characters[0];
  it("同じカルテでも Lv.1 と Lv.8 で振る舞いの指示が変わる", () => {
    const e = evaluate(without(loadCase("K2"), "C002_N10_HOKATSU"));
    const p1 = buildSystemPrompt(c, 1, e);
    const p8 = buildSystemPrompt(c, 8, e);
    expect(p1).not.toEqual(p8);
    expect(p1).toContain(levelBehavior(1).timing);
    expect(p8).toContain("聞かれたときだけ");
  });
  it("判定を上書きしない・答えを言わない・「その他」「判定不能」・院内ルールを使わない、が入っていて、判定（R03 の取り忘れ）を渡す", () => {
    const p = buildSystemPrompt(c, 1, evaluate(without(loadCase("K2"), "C002_N10_HOKATSU")));
    for (const s of ["上書き", "答えそのもの", "「その他」「判定不能」", "院内のローカルルールは助言に使わない", "ask_missing"]) expect(p).toContain(s);
    expect(p).toContain('"ruleId":"R03"');
    expect(p).not.toMatch(/教育|学習|学ぶ|教える/);
  });
});

describe("ツールの中身", () => {
  let root: string;
  const store = () => ({ knowledgeDir: path.join(root, "knowledge"), skillsDir: path.join(root, "skills") });
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "iji-mentor-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const mk = (layer: "地域" | "院内" | "ベテラン", slug: string, approve: boolean) => {
    const src = layer === "地域" ? "返戻" : layer === "院内" ? "手動" : "エスカレーション";
    const m = createKnowledge(
      store(),
      { layer, slug, summary: `${slug} BNP`, body: `${slug} の本文`, source: { type: src, ref: slug }, match: layer === "地域" ? { kubunAll: ["D008_18"], payer: "支払基金", prefecture: "東京都" } : {} },
      T,
    );
    if (approve) applyEvent(store(), m.id, { type: "VERIFY_APPROVE" }, T);
    return m.id;
  };

  it("query_skills は承認済みかつ院内以外だけを返す", () => {
    const ok = mk("地域", "ok", true);
    mk("地域", "draft", false);
    mk("院内", "local", true);
    const vet = mk("ベテラン", "vet", true);
    expect(querySkills(store(), "BNP").map((x) => x.id).sort()).toEqual([ok, vet].sort());
    expect(querySkills(store(), "存在しない語")).toEqual([]);
  });

  it("引用した知識に USED が出る（承認済み・要再検証だけ。未検証や未知の id は飛ばす）", () => {
    const ok = mk("地域", "ok", true);
    const draft = mk("地域", "draft", false);
    expect(markCited(store(), [ok, draft, "regional/none"], T)).toEqual([ok]);
    expect(readKnowledge(store(), ok)?.last_used_at).toBe(T);
  });

  it("query_history は過去月の算定を返す（K6 は 1 月・2 月に BNP）", () => {
    expect(queryHistory(loadCase("K6")).map((h) => h.yearMonth)).toEqual(["2025-01", "2025-02"]);
  });

  it("ベテランのメンターが答えられなければ、ベテラン本人に届ける", async () => {
    const human = async () => ({ queued: "v-1" });
    expect(await askPeerThenHuman({ askPeerMentor: async () => "答え", askHuman: human }, "q")).toEqual({ from: "peer", answer: "答え" });
    expect(await askPeerThenHuman({ askPeerMentor: async () => null, askHuman: human }, "q")).toEqual({ from: "human", queued: "v-1" });
  });
});

describe("Agent SDK への登録（API は呼ばない）", () => {
  it("ツールは 6 つだけで、名前は mcp__resemen__ の下にある", async () => {
    const { ALLOWED_TOOLS, mentorServer } = await import("../../src/mentor/session");
    expect(ALLOWED_TOOLS).toEqual([
      "mcp__resemen__query_skills",
      "mcp__resemen__query_history",
      "mcp__resemen__ask_peer_mentor",
      "mcp__resemen__ask_human",
      "mcp__resemen__ask_doctor",
      "mcp__resemen__ask_missing",
    ]);
    const deps = {
      store: { knowledgeDir: "/nonexistent/k", skillsDir: "/nonexistent/s" },
      queryLog: { dir: "/nonexistent/q" },
      askPeerMentor: async () => null,
      askHuman: async () => ({ queued: "x" }),
    };
    const server = mentorServer(deps, loadCase("K2"), () => T);
    expect(server).toMatchObject({ type: "sdk", name: "resemen" });
  });
});
