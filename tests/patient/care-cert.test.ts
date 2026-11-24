// 期限を診療年月で比べる（design.md §18-1。判断 A）と、要介護・要支援の認定 careCert（C-510・C-493・C-504）
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluate } from "../../src/engine";
import { careLevelOf, careStateOf, certifiedOf, effectiveFor, validatePatientFact, type PatientFact, type PatientFactInput } from "../../src/patient/facts";
import { openApp, type App } from "../../src/server/app";
import { claimId, dateIn, day, month, YM } from "../helpers/period";

const row = (f: Partial<PatientFact> & Pick<PatientFact, "key" | "value">, checkedAt = `${day(3)}T09:00:00+09:00`): PatientFact => ({ patientId: "P1", source: "介護保険証", validUntil: null, checkedAt, checkedBy: "new1", ...f });
const cert = (kind: "要介護" | "要支援", level: number, validFrom: string, validUntil: string) => row({ key: "careCert", value: { kind, level, validFrom }, validUntil });

describe("effectiveFor（診療年月の全部の日に効くか）", () => {
  it("終わりが末日以上なら効き、月の中の日・月より前なら効かない。始まりが初日以下なら効き、月の中・月より後なら効かない", () => {
    expect(effectiveFor({ validUntil: null }, YM)).toBe(true);
    expect(effectiveFor({ validUntil: dateIn(0, 31) }, YM)).toBe(true);
    expect(effectiveFor({ validUntil: day(15) }, YM)).toBe(false);
    expect(effectiveFor({ validUntil: dateIn(-1, 30) }, YM)).toBe(false);
    expect(effectiveFor({ validUntil: null, validFrom: day(1) }, YM)).toBe(true);
    expect(effectiveFor({ validUntil: null, validFrom: day(2) }, YM)).toBe(false);
    expect(effectiveFor({ validUntil: null, validFrom: dateIn(1, 1) }, YM)).toBe(false);
  });
});

describe("careStateOf・careLevelOf・certifiedOf", () => {
  it("要介護 3（月の全部の日）は careLevel 3・認定あり。要支援 2 は careLevel 0・認定あり。認定なしは careLevel 0・認定なし", () => {
    const s = careStateOf([cert("要介護", 3, dateIn(-6, 1), dateIn(5, 30))], YM);
    expect([careLevelOf(s, 3), certifiedOf(s)]).toEqual([{ known: true, value: 3 }, { known: true, value: true }]);
    const t = careStateOf([cert("要支援", 2, dateIn(-6, 1), dateIn(5, 30))], YM);
    expect([careLevelOf(t, 3), certifiedOf(t)]).toEqual([{ known: true, value: 0 }, { known: true, value: true }]);
    // 認定なし：確かめた診療月から 6 か月効く（design.md §18-12 の 1）
    const n = careStateOf([row({ key: "careCert", value: { kind: "認定なし", forMonth: YM } }, `${dateIn(1, 10)}T09:00:00+09:00`)], YM);
    expect([careLevelOf(n, 3), certifiedOf(n)]).toEqual([{ known: true, value: 0 }, { known: true, value: false }]);
  });

  it("月の途中で始まる・切れる認定は分からない。分からないの行も分からない", () => {
    expect(careStateOf([cert("要介護", 3, day(10), dateIn(5, 30))], YM)).toEqual({ known: false });
    expect(careStateOf([cert("要介護", 3, dateIn(-6, 1), day(15))], YM)).toEqual({ known: false });
    expect(careStateOf([row({ key: "careCert", value: { kind: "分からない" } })], YM)).toEqual({ known: false });
  });

  it("月の途中で区分が変わった続いた 2 行：要介護 3 以上かが同じなら careLevel は効き、違えば分からない。認定ありかは要介護・要支援で同じなら効く", () => {
    const a = cert("要介護", 3, dateIn(-6, 1), day(15));
    const b = cert("要介護", 4, day(16), dateIn(5, 30));
    const s = careStateOf([a, b], YM);
    expect([careLevelOf(s, 3), certifiedOf(s)]).toEqual([{ known: true, value: 4 }, { known: true, value: true }]);
    const c = cert("要支援", 2, day(16), dateIn(5, 30));
    const t = careStateOf([a, c], YM);
    expect([careLevelOf(t, 3), certifiedOf(t)]).toEqual([{ known: false }, { known: true, value: true }]);
    // 続いていない 2 行（間が空く）は分からない
    expect(careStateOf([a, cert("要介護", 4, day(17), dateIn(5, 30))], YM)).toEqual({ known: false });
  });

  it("今までの careLevel の行：始まりの日を持たず、終わりだけを診療年月で比べる。0 は認定の区分が分からない（R03 は 0 のまま。C-504）", () => {
    const zero = careStateOf([row({ key: "careLevel", value: 0, validUntil: dateIn(3, 31) })], YM);
    expect([careLevelOf(zero, 3), certifiedOf(zero)]).toEqual([{ known: true, value: 0 }, { known: false }]);
    const two = careStateOf([row({ key: "careLevel", value: 2, validUntil: dateIn(3, 31) })], YM);
    expect(certifiedOf(two)).toEqual({ known: true, value: true });
    // careCert の行があれば、そちらだけを読む
    expect(certifiedOf(careStateOf([row({ key: "careLevel", value: 2, validUntil: dateIn(3, 31) }), row({ key: "careCert", value: { kind: "分からない" } })], YM))).toEqual({ known: false });
  });
});

describe("「認定なし（確かめた）」の効く範囲（design.md §18-12 の 1）", () => {
  it("確かめた診療月から 6 か月目まで効き、前の月と 7 か月目には効かない。翌月に確かめても、答えた請求の診療年月に効く", () => {
    const n = [row({ key: "careCert", value: { kind: "認定なし", forMonth: YM } }, `${dateIn(1, 10)}T09:00:00+09:00`)];
    expect([-1, 0, 5, 6].map((m) => certifiedOf(careStateOf(n, month(m))))).toEqual([{ known: false }, { known: true, value: false }, { known: true, value: false }, { known: false }]);
  });
});

describe("入力の検査（validatePatientFact）", () => {
  const now = `${day(13)}T09:00:00+09:00`;
  const v = (f: Omit<PatientFactInput, "source"> & { source?: PatientFactInput["source"] }) => () => validatePatientFact({ source: "介護保険証", ...f }, now);
  it("要介護・要支援は始まりと終わりの日が要り、区分の範囲を確かめる。認定なし・分からないは日付を持たない。終わりが今日より前でも残せる", () => {
    expect(v({ key: "careCert", value: { kind: "要介護", level: 3, validFrom: dateIn(-6, 1) }, validUntil: dateIn(-1, 30) })).not.toThrow();
    expect(v({ key: "careCert", value: { kind: "要介護", level: 6, validFrom: dateIn(-6, 1) }, validUntil: dateIn(5, 30) })).toThrow(/1〜5/);
    expect(v({ key: "careCert", value: { kind: "要支援", level: 3, validFrom: dateIn(-6, 1) }, validUntil: dateIn(5, 30) })).toThrow(/1・2/);
    expect(v({ key: "careCert", value: { kind: "要介護", level: 3 } as never, validUntil: dateIn(5, 30) })).toThrow(/始まり/);
    expect(v({ key: "careCert", value: { kind: "要介護", level: 3, validFrom: dateIn(-6, 1) }, validUntil: null })).toThrow(/終わり/);
    expect(v({ key: "careCert", value: { kind: "要介護", level: 3, validFrom: dateIn(6, 1) }, validUntil: dateIn(5, 30) })).toThrow(/始まりが、終わりより後/);
    expect(v({ key: "careCert", value: { kind: "認定なし" }, validUntil: null })).not.toThrow();
    expect(v({ key: "careCert", value: { kind: "認定なし" }, validUntil: dateIn(5, 30) })).toThrow(/期限は付けない/);
    expect(v({ key: "careCert", value: { kind: "分からない", level: 1 } as never, validUntil: null })).toThrow(/区分と日付を付けない/);
  });
});

describe("請求の判定（design.md §18-9 の 2）", () => {
  let tmp: string;
  let app: App;
  const repo = path.join(__dirname, "..", "..");
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "iji-care-"));
    app = openApp({ root: repo, dbFile: path.join(tmp, "app.db"), knowledgeDir: path.join(tmp, "knowledge"), skillsDir: path.join(tmp, "skills"), queryLogDir: path.join(tmp, "query-log") });
    app.upsertClerk({ id: "new1", name: "新人", callName: "さん", characterId: "a", role: "clerk" });
  });
  afterEach(() => {
    app.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("翌月の時計で、基準月の請求から「認定なし」を残すと、基準月の請求に効く（確かめた診療月を付ける。design.md §18-12 の 1）", () => {
    app.advanceClock(`${month(1)}-10T09:00:00+09:00`);
    app.savePatientFact(claimId("K4"), "new1", { key: "careCert", value: { kind: "認定なし" }, source: "介護保険証", validUntil: null });
    expect(app.patientFacts(claimId("K4")).facts.find((f) => f.key === "careCert")?.value).toEqual({ kind: "認定なし", forMonth: YM });
    expect(app.caseOf(claimId("K4")).facts.careLevel).toEqual({ known: true, value: 0 });
  });

  it("基準月の請求を翌月の時計で点検して、基準月の末日まで有効の要介護度が効く。15 日まで有効なら分からないになり、情報不足が出る", () => {
    app.advanceClock(`${month(1)}-10T09:00:00+09:00`);
    app.savePatientFact(claimId("K4"), "new1", { key: "careCert", value: { kind: "要介護", level: 2, validFrom: dateIn(-6, 1) }, source: "介護保険証", validUntil: dateIn(0, 31) });
    expect(app.caseOf(claimId("K4")).facts.careLevel).toEqual({ known: true, value: 2 });
    expect(evaluate(app.caseOf(claimId("K4"))).findings).toEqual([]);
    app.savePatientFact(claimId("K4"), "new1", { key: "careCert", value: { kind: "要介護", level: 2, validFrom: dateIn(-6, 1) }, source: "介護保険証", validUntil: day(15) });
    expect(app.caseOf(claimId("K4")).facts.careLevel).toEqual({ known: false });
    expect(evaluate(app.caseOf(claimId("K4"))).findings.map((f) => [f.ruleId, f.kind, f.missing?.field])).toEqual([["R03", "情報不足", "careLevel"]]);
  });
});

describe("月の途中で要介護度が変わった月の R17（design.md §18-12 の 4）", () => {
  it("区間で値が違う月は careLevelMixed が立つ（R03 は境が同じなら効くまま）", async () => {
    const { tempApp, upload, fileOf, receiptOf } = await import("../helpers/care");
    const t = tempApp();
    try {
      const [id] = upload(t.app, fileOf([receiptOf(1, YM, [{ kubun: "C001_1I", count: 2, dates: [day(6), day(20)] }, { kubun: "C002_2RO1", count: 1, dates: [day(20)] }])]));
      t.app.savePatientFact(id, "new1", { key: "careCert", value: { kind: "要介護", level: 3, validFrom: dateIn(-6, 1) }, source: "介護保険証", validUntil: day(15) });
      t.app.savePatientFact(id, "new1", { key: "careCert", value: { kind: "要介護", level: 4, validFrom: day(16) }, source: "介護保険証", validUntil: dateIn(5, 30) });
      expect([t.app.caseOf(id).facts.careLevel, t.app.caseOf(id).facts.careLevelMixed]).toEqual([{ known: true, value: 4 }, { known: true, value: true }]);
    } finally {
      t.close();
    }
  });
});

describe("過去の月の答えが、後の月の値を上書きしない（design.md §18-12 の 1。X-370）", () => {
  it("翌月から有効の要介護 3 を残したあとで、基準月の「認定なし」を答えても、翌月は要介護 3（包括的支援加算は対象のまま）、基準月は認定なし", async () => {
    const { tempApp, upload, fileOf, receiptOf } = await import("../helpers/care");
    const t = tempApp();
    try {
      const lines = (ym: string) => [{ kubun: "C001_1I", count: 2, dates: [`${ym}-06`, `${ym}-20`] }, { kubun: "C002_2RO1", count: 1, dates: [`${ym}-20`] }, { kubun: "C002_N10_HOKATSU", count: 1, dates: [`${ym}-20`] }];
      const [oct, nov] = upload(t.app, fileOf([receiptOf(1, YM, lines(YM)), receiptOf(1, month(1), lines(month(1)))]));
      t.app.savePatientFact(nov, "new1", { key: "careCert", value: { kind: "要介護", level: 3, validFrom: dateIn(1, 1) }, source: "介護保険証", validUntil: dateIn(7, 28) });
      t.app.savePatientFact(oct, "new1", { key: "careCert", value: { kind: "認定なし" }, source: "介護保険証", validUntil: null });
      // v40（全会一致）：翌月は、翌月に答えた要介護 3 と、あとに残した前の月の認定なしが、どちらも負けずに食い違うので分からない（確定の 0 にしない）
      expect([t.app.caseOf(oct).facts.careLevel, t.app.caseOf(nov).facts.careLevel]).toEqual([{ known: true, value: 0 }, { known: false }]);
      expect(evaluate(t.app.caseOf(nov)).findings.filter((f) => f.messageKey === "R03.not_eligible")).toEqual([]);
    } finally {
      t.close();
    }
  });
});

describe("同じ月の訂正（design.md §18-12 の 1。X-380）", () => {
  it("誤って要介護 1（1〜12 月）を残したあとで、翌月分の点検で「分からない」を答えると、翌月は分からない（R03 は確定の not_eligible を出さない）。基準月は要介護 1 のまま", async () => {
    const { tempApp, upload, fileOf, receiptOf } = await import("../helpers/care");
    const t = tempApp();
    try {
      const lines = (ym: string) => [{ kubun: "C001_1I", count: 2, dates: [`${ym}-06`, `${ym}-20`] }, { kubun: "C002_2RO1", count: 1, dates: [`${ym}-20`] }, { kubun: "C002_N10_HOKATSU", count: 1, dates: [`${ym}-20`] }];
      const [oct, nov] = upload(t.app, fileOf([receiptOf(1, YM, lines(YM)), receiptOf(1, month(1), lines(month(1)))]));
      t.app.savePatientFact(oct, "new1", { key: "careCert", value: { kind: "要介護", level: 1, validFrom: dateIn(-9, 1) }, source: "介護保険証", validUntil: dateIn(2, 31) });
      t.app.savePatientFact(nov, "new1", { key: "careCert", value: { kind: "分からない" }, source: "介護保険証", validUntil: null });
      expect([t.app.caseOf(oct).facts.careLevel, t.app.caseOf(nov).facts.careLevel]).toEqual([{ known: true, value: 1 }, { known: false }]);
      expect(evaluate(t.app.caseOf(nov)).findings.filter((f) => f.ruleId === "R03" && f.kind !== "情報不足")).toEqual([]);
      // あとから誤った認定を同じ始まりの日で残し直せば（訂正）、またそれが効く
      t.app.savePatientFact(nov, "new1", { key: "careCert", value: { kind: "要介護", level: 3, validFrom: dateIn(-9, 1) }, source: "介護保険証", validUntil: dateIn(2, 31) });
      expect(t.app.caseOf(nov).facts.careLevel).toEqual({ known: true, value: 3 });
    } finally {
      t.close();
    }
  });
});

describe("申請中（EM §7-2 U-71。2026-11-24 利用者の判断）", () => {
  it("答えた月から 6 か月の窓で語り（v40）、R03 には分からない（careLevel を渡さない）、④・短期入所には認定なしに準じる", () => {
    const rows = [row({ key: "careCert", value: { kind: "申請中", forMonth: YM } })];
    const s = careStateOf(rows, YM);
    expect([careLevelOf(s, 3), certifiedOf(s)]).toEqual([{ known: false }, { known: true, value: false }]);
    expect(careLevelOf(careStateOf(rows, month(1)), 3)).toEqual({ known: false });
    expect(careStateOf(rows, month(6))).toEqual({ known: false });
    expect(() => validatePatientFact({ key: "careCert", value: { kind: "申請中" }, source: "介護保険証", validUntil: null }, `${day(13)}T09:00:00+09:00`)).not.toThrow();
  });
});

describe("申請中は、それより前に答えた「認定なし」の 6 か月を断ち切る（C-530）", () => {
  it("9 月「認定なし」→ 10 月「申請中」の順で、10・11・12 月は分からない（R03 に 0 を渡さず、聞き取りの対象になる）。9 月は認定なし", () => {
    const rows = [row({ key: "careCert", value: { kind: "認定なし", forMonth: month(-1) } }), row({ key: "careCert", value: { kind: "申請中", forMonth: YM } })];
    expect(certifiedOf(careStateOf(rows, month(-1)))).toEqual({ known: true, value: false });
    expect(careLevelOf(careStateOf(rows, YM), 3)).toEqual({ known: false });
    for (const m of [1, 2]) expect([m, careLevelOf(careStateOf(rows, month(m)), 3)]).toEqual([m, { known: false }]);
  });
});

describe("「分からない」は答えた診療月だけに効く（C-533）", () => {
  it("10 月「認定なし」のあとで 9 月分に「分からない」を答えても、10 月〜は認定なしのまま。9 月は分からない", () => {
    const rows = [row({ key: "careCert", value: { kind: "認定なし", forMonth: YM } }), row({ key: "careCert", value: { kind: "分からない", forMonth: month(-1) } })];
    expect(careStateOf(rows, month(-1))).toEqual({ known: false });
    for (const m of [0, 3]) expect(certifiedOf(careStateOf(rows, month(m)))).toEqual({ known: true, value: false });
  });
});

describe("「この認定は申請の結果ですか」（design.md §18-12 の 1 v40）", () => {
  it("申請中が残っている患者に期間つきの認定を入れるときだけ聞く。はい→申請中に勝つ、いいえ・分からない→両方残って分からない。答えは行に残る", async () => {
    const { tempApp, upload, fileOf, receiptOf } = await import("../helpers/care");
    const t = tempApp();
    try {
      const lines = [{ kubun: "C001_1I", count: 2, dates: [day(6), day(20)] }, { kubun: "C002_2RO1", count: 1, dates: [day(20)] }];
      const [id] = upload(t.app, fileOf([receiptOf(1, YM, lines)]));
      const cert = (extra: object = {}) => ({ key: "careCert" as const, value: { kind: "要介護" as const, level: 3, validFrom: dateIn(-1, 1), ...extra }, source: "介護保険証" as const, validUntil: dateIn(5, 28) });
      expect(t.app.patientFacts(id).applicationPending).toBe(false);
      t.app.savePatientFact(id, "new1", { key: "careCert", value: { kind: "申請中" }, source: "介護保険証", validUntil: null });
      expect(t.app.patientFacts(id).applicationPending).toBe(true);
      expect(() => t.app.savePatientFact(id, "new1", cert())).toThrow(/申請の結果/);
      expect(() => t.app.savePatientFact(id, "new1", cert({ fromApplication: "たぶん" }))).toThrow(/申請の結果/);
      t.app.savePatientFact(id, "new1", cert({ fromApplication: "いいえ" }));
      expect(t.app.caseOf(id).facts.careLevel).toEqual({ known: false });
      expect((t.app.patientFacts(id).facts.find((f) => f.key === "careCert")?.value as { fromApplication?: string }).fromApplication).toBe("いいえ");
      t.app.savePatientFact(id, "new1", cert({ fromApplication: "はい" }));
      expect(t.app.caseOf(id).facts.careLevel).toEqual({ known: true, value: 3 });
      expect(t.app.patientFacts(id).applicationPending).toBe(false);
    } finally {
      t.close();
    }
  });
  it("zod でも答えの形を確かめる", async () => {
    const { factBody } = await import("../../src/server/schemas/patients");
    const v = (fromApplication: unknown) => factBody.safeParse({ fact: { key: "careCert", value: { kind: "要介護", level: 3, validFrom: day(1), fromApplication }, source: "介護保険証", validUntil: day(28) } }).success;
    expect([v("はい"), v("いいえ"), v("分からない"), v("たぶん")]).toEqual([true, true, true, false]);
  });
});

describe("「申請の結果ですか」を聞く条件は、入れる認定の期間で決める（round-87 C-560）", () => {
  const setup = async () => {
    const { tempApp, upload, fileOf, receiptOf } = await import("../helpers/care");
    const t = tempApp();
    const lines = (ym: string) => [{ kubun: "C001_1I", count: 2, dates: [`${ym}-06`, `${ym}-20`] }, { kubun: "C002_2RO1", count: 1, dates: [`${ym}-20`] }];
    const ids = upload(t.app, fileOf([receiptOf(1, YM, lines(YM)), receiptOf(1, month(1), lines(month(1))), receiptOf(1, month(6), lines(month(6)))]));
    return { t, oct: ids[0], nov: ids[1], apr: ids[2] };
  };
  const old1 = { key: "careCert" as const, value: { kind: "要介護" as const, level: 1, validFrom: dateIn(-6, 1) }, source: "介護保険証" as const, validUntil: dateIn(5, 28) };
  it("10 月分の申請中 → 11 月分の分からない → 11 月の請求から前からの要介護 1 を入れるときも聞く（答えがなければ断る）。いいえと答えれば 10 月は分からない", async () => {
    const { t, oct, nov } = await setup();
    try {
      t.app.savePatientFact(oct, "new1", { key: "careCert", value: { kind: "申請中" }, source: "介護保険証", validUntil: null });
      t.app.savePatientFact(nov, "new1", { key: "careCert", value: { kind: "分からない" }, source: "介護保険証", validUntil: null });
      expect(t.app.patientFacts(nov, { validFrom: old1.value.validFrom, validUntil: old1.validUntil }).applicationPending).toBe(true);
      expect(() => t.app.savePatientFact(nov, "new1", old1)).toThrow(/申請の結果/);
      t.app.savePatientFact(nov, "new1", { ...old1, value: { ...old1.value, fromApplication: "いいえ" } });
      expect(t.app.caseOf(oct).facts.careLevel).toEqual({ known: false });
    } finally {
      t.close();
    }
  });
  it("申請中の窓を過ぎた月の請求から、申請中の月を覆う前からの認定を入れるときも聞く", async () => {
    const { t, oct, apr } = await setup();
    try {
      t.app.savePatientFact(oct, "new1", { key: "careCert", value: { kind: "申請中" }, source: "介護保険証", validUntil: null });
      expect(t.app.patientFacts(apr).applicationPending).toBe(false);
      expect(() => t.app.savePatientFact(apr, "new1", old1)).toThrow(/申請の結果/);
    } finally {
      t.close();
    }
  });
});
