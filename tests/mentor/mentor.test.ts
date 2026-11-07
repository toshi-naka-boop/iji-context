// F2 メンターの決定的な部分（出力の検査・表情の制約・プロンプト・ツールの中身）
import { existsSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import characters from "../../config/characters.json";
import { evaluate } from "../../src/engine";
import { applyEvent, createKnowledge, readKnowledge } from "../../src/lifecycle/store";
import { guardExpression, leakedTerms, parseMentorOutput } from "../../src/mentor/output";
import { buildSystemPrompt, levelBehavior } from "../../src/mentor/prompt";
import { askPeerThenHuman, markCited, queryHistory } from "../../src/mentor/tools";
import { clerkMemo, ensureWorkspace, skillGuard, skillNames, workspaceRoot, workspaceSkillNames } from "../../src/mentor/workspace";
import { loadCase, without } from "../engine/helpers";

const T = "2025-03-10T09:00:00+09:00";

describe("出力の検査と表情（FR-21〜24）", () => {
  it("形が正しい出力は通り、引用 id は重複を除く", () => {
    expect(parseMentorOutput({ body: "在医総管の区分を見直してみて", expression: "考え中", citedKnowledge: ["a", "a"], topic: "算定" }, "通常")).toEqual({ body: "在医総管の区分を見直してみて", expression: "考え中", citedKnowledge: ["a"], topic: "算定" });
    // topic が欠けていたら「算定」として扱う（雑談の回数を数えない側に倒す）
    expect(parseMentorOutput({ body: "x", expression: "通常", citedKnowledge: [] }, "通常").topic).toBe("算定");
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
    expect(p8).toContain("聞かれたときに一言だけ");
    expect(p8).toContain("あなたなら余裕ですね");
    expect(p1).toContain("同僚");
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

  it("Skill を読む直前の Hooks：承認済みかつ院内以外だけ読ませ、読めたものを知識 id で記録する", async () => {
    const ok = mk("地域", "ok", true);
    const draft = mk("地域", "draft", false);
    const local = mk("院内", "local", true);
    const g = skillGuard(store());
    const pre = g.hooks.PreToolUse![0].hooks[0];
    const post = g.hooks.PostToolUse![0].hooks[0];
    const call = (h: typeof pre, id: string) => h({ hook_event_name: "PreToolUse", tool_name: "Skill", tool_input: { skill: `iji-${id.replace("/", "-")}` } } as never, undefined, { signal: new AbortController().signal });
    expect(await call(pre, ok)).toEqual({});
    for (const id of [draft, local, "regional/none"]) expect(await call(pre, id)).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    await call(post, ok);
    await call(post, draft);
    expect(g.reads).toEqual([ok]);
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
  it("自前のツールは 5 つだけで、名前は mcp__resemen__ の下にある（知識は Skill で読む）", async () => {
    const { ALLOWED_TOOLS, mentorServer } = await import("../../src/mentor/session");
    expect(ALLOWED_TOOLS).toEqual([
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

describe("指摘の文言", () => {
  it("すべてのルールの指摘に文言があり、禁止語・金額を含まない", async () => {
    const { FINDING_TEXT, findingText } = await import("../../src/messages");
    const { readFileSync, readdirSync } = await import("node:fs");
    const dir = path.join(__dirname, "..", "..", "src", "engine", "rules");
    const keys = readdirSync(dir)
      .filter((f) => /^r\d+\.ts$/.test(f))
      .flatMap((f) => [...readFileSync(path.join(dir, f), "utf8").matchAll(/finding\(this, "[^"]+", [\s\S]*?"([a-z_0-9]+)"\)/g)].map((m) => `${f.slice(0, 3).toUpperCase()}.${m[1]}`));
    expect(keys.length).toBeGreaterThan(25);
    for (const k of keys) expect(FINDING_TEXT[k], k).toBeTruthy();
    for (const t of Object.values(FINDING_TEXT)) expect(t).not.toMatch(/教育|学習|学ぶ|教える|円/);
    expect(findingText({ ruleId: "R03", kind: "情報不足", lineRefs: [], missing: { target: "clerk", field: "careLevel" }, messageKey: "R03.missing_fact", reference: "" })).toBe("要介護度が入っていません。介護保険証で確かめて入力してください");
  });
});

describe("ヒントの段階で答えに触れていないか（決まった規則）", () => {
  const e = evaluate(without(loadCase("K2"), "C002_N10_HOKATSU"));
  it("取り忘れでは、足すべき項目の名前・指摘の種類・点数の数字に触れたら拾う", () => {
    expect(leakedTerms("包括的支援加算を付けてください", e)).toContain("包括的支援加算");
    expect(leakedTerms("取り忘れがあります", e)).toContain("取り忘れ");
    expect(leakedTerms("合計は 6043 点です", e)).toContain("6043 点");
  });
  it("見る場所を示すだけなら通す", () => {
    expect(leakedTerms("R03 の条件を、患者さんの要介護度と見比べてみてください。", e)).toEqual([]);
  });
  it("ヒントの段階のプロンプトには、指摘の種類・根拠・点数を渡さない", () => {
    const c = characters.characters[0];
    const p = buildSystemPrompt(c, 1, e, false);
    expect(p).toContain('"ruleId":"R03"');
    expect(p).not.toContain("取り忘れ");
    expect(p).not.toContain("包括的支援加算");
    expect(p).not.toContain('"total"');
  });
});

describe("一人ひとりの作業場所", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "iji-ws-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("CLAUDE.md を書き、.claude/skills には同期先の知識へのリンクだけを置く（何度呼んでも同じ）", () => {
    const skills = path.join(root, "skills");
    mkdirSync(path.join(skills, "iji-system-r03"), { recursive: true });
    mkdirSync(path.join(skills, "other"), { recursive: true });
    const dir = ensureWorkspace(path.join(root, "ws"), "new1", skills, "# メモ\n");
    ensureWorkspace(path.join(root, "ws"), "new1", skills, "# メモ\n");
    expect(readFileSync(path.join(dir, "CLAUDE.md"), "utf8")).toBe("# メモ\n");
    expect(readlinkSync(path.join(dir, ".claude", "skills", "iji-system-r03"))).toBe(path.join(path.resolve(skills), "iji-system-r03"));
    expect(workspaceSkillNames(dir)).toEqual(["iji-system-r03"]);
    expect(skillNames(skills)).toEqual(["iji-system-r03"]);
    expect(() => ensureWorkspace(path.join(root, "ws"), "../x", skills, "")).toThrow(/id/);
  });

  it("上の階層に CLAUDE.md がある場所には置かない（メンターに読み込まれてしまう）", () => {
    writeFileSync(path.join(root, "CLAUDE.md"), "x");
    expect(() => workspaceRoot(path.join(root, "a", "ws"))).toThrow(/CLAUDE\.md/);
    expect(existsSync(path.join(root, "a"))).toBe(false);
  });

  it("本人の CLAUDE.md：レベルと、直近で確認が入ったルールを数える", () => {
    const k2 = without(loadCase("K2"), "C002_N10_HOKATSU");
    const q = (id: string, ctx = k2) => ({ id, clerkId: "new1", claimId: ctx.claimId, phase: "完了" as const, startedAt: `2025-03-1${id}T09:00:00+09:00`, drafts: [], confirmed: { lines: ctx.lines, result: evaluate(ctx), at: T }, correct: false, finishedAt: T });
    const memo = clerkMemo({ name: "新人", callName: "さん", role: "clerk", level: 2, count: 25, streak: 0 }, [q("1"), q("2")]);
    expect(memo).toContain("Lv.2（処理 25 件");
    expect(memo).toContain("R03 2 回");
    expect(memo).not.toMatch(/教育|学習|学ぶ|教える/);
  });
});

describe("役割ごとのモデル（config/models.json）", () => {
  it("4 つの役割にモデルがあり、深く考える（high 以上）のはベテランのメンターだけ", async () => {
    const { modelFor } = await import("../../src/mentor/models");
    const roles = ["mentor", "veteranMentor", "scribe", "notice"] as const;
    const deep = roles.filter((r) => ["high", "xhigh", "max"].includes(modelFor(r).effort ?? ""));
    for (const r of roles) expect(modelFor(r).model).toMatch(/^claude-/);
    expect(deep).toEqual(["veteranMentor"]);
  });
  it("メンターは Lv.6 から段が変わる（Lv.5 は速さ優先、Lv.6 以上は深く考える）", async () => {
    const { modelFor } = await import("../../src/mentor/models");
    expect(modelFor("mentor", { level: 5 })).toEqual(modelFor("mentor"));
    expect(modelFor("mentor", { level: 6 }).model).toBe("claude-opus-5-5");
    expect(modelFor("mentor", { level: 10 }).model).toBe("claude-opus-5-5");
  });
  it("場面：Lv.5 までは解説だけ考える深さが「中」、ヒントは「低」。Lv.6 以上はレベルの段（Opus）が優先", async () => {
    const { modelFor } = await import("../../src/mentor/models");
    expect(modelFor("mentor", { level: 1, scene: "hint" })).toEqual({ model: "claude-sonnet-5-5", effort: "low" });
    expect(modelFor("mentor", { level: 1, scene: "explain" })).toEqual({ model: "claude-sonnet-5-5", effort: "medium" });
    expect(modelFor("mentor", { level: 6, scene: "explain" })).toEqual(modelFor("mentor", { level: 6 }));
  });
});

describe("医師に聞く前に正しい決まりを読む（照合の不一致 M01）", () => {
  const draft = { claimId: "K4-2025-03", field: "SY:心房細動の病型", why: "w", question: "q", indicators: [{ source: "s", text: "t" }], options: ["非弁膜症性心房細動", "弁膜症性心房細動", "その他", "判定不能"], createdBy: "clerk" as const };
  const item = { ruleId: "M01", disease: "心房細動", why: "w", draft, sent: false };
  it("Hooks：このレセプトに当てはまる決まり（applied と照合の規則）のどれかを読むまで医師確認を作らせない。決まりがなければベテランへ。医療事務あては止めない", async () => {
    const { doctorReadGuard, relevantRules } = await import("../../src/mentor/session");
    const k5 = relevantRules(["R09", "R10", "R13"], []);
    const k4 = relevantRules(["R03"], [item]);
    expect(k4).toEqual(["system/r03", "crosscheck/m01"]);
    const call = async (reads: string[], rel: string[], tool: string, ti: Record<string, unknown>) =>
      doctorReadGuard(reads, () => rel).hooks[0]({ hook_event_name: "PreToolUse", tool_name: `mcp__resemen__${tool}`, tool_input: ti } as never, undefined, { signal: new AbortController().signal });
    const deny = { hookSpecificOutput: { permissionDecision: "deny" } };
    expect(await call([], k5, "ask_doctor", {})).toMatchObject(deny);
    expect(await call(["system/r03"], k5, "ask_doctor", {})).toMatchObject(deny); // 関係ない知識では通らない
    expect(await call(["system/r09"], k5, "ask_doctor", {})).toEqual({});
    expect(await call(["crosscheck/m01"], k4, "ask_missing", { target: "doctor" })).toEqual({});
    expect(await call(["system/r09"], [], "ask_doctor", {})).toMatchObject({ hookSpecificOutput: { permissionDecisionReason: expect.stringMatching(/ベテランのメンター/) } });
    expect(await call([], k5, "ask_missing", { target: "clerk" })).toEqual({});
  });
  it("照合でまだ送っていない不一致があれば、メンターは医師確認を作らず、本人に選んでもらう", async () => {
    const { mentorServer } = await import("../../src/mentor/session");
    const root = mkdtempSync(path.join(tmpdir(), "iji-choice-"));
    try {
      const offered: string[] = [];
      const deps = { store: { knowledgeDir: path.join(root, "k"), skillsDir: path.join(root, "s") }, queryLog: { dir: path.join(root, "q") }, askPeerMentor: async () => null, askHuman: async () => ({ queued: "x" }), crosscheck: () => [item] };
      const server = mentorServer(deps, loadCase("K4"), () => T, (items) => offered.push(...items.map((m) => m.ruleId)));
      const tools = (server.instance as unknown as { _registeredTools: Record<string, { handler?: (a: unknown, e: unknown) => Promise<{ content: { text: string }[] }>; callback?: (a: unknown, e: unknown) => Promise<{ content: { text: string }[] }> }> })._registeredTools;
      const t = tools.ask_doctor;
      const fn = t.handler ?? t.callback!;
      const r = await fn({ field: "病型", why: "w", question: "心房細動の続き方を教えてください", indicators: [{ source: "カルテ", text: "AF" }], options: ["発作性", "持続性", "その他", "判定不能"] }, {});
      expect(r.content[0].text).toContain("needsClerkChoice");
      expect(offered).toEqual(["M01"]);
      expect(existsSync(path.join(root, "q"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("照合の規則 M01 は、作業場所に crosscheck-m01 として置かれ、いつでも読める（状態を持たない決まった規則）", async () => {
    const { crosscheckSkills } = await import("../../src/uke/crosscheck");
    const root = mkdtempSync(path.join(tmpdir(), "iji-cross-"));
    try {
      const skills = path.join(root, "skills");
      mkdirSync(path.join(skills, "iji-system-r03"), { recursive: true });
      const cwd = ensureWorkspace(path.join(root, "ws"), "new1", skills, "# メモ\n", crosscheckSkills());
      expect(workspaceSkillNames(cwd)).toEqual(["crosscheck-m01", "iji-system-r03"]);
      expect(readFileSync(path.join(cwd, ".claude", "skills", "crosscheck-m01", "SKILL.md"), "utf8")).toContain("非弁膜症性");
      const g = skillGuard({ knowledgeDir: path.join(root, "k"), skillsDir: skills });
      const call = (h: (typeof g.hooks.PreToolUse)[number]["hooks"][number], name: string) => h({ hook_event_name: "PreToolUse", tool_name: "Skill", tool_input: { skill: name } } as never, undefined, { signal: new AbortController().signal });
      expect(await call(g.hooks.PreToolUse![0].hooks[0], "crosscheck-m01")).toEqual({});
      await call(g.hooks.PostToolUse![0].hooks[0], "crosscheck-m01");
      expect(g.reads).toEqual(["crosscheck/m01"]);
      expect(await call(g.hooks.PreToolUse![0].hooks[0], "crosscheck-m99")).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("雑談（3 回続いたら算定に戻る声かけ）", () => {
  it("雑談が続いた回数を数え、3 回目で声かけを添えたら 0 に戻す。算定の話でも 0 に戻す", async () => {
    const { nextSmalltalkStreak } = await import("../../src/mentor/output");
    let n = 0;
    n = nextSmalltalkStreak(n, "雑談");
    expect(n).toBe(1);
    n = nextSmalltalkStreak(n, "雑談");
    expect(n).toBe(2);
    n = nextSmalltalkStreak(n, "雑談"); // 3 回目：声かけを添えた回
    expect(n).toBe(0);
    expect(nextSmalltalkStreak(2, "算定")).toBe(0);
  });
  it("雑談が 2 回続いたあとの発言には、算定に戻る一言を添えるよう伝える。1 回では伝えない", async () => {
    const { turnContext } = await import("../../src/mentor/prompt");
    const e = evaluate(loadCase("K3"));
    expect(turnContext(e, false, [], 2)).toContain("算定のほうは終わりました");
    expect(turnContext(e, false, [], 1)).not.toContain("算定のほうは終わりました");
  });
});

describe("ヒントの段階で渡すもの（prompt-eval M5 の改訂）", () => {
  it("情報不足は、入っていない事実と確かめ方を渡す。取り忘れの項目名は渡さない。今日の日付を添える", async () => {
    const { turnContext } = await import("../../src/mentor/prompt");
    const k4 = turnContext(evaluate(loadCase("K4")), false, [], 0, "2025-03-10");
    expect(k4).toContain("情報不足（本人の誤りではない）：要介護度が入っていません。介護保険証で確かめて入力してください");
    expect(k4).toContain("その行に加算が付いているという意味ではない");
    expect(k4).toContain("今日の日付：2025-03-10");
    const k2 = turnContext(evaluate(without(loadCase("K2"), "C002_N10_HOKATSU")), false);
    expect(k2).not.toContain("包括的支援加算");
    expect(k2).not.toContain("情報不足（");
  });
});

describe("愚痴（数えずに聞く）", () => {
  it("愚痴は雑談の回数に数えず 0 に戻す。愚痴が続いた回数は別に数え、3 回目で提案を添えたら 0 に戻す", async () => {
    const { nextSmalltalkStreak, nextVentStreak } = await import("../../src/mentor/output");
    expect(nextSmalltalkStreak(2, "愚痴")).toBe(0);
    expect(nextVentStreak(0, "愚痴")).toBe(1);
    expect(nextVentStreak(1, "愚痴")).toBe(2);
    expect(nextVentStreak(2, "愚痴")).toBe(0);
    expect(nextVentStreak(2, "雑談")).toBe(0);
  });
  it("愚痴が 2 回続いたあとは、休む・人に話す提案を一度だけ添えるよう伝える（知らせはしない）", async () => {
    const { turnContext } = await import("../../src/mentor/prompt");
    const e = evaluate(loadCase("K3"));
    const c = turnContext(e, false, [], 0, undefined, 2);
    expect(c).toContain("少し休んでから続けます？");
    expect(c).toContain("誰かに知らせることはしない");
    expect(turnContext(e, false, [], 0, undefined, 1)).not.toContain("少し休んで");
  });
  it("キャラの話し方（呼び方・敬語・口調・使わない言い方・例文）が守ることの後に入り、例文は写さないよう添える。空の項目は入れない", () => {
    const base = { id: "x", name: "テスト", firstPerson: "私", tone: "明るく短く" };
    const p = buildSystemPrompt({ ...base, callUser: "〇〇さん", politeness: "です・ます", catchphrases: ["いい感じです", " "], avoid: ["マジで"], examples: { opening: "お疲れさまです。今日もよろしくお願いします", hint: "" } }, 1);
    for (const w of ["相手の呼び方：〇〇さん", "敬語の度合い：です・ます", "口癖：「いい感じです」。毎回は使わず", "使わない言い方：「マジで」", "同じ文は使わず", "レセプトを開いたとき：お疲れさまです。今日もよろしくお願いします", "守ることを優先する"]) expect(p).toContain(w);
    expect(p).not.toContain("ヒント：");
    expect(p.indexOf("話し方（")).toBeGreaterThan(p.indexOf("守ること："));
    expect(buildSystemPrompt(base, 1)).not.toContain("話し方（");
  });
  it("愚痴の受け止め方の決まりがシステムプロンプトに入っている", () => {
    const p = buildSystemPrompt(characters.characters[0], 1);
    for (const w of ["愚痴", "解決策", "評価・批判しない", "聞き出さない", "カウンセラーではない"]) expect(p).toContain(w);
    expect(p).not.toMatch(/教育|学習|学ぶ|教える/);
  });
});

describe("伝え方のタイプ（FR-20。本人の申告）", () => {
  it("申告した好みと 16 タイプを、守ることの後に入れ、申告がなければ入れない", async () => {
    const { buildSystemPrompt } = await import("../../src/mentor/prompt");
    const { validateStyle } = await import("../../src/mentor/style");
    const c = { id: "a", name: "マッキー", firstPerson: "ぼく", tone: "静かに優しい" };
    const p = buildSystemPrompt(c, 1, undefined, true, { preference: "結論から短く", type16: "INFP" });
    expect(p.indexOf("話し方の好み：結論から短く")).toBeGreaterThan(p.indexOf("守ること："));
    expect(p).toContain("INFP");
    expect(buildSystemPrompt(c, 1)).not.toContain("伝え方の好み");
    expect(() => validateStyle({ type16: "ABCD" as never })).toThrow();
  });
});
