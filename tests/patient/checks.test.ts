// 患者情報チェック P01〜P08（src/patient/checks.ts）と、患者マスタから Facts を出す関数（src/patient/profile.ts）。
// 番号・氏名・生年月日はすべて架空（検証番号は EM §2-5 P-2 の算法で合わせてある）
import { describe, expect, it } from "vitest";
import { PATIENT_FINDING_TEXT, patientFindingText } from "../../src/messages";
import { CHECK_BASIS, PATIENT_CHECK_IDS, PATIENT_FINDING_KINDS, checkDigitOf, checkDigitOk, checkPatient, type CheckBasis, type PatientCheckId } from "../../src/patient/checks";
import { ageOn, factsFromPatient, type Coverage, type PatientProfile } from "../../src/patient/profile";

/** 確かめ済みの医保（後期高齢者・1 割・期限あり） */
const medical = (over: Partial<Coverage> = {}): Coverage => ({
  coverageId: "C1",
  kind: "医保",
  position: 0,
  payerNumber: "39139993",
  symbol: "",
  memberNo: "00000001",
  burdenRatio: 0.1,
  validFrom: "2024-08-01",
  validUntil: "2025-07-31",
  source: "保険証・資格確認書",
  checkedBy: "new1",
  checkedAt: "2025-03-10T09:00:00+09:00",
  ...over,
});
const kohi = (over: Partial<Coverage> = {}): Coverage => ({ ...medical(), coverageId: "C2", kind: "公費", position: 1, payerNumber: "54139993", memberNo: "9999996", burdenRatio: null, source: "受給者証", ...over });
/** 指摘が 1 つも出ない患者（85 歳・後期高齢者・レセプト種別 1318） */
const profile = (over: Partial<PatientProfile> = {}): PatientProfile => ({
  patientId: "P0001",
  name: "架空　一郎",
  sex: 1,
  birth: "19390401",
  coverages: [medical()],
  careCertification: { validUntil: "2025-09-30" },
  receiptType: "1318",
  ...over,
});
const basis: CheckBasis = { yearMonth: "2025-03", today: "2025-03-10", serviceDates: ["2025-03-05", "2025-03-19"] };
const keys = (p: PatientProfile, b: CheckBasis = basis) => checkPatient(p, b).map((f) => f.messageKey);
const of = (id: PatientCheckId, p: PatientProfile, b: CheckBasis = basis) => checkPatient(p, b).filter((f) => f.checkId === id).map((f) => [f.kind, f.messageKey]);

describe("患者情報チェックの枠", () => {
  it("そろった患者には指摘が出ない", () => {
    expect(checkPatient(profile(), basis)).toEqual([]);
  });

  it("P 系のすべての id に根拠があり、P01〜P05 は EM の行に対応する。P06〜P08 は日付と形だけを見るので仕様の FR を根拠にする", () => {
    expect(Object.keys(CHECK_BASIS)).toEqual([...PATIENT_CHECK_IDS]);
    for (const id of ["P01", "P02", "P03", "P04", "P05"] as const) {
      expect(CHECK_BASIS[id].em.length).toBeGreaterThan(0);
      for (const row of CHECK_BASIS[id].em) expect(row).toMatch(/^(P-\d+|L-\d+|\d+-\d+)$/);
    }
    for (const id of ["P06", "P07", "P08"] as const) expect(CHECK_BASIS[id]).toMatchObject({ em: [], spec: expect.stringMatching(/^FR-\d+$/) });
  });

  it("指摘の種類は 4 つで閉じ、文言のキーはすべて文言を持つ。文言は点数・金額に触れず、禁止語を使わない", () => {
    const bad: PatientProfile = profile({ name: "", sex: 9, birth: "20250230", coverages: [medical({ payerNumber: "123", burdenRatio: null, validUntil: null, checkedAt: null }), kohi({ payerNumber: "12139990", memberNo: "1" }), kohi({ coverageId: "C3", position: 2, payerNumber: "54139993" })], careCertification: null });
    const fs = checkPatient(bad, basis);
    expect(fs.length).toBeGreaterThan(5);
    for (const f of fs) {
      expect(PATIENT_FINDING_KINDS).toContain(f.kind);
      expect(PATIENT_FINDING_TEXT[f.messageKey]).toBeTruthy();
      expect(f.reference).toMatch(/^(EM §2-5 |spec FR-)/);
    }
    for (const text of Object.values(PATIENT_FINDING_TEXT)) expect(text).not.toMatch(/点数|円|金額|教育|学習|学ぶ|教える/);
    // 文言に番号・氏名・生年月日は入らない（差し込むのは法別番号だけ）
    expect(patientFindingText({ messageKey: "P05.order", params: { first: "54", second: "12" } })).toBe("公費の順番を確かめてください（法別番号 54 は 12 より先に書きます）");
  });
});

describe("P01 番号の桁数と検証番号", () => {
  it("検証番号の算法は EM P-2 の例（06-13-048 → 8）に合う", () => {
    expect(checkDigitOf("0613048")).toBe(8);
    expect(checkDigitOk("06130488")).toBe(true);
    expect(checkDigitOk("06130480")).toBe(false);
    // 下 1 桁が 0 なら検証番号は 0
    expect(checkDigitOf("19")).toBe(0);
  });

  it("医保：8 桁か 6 桁で検証番号が合えば出ない。桁数違い・検証番号違いは形式の指摘", () => {
    expect(of("P01", profile())).toEqual([]);
    expect(of("P01", profile({ coverages: [medical({ payerNumber: "138057" })], receiptType: "1112", birth: "19700401" }))).toEqual([]);
    expect(of("P01", profile({ coverages: [medical({ payerNumber: "39139999" })] }))).toEqual([["形式", "P01.insurer_check_digit"]]);
    expect(of("P01", profile({ coverages: [medical({ payerNumber: "3913999" })] }))).toEqual([["形式", "P01.insurer_length"]]);
  });

  it("公費：負担者番号は 8 桁、受給者番号は 7 桁で、それぞれ検証番号を見る", () => {
    const p = (k: Partial<Coverage>) => profile({ coverages: [medical(), kohi(k)], receiptType: "1328" });
    expect(of("P01", p({}))).toEqual([]);
    expect(of("P01", p({ payerNumber: "54139999", memberNo: "9999999" }))).toEqual([["形式", "P01.kohi_payer_check_digit"], ["形式", "P01.recipient_check_digit"]]);
    expect(of("P01", p({ payerNumber: "541399", memberNo: "99999960" }))).toEqual([["形式", "P01.kohi_payer_length"], ["形式", "P01.recipient_length"]]);
  });
});

describe("P02 生年月日と保険の種類", () => {
  it("満年齢は誕生日の当日に上がる", () => {
    expect(ageOn("1950-03-01", "2025-02-28")).toBe(74);
    expect(ageOn("1950-03-01", "2025-03-01")).toBe(75);
  });

  it("75 歳以上で後期高齢者でない医保は指摘。月の初日が誕生日なら当たり、月の途中で 75 歳になる月は出さない", () => {
    const kyokai = (birth: string) => profile({ birth, coverages: [medical({ payerNumber: "01139997", burdenRatio: 0.2 })], receiptType: "1118" });
    expect(of("P02", kyokai("19500301"))).toEqual([["不整合", "P02.over_75_not_late_elderly"]]);
    expect(of("P02", kyokai("19500302"))).toEqual([]);
    expect(of("P02", kyokai("19540401"))).toEqual([]);
  });

  it("後期高齢者で 65 歳未満は指摘。65〜74 歳は確かめた記録が付くまで確認を促す。月末までに 75 歳になるなら出さない", () => {
    const late = (birth: string, c: Partial<Coverage> = {}) => profile({ birth, coverages: [medical(c)] });
    expect(of("P02", late("19600401"))).toEqual([["不整合", "P02.late_elderly_under_65"]]);
    expect(of("P02", late("19550401", { checkedAt: null, checkedBy: null }))).toContainEqual(["不整合", "P02.late_elderly_65_74"]);
    expect(of("P02", late("19550401"))).toEqual([]);
    // 月の末日が 75 歳の誕生日／その翌日
    expect(of("P02", late("19500331", { checkedAt: null, checkedBy: null }))).toEqual([]);
    expect(of("P02", late("19500401", { checkedAt: null, checkedBy: null }))).toEqual([["不整合", "P02.late_elderly_65_74"]]);
  });
});

describe("P03 負担割合", () => {
  it("入っていなければ情報不足。入力すると消える", () => {
    expect(of("P03", profile({ coverages: [medical({ burdenRatio: null })] }))).toEqual([["情報不足", "P03.missing"]]);
    expect(of("P03", profile())).toEqual([]);
  });

  it("患者マスタに入っていなくても、症例側に値があれば未入力とはしない。その値でも不整合は見る。患者マスタの値があればそちらで見る", () => {
    const none = medical({ burdenRatio: null });
    expect(of("P03", profile({ coverages: [none], caseBurdenRatio: 0.1 }))).toEqual([]);
    expect(of("P03", profile({ coverages: [none], caseBurdenRatio: null }))).toEqual([["情報不足", "P03.missing"]]);
    expect(of("P03", profile({ coverages: [none], caseBurdenRatio: 0.3 }))).toEqual([["不整合", "P03.receipt_type_ratio"]]);
    expect(of("P03", profile({ coverages: [medical({ burdenRatio: 0.3 })], caseBurdenRatio: 0.1 }))).toEqual([["不整合", "P03.receipt_type_ratio"]]);
  });

  it("後期高齢者は 1・2・3 割、70〜74 歳は 2 割か 3 割。レセプト種別とも合わせる", () => {
    expect(of("P03", profile({ coverages: [medical({ burdenRatio: 0.5 })] }))).toEqual([["不整合", "P03.late_elderly_ratio"]]);
    const k6 = (ratio: number, receiptType = "1118", birth = "19540401") => profile({ birth, receiptType, coverages: [medical({ payerNumber: "01139997", burdenRatio: ratio })] });
    expect(of("P03", k6(0.2))).toEqual([]);
    expect(of("P03", k6(0.1))).toEqual([["不整合", "P03.age_70_74_ratio"]]);
    expect(of("P03", k6(0.3))).toEqual([["不整合", "P03.receipt_type_ratio"]]);
    expect(of("P03", k6(0.3, "1110"))).toEqual([]);
    // 月の初日に 69 歳（その月に 70 歳になる）なら、70〜74 歳の決まりは当てない
    expect(of("P03", k6(0.1, "1112", "19550302"))).toEqual([]);
    // 後期高齢者：1318 は 1・2 割、1310 は 3 割
    expect(of("P03", profile({ coverages: [medical({ burdenRatio: 0.3 })] }))).toEqual([["不整合", "P03.receipt_type_ratio"]]);
    expect(of("P03", profile({ coverages: [medical({ burdenRatio: 0.3 })], receiptType: "1310" }))).toEqual([]);
  });
});

describe("P04 レセプト種別コード", () => {
  it("保険の種類・公費の数・年齢が合えば出ない", () => {
    expect(of("P04", profile())).toEqual([]);
    expect(of("P04", profile({ coverages: [medical(), kohi()], receiptType: "1328" }))).toEqual([]);
  });

  it("後期高齢者のコードなのに医保が別、公費の数が違う、高齢受給者のコードなのに 70 歳未満、は指摘", () => {
    expect(of("P04", profile({ receiptType: "1118" }))).toContainEqual(["不整合", "P04.insurance_kind"]);
    expect(of("P04", profile({ coverages: [medical(), kohi()] }))).toEqual([["不整合", "P04.kohi_count"]]);
    expect(of("P04", profile({ receiptType: "1328" }))).toEqual([["不整合", "P04.kohi_count"]]);
    const kyokai = (birth: string, receiptType: string) => profile({ birth, receiptType, coverages: [medical({ payerNumber: "01139997", burdenRatio: 0.2 })] });
    expect(of("P04", kyokai("19600401", "1118"))).toEqual([["不整合", "P04.age"]]);
    expect(of("P04", kyokai("19540401", "1112"))).toEqual([["不整合", "P04.age"]]);
    expect(of("P04", kyokai("19540401", "1118"))).toEqual([]);
  });

  it("EM にないコードと、請求のない患者は判定しない", () => {
    expect(of("P04", profile({ receiptType: "1122", coverages: [medical(), kohi()] }))).toEqual([]);
    expect(of("P04", profile({ receiptType: null, coverages: [medical(), kohi()] }))).toEqual([]);
  });
});

describe("P05 公費の順位", () => {
  const two = (first: string, second: string) => profile({ receiptType: null, coverages: [medical(), kohi({ payerNumber: first }), kohi({ coverageId: "C3", position: 2, payerNumber: second })] });
  it("54（難病）は 12（生保）より先。逆なら指摘", () => {
    expect(of("P05", two("54139993", "12139992"))).toEqual([]);
    const fs = checkPatient(two("12139992", "54139993"), basis).filter((f) => f.checkId === "P05");
    expect(fs.map((f) => [f.kind, f.messageKey, f.params])).toEqual([["不整合", "P05.order", { first: "54", second: "12" }]]);
  });
  it("一覧にない法別番号（地方単独の公費など）とは比べない", () => {
    expect(of("P05", two("80139990", "54139993"))).toEqual([]);
  });
});

describe("P06 資格・受給者証の有効期間", () => {
  it("期限が入っていなければ情報不足。確かめて入力する（期限の定めなしを含む）と消える", () => {
    expect(of("P06", profile({ coverages: [medical({ validFrom: null, validUntil: null, checkedAt: null, checkedBy: null })] }))).toEqual([["情報不足", "P06.no_period_insurance"]]);
    expect(of("P06", profile({ coverages: [medical({ validFrom: null, validUntil: null })] }))).toEqual([]);
    expect(of("P06", profile({ receiptType: "1328", coverages: [medical(), kohi({ validUntil: null, checkedAt: null })] }))).toEqual([["情報不足", "P06.no_period_kohi"]]);
  });

  it("時計が期限の先に進むと期限の指摘。期限の当日は出ない", () => {
    const p = profile({ coverages: [medical({ validUntil: "2025-03-31" })] });
    expect(of("P06", p, { ...basis, today: "2025-03-31" })).toEqual([]);
    expect(of("P06", p, { ...basis, today: "2025-04-01" })).toEqual([["期限", "P06.expired"]]);
  });

  it("診療日が期間の外なら期限の指摘。月の途中の切替で、どの診療日もどちらかの期間に入っていれば出ない", () => {
    const until15 = medical({ validUntil: "2025-03-15" });
    expect(of("P06", profile({ coverages: [until15] }))).toEqual([["期限", "P06.outside_period"]]);
    expect(of("P06", profile({ coverages: [until15] }), { ...basis, serviceDates: ["2025-03-05", "2025-03-15"], today: "2025-03-15" })).toEqual([]);
    const next = medical({ coverageId: "C9", validFrom: "2025-03-16", validUntil: "2026-07-31" });
    expect(of("P06", profile({ coverages: [until15, next] }), { ...basis, today: "2025-03-20" })).toEqual([]);
    // 診療日が分からないときは、月の途中の切替を確かめてもらう
    expect(of("P06", profile({ coverages: [until15] }), { yearMonth: "2025-03", today: "2025-03-10" })).toEqual([["期限", "P06.mid_month"]]);
  });

  it("その月に有効な医保がなければ指摘。期間の重なる医保が 2 件あれば情報不足", () => {
    expect(of("P06", profile({ coverages: [medical({ validUntil: "2025-02-28" })] }))).toEqual([["期限", "P06.no_valid_insurance"]]);
    const open = { validFrom: null, validUntil: null, checkedAt: null, checkedBy: null };
    expect(of("P06", profile({ coverages: [medical(open), medical({ ...open, coverageId: "C9", payerNumber: "01139997" })] }))).toContainEqual(["情報不足", "P06.overlap"]);
  });
});

describe("P07 要介護認定の有効期間", () => {
  it("要介護度の記録がない患者には出さない（認定を受けていない人もいる）。記録があるのに有効期間がなければ情報不足", () => {
    expect(of("P07", profile({ careCertification: null }))).toEqual([]);
    expect(of("P07", profile({ careCertification: { validUntil: null } }))).toEqual([["情報不足", "P07.missing"]]);
  });

  it("期限の当日までは出ず、翌日から期限の指摘。期限が近いと知らせる", () => {
    const p = profile({ careCertification: { validUntil: "2025-05-31" } });
    expect(of("P07", p)).toEqual([]);
    expect(of("P07", p, { ...basis, today: "2025-05-01" })).toEqual([["期限", "P07.expiring_soon"]]);
    expect(of("P07", p, { ...basis, today: "2025-05-31" })).toEqual([["期限", "P07.expiring_soon"]]);
    expect(of("P07", p, { ...basis, today: "2025-06-01" })).toEqual([["期限", "P07.expired"]]);
  });
});

describe("P08 記録の形式", () => {
  it("氏名なし・暦にない生年月日・未来の生年月日・読めない性別は形式の指摘", () => {
    expect(of("P08", profile())).toEqual([]);
    expect(of("P08", profile({ name: "　" }))).toEqual([["形式", "P08.name_missing"]]);
    expect(of("P08", profile({ birth: "19390230" }))).toEqual([["形式", "P08.birth_format"]]);
    expect(of("P08", profile({ birth: "1939-04-01" }))).toEqual([["形式", "P08.birth_format"]]);
    expect(keys(profile({ birth: "20250311", coverages: [] }))).toContain("P08.birth_future");
    expect(keys(profile({ birth: "20250310", coverages: [] }))).not.toContain("P08.birth_future");
    expect(of("P08", profile({ sex: 3 }))).toEqual([["形式", "P08.sex_code"]]);
  });
});

describe("患者マスタから Facts を出す", () => {
  it("年齢は診療年月の初日の満年齢。保険種別と負担割合は、その月に有効な医保から", () => {
    expect(factsFromPatient(profile(), "2025-03")).toEqual({ age: { known: true, value: 85 }, insurance: { known: true, value: "後期高齢者" }, burdenRatio: { known: true, value: 0.1 } });
    expect(factsFromPatient(profile({ birth: "19390301" }), "2025-03").age).toEqual({ known: true, value: 86 });
    expect(factsFromPatient(profile({ birth: "19390302" }), "2025-03").age).toEqual({ known: true, value: 85 });
    expect(factsFromPatient(profile({ coverages: [medical({ payerNumber: "01139997", burdenRatio: 0.2 })] }), "2025-03")).toMatchObject({ insurance: { known: true, value: "協会けんぽ" }, burdenRatio: { known: true, value: 0.2 } });
    expect(factsFromPatient(profile({ coverages: [medical({ payerNumber: "138057" })] }), "2025-03").insurance).toEqual({ known: true, value: "国保" });
  });

  it("有効な医保が 0 件・2 件以上、値が入っていないときは「分からない」", () => {
    const unknown = { known: false };
    expect(factsFromPatient(profile({ coverages: [medical({ validUntil: "2025-02-28" })] }), "2025-03")).toMatchObject({ insurance: unknown, burdenRatio: unknown });
    expect(factsFromPatient(profile({ coverages: [medical(), medical({ coverageId: "C9" })] }), "2025-03")).toMatchObject({ insurance: unknown, burdenRatio: unknown });
    expect(factsFromPatient(profile({ coverages: [medical({ burdenRatio: null })] }), "2025-03")).toMatchObject({ insurance: { known: true, value: "後期高齢者" }, burdenRatio: unknown });
    expect(factsFromPatient(profile({ birth: "x" }), "2025-03").age).toEqual(unknown);
  });
});
