// 合成の症例 K25〜K31（EM §5-1。fixtures/care/kaigo.json・kaigo.UKE）で、design.md §18-9 の完了条件 3〜7 を縛る（v37 21e）。
// 合成の UKE を取り込み、聞き取りの画面と同じ入口（app の saveCare など）で申告を答えてから、取り込んだレセプトの点検（ukeCheck）を見る。AI は呼ばない
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dateOf, generateKaigo, KAIGO_FILE, loadKaigo, type KaigoCase } from "../../scripts/gen-care-uke";
import { CARE_SCOPE_TEXT } from "../../src/engine/care-judge";
import type { Finding } from "../../src/engine/types";
import { findingText } from "../../src/messages";
import { evaluate } from "../../src/engine";
import { claimForAi } from "../../src/llm/outbound";
import { turnContext } from "../../src/mentor/prompt";
import { checkDraft, confirm, startQuestion } from "../../src/practice/practice";
import { preventedOf } from "../../src/prevented/prevented";
import { handCertaintyOf } from "../../src/server/app/review";
import type { App } from "../../src/server/app";
import { repo, tempApp } from "../helpers/care";
import { at, YM } from "../helpers/period";

const cfg = loadKaigo();
/** EM §5-1 の症例の行（design.md §18-12 の 3：完了条件 3 はこの行で縛る）。正解の指摘の件数と、点検の範囲に出る「見ていません」の文 */
const emRows = readFileSync(path.join(repo, "design", "iji-context", "sources", "evidence-master-iji-context.md"), "utf8").split("\n");
function emAnswer(id: string): { count: number; notes: string[] } {
  const row = emRows.find((l) => l.startsWith(`| ${id} |`));
  if (!row) throw new Error(`EM §5-1 に行がない: ${id}`);
  const seg = /正解の指摘：([^|（]*)/.exec(row)?.[1] ?? "";
  return { count: [...seg.matchAll(/(\d+) 件/g)].reduce((n, m) => n + Number(m[1]), 0), notes: [...seg.matchAll(/「([^」]*見ていません)」/g)].map((m) => m[1]) };
}
const basis = { checkedOn: dateOf(cfg.basis.checkedOn.m, cfg.basis.checkedOn.d), source: cfg.basis.source as "ケアマネジャーからの連絡" };

let app: App;
let close: () => void;
let ids: Record<string, string>;
beforeEach(() => {
  ({ app, close } = tempApp());
  const files = app.uploadUke("new1", readFileSync(path.join(repo, KAIGO_FILE)));
  const receipts = files.filter((f) => f.uploaded).flatMap((f) => f.receipts);
  // 基準月の請求の id（患者の番号 → 請求 id）
  ids = Object.fromEntries(receipts.filter((r) => app.caseOf(r.claimId).yearMonth === YM).map((r) => [r.patientNo!, r.claimId]));
});
afterEach(() => close());

type Override = Partial<KaigoCase["declare"]>;
/** 設定の申告を答える（聞き取りの画面と同じ入口）。over で項目を差し替える（undefined は答えない） */
function answer(c: KaigoCase, over: Override = {}) {
  const id = ids[c.id];
  const d = { ...c.declare, ...over } as Record<string, unknown>;
  const homes = Object.fromEntries(cfg.homes.map((h) => {
    const hh = h as { key: string; name: string; kind: string; placedPhysician: string; mitoriFacility: string; recheck: { m: number; d: number } };
    const saved = app.saveCareHome("new1", { name: hh.name, kind: hh.kind as never, placedPhysician: hh.placedPhysician as never, mitoriFacility: (d.mitori as never) ?? (hh.mitoriFacility as never), recheckOn: dateOf(hh.recheck.m, hh.recheck.d), ...basis, source: "施設との契約" });
    return [hh.key, saved.at(-1)!.homeId];
  }));
  const cert = d.careCert as { kind: "要介護" | "要支援"; level: number } | undefined;
  if (cert) app.savePatientFact(id, "new1", { key: "careCert", value: { ...cert, validFrom: dateOf(-6, 1) }, source: "介護保険証", validUntil: dateOf(5, 30) });
  const res = d.residence as { type: string; home?: string } | undefined;
  if (res) app.saveCare(id, "new1", { item: "residenceType", value: { type: res.type as never, ...(res.home ? { careHomeId: homes[res.home] } : {}), ...(d.midMonth ? { changedMidMonth: true } : {}) }, ...basis });
  const stay = d.shortStay as "none" | { kind: string; start: number; end: number; fromDischarge: string } | undefined;
  if (stay === "none") app.saveCare(id, "new1", { item: "shortStay", value: { status: "使っていない" }, ...basis });
  else if (stay) app.saveCare(id, "new1", { item: "shortStay", value: { status: "使った", uses: [{ kind: stay.kind as never, start: dateOf(0, stay.start), end: dateOf(0, stay.end), fromDischarge: stay.fromDischarge as never }] }, ...basis });
  const others = d.others as "none" | { name: string; kind: string; specialRelation: string; kanriSide: string; activities: Record<string, string>; referredOn?: { m: number; d: number } }[] | undefined;
  if (others === "none") app.saveOtherNone(id, "new1", basis);
  else if (others) for (const o of others) app.saveOther(id, "new1", { ...o, kind: o.kind as never, specialRelation: o.specialRelation as never, kanriSide: o.kanriSide as never, activities: o.activities as never, referredOn: o.referredOn ? dateOf(o.referredOn.m, o.referredOn.d) : null, ...basis });
  if (typeof d.terminalCancer === "boolean") app.savePatientFact(id, "new1", { key: "terminalCancer", value: d.terminalCancer, source: "医師に確認", validUntil: null });
  return id;
}
type Check = { findings: Finding[]; missing: Finding[]; conditionalCount: number; generic: { scope: { notDone: string[] } } };
const check = (id: string) => app.ukeCheck(id) as unknown as Check;
const careFindings = (id: string) => check(id).findings.filter((f) => f.ruleId === "R20" || f.ruleId === "R21");
const notDone = (id: string) => check(id).generic.scope.notDone;
const caseOf = (id: string) => cfg.cases.find((c) => c.id === id)!;

describe("合成の UKE（fixtures/care/kaigo.UKE）", () => {
  it("設定（kaigo.json）から作り直したものと一致し、K25〜K31 の基準月の請求と K26 の前の月の請求が読める", () => {
    expect(readFileSync(path.join(repo, KAIGO_FILE)).equals(generateKaigo())).toBe(true);
    expect(Object.keys(ids).sort()).toEqual(["K25", "K26", "K27", "K28", "K29", "K30", "K31"]);
  });
});

describe("完了条件 3：場面ごとの正解の表（EM §5-1）どおりの条件つきの指摘", () => {
  for (const c of cfg.cases) {
    it(`${c.id}：${c.expected.join("・")}。文は前提から始まり、確かめた日を含む`, () => {
      const id = answer(c);
      const f = careFindings(id);
      expect(f.filter((x) => x.kind !== "情報不足").map((x) => x.messageKey)).toEqual(c.expected);
      // 件数は EM §5-1 の行の正解の指摘の件数
      const em = emAnswer(c.id);
      expect([c.id, f.filter((x) => x.kind !== "情報不足").length]).toEqual([c.id, em.count]);
      // 確かめた日：聞き取りの申告は答えた確かめた日、要介護・要支援の認定は患者の事実を残した日
      const certOn = app.patientFacts(id).facts.find((x) => x.key === "careCert")?.checkedAt.slice(0, 10);
      for (const x of f) {
        expect(x.params?.conditional).toBe("1");
        expect(findingText(x)).toMatch(/^(申告（|求めた機関が 1 つなら)/);
        expect(findingText(x)).toContain(x.messageKey === "R20.renkei" ? certOn : basis.checkedOn);
      }
      // 申告を全部答えた請求では、介護・ほかの機関の「見ていません」は出ない（先頭の「見ている場面」だけ）。
      // 行に書いた「見ていません」（K27：前の月の請求を取り込んでいないので、利用前 30 日の当院の訪問が分からない。C-502）だけが残る
      expect(notDone(id).filter((t) => Object.values(CARE_SCOPE_TEXT).includes(t as never))).toEqual([CARE_SCOPE_TEXT.scenes, ...em.notes]);
    });
  }

  it("③ 自宅の患者の小多機の宿泊の月に施医総管：R16 の確定の指摘が 1 件で、R20 は出さない", () => {
    const id = answer(caseOf("K27"), { residence: { type: "自宅" } });
    expect(check(id).findings.filter((f) => ["R16", "R20"].includes(f.ruleId)).map((f) => [f.messageKey, f.params?.conditional])).toEqual([["R16.use_zaii", undefined]]);
  });

  it("当たらない側：末期の悪性腫瘍（K25）・施設の基準が「はい」（K25）・ないと確かめた（K29）・使っていないと確かめた（K26）・同じ法人のステーションの訪問看護の月（K31）では出ない", () => {
    expect(careFindings(answer(caseOf("K25"), { terminalCancer: true }))).toEqual([]);
    close();
    ({ app, close } = tempApp());
    ids = reupload();
    const k25 = answer(caseOf("K25"), { mitori: "はい" });
    expect(careFindings(k25)).toEqual([]);
    expect(notDone(k25)).toContain(CARE_SCOPE_TEXT.mitori);
    expect(careFindings(answer(caseOf("K29"), { others: "none" }))).toEqual([]);
    expect(careFindings(answer(caseOf("K26"), { shortStay: "none" }))).toEqual([]);
    expect(careFindings(answer(caseOf("K31"), { others: [{ name: "架空の訪問看護ステーションひかり", kind: "訪問看護ステーション", specialRelation: "はい", kanriSide: "取っていない", activities: { "ステーションの訪問看護（医療保険）": "はい" } }] }))).toEqual([]);
  });
});

function reupload(): Record<string, string> {
  const receipts = app.uploadUke("new1", readFileSync(path.join(repo, KAIGO_FILE))).filter((f) => f.uploaded).flatMap((f) => f.receipts);
  return Object.fromEntries(receipts.filter((r) => app.caseOf(r.claimId).yearMonth === YM).map((r) => [r.patientNo!, r.claimId]));
}

describe("完了条件 4：申告がない・分からない・期限切れ・月の途中の変化・読みが割れる", () => {
  it("申告がなければ、指摘を出さず「見ていません」（介護・ほかの機関）", () => {
    for (const c of cfg.cases) {
      const id = ids[c.id];
      expect([c.id, careFindings(id).filter((f) => f.kind !== "情報不足").map((f) => f.messageKey).filter((k) => k !== "R21.visit2_count")]).toEqual([c.id, []]);
      expect(notDone(id).some((t) => t === CARE_SCOPE_TEXT.careUnknown || t === CARE_SCOPE_TEXT.othersUnknown || t === CARE_SCOPE_TEXT.noReferrer)).toBe(true);
    }
  });
  it("住まいの種別が「分からない」・認定の期限が月の中で切れる（K28）では「見ていません」", () => {
    const k25 = answer(caseOf("K25"), { residence: { type: "分からない" } });
    expect([careFindings(k25), notDone(k25).includes(CARE_SCOPE_TEXT.careUnknown)]).toEqual([[], true]);
    const k28 = ids.K28;
    app.saveCare(k28, "new1", { item: "residenceType", value: { type: "自宅" }, ...basis });
    app.saveCare(k28, "new1", { item: "shortStay", value: { status: "使っていない" }, ...basis });
    app.savePatientFact(k28, "new1", { key: "careCert", value: { kind: "要支援", level: 2, validFrom: dateOf(-6, 1) }, source: "介護保険証", validUntil: dateOf(0, 15) });
    expect([careFindings(k28), notDone(k28).includes(CARE_SCOPE_TEXT.careUnknown)]).toEqual([[], true]);
  });
  it("月の途中で住まいが変わった月（K27）と、退院日から始めた短期入所生活介護（K26）は、それぞれの文が出る", () => {
    const k27 = answer(caseOf("K27"), { midMonth: true });
    expect([careFindings(k27), notDone(k27).includes(CARE_SCOPE_TEXT.midMonth)]).toEqual([[], true]);
    const k26 = answer(caseOf("K26"), { shortStay: { kind: "短期入所生活介護", start: 20, end: 24, fromDischarge: "はい" } });
    expect([careFindings(k26), notDone(k26).includes(CARE_SCOPE_TEXT.split)]).toEqual([[], true]);
  });
});

describe("完了条件 5：条件つきの数え方", () => {
  it("条件つきの指摘は、取り込んだレセプトの点検で条件つきの数に入り、I-1 の突き合わせでは「条件つき」。防いだ額に入らない", () => {
    const id = answer(caseOf("K28"));
    const c = check(id);
    expect(c.conditionalCount).toBe(1);
    const f = c.findings.find((x) => x.messageKey === "R20.renkei")!;
    expect(handCertaintyOf(f)).toBe("条件つき");
    expect(handCertaintyOf({ ...f, params: {} })).toBe("確定");
    // 月末の点検の形：下書きで R20 の条件つきの指摘が出て、C010 を外して確定しても、防いだ額に数えない
    const ctx = app.caseOf(id);
    const T = at(20);
    let q = startQuestion("q", "new1", id, T);
    q = checkDraft(q, ctx, T).question;
    expect(q.drafts[0].findings.some((x) => x.messageKey === "R20.renkei")).toBe(true);
    q = confirm(q, { ...ctx, lines: ctx.lines.filter((l) => l.kubun !== "C010") }, T);
    expect(preventedOf(q).filter((i) => i.ruleId === "R20")).toEqual([]);
  });
});

describe("完了条件 6：R16・導出 D03 と住まいの種別", () => {
  it("老健（K25 の住まいを差し替え）では R16 が情報不足を出さない。短期入所生活介護の月（K26）は在医総管でも施医総管でも R16 は黙り、R16 と R20 が逆の向きを言わない", () => {
    const k25 = answer(caseOf("K25"), { residence: { type: "老健" } });
    expect(check(k25).findings.concat(check(k25).missing).filter((f) => f.ruleId === "R16")).toEqual([]);
    const k26 = answer(caseOf("K26"));
    const r16 = (id: string) => check(id).findings.concat(check(id).missing).filter((f) => f.ruleId === "R16");
    expect(r16(k26)).toEqual([]);
    expect(careFindings(k26).map((f) => f.messageKey)).toContain("R20.seikatsu_family");
  });
});

describe("完了条件 7：消す・監査ログ・AI に送る文脈", () => {
  it("患者 id を持つ 3 表は、患者マスタを消すと残らない（取り込んだファイルを消す全表走査）", () => {
    for (const c of cfg.cases) answer(c);
    const db = new Database(app.paths.dbFile);
    const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    expect(["patient_care", "other_institutions", "other_institutions_none"].map(count).every((n) => n > 0)).toBe(true);
    const sha = (app.ukeList("new1") as { name: string; uploaded: boolean }[]).find((u) => u.uploaded)!.name.slice(0, 64);
    app.deleteUpload(sha);
    expect(["patient_care", "other_institutions", "other_institutions_none"].map(count)).toEqual([0, 0, 0]);
    // 院内の設定（入所先の施設）は残る
    expect(count("care_homes")).toBeGreaterThan(0);
    db.close();
  });

  it("AI に送る文脈（メンターの指示文）に、申告の値・機関名・施設名が入らない", () => {
    const id = answer(caseOf("K31"));
    const k25 = answer(caseOf("K25"));
    for (const x of [id, k25]) {
      const ctx = app.caseOf(x);
      // メンターに渡すのは、claimForAi を通した請求と、判定の結果から作る文脈だけ（src/llm/outbound.ts・src/mentor/prompt.ts）
      const text = JSON.stringify(claimForAi(ctx)) + turnContext(evaluate(ctx), true);
      for (const secret of ["架空のひかり病院", "架空の特養さくら", "特別の関係", "特養（地域密着型を含む）", basis.source, "申告（"]) expect(text).not.toContain(secret);
    }
  });
});
