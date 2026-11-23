// 画面から呼ぶ処理の層（src/server/app.ts）。設定と合成データはリポジトリのものを使い、DB・知識・記録は一時ディレクトリに置く
import Database from "better-sqlite3";
import iconv from "iconv-lite";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applications } from "../../src/db/schema";
import { seed } from "../../scripts/seed-knowledge";
import { cleanName, openApp, type App } from "../../src/server/app";
import { listKnowledge, readKnowledge } from "../../src/lifecycle/store";
import { evaluate } from "../../src/engine";
import { period } from "../../src/demo/period";
import { docKey } from "../../src/official/match";
import { at, claimId, dateIn, day } from "../helpers/period";
import { makeDoc } from "../official/helpers";

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
  it("合成 UKE 2 本と合成カルテ側の事実から、K1〜K7 の 7 件が読める（K7 は国保連の UKE に入る）", () => {
    expect(app.cases().map((c) => [c.claimId, c.payer])).toEqual([
      [claimId("K1"), "国保連"], [claimId("K2"), "国保連"], [claimId("K3"), "国保連"], [claimId("K4"), "国保連"], [claimId("K5"), "国保連"], [claimId("K7"), "国保連"], [claimId("K6"), "支払基金"],
    ]);
  });
});

describe("患者ごとに確かめた情報", () => {
  const care = { key: "careLevel" as const, value: 2, source: "介護保険証" as const, validUntil: dateIn(2, 31) };

  it("K4 に要介護度（要介護2）を残すと R03 の情報不足が消え、開き直しても残っている", () => {
    expect(evaluate(app.caseOf(claimId("K4"))).findings.map((f) => [f.ruleId, f.kind])).toEqual([["R03", "情報不足"]]);
    app.savePatientFact(claimId("K4"), "new1", care);
    expect(evaluate(app.caseOf(claimId("K4"))).findings).toEqual([]);
    expect(app.patientFacts(claimId("K4")).facts).toEqual([expect.objectContaining({ key: "careLevel", value: 2, source: "介護保険証", checkedBy: "new1", expired: false })]);
  });

  it("時計を有効期間の終わりの翌日に進めると、要介護度は分からないに戻り R03 の情報不足が戻る", () => {
    app.savePatientFact(claimId("K4"), "new1", care);
    app.advanceClock(`${dateIn(3, 1)}T09:00:00+09:00`);
    expect(app.caseOf(claimId("K4")).facts.careLevel).toEqual({ known: false });
    expect(evaluate(app.caseOf(claimId("K4"))).findings.map((f) => [f.ruleId, f.kind])).toEqual([["R03", "情報不足"]]);
    expect(app.patientFacts(claimId("K4")).facts[0].expired).toBe(true);
  });

  it("K2 で別表第八の二を当たるに直すと、在医総管の区分の指摘（R02）が出る", () => {
    expect(evaluate(app.caseOf(claimId("K2"))).findings).toEqual([]);
    app.savePatientFact(claimId("K2"), "new1", { key: "table8_2", value: true, source: "医師に確認", validUntil: null });
    expect(evaluate(app.caseOf(claimId("K2"))).findings.map((f) => f.ruleId)).toContain("R02");
  });

  it("要介護度に有効期間の終わりがない・範囲外の値・登録していない医療事務は残せない", () => {
    expect(() => app.savePatientFact(claimId("K4"), "new1", { ...care, validUntil: null })).toThrow(/有効期間の終わり/);
    expect(() => app.savePatientFact(claimId("K4"), "new1", { ...care, value: 6 })).toThrow(/0〜5/);
    expect(() => app.savePatientFact(claimId("K4"), "new1", { ...care, validUntil: day(3) })).toThrow(/今日より前/);
    expect(() => app.savePatientFact(claimId("K4"), "nobody", care)).toThrow(/登録されていない/);
  });

  it("K4 に要介護 2 と障害支援区分 2 を残すと、包括的支援加算の取り忘れが出る。障害支援区分は 0〜6 で、期限を付けない（design.md §11-4）", () => {
    const level = { key: "disabilitySupportLevel" as const, value: 2, source: "受給者証" as const, validUntil: null };
    app.savePatientFact(claimId("K4"), "new1", care);
    app.savePatientFact(claimId("K4"), "new1", level);
    expect(app.caseOf(claimId("K4")).facts.disabilitySupportLevel).toEqual({ known: true, value: 2 });
    expect(evaluate(app.caseOf(claimId("K4"))).findings.map((f) => [f.ruleId, f.kind])).toEqual([["R03", "取り忘れ"]]);
    expect(() => app.savePatientFact(claimId("K4"), "new1", { ...level, value: 7 })).toThrow(/0〜6/);
    expect(() => app.savePatientFact(claimId("K4"), "new1", { ...level, validUntil: dateIn(2, 31) })).toThrow(/期限は付けない/);
  });
});

describe("1 問の流れ（K2：加算の取り忘れ）", () => {
  it("下書きで取り忘れの指摘 → 足して確定 → 正解、適用記録が書かれ、レベルの件数が増え、防いだ額が数えられる", () => {
    const k2 = app.caseOf(claimId("K2"));
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
    expect(() => app.start("nobody", claimId("K1"))).toThrow(/登録されていない/);
    expect(() => app.start("new1", claimId("K9"))).toThrow(/症例がない/);
  });
});

describe("時計とレセメン会議", () => {
  it("提出結果の外れを取り込み、土曜を過ぎるまで時計を進めると会議の整理が回り、議題に外れの確認が出る。知識は使い続ける", () => {
    const k6 = app.caseOf(claimId("K6"));
    const q = app.start("new1", k6.claimId);
    app.confirm(q.id, k6.lines);
    // K6 の知識（支払基金の BNP）は地域層なので、制度層の R11 に外れを付ける
    app.importClaimResult({ resultId: "r1", submissionId: q.id, kind: "原審査", outcome: "査定", kubun: ["D008_19"] });
    const r = app.advanceClock(at(17));
    expect(r.meeting).not.toBeNull();
    const items = app.agenda().items;
    expect(items.some((i) => i.kind === "miss" && i.knowledgeId === "system/r11")).toBe(true);
    expect(readKnowledge(app.store, "system/r11")?.status).toBe("承認済み");
  });
});

describe("K4：照合 → 医師確認 → 承認で病名が確定", () => {
  it("不一致が 1 件出て、医師確認を送り、医師が回答・承認すると傷病名が確定して不一致が消える", () => {
    const c1 = app.crosscheckOf(claimId("K4"));
    expect(c1.mismatches.map((m) => m.ruleId)).toEqual(["M01"]);
    const r = app.sendCrosscheck(claimId("K4"), "M01");
    expect(r.route).toBe("F1");
    expect(() => app.sendCrosscheck(claimId("K4"), "M01")).toThrow(/もう送ってある/);
    const id = r.route === "F1" ? r.query.id : "";
    app.answerDoctor(id, { option: "非弁膜症性心房細動", answeredBy: "院長" });
    app.approveDoctor(id, "院長");
    const c2 = app.crosscheckOf(claimId("K4"));
    expect(c2).toEqual({ mismatches: [], confirmed: ["非弁膜症性心房細動"] });
  });

  it("カルテのない症例は照合しない", () => {
    expect(app.crosscheckOf(claimId("K1")).mismatches).toEqual([]);
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
    expect(validateQuery(proxyConfirmDraft(claimId("K4"), "AF 継続 DOAC", "心房細動。DOAC を継続する。"))).toEqual([]);
    const scribed = parseScribe({ text: "心房細動。DOAC を継続する。", missing: [{ field: "心房細動の病型", why: "記載がない", target: "doctor" }, { field: "次回の訪問日", why: "記載がない", target: "clerk" }, { bad: 1 }] });
    expect(scribed.missing).toHaveLength(2);
    const r = app.proxySubmit(claimId("K4"), "AF 継続 DOAC", scribed);
    expect(r.query?.field).toBe("代行入力");
    expect(r.query?.indicators.at(-1)).toEqual({ source: "記載が足りない項目", text: "心房細動の病型（記載がない）" });
    expect(r.clerkTasks.map((t) => t.field)).toEqual(["次回の訪問日"]);
    app.answerDoctor(r.query!.id, { option: "この内容で確定する", answeredBy: "院長" });
    expect(app.approveDoctor(r.query!.id, "院長").query.status).toBe("承認済み");
  });
});

describe("選択モード", () => {
  it("選択モードで始めると、問題が引けて、選んだものが記録される。通常の問題では引けない", () => {
    const k1 = app.caseOf(claimId("K1"));
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
    const k4 = app.visits().filter((v) => v.claimId === claimId("K4"));
    expect(k4.map((v) => v.date)).toEqual([day(13), day(27)]);
    expect(k4[0].chart?.a).toBe("AF");
    expect(k4[0].lines.map((l) => [l.kubun, l.count])).toEqual([["C001_1I", 1], ["O001_3I", 1], ["O100_1HA", 1], ["C001_N13_DX", 1]]);
    expect(app.start("new1", claimId("K4"), "通常", day(27)).asOf).toBe(day(27));
    expect(() => app.start("new1", claimId("K4"), "通常", day(14))).toThrow();
  });
  it("確定しても提出にならず、件数・防いだ額に数えない。照合はその日までのカルテで出る", () => {
    app.advanceClock(at(13, "18:00:00"));
    const q = app.start("new1", claimId("K4"), "通常", day(13));
    const lines = app.caseFor(q).lines;
    app.draft(q.id, [...lines, { kubun: "C002-2_2RO1", count: 1, dates: [day(13)] }]);
    const c = app.confirm(q.id, lines);
    expect(c.correct).toBe(true);
    app.done(app.explain(q.id).id);
    expect(app.status("new1").count).toBe(0);
    expect(app.crosscheckOf(claimId("K4"), day(13)).mismatches.map((m) => m.ruleId)).toEqual(["M01"]);
    expect(app.outlookOf(q)).toContain("ここまで 1 回");
  });
});

describe("訪問カルテを書く（FR-69）", () => {
  const note = { s: "変わりなし", o: "", a: "AF", p: "DOAC 継続", rx: "" };
  it("書いて確かめた訪問が、その日の訪問の記録になり、訪問の時点の問題で判定できる", () => {
    app.advanceClock(at(20, "15:00:00"));
    expect(app.patients().map((p) => p.claimId)).toEqual([claimId("K1"), claimId("K2"), claimId("K3"), claimId("K4"), claimId("K5"), claimId("K7")]);
    const s = app.saveNote(claimId("K4"), "new1", "訪問診療", note);
    expect(s.date).toBe(day(20));
    expect(app.visits("new1").some((v) => v.claimId === claimId("K4") && v.date === day(20))).toBe(false);
    app.confirmNote(s.id, "new1", [{ kind: "処方", value: "DOAC", quote: "DOAC 継続" }]);
    const v = app.visits("new1").find((x) => x.claimId === claimId("K4") && x.date === day(20));
    // ほかの利用者には、この人が書いたカルテは重ならない
    const other = app.createClerk("審査員A");
    expect(app.visits(other.id).some((x) => x.claimId === claimId("K4") && x.date === day(20))).toBe(false);
    expect(v).toMatchObject({ written: true, chart: { a: "AF" } });
    const q = app.start("new1", claimId("K4"), "通常", day(20));
    expect(app.caseFor(q).lines.find((l) => l.kubun === "C001_1I")?.count).toBe(2);
    expect(app.crosscheckOf(claimId("K4"), day(20), "new1").mismatches.map((m) => m.ruleId)).toEqual(["M01"]);
  });
  it("カルテにない言葉の事実では確定できない。診療月の外の日には書けない", () => {
    app.advanceClock(at(20, "15:00:00"));
    const s = app.saveNote(claimId("K4"), "new1", "訪問診療", note);
    expect(() => app.confirmNote(s.id, "new1", [{ kind: "処方", value: "DOAC", quote: "エリキュース" }])).toThrow();
    app.advanceClock(`${dateIn(1, 2)}T09:00:00+09:00`);
    expect(() => app.saveNote(claimId("K4"), "new1", "訪問診療", note)).toThrow();
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
    expect(app.importedClaims(a.id)).toEqual([claimId("K6")]);
    expect(app.ukeList(a.id).map((u) => [u.name, u.payer, u.imported])).toEqual([["kokuhoren.UKE", "国保連", false], ["shiharaikikin.UKE", "支払基金", true]]);
    expect(() => app.importUke(a.id, "other.UKE")).toThrow();
  });
  it("以前の作り物のコードで作られた取り込み済みの UKE は、一覧から落とさず、行をまるごと点検の対象外として出す。形式そのものが読めないファイルは「読めない」と出し、点検には並べない。ほかのレセプトは今までどおり読める（design.md §11-1 の移行・§11-12）", () => {
    // 見本（K6）の請求 id とコードを差し替えて、以前の形式（99 で始まる作り物のコード）の UKE を置き場に置く
    const sample = new TextDecoder("shift_jis").decode(readFileSync(path.join(repo, "fixtures", "uke", "shiharaikikin.UKE")).subarray(0, -1));
    const old = sample.replace(claimId("K6"), `X9-${period.yearMonth}`).replace(/^(SI,\d+,\d+,)\d{9}/gm, `$1${"99"}0000031`);
    const bytes = Buffer.concat([iconv.encode(old, "Shift_JIS"), Buffer.from([0x1a])]);
    const name = `${createHash("sha256").update(bytes).digest("hex")}.UKE`;
    mkdirSync(path.join(tmp, "uke"), { recursive: true });
    writeFileSync(path.join(tmp, "uke", name), bytes);
    // 形式そのものが読めないファイル（最後のレコードが CRLF で終わらない。EOF がないだけなら読める）
    const broken = Buffer.concat([bytes.subarray(0, -3), Buffer.from([0x1a])]);
    const brokenName = `${createHash("sha256").update(broken).digest("hex")}.UKE`;
    writeFileSync(path.join(tmp, "uke", brokenName), broken);
    app.setSetting("uke-uploads", JSON.stringify([name, brokenName]));
    const a = app.createClerk("審査員A");
    expect(app.ukeList(a.id).map((u) => [u.name, u.unreadable?.reason ?? null, u.payer, u.receipts.map((x) => [x.claimId, x.otherRows, x.unreadable]), u.imported])).toEqual([
      ["kokuhoren.UKE", null, "国保連", ["K1", "K2", "K3", "K4", "K5", "K7"].map((k) => [claimId(k), 0, null]), false],
      ["shiharaikikin.UKE", null, "支払基金", [[claimId("K6"), 0, null]], false],
      // 以前のコードの行（2 行）は、版の表にないコードなので、点検の対象外の行として残る
      [name, null, "支払基金", [["U1-1", 2, null]], false],
      [brokenName, expect.stringContaining("いまの形式では読めない UKE"), null, [], false],
    ]);
    expect(() => app.importUke(a.id, brokenName)).toThrow("いまの形式では読めない UKE");
    const checked = app.ukeCheck("U1-1");
    if (!("lines" in checked)) throw new Error("読めるはずのレセプトが読めない");
    expect([checked.lines, checked.otherRows, checked.partial, checked.subtotal, checked.declared]).toEqual([[], 2, true, 0, { ho: 274, ko: [] }]);
    expect(app.cases().map((c) => c.claimId)).toEqual([...["K1", "K2", "K3", "K4", "K5", "K7", "K6"].map(claimId), "U1-1"]);
    app.importUke(a.id, "shiharaikikin.UKE");
    expect(app.importedClaims(a.id)).toEqual([claimId("K6")]);
  });
});

describe("コメントを持つ請求か（commentsKnown。design.md §11-13）", () => {
  it("UKE から作った請求は真。問題の請求（通常モード・選択モード・練習問題）は偽（行を入れ替えるだけで、コメントを直さないため）", () => {
    expect(app.cases().map((c) => c.commentsKnown)).toEqual(Array.from({ length: 7 }, () => true));
    app.importUke("new1", "kokuhoren.UKE");
    const normal = app.start("new1", claimId("K1"));
    const choice = app.start("new1", claimId("K2"), "選択");
    const drill = app.startDrill("new1", "d04");
    expect([normal, choice, drill].map((q) => app.caseFor(q).commentsKnown)).toEqual([false, false, false]);
  });
  it("摘要欄の記載（R17）は、UKE から作った請求をそのまま判定するときだけ当たる。問題の判定（下書き・確定・選択）には当たらない（§11-13 完了条件 (g)）", () => {
    // UKE のままの請求：R17 が当たり、同梱の UKE は必須のコメントが付いているので指摘は出ない
    for (const k of ["K1", "K2", "K3", "K4", "K5", "K7"]) {
      const r = app.judgeFor(app.start("new1", claimId(k)))(app.caseOf(claimId(k)));
      expect(r.applied, k).toContain("R17");
      expect(r.findings.filter((f) => f.ruleId === "R17"), k).toEqual([]);
    }
    // 通常モードの月末の問題：行を消して下書き・確定しても、UKE のコメントと行を突き合わせた指摘（記載もれ）は出ない
    const normal = app.start("new1", claimId("K2"));
    const cut = app.caseFor(normal).lines.filter((l) => l.kubun !== "C002_N10_HOKATSU" && l.kubun !== "C002_2RO1");
    const draft = app.draft(normal.id, cut).result;
    const done = app.confirm(normal.id, cut).confirmed!.result;
    for (const r of [draft, done]) expect([r.applied.includes("R17"), r.findings.some((f) => f.kind === "記載もれ")]).toEqual([false, false]);
    // 選択モードと練習問題も同じ
    const choice = app.start("new1", claimId("K2"), "選択");
    const drill = app.startDrill("new1", "d04");
    for (const q of [choice, drill]) expect(app.judgeFor(q)(app.caseFor(q)).applied).not.toContain("R17");
    const item = app.choices(choice.id)[0];
    if (item) expect(app.pick(choice.id, item.lineIndex, item.options[0]).findings.every((f) => f.ruleId !== "R17")).toBe(true);
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
  it("一覧には、本人が正解で終えた練習に cleared が付く（不正解・ほかの人の分は付かない）", () => {
    const q = app.startDrill("new1", "d04");
    app.confirm(q.id, app.caseFor(q).lines.filter((l) => l.kubun !== "B000"));
    const w = app.startDrill("new1", "d02");
    app.confirm(w.id, app.caseFor(w).lines);
    const list = app.drills("new1").fix;
    expect(list.find((d) => d.id === "d04")?.cleared).toBe(true);
    expect(list.find((d) => d.id === "d02")?.cleared).toBe(false);
    expect(app.drills("vet1").fix.every((d) => !d.cleared)).toBe(true);
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
    const sent = app.sendCrosscheck(claimId("K4"), "M01");
    if (sent.route !== "F1") throw new Error("医師確認にならない");
    app.answerDoctor(sent.query.id, { option: "非弁膜症性心房細動", answeredBy: "医師" });
    app.approveDoctor(sent.query.id, "医師");
    expect(app.drillState(q.id)).toMatchObject({ crosscheckOpen: false });
    expect(app.confirm(q.id, app.caseFor(q).lines).correct).toBe(true);
  });
});

describe("ローカルルール（FR-78・FR-79・FR-80）", () => {
  it("地域ルール（K6 の査定通知から）は K6（東京都・支払基金・BNP）に当てはまり、K1（国保連）には当てはまらない", () => {
    const made = app.seedLocalRules();
    expect(made).toHaveLength(13); // 院内 12 ＋ 地域 1
    expect(app.seedLocalRules()).toHaveLength(0); // 2 回目は入れない
    const k6 = app.start("new1", claimId("K6"));
    const area = (id: string) => app.localRulesOf(id).filter((r) => r.layer === "地域");
    expect(area(k6.id)).toHaveLength(1);
    expect(area(k6.id)[0]).toMatchObject({ source: "査定", usedByMentor: false });
    expect(app.localRulesOf(k6.id, app.caseFor(k6).lines.filter((l) => l.kubun !== "D008_19")).filter((r) => r.layer === "地域")).toHaveLength(0);
    expect(area(app.start("new1", claimId("K1")).id)).toHaveLength(0);
  });
  it("院内ルールは中身を伏せて区分の名前だけを出し、何年も使われていない承認済みのものが積み上がっている", () => {
    app.seedLocalRules();
    const k1 = app.start("new1", claimId("K1"));
    const inHouse = app.localRulesOf(k1.id).filter((r) => r.layer === "院内");
    expect(inHouse.every((r) => r.summary.endsWith("に関する院内ローカル"))).toBe(true);
    expect(inHouse.find((r) => r.summary.startsWith("在宅時医学総合管理料"))?.stale ?? inHouse.find((r) => r.id === "local/seed-01")?.stale).toBe(true);
    expect(inHouse.find((r) => r.id === "local/seed-08")).toMatchObject({ stale: false, lastUsed: dateIn(-1, 26) });
    expect(inHouse.some((r) => r.id === "local/seed-10")).toBe(false); // しまわれたものは出さない
    expect(inHouse.every((r) => !r.usedByMentor)).toBe(true); // 院内はメンターの助言に使わない
  });
  it("レセメン会議を開くと、長く使われていない院内ルールが要再検証に回る", () => {
    app.seedLocalRules();
    app.runMeeting();
    const st = Object.fromEntries(app.knowledgeList().map((k) => [k.id, k.status]));
    expect(st["local/seed-01"]).toBe("要再検証");
    expect(st["local/seed-08"]).toBe("承認済み");
    expect(st["local/seed-10"]).toBe("保管");
    expect(st["local/seed-11"]).toBe("未検証");
  });
});

describe("公的情報との突き合わせと、公的文書による再検証（FR-128〜131）", () => {
  /** BNP（D008_19）を対象に持つ、同梱の支払基金の文書（evidence-master §2-4） */
  const BNP_DOCS = ["SJ-133", "SJ-154", "SJ-210", "SJ-286", "SJ-319", "SJ-89"];
  /** K6 の合成の査定通知から入る地域ルール（支払基金・東京都・BNP。条件の注記あり） */
  function k6Rule() {
    const q = app.start("new1", claimId("K6"));
    return app.localRulesOf(q.id).find((r) => r.layer === "地域")!;
  }
  const historyEvents = () => listKnowledge(app.store).flatMap((m) => m.history.map((h) => h.event));

  it("本番の配線は、同梱のレジストリを会議の整理に渡している", () => {
    expect(app.deps.official?.docs.length).toBeGreaterThanOrEqual(10);
    expect(app.deps.official?.generationOf(period.yearMonth)).toBe("R8");
  });

  it("K6 の地域ルールに「関連あり・未照合」の結果と、BNP の文書への出典リンクが出る。出すのは要旨とリンクだけで、「整合」とは出さない", () => {
    app.seedLocalRules();
    const rule = k6Rule();
    expect(rule.official).toMatchObject({ verdict: "関連あり・未照合", approx: true });
    expect(rule.official.conditionNote).toContain("通知の理由：");
    expect(rule.official.docs.map((d) => d.id)).toEqual(BNP_DOCS);
    for (const d of rule.official.docs) {
      expect(d.url, d.id).toMatch(/^https:\/\/www\.hpdx\.or\.jp\/.+\.pdf#page=\d+$/);
      expect(d.verdict, d.id).toBe("関連あり・未照合");
      expect(Object.keys(d).sort(), d.id).toEqual(["id", "issuedOn", "issuer", "kind", "number", "stance", "summary", "url", "verdict"]);
      expect(d.summary, d.id).not.toMatch(/[0-9０-９]\s*(点|円)/);
    }
    // 読み比べる相手：確定病名への連月は認める／疑いへの連月は認めない
    expect(rule.official.docs.filter((d) => d.id === "SJ-133" || d.id === "SJ-319").map((d) => d.stance)).toEqual(["認める", "認めない"]);
  });

  it("どのローカルルールにも 4 つの結果のどれか 1 つが付く。当たる文書がなければ「公的根拠なし」で、出典は出ない", () => {
    app.seedLocalRules();
    const rules = [claimId("K1"), claimId("K6")].flatMap((c) => app.localRulesOf(app.start("new1", c).id));
    expect(rules.length).toBeGreaterThan(3);
    for (const r of rules) {
      expect(["整合", "矛盾の恐れ", "公的根拠なし", "関連あり・未照合"], r.id).toContain(r.official.verdict);
      expect(r.official.docs.length > 0, r.id).toBe(r.official.verdict !== "公的根拠なし");
    }
    // 血液採取の院内ルール（seed-07）には、当たる文書がない。管理料の院内ルール（seed-01）には、疑義解釈が当たる
    expect(rules.find((r) => r.id === "local/seed-07")?.official).toMatchObject({ verdict: "公的根拠なし", approx: false, conditionNote: null, docs: [] });
    expect(rules.find((r) => r.id === "local/seed-01")?.official.docs.map((d) => d.id)).toEqual(["GK-R8-02-Q66", "GK-R8-06-Q15", "GK-R8-08-Q9", "GK-R8-10-Q3"]);
    // 同梱の文書はどれも条件の注記を持つので、矛盾の恐れ・整合は出ない
    expect(rules.some((r) => r.official.verdict === "矛盾の恐れ" || r.official.verdict === "整合")).toBe(false);
  });

  it("K6 の地域ルールを承認して時計を改選日の後へ進めると、会議の議題（確かめ直し）に出る。同梱の文書では公的文書のトリガーは 1 件も出ない", () => {
    app.seedLocalRules();
    const rule = k6Rule();
    app.verify(rule.id, true);
    app.advanceClock(`${dateIn(8, 5)}T09:00:00+09:00`);
    expect(readKnowledge(app.store, rule.id)?.status).toBe("要再検証");
    const item = app.agenda().items.find((i) => i.kind === "recheck" && i.knowledgeId === rule.id)!;
    expect(item.reason).toEqual({ kind: "recheck", event: "TRIGGER{reappointment}", trigger: "reappointment" });
    expect(item.choices.map((c) => c.label)).toEqual(expect.arrayContaining(["その他", "判定不能"]));
    expect(historyEvents()).not.toContain("TRIGGER{official}");
    expect(historyEvents()).not.toContain("OFFICIAL_BASELINE");
  });

  it("（合成の文書）BNP を条件なしに認める文書がレジストリに入ると、K6 の地域ルールは「矛盾の恐れ」になり、時計を進めると要再検証になって議題に出る。自動では停止しない", () => {
    app.seedLocalRules();
    // 実在の文書ではない。レジストリに後から 1 件足された状況を作る
    const added = makeDoc({ id: "X-BNP", stance: "認める", scope: { kubun: ["D008_19"], payer: "支払基金" } });
    app.deps.official!.docs.push(added);
    const rule = k6Rule();
    expect(rule.official).toMatchObject({ verdict: "矛盾の恐れ", approx: true });
    expect(rule.official.docs.map((d) => [d.id, d.verdict])).toEqual([...BNP_DOCS.map((id) => [id, "関連あり・未照合"]), ["X-BNP", "矛盾の恐れ"]]);
    app.verify(rule.id, true);
    // 未承認の間は動かない。承認の次の会議で議題に出る
    app.advanceClock(at(14));
    const after = readKnowledge(app.store, rule.id)!;
    expect(after.status).toBe("要再検証");
    expect(after.history.at(-1)).toMatchObject({ event: "TRIGGER{official}", basis: { trigger: "official", officialIds: [docKey(added)] } });
    const item = app.agenda().items.find((i) => i.kind === "recheck" && i.knowledgeId === rule.id)!;
    expect(item.reason).toMatchObject({ trigger: "official", official: [{ id: "X-BNP", url: added.url, summary: added.summary, seen: false }] });
    expect((item.reason as { conditionNote?: string }).conditionNote).toContain("通知の理由：");
    expect(app.agenda().items.some((i) => i.kind === "disposal" && i.knowledgeId === rule.id)).toBe(false);
    // 要再検証の間は、メンターが助言に使わない
    expect(k6Rule()).toMatchObject({ status: "要再検証", usedByMentor: false });
    // 責任者が「今も正しい」と答えると承認済みに戻り、同じ文書では二度と要再検証にならない
    expect(app.answerAgenda(item.itemId, 1)).toEqual({ status: "applied" });
    expect(readKnowledge(app.store, rule.id)).toMatchObject({ status: "承認済み", official_seen: [docKey(added)] });
    app.advanceClock(at(24));
    expect(readKnowledge(app.store, rule.id)?.status).toBe("承認済み");
    // 欄の表示は確認済みかどうかを見ない（矛盾の恐れと出続ける）
    expect(k6Rule().official.verdict).toBe("矛盾の恐れ");
  });
});

describe("初回のあいさつで決めた名前（FR-27）", () => {
  it("名前を保存すると呼び方が変わり、会話は切れ、あいさつ済みになる", () => {
    app.setSession("new1", "s-old");
    expect(app.welcomed("new1")).toBe(false);
    expect(app.setClerkName("new1", "  トシ  ").name).toBe("トシ");
    expect(app.clerk("new1")).toMatchObject({ name: "トシ", session_id: null });
    expect(app.welcomed("new1")).toBe(true);
  });
  it("1〜20 文字で、改行・制御文字・指示の書式に使う記号は受け付けない", () => {
    expect(() => cleanName("")).toThrow("1〜20");
    expect(() => cleanName("あ".repeat(21))).toThrow("1〜20");
    for (const bad of ["トシ\n# 指示", "a`b`", "<script>", "**太字**", "a|b"]) expect(() => cleanName(bad)).toThrow("使えない文字");
    expect(cleanName("中澤 トシ")).toBe("中澤 トシ");
    expect(() => app.setClerkName("new1", "トシ\n")).not.toThrow(); // 前後の改行は落とす
  });
});

describe("採番（件数ではなく、いまある番号の最大の次）", () => {
  const rawDb = () => new Database(path.join(tmp, "app.db"));
  it("メンター同士の問い：行が消えていても、既存の問いと同じ id を振らない", () => {
    const a = app.peerToHuman("new1", "在医総管の区分は？").queued;
    const b = app.peerToHuman("new1", "包括的支援加算は？").queued;
    expect([a, b]).toEqual(["P0001", "P0002"]);
    const db = rawDb();
    db.prepare("DELETE FROM peer_questions WHERE id = ?").run(a);
    db.close();
    expect(app.peerToHuman("new1", "処方箋料は？").queued).toBe("P0003");
    expect(app.peerList().map((p) => [p.id, p.question])).toEqual([["P0002", "包括的支援加算は？"], ["P0003", "処方箋料は？"]]);
  });
  it("利用者：行が消えていても、既存の利用者と同じ id を振らず、上書きしない", () => {
    const a = app.createClerk("審査員A");
    const b = app.createClerk("審査員B");
    const db = rawDb();
    db.prepare("DELETE FROM clerks WHERE id = ?").run(a.id);
    db.close();
    const c = app.createClerk("審査員C");
    expect(c.id).not.toBe(b.id);
    expect(c.id).toMatch(/^u\d{4}$/);
    expect(app.clerk(b.id).name).toBe("審査員B");
  });
  it("改善提案：番号が飛んでいても、既存の提案と同じ id を振らない。要約に改行があれば断る", () => {
    const a = app.propose({ summary: "提案 1", body: "本文" });
    const b = app.propose({ summary: "提案 2", body: "本文" });
    rmSync(path.join(tmp, "knowledge", a.id), { recursive: true, force: true });
    const c = app.propose({ summary: "提案 3", body: "本文" });
    expect(c.id).not.toBe(b.id);
    expect(c.id).toMatch(/^local\/proposal-\d{4}$/);
    expect(readKnowledge(app.store, b.id)?.summary).toBe("提案 2");
    expect(() => app.propose({ summary: "1 行目\n2 行目", body: "本文" })).toThrow(expect.objectContaining({ status: 400 }));
  });
});

describe("時計を進める処理の順序", () => {
  it("途中の処理が失敗したら、時計は進まない", () => {
    // 医師確認の記録が壊れていると、リマインド・保留の処理が失敗する
    mkdirSync(path.join(tmp, "query-log"), { recursive: true });
    writeFileSync(path.join(tmp, "query-log", "q-broken.json"), "{ 壊れた記録");
    expect(() => app.advanceClock(at(14))).toThrow();
    expect(app.now()).toBe(at(13));
    rmSync(path.join(tmp, "query-log", "q-broken.json"));
    expect(app.advanceClock(at(14)).now).toBe(at(14));
    expect(app.now()).toBe(at(14));
  });
});

describe("代行入力（F3）", () => {
  it("下書きが点数・金額に触れていると、医師確認にせず 400 の文言で断る", () => {
    const scribed = { text: "処方箋料を算定した", missing: [] };
    expect(() => app.proxySubmit(claimId("K1"), "処方箋料を算定", scribed)).toThrow(expect.objectContaining({ status: 400, message: expect.stringContaining("医師確認の要件を満たさない") }));
    expect(app.doctorQueries()).toEqual([]);
    expect(app.proxySubmit(claimId("K1"), "訪問した。変わりなし", { text: "訪問した。変わりなし。", missing: [] }).query).not.toBeNull();
  });
});
