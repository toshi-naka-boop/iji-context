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
import { evaluate } from "../../src/engine";

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

describe("患者ごとに確かめた情報", () => {
  const care = { key: "careLevel" as const, value: 2, source: "介護保険証" as const, validUntil: "2025-05-31" };

  it("K4 に要介護度（要介護2）を残すと R03 の情報不足が消え、開き直しても残っている", () => {
    expect(evaluate(app.caseOf("K4-2025-03")).findings.map((f) => [f.ruleId, f.kind])).toEqual([["R03", "情報不足"]]);
    app.savePatientFact("K4-2025-03", "new1", care);
    expect(evaluate(app.caseOf("K4-2025-03")).findings).toEqual([]);
    expect(app.patientFacts("K4-2025-03").facts).toEqual([expect.objectContaining({ key: "careLevel", value: 2, source: "介護保険証", checkedBy: "new1", expired: false })]);
  });

  it("時計を有効期間の終わりの翌日に進めると、要介護度は分からないに戻り R03 の情報不足が戻る", () => {
    app.savePatientFact("K4-2025-03", "new1", care);
    app.advanceClock("2025-06-01T09:00:00+09:00");
    expect(app.caseOf("K4-2025-03").facts.careLevel).toEqual({ known: false });
    expect(evaluate(app.caseOf("K4-2025-03")).findings.map((f) => [f.ruleId, f.kind])).toEqual([["R03", "情報不足"]]);
    expect(app.patientFacts("K4-2025-03").facts[0].expired).toBe(true);
  });

  it("K2 で別表第八の二を当たるに直すと、在医総管の区分の指摘（R02）が出る", () => {
    expect(evaluate(app.caseOf("K2-2025-03")).findings).toEqual([]);
    app.savePatientFact("K2-2025-03", "new1", { key: "table8_2", value: true, source: "医師に確認", validUntil: null });
    expect(evaluate(app.caseOf("K2-2025-03")).findings.map((f) => f.ruleId)).toContain("R02");
  });

  it("要介護度に有効期間の終わりがない・範囲外の値・登録していない医療事務は残せない", () => {
    expect(() => app.savePatientFact("K4-2025-03", "new1", { ...care, validUntil: null })).toThrow(/有効期間の終わり/);
    expect(() => app.savePatientFact("K4-2025-03", "new1", { ...care, value: 6 })).toThrow(/0〜5/);
    expect(() => app.savePatientFact("K4-2025-03", "new1", { ...care, validUntil: "2025-03-01" })).toThrow(/今日より前/);
    expect(() => app.savePatientFact("K4-2025-03", "nobody", care)).toThrow(/登録されていない/);
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

describe("選択モード", () => {
  it("選択モードで始めると、問題が引けて、選んだものが記録される。通常の問題では引けない", () => {
    const k1 = app.caseOf("K1-2025-03");
    const q = app.start("new1", k1.claimId, "選択");
    const items = app.choices(q.id);
    expect(items.map((x) => x.group)).toEqual(["在医総管の区分"]);
    expect(app.pick(q.id, items[0].lineIndex, "C002_2RO1").correct).toBe(false);
    expect(app.pick(q.id, items[0].lineIndex, "C002_2I1").correct).toBe(true);
    expect(app.question(q.id).picks?.map((p) => p.correct)).toEqual([false, true]);
    expect(() => app.choices(app.start("new1", k1.claimId).id)).toThrow(/選択モードの問題ではない/);
  });
});

describe("メンターを選ぶ（FR-19）", () => {
  it("選ぶとキャラが替わってセッションが作り直しになり、起動し直しても選んだキャラが残る", () => {
    expect(app.characterChosen("new1")).toBe(false);
    app.setSession("new1", "s-old");
    app.chooseCharacter("new1", "c");
    expect(app.clerk("new1")).toMatchObject({ character_id: "c", session_id: null });
    expect(app.characterChosen("new1")).toBe(true);
    app.upsertClerk({ id: "new1", name: "新人", callName: "さん", characterId: "a", role: "clerk" });
    expect(app.clerk("new1").character_id).toBe("c");
  });
});

describe("訪問の記録（レセコンに入れる前。FR-68）", () => {
  it("時計に関係なく全部の訪問を開けて、その日のカルテとその日までの実施が付く", () => {
    const k4 = app.visits().filter((v) => v.claimId === "K4-2025-03");
    expect(k4.map((v) => v.date)).toEqual(["2025-03-11", "2025-03-25"]);
    expect(k4[0].chart?.a).toBe("AF");
    expect(k4[0].lines.map((l) => [l.kubun, l.count])).toEqual([["C001_1I", 1]]);
    expect(app.start("new1", "K4-2025-03", "通常", "2025-03-25").asOf).toBe("2025-03-25");
    expect(() => app.start("new1", "K4-2025-03", "通常", "2025-03-12")).toThrow();
  });
  it("確定しても提出にならず、件数・防いだ額に数えない。照合はその日までのカルテで出る", () => {
    app.advanceClock("2025-03-11T18:00:00+09:00");
    const q = app.start("new1", "K4-2025-03", "通常", "2025-03-11");
    const lines = app.caseFor(q).lines;
    app.draft(q.id, [...lines, { kubun: "C002_2RO1", count: 1, dates: ["2025-03-11"] }]);
    const c = app.confirm(q.id, lines);
    expect(c.correct).toBe(true);
    app.done(app.explain(q.id).id);
    expect(app.status("new1").count).toBe(0);
    expect(app.crosscheckOf("K4-2025-03", "2025-03-11").mismatches.map((m) => m.ruleId)).toEqual(["M01"]);
    expect(app.outlookOf(q)).toContain("ここまで 1 回");
  });
});

describe("訪問カルテを書く（FR-69）", () => {
  const note = { s: "変わりなし", o: "", a: "AF", p: "DOAC 継続", rx: "" };
  it("書いて確かめた訪問が、その日の訪問の記録になり、訪問の時点の問題で判定できる", () => {
    app.advanceClock("2025-03-18T15:00:00+09:00");
    expect(app.patients().map((p) => p.claimId)).toEqual(["K1-2025-03", "K2-2025-03", "K3-2025-03", "K4-2025-03", "K5-2025-03"]);
    const s = app.saveNote("K4-2025-03", "new1", "訪問診療", note);
    expect(s.date).toBe("2025-03-18");
    expect(app.visits("new1").some((v) => v.claimId === "K4-2025-03" && v.date === "2025-03-18")).toBe(false);
    app.confirmNote(s.id, [{ kind: "処方", value: "DOAC", quote: "DOAC 継続" }]);
    const v = app.visits("new1").find((x) => x.claimId === "K4-2025-03" && x.date === "2025-03-18");
    // ほかの利用者には、この人が書いたカルテは重ならない
    const other = app.createClerk("審査員A");
    expect(app.visits(other.id).some((x) => x.claimId === "K4-2025-03" && x.date === "2025-03-18")).toBe(false);
    expect(v).toMatchObject({ written: true, chart: { a: "AF" } });
    const q = app.start("new1", "K4-2025-03", "通常", "2025-03-18");
    expect(app.caseFor(q).lines.find((l) => l.kubun === "C001_1I")?.count).toBe(2);
    expect(app.crosscheckOf("K4-2025-03", "2025-03-18", "new1").mismatches.map((m) => m.ruleId)).toEqual(["M01"]);
  });
  it("カルテにない言葉の事実では確定できない。診療月の外の日には書けない", () => {
    app.advanceClock("2025-03-18T15:00:00+09:00");
    const s = app.saveNote("K4-2025-03", "new1", "訪問診療", note);
    expect(() => app.confirmNote(s.id, [{ kind: "処方", value: "DOAC", quote: "エリキュース" }])).toThrow();
    app.advanceClock("2025-04-02T09:00:00+09:00");
    expect(() => app.saveNote("K4-2025-03", "new1", "訪問診療", note)).toThrow();
  });
});

describe("伝え方のタイプ（FR-20）", () => {
  it("保存するとセッションが作り直しになり、あとで読める", () => {
    app.setSession("new1", "s-old");
    app.setStyle("new1", { preference: "順を追って丁寧に" });
    expect(app.styleOf("new1")).toEqual({ preference: "順を追って丁寧に" });
    expect(app.clerk("new1").session_id).toBeNull();
  });
});

describe("利用者ごとに使う・UKE を取り込む", () => {
  it("名前を入れると利用者ができ、キャラは利用者ごとに選べる", () => {
    const a = app.createClerk("審査員A");
    const b = app.createClerk("審査員B");
    expect([a.id, b.id]).toEqual(["u0001", "u0002"]);
    app.chooseCharacter(a.id, "c");
    expect([app.clerk(a.id).character_id, app.characterChosen(b.id)]).toEqual(["c", false]);
    expect(() => app.createClerk("  ")).toThrow();
  });
  it("UKE は利用者ごとに取り込み、取り込んだレセプトだけが月末の点検の対象になる", () => {
    const a = app.createClerk("審査員A");
    expect(app.importedClaims(a.id)).toEqual([]);
    app.importUke(a.id, "shiharaikikin.UKE");
    expect(app.importedClaims(a.id)).toEqual(["K6-2025-03"]);
    expect(app.ukeList(a.id).map((u) => [u.name, u.payer, u.imported])).toEqual([["kokuhoren.UKE", "国保連", false], ["shiharaikikin.UKE", "支払基金", true]]);
    expect(() => app.importUke(a.id, "other.UKE")).toThrow();
  });
});

describe("練習問題（FR-75）", () => {
  it("間違いを入れた明細から始まり、直して確定すると正解。件数には数え、提出・防いだ額には数えない", () => {
    const q = app.startDrill("new1", "d04");
    const start = app.caseFor(q);
    expect(start.lines.some((l) => l.kubun === "B000")).toBe(true);
    const fixed = start.lines.filter((l) => l.kubun !== "B000");
    app.draft(q.id, start.lines);
    const c = app.confirm(q.id, fixed);
    expect(c.correct).toBe(true);
    app.done(app.explain(q.id).id);
    expect(app.status("new1").count).toBe(1);
    expect(app.personal("new1", true)).toMatchObject({ visible: true, summary: { 差し戻し: { count: 0 } } });
    expect(app.outlookOf(q)).toContain("練習問題");
  });
  it("直さずに確定すると、ねらいのルールで不正解。状況の事実（要介護2）は問題の側で決まる", () => {
    const q = app.startDrill("new1", "d02");
    expect(app.caseFor(q).facts.careLevel).toEqual({ known: true, value: 2 });
    const c = app.confirm(q.id, app.caseFor(q).lines);
    expect(c.correct).toBe(false);
    expect(c.confirmed?.result.findings.map((f) => f.ruleId)).toContain("R03");
  });
});

describe("医師確認の練習問題（FR-76）", () => {
  it("聞かずに確定すると不正解。医師確認を送り、回答と承認がそろうと事実に戻り、確定して正解", () => {
    const q1 = app.startDrill("new1", "m01");
    expect(app.confirm(q1.id, app.caseFor(q1).lines).correct).toBe(false);

    const q = app.startDrill("new1", "m01");
    const sent = app.askDoctorForDrill(q.id);
    expect(app.askDoctorForDrill(q.id).id).toBe(sent.id); // 2 回は送らない
    expect(app.drillState(q.id)).toMatchObject({ kind: "医師確認", query: { status: "未回答" } });
    expect(app.caseFor(q).facts.table8_2).toEqual({ known: false });
    app.answerDoctor(sent.id, { option: "該当する", answeredBy: "医師" });
    expect(app.caseFor(q).facts.table8_2).toEqual({ known: false }); // 承認まで戻さない
    app.approveDoctor(sent.id, "医師");
    expect(app.caseFor(q).facts.table8_2).toEqual({ known: true, value: true });
    expect(app.confirm(q.id, app.caseFor(q).lines).correct).toBe(true);
  });
  it("K4 の照合の問題は、病型の医師確認が承認されるまで正解にならない", () => {
    const q = app.startDrill("new1", "m03");
    expect(app.drillState(q.id)).toMatchObject({ crosscheckOpen: true });
    const sent = app.sendCrosscheck("K4-2025-03", "M01");
    if (sent.route !== "F1") throw new Error("医師確認にならない");
    app.answerDoctor(sent.query.id, { option: "非弁膜症性心房細動", answeredBy: "医師" });
    app.approveDoctor(sent.query.id, "医師");
    expect(app.drillState(q.id)).toMatchObject({ crosscheckOpen: false });
    expect(app.confirm(q.id, app.caseFor(q).lines).correct).toBe(true);
  });
});

describe("ローカルルール（FR-78・FR-79）", () => {
  it("K6 の査定通知から地域ルールを入れると、K6（東京都・支払基金・BNP）にだけ当てはまり、K1（国保連）には当てはまらない", () => {
    const made = app.seedLocalRules();
    expect(made).toHaveLength(1);
    expect(app.seedLocalRules()).toHaveLength(0); // 2 回目は入れない
    const k6 = app.start("new1", "K6-2025-03");
    const rules = app.localRulesOf(k6.id);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ layer: "地域", source: "査定", usedByMentor: false });
    expect(rules[0].summary).toContain("BNP");
    // BNP の行を外すと当てはまらない
    expect(app.localRulesOf(k6.id, app.caseFor(k6).lines.filter((l) => l.kubun !== "D008_18"))).toHaveLength(0);
    const k1 = app.start("new1", "K1-2025-03");
    expect(app.localRulesOf(k1.id)).toHaveLength(0);
  });
});
