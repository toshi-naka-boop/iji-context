// 画面から呼ぶ処理の層（src/server/app.ts）。設定と合成データはリポジトリのものを使い、DB・知識・記録は一時ディレクトリに置く
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applications } from "../../src/db/schema";
import { seed } from "../../scripts/seed-knowledge";
import { openApp, type App } from "../../src/server/app";
import { readKnowledge } from "../../src/lifecycle/store";

const repo = path.join(__dirname, "..", "..");
let tmp: string;
let app: App;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "iji-app-"));
  app = openApp({ root: repo, dbFile: path.join(tmp, "app.db"), knowledgeDir: path.join(tmp, "knowledge"), skillsDir: path.join(tmp, "skills"), queryLogDir: path.join(tmp, "query-log") });
  seed(app.store);
  app.upsertClerk({ id: "new1", name: "新人", callName: "さん", characterId: "a", role: "clerk" });
});
afterEach(() => {
  app.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("症例", () => {
  it("合成 UKE 2 本と合成カルテ側の事実から、K1〜K6 の 6 件が読める", () => {
    expect(app.cases().map((c) => [c.claimId, c.payer])).toEqual([
      ["K1-2025-03", "国保連"], ["K2-2025-03", "国保連"], ["K3-2025-03", "国保連"], ["K4-2025-03", "国保連"], ["K5-2025-03", "国保連"], ["K6-2025-03", "支払基金"],
    ]);
  });
});

describe("1 問の流れ（K2：加算の取り忘れ）", () => {
  it("下書きで取り忘れの指摘 → 足して確定 → 正解、適用記録が書かれ、レベルの件数が増え、防いだ額が数えられる", () => {
    const k2 = app.caseOf("K2-2025-03");
    const q = app.start("new1", k2.claimId);
    const missing = k2.lines.filter((l) => l.kubun !== "C002_N10_HOKATSU" && l.kubun !== "C002_N4_IKOU");
    const d = app.draft(q.id, missing);
    expect(d.result.findings.map((f) => f.ruleId).sort()).toEqual(["R03", "R14"]);
    const c = app.confirm(q.id, k2.lines);
    expect(c.correct).toBe(true);
    app.explain(q.id);
    app.done(q.id);
    expect(app.status("new1")).toEqual({ level: 1, count: 1, streak: 1 });
    expect(app.personal("new1", false)).toEqual({ visible: false });
    expect(app.personal("new1", true)).toMatchObject({ visible: true, summary: { 取りこぼし: { count: 2, yen: 2500 } } });
    // 適用記録：制度層の R03 の知識に final が付く
    const row = app.deps.db.select().from(applications).where(and(eq(applications.submissionId, q.id), eq(applications.knowledgeId, "system/r03"))).get();
    expect(row?.role).toBe("final");
  });

  it("登録していない医療事務・ない症例では始められない", () => {
    expect(() => app.start("nobody", "K1-2025-03")).toThrow(/登録されていない/);
    expect(() => app.start("new1", "K9-2025-03")).toThrow(/症例がない/);
  });
});

describe("時計とレセメン会議", () => {
  it("提出結果の外れを取り込み、土曜を過ぎるまで時計を進めると会議の整理が回り、議題に外れの確認が出る。知識は使い続ける", () => {
    const k6 = app.caseOf("K6-2025-03");
    const q = app.start("new1", k6.claimId);
    app.confirm(q.id, k6.lines);
    // K6 の知識（支払基金の BNP）は地域層なので、制度層の R11 に外れを付ける
    app.importClaimResult({ resultId: "r1", submissionId: q.id, kind: "原審査", outcome: "査定", kubun: ["D008_18"] });
    const r = app.advanceClock("2025-03-15T09:00:00+09:00");
    expect(r.meeting).not.toBeNull();
    const items = app.agenda().items;
    expect(items.some((i) => i.kind === "miss" && i.knowledgeId === "system/r11")).toBe(true);
    expect(readKnowledge(app.store, "system/r11")?.status).toBe("承認済み");
  });
});

describe("K4：照合 → 医師確認 → 承認で病名が確定", () => {
  it("不一致が 1 件出て、医師確認を送り、医師が回答・承認すると傷病名が確定して不一致が消える", () => {
    const c1 = app.crosscheckOf("K4-2025-03");
    expect(c1.mismatches.map((m) => m.ruleId)).toEqual(["M01"]);
    const r = app.sendCrosscheck("K4-2025-03", "M01");
    expect(r.route).toBe("F1");
    expect(() => app.sendCrosscheck("K4-2025-03", "M01")).toThrow(/もう送ってある/);
    const id = r.route === "F1" ? r.query.id : "";
    app.answerDoctor(id, { option: "非弁膜症性心房細動", answeredBy: "院長" });
    app.approveDoctor(id, "院長");
    const c2 = app.crosscheckOf("K4-2025-03");
    expect(c2).toEqual({ mismatches: [], confirmed: ["非弁膜症性心房細動"] });
  });

  it("カルテのない症例は照合しない", () => {
    expect(app.crosscheckOf("K1-2025-03").mismatches).toEqual([]);
  });
});

describe("F6 メンター同士", () => {
  it("ベテラン本人に届いた問いに回答すると、ベテランの判断の知識候補（未検証・エスカレーション）ができる", () => {
    const q = app.peerToHuman("new1", "看取りの月の在医総管はどう考える？");
    expect(app.peerList().map((r) => [r.id, r.status])).toEqual([[q.queued, "回答待ち"]]);
    const r = app.peerAnswerByHuman(q.queued, "看取りの月も、訪問の回数で区分を決める。");
    const k = readKnowledge(app.store, r.knowledgeId)!;
    expect(k).toMatchObject({ layer: "ベテラン", status: "未検証", source_event: { type: "エスカレーション", ref: q.queued } });
    expect(() => app.peerAnswerByHuman(q.queued, "x")).toThrow(/回答済み/);
  });

  it("ベテランのメンターが答えた問いも記録され、知識候補になる", () => {
    const r = app.peerResolvedByMentor("new1", "BNP のコメントは？", "R11 の知識による。");
    expect(app.peerList()[0]).toMatchObject({ status: "解決", answered_by: "veteran_mentor", knowledge_id: r.knowledgeId });
  });
});

describe("F11 提案と共感・検証キュー", () => {
  it("提案は院内層の未検証の候補になり、共感の多い順に検証キューに並び、ベテランの承認で承認済みになる。院内層は同期されない", () => {
    const a = app.propose({ summary: "BNP のコメントの書き方", body: "毎月 BNP を算定するときは理由を摘要に書く" });
    const b = app.propose({ summary: "訪問日の確認", body: "訪問日はカルテの日付と照合する", relatesTo: "system/r13" });
    app.empathize(b.id);
    expect(app.queue().map((m) => m.id)).toEqual([b.id, a.id]);
    expect(readKnowledge(app.store, b.id)).toMatchObject({ layer: "院内", status: "未検証", empathy: 1, relates_to: "system/r13" });
    expect(app.verify(b.id, true).status).toBe("承認済み");
    expect(app.verify(a.id, false, "重複").status).toBe("保管");
    expect(app.queue()).toEqual([]);
  });
});

describe("F3 代行入力", () => {
  it("整えた文は医師確認になり（7 要件を通る）、足りない項目は医師確認の引用と医療事務への確認に分かれる。承認で確定する", async () => {
    const { parseScribe, proxyConfirmDraft } = await import("../../src/mentor/scribe");
    const { validateQuery } = await import("../../src/query/doctor-query");
    expect(validateQuery(proxyConfirmDraft("K4-2025-03", "AF 継続 DOAC", "心房細動。DOAC を継続する。"))).toEqual([]);
    const scribed = parseScribe({ text: "心房細動。DOAC を継続する。", missing: [{ field: "心房細動の病型", why: "記載がない", target: "doctor" }, { field: "次回の訪問日", why: "記載がない", target: "clerk" }, { bad: 1 }] });
    expect(scribed.missing).toHaveLength(2);
    const r = app.proxySubmit("K4-2025-03", "AF 継続 DOAC", scribed);
    expect(r.query?.field).toBe("代行入力");
    expect(r.query?.indicators.at(-1)).toEqual({ source: "記載が足りない項目", text: "心房細動の病型（記載がない）" });
    expect(r.clerkTasks.map((t) => t.field)).toEqual(["次回の訪問日"]);
    app.answerDoctor(r.query!.id, { option: "この内容で確定する", answeredBy: "院長" });
    expect(app.approveDoctor(r.query!.id, "院長").query.status).toBe("承認済み");
  });
});
