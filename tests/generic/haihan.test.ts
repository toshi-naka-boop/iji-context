// 段 15a：背反の特例条件の例外（design.md §13-2〜§13-5）。データは同梱しないので、小さな表（tests/generic/small-tensuhyo.ts。EM の錨と EM §2-8 のコードだけ）で確かめる。
// 出荷の例外の決まり（config/haihan-exceptions.json）は、往診料×訪問診療料（HP-01）で掛ける。ほかの形（レセプトで当たらない・ウ・日ごとの問い・同時の表・2 つの組）は、
// テスト用に作った決まり（EM の行ではない）を makeG05 に渡して確かめる
import { describe, expect, it } from "vitest";
import { r2026 } from "../../src/engine/revisions/r2026";
import type { Finding } from "../../src/engine/types";
import { overlap } from "../../src/generic/overlap";
import { evaluateGeneric } from "../../src/generic";
import { makeG05 } from "../../src/generic/g05";
import { HAIHAN, haihanKey, type HaihanConfig, type HaihanException } from "../../src/generic/haihan";
import { genericScopeOf } from "../../src/generic/scope";
import type { TimedClaim } from "../../src/generic/tensuhyo";
import type { GenericAboutMore, GenericFinding } from "../../src/generic/types";
import { genericText } from "../../src/messages";
import { YM } from "../helpers/period";
import { GEN, put } from "./small-masters";
import { C, putHaihan, tensuhyoMasters } from "./small-tensuhyo";

type Unit = TimedClaim["units"][number];
const unit = (codes: string[], days: number[]): Unit => {
  const d = Array.from({ length: 31 }, () => 0);
  for (const n of days) d[n - 1]++;
  return { items: codes.map((code) => ({ kind: "SI" as const, code })), count: days.length, days: d };
};
const TERMINAL = "114018370"; // EM §2-8 C001_N6_TERMINAL（在宅ターミナルケア加算）
const REASON = "830100086"; // EM §2-10 T162-reason（往診が必要になった理由）
const day = (n: number) => `${YM}-${String(n).padStart(2, "0")}`;
/** 事実：日付ごとの 2 つ（sameDaySeparate・sameDayOushinAfterVisit）と看取りの場所だけを持つ（G05 が読むのはこれだけ） */
const factsOf = (f: { separate?: Record<string, boolean>; after?: Record<string, boolean>; deathPlace?: string }) =>
  ({
    sameDaySeparate: f.separate ? { known: true, value: f.separate } : { known: false },
    sameDayOushinAfterVisit: f.after ? { known: true, value: f.after } : { known: false },
    deathPlace: f.deathPlace ? { known: true, value: f.deathPlace } : { known: false },
  }) as unknown as GenericAboutMore["facts"];
/** 答え：key と日付（請求ごとは ""）→ 選択肢の文字列 */
const answersOf = (m: Record<string, string> = {}) => (key: string, date: string | null) => m[`${key}|${date ?? ""}`] ?? null;
const g05Of = (units: Unit[], about: Partial<GenericAboutMore> = {}, opts: { db?: ReturnType<typeof tensuhyoMasters>; config?: HaihanConfig; certain?: ReadonlySet<string>; comments?: string[] } = {}) => {
  const db = opts.db ?? tensuhyoMasters();
  const claim = { units, ...(opts.comments ? { comments: opts.comments.map((code) => ({ code })) } : {}) };
  const a = { yearMonth: YM, generation: GEN, ...about };
  const r = evaluateGeneric(claim, db, a, [makeG05(opts.config)], opts.certain ?? new Set());
  return { findings: r.findings.filter((f) => f.check === "G05"), result: r, scope: genericScopeOf(claim, db, a, r) };
};
const brief = (fs: GenericFinding[]) => fs.map((f) => [f.messageKey, f.certainty, ...f.codes]);
/** 往診料と訪問診療料が 6 日に両方ある請求（K1 の形） */
const sameDay = [unit([C.oushin], [6]), unit([C.houmon], [6, 20])];
const OU_HO = haihanKey("HX-01", C.oushin, C.houmon);

describe("出荷の決まり：往診料 × 訪問診療料（HP-01。HX-01 急変の往診・HX-02 死亡日の往診だけの日のターミナルケア加算）", () => {
  it("答えを渡さない点検（月末の点検・算定プレビュー・measure-generic）では、問いを出さず、今までどおり条件つき（L-76）", () => {
    expect(brief(g05Of(sameDay).findings)).toEqual([["G05.day_cond", "条件つき", C.oushin, C.houmon]]);
  });

  it("答えがない → 条件つき＋問い（HX-01。sameDayOf が名指しする事実）。文は告示・通知の例外の一言を挙げる", () => {
    const { findings } = g05Of(sameDay, { answers: answersOf(), facts: factsOf({}) });
    expect(brief(findings)).toEqual([["G05.exception_ask", "条件つき", C.oushin, C.houmon]]);
    expect(JSON.parse(findings[0].params.asks)).toEqual([{ hx: "HX-01", key: OU_HO, dates: [day(6)] }]);
    expect(genericText(findings[0])).toContain("訪問診療の後に、病状の急変等で往診した場合の往診料");
    // 「いいえ」（往診のあとではない＝偽）と答えたあと、別々の診療かが分からない日は、sameDayOf が名指しする R10 と同じ「別々の診療か」を問う（§13-3 の C-117 の対応。round-36 C-125）。
    // それに答えると、どちらの答えでも当たらない（exception_none）
    const sep = g05Of(sameDay, { answers: answersOf(), facts: factsOf({ after: { [day(6)]: false } }) }).findings;
    expect(JSON.parse(sep[0].params.asks)).toEqual([{ hx: "HX-01", key: "sameDaySeparate", dates: [day(6)] }]);
    for (const separate of [true, false]) expect(g05Of(sameDay, { answers: answersOf(), facts: factsOf({ after: { [day(6)]: false }, separate: { [day(6)]: separate } }) }).findings.map((f) => [f.messageKey, f.params.answered])).toEqual([["G05.exception_none", "true"]]);
  });

  it("当たるの答え（急変の往診）→ 背反は出さない。摘要欄の理由（830100086）が足りなければ exception_needs_comment、あれば何も出さず、点検の範囲に数と id を出す", () => {
    const facts = factsOf({ after: { [day(6)]: true } });
    expect(brief(g05Of(sameDay, { answers: answersOf(), facts }).findings)).toEqual([["G05.exception_needs_comment", "条件つき", C.oushin, C.houmon]]);
    const ok = g05Of(sameDay, { answers: answersOf(), facts }, { comments: [REASON] });
    expect(ok.findings).toEqual([]);
    expect(ok.result.silenced).toEqual([{ hx: "HX-01", count: 1 }]);
    expect(ok.scope.notDone).toContain("特例の例外に当たるので出していない：1 件（HX-01）");
  });

  it("当たらないの答え → 条件つきの exception_none（answered）。sameDaySeparate が偽の日も当たらない（R10 と同じ sameDayOf で読む）", () => {
    for (const facts of [factsOf({ after: { [day(6)]: false }, separate: { [day(6)]: true } }), factsOf({ separate: { [day(6)]: false } })]) {
      const fs = g05Of(sameDay, { answers: answersOf(), facts }).findings;
      expect(brief(fs)).toEqual([["G05.exception_none", "条件つき", C.oushin, C.houmon]]);
      expect([fs[0].params.hp, fs[0].params.answered]).toEqual(["HP-01", "true"]);
      expect(genericText(fs[0])).toContain("確かめたので");
    }
  });

  it("certain に G05.exception_none#HP-01 を足した一覧でだけ確定になる（ほかの組・一覧なしは条件つき）", () => {
    const facts = factsOf({ separate: { [day(6)]: false } });
    expect(g05Of(sameDay, { answers: answersOf(), facts }, { certain: new Set(["G05.exception_none#HP-01"]) }).findings[0].certainty).toBe("確定");
    expect(g05Of(sameDay, { answers: answersOf(), facts }, { certain: new Set(["G05.exception_none#HP-02"]) }).findings[0].certainty).toBe("条件つき");
  });

  it("決まらないの答え（その他・判定不能）→ 条件つきで、もう問わない", () => {
    for (const label of ["その他", "判定不能"]) {
      const fs = g05Of(sameDay, { answers: answersOf({ [`${OU_HO}|${day(6)}`]: label }), facts: factsOf({}) }).findings;
      expect(brief(fs)).toEqual([["G05.day_cond", "条件つき", C.oushin, C.houmon]]);
    }
  });

  it("1 日の表で、例外に当たる日と当たらない日がある組は、当たらない日だけ出る", () => {
    const units = [unit([C.oushin], [6, 9]), unit([C.houmon], [6, 9])];
    const fs = g05Of(units, { answers: answersOf(), facts: factsOf({ after: { [day(6)]: true }, separate: { [day(9)]: false } }) }, { comments: [REASON] }).findings;
    expect(brief(fs)).toEqual([["G05.exception_none", "条件つき", C.oushin, C.houmon]]);
    expect(fs[0].params.days).toBe("9");
  });

  it("訪問診療料の本体のほかの加算（患家診療時間加算など）も、HP-02 と同じく HP-01 の組で、急変の往診の答えで出なくなる（round-37 C-151）", () => {
    const db = tensuhyoMasters();
    const KANKA = "114001470"; // 患家診療時間加算（訪問診療料）
    putHaihan(db, "20261001", 1, C.oushin, KANKA, "3", "1");
    const r = g05Of([unit([C.oushin], [6]), unit([C.houmon, KANKA], [6])], { answers: answersOf(), facts: factsOf({ after: { [day(6)]: true } }) }, { db, comments: [REASON] });
    expect([r.findings, r.result.silenced]).toEqual([[], [{ hx: "HX-01", count: 2 }]]);
  });

  it("表と裏のどちらの向きの行にも、同じ組・同じ例外が掛かる", () => {
    const db = tensuhyoMasters();
    db.prepare("DELETE FROM haihan WHERE code1 = ? AND code2 = ?").run(C.oushin, C.houmon);
    putHaihan(db, "20261001", 1, C.houmon, C.oushin, "3", "1");
    const fs = g05Of(sameDay, { answers: answersOf(), facts: factsOf({ separate: { [day(6)]: false } }) }, { db }).findings;
    expect(fs.map((f) => [f.messageKey, f.params.hp])).toEqual([["G05.exception_none", "HP-01"]]);
  });

  it("K5 の形（死亡日に往診だけ、訪問診療料の在宅ターミナルケア加算）→ exception_needs_check で、在宅での死亡と、死亡日前 15 日間の C001 の算定を挙げる（黙って消えない）", () => {
    const db = tensuhyoMasters();
    putHaihan(db, "20261001", 1, C.oushin, TERMINAL, "3", "1");
    const units = [unit([C.oushin, TERMINAL], [28])];
    const fs = g05Of(units, {}, { db }).findings;
    expect(brief(fs)).toEqual([["G05.exception_needs_check", "条件つき", C.oushin, TERMINAL]]);
    expect([fs[0].params.hp, fs[0].params.checks]).toEqual(["HP-54", "在宅での死亡（在宅以外なら、往診又は訪問診療の後 24 時間以内の死亡）、死亡日と死亡日前 14 日以内の計 15 日間の、訪問診療料(Ⅰ)又は(Ⅱ)の算定（前の月にまたがることがあります）"]);
    // すでにある事実で確かめられる要件（看取りの場所）：在宅なら挙げない。在宅以外でも当たらないとせず（告示 C001 注6 は往診後 24 時間以内の在宅以外での死亡を含む）、24 時間以内の死亡かを挙げる（round-36 C-123）
    expect(g05Of(units, { facts: factsOf({ deathPlace: "在宅" }) }, { db }).findings[0].params.checks).toBe("死亡日と死亡日前 14 日以内の計 15 日間の、訪問診療料(Ⅰ)又は(Ⅱ)の算定（前の月にまたがることがあります）");
    const elsewhere = g05Of(units, { facts: factsOf({ deathPlace: "在宅以外" }) }, { db }).findings;
    expect([brief(elsewhere), elsewhere[0].params.checks]).toEqual([[["G05.exception_needs_check", "条件つき", C.oushin, TERMINAL]], "往診又は訪問診療の後 24 時間以内の死亡か（在宅以外での死亡）、死亡日と死亡日前 14 日以内の計 15 日間の、訪問診療料(Ⅰ)又は(Ⅱ)の算定（前の月にまたがることがあります）"]);
    // 同じ日に訪問診療料もあれば、往診だけの日ではないので HX-02 には当たらない（HX-01 の問いになる）
    const withVisit = g05Of([unit([C.oushin, TERMINAL], [28]), unit([C.houmon], [28])], { answers: answersOf(), facts: factsOf({}) }, { db }).findings.filter((f) => f.codes.includes(TERMINAL));
    expect(withVisit.map((f) => [f.messageKey, f.params.hx])).toEqual([["G05.exception_ask", "HX-01"]]);
  });

  it("例外は、掛かる行だけに掛かる（round-36 C-122）：二重の死亡診断加算は例外なしで黙らず、ターミナルケア加算が同じ日にあっても needs_check にならない", () => {
    const db = tensuhyoMasters();
    const [OU_DD, HO_DD] = ["114007270", C.shibou];
    putHaihan(db, "20261001", 1, OU_DD, HO_DD, "3", "1");
    putHaihan(db, "20261001", 1, C.oushin, HO_DD, "3", "1");
    putHaihan(db, "20261001", 1, C.oushin, TERMINAL, "3", "1");
    const pick = (fs: GenericFinding[]) => fs.filter((f) => f.codes.includes(HO_DD)).map((f) => [f.messageKey, f.params.hp ?? "", ...f.codes]);
    // 死亡日に往診だけ＋二重の死亡診断加算＋ターミナルケア加算：死亡診断加算の 2 行は、どちらも例外の要件を挙げない
    const withTerminal = g05Of([unit([C.oushin, OU_DD], [20]), unit([TERMINAL, HO_DD], [20])], { answers: answersOf(), facts: factsOf({}) }, { db }).findings;
    expect(pick(withTerminal)).toEqual([["G05.day_cond", "", C.oushin, HO_DD], ["G05.exception_none", "HP-56", OU_DD, HO_DD]]);
    // ターミナルケア加算を外しても、結論は変わらない（関係のないコードで逆にならない）
    expect(pick(g05Of([unit([C.oushin, OU_DD], [20]), unit([HO_DD], [20])], { answers: answersOf(), facts: factsOf({}) }, { db }).findings)).toEqual(pick(withTerminal));
    // 訪問診療のあとの急変の往診で、摘要欄の理由もある日でも、二重の死亡診断加算は黙らない
    const afterVisit = g05Of([unit([C.oushin, OU_DD], [20]), unit([C.houmon, HO_DD], [20])], { answers: answersOf(), facts: factsOf({ after: { [day(20)]: true } }) }, { db, comments: [REASON] }).findings;
    expect(pick(afterVisit)).toEqual([["G05.day_cond", "", C.oushin, HO_DD], ["G05.exception_none", "HP-56", OU_DD, HO_DD]]);
  });

  it("往診だけの死亡日の、往診に付く再診料 × ターミナルケア加算（HP-55・HX-24。round-36 C-124）：答えようのない問いを出さず、HX-02 と同じ要件を挙げる", () => {
    const db = tensuhyoMasters();
    // 小さな表の区分番号の部は版の表示から作るので、A001 の部を基本マスターと同じ 1 にする
    db.prepare("UPDATE shinryo SET bu = 1 WHERE code = ?").run(C.saishin);
    putHaihan(db, "20261001", 1, C.saishin, TERMINAL, "2", "1");
    const fs = g05Of([unit([C.saishin, C.oushin], [20]), unit([TERMINAL], [20])], { answers: answersOf(), facts: factsOf({ deathPlace: "在宅" }) }, { db }).findings.filter((f) => f.codes.includes(C.saishin));
    expect(fs.map((f) => [f.messageKey, f.params.hp, f.params.hx, f.params.checks])).toEqual([["G05.exception_needs_check", "HP-55", "HX-24", "この再診料（加算）は、その日の往診に付くものか（外来の受診・電話などの再診ではない）、死亡日と死亡日前 14 日以内の計 15 日間の、訪問診療料(Ⅰ)又は(Ⅱ)の算定（前の月にまたがることがあります）"]]);
    // 往診料のない日（外来の再診）は HX-24 に当たらず、再診料が往診に付くかの問い（HX-11）は pre で当たらない → exception_none
    const outpatient = g05Of([unit([C.saishin], [20]), unit([TERMINAL], [20])], { answers: answersOf(), facts: factsOf({}) }, { db }).findings.filter((f) => f.codes.includes(C.saishin));
    expect(outpatient.map((f) => [f.messageKey, f.params.hp])).toEqual([["G05.exception_none", "HP-55"]]);
    // 電話等再診料（往診に付く再診料ではない）の行は組に入れない：HX-24 に当たらず、今までどおり条件つき（round-37 C-150）
    const PHONE = "112007950";
    put(db, "shinryo", "20261001", { code: PHONE, name: "手作りの電話等再診料", alpha: "A", sho: 1, bu: 1, kubun_no: 1 });
    putHaihan(db, "20261001", 1, PHONE, TERMINAL, "2", "1");
    const phone = g05Of([unit([PHONE, C.oushin], [20]), unit([TERMINAL], [20])], { answers: answersOf(), facts: factsOf({ deathPlace: "在宅" }) }, { db }).findings.filter((f) => f.codes.includes(PHONE));
    expect(phone.map((f) => [f.messageKey, f.params.hp ?? ""])).toEqual([["G05.day_cond", ""]]);
  });
});

/** テスト用の決まり：酸素の管理料 × 酸素吸入（同一月の表。錨 A51）と、往診料 × 救急搬送診療料（同時の表。錨 A54）。コードで選ぶ */
const testConfig = (exceptions: HaihanException[], ids: string[], more: Partial<HaihanConfig> = {}): HaihanConfig => ({
  patterns: [
    { id: "HP-T1", a: { codes: [C.sanso] }, b: { codes: [C.sansoKyunyu] }, tani: [2], exceptions: ids },
    { id: "HP-T2", a: { codes: [C.kyukyu] }, b: { codes: [C.oushin] }, tani: [3], exceptions: ids },
    ...(more.patterns ?? []),
  ],
  exceptions,
});
const RECEIPT: HaihanException = { id: "HX-T1", text: "入院中の患者に行ったもの", kind: "receipt", allow: { receiptKind: "入院" } };
const NONE: HaihanException = { id: "HX-T2", text: "決まらない例外", kind: "none" };
const ASK_DAY: HaihanException = {
  id: "HX-T3",
  text: "短期入所中",
  kind: "fact",
  ask: { factKey: "haihan:HX-T3", scope: "day", askOn: "b", question: "短期入所中でしたか", choices: [{ label: "はい", means: "当たる" }, { label: "いいえ", means: "当たらない" }, { label: "その他", means: "決まらない" }, { label: "判定不能", means: "決まらない" }] },
};
const month = [unit([C.sanso], [6]), unit([C.sansoKyunyu], [6, 20])];

describe("例外の形（テスト用の決まり）", () => {
  it("レセプトで当たらない（入院外）→ 条件つきの exception_none（answered でない）。入院なら当たって出さない", () => {
    const config = testConfig([RECEIPT], ["HX-T1"]);
    const fs = g05Of(month, { outpatient: true }, { config }).findings;
    expect(brief(fs)).toEqual([["G05.exception_none", "条件つき", C.sanso, C.sansoKyunyu]]);
    expect(fs[0].params.answered).toBe("false");
    expect(genericText(fs[0])).toContain("レセプトで確かめたところ");
    const inpatient = g05Of(month, { outpatient: false }, { config });
    expect([inpatient.findings, inpatient.result.silenced]).toEqual([[], [{ hx: "HX-T1", count: 1 }]]);
    // 入院外かが分からない（区分キーの行）なら決まらない
    expect(brief(g05Of(month, {}, { config }).findings)).toEqual([["G05.month_cond", "条件つき", C.sanso, C.sansoKyunyu]]);
  });

  it("確かめられない例外（ウ）が 1 つある組では、ほかの例外が全部当たらなくても exception_none にならない", () => {
    const config = testConfig([RECEIPT, NONE], ["HX-T1", "HX-T2"]);
    expect(brief(g05Of(month, { outpatient: true }, { config }).findings)).toEqual([["G05.month_cond", "条件つき", C.sanso, C.sansoKyunyu]]);
  });

  it("同一月の表の scope: day の問い：b 側の算定日ごとに問い、日によって答えが分かれると「決まらない」で、分かれた日が文に出る", () => {
    const config = testConfig([ASK_DAY], ["HX-T3"]);
    const key = haihanKey("HX-T3", C.sanso, C.sansoKyunyu);
    const ask = g05Of(month, { answers: answersOf({ [`${key}|${day(6)}`]: "いいえ" }) }, { config }).findings;
    expect(ask.map((f) => [f.messageKey, JSON.parse(f.params.asks)])).toEqual([["G05.exception_ask", [{ hx: "HX-T3", key, dates: [day(20)] }]]]);
    const split = g05Of(month, { answers: answersOf({ [`${key}|${day(6)}`]: "はい", [`${key}|${day(20)}`]: "いいえ" }) }, { config }).findings;
    expect(split.map((f) => [f.messageKey, f.params.hitDays, f.params.missDays])).toEqual([["G05.exception_split", "6", "20"]]);
    expect(genericText(split[0])).toContain("当たる日：6日、当たらない日：20日");
    const none = g05Of(month, { answers: answersOf({ [`${key}|${day(6)}`]: "いいえ", [`${key}|${day(20)}`]: "いいえ" }) }, { config }).findings;
    expect(none.map((f) => f.messageKey)).toEqual(["G05.exception_none"]);
  });

  it("同時の表：別の単位なら、例外に当たらないと答えがあっても条件つき。同じ単位なら、一覧に載せた組で確定（X-101）", () => {
    const x: HaihanException = { ...ASK_DAY, id: "HX-T4", ask: { ...ASK_DAY.ask!, factKey: "haihan:HX-T4", askOn: undefined } };
    const config = testConfig([x], ["HX-T4"]);
    const key = haihanKey("HX-T4", C.oushin, C.kyukyu);
    const about = { answers: answersOf({ [`${key}|${day(6)}`]: "いいえ" }) };
    const certain = new Set(["G05.exception_none#HP-T2"]);
    expect(brief(g05Of([unit([C.oushin, C.kyukyu], [6])], about, { config, certain }).findings)).toEqual([["G05.exception_none", "確定", C.oushin, C.kyukyu]]);
    expect(brief(g05Of([unit([C.oushin], [6]), unit([C.kyukyu], [6])], about, { config, certain }).findings)).toEqual([["G05.exception_none", "条件つき", C.oushin, C.kyukyu]]);
  });

  it("答えは組ごと：同じ日に同じ例外が掛かる 2 つの組に、別の答えを入れられ、互いに効かない（X-106）", () => {
    const db = tensuhyoMasters();
    putHaihan(db, "20261001", 1, C.oushin, TERMINAL, "3", "1");
    const x: HaihanException = { ...ASK_DAY, id: "HX-T5", ask: { ...ASK_DAY.ask!, factKey: "haihan:HX-T5", askOn: undefined } };
    const config: HaihanConfig = { patterns: [{ id: "HP-T3", a: { codes: [C.oushin] }, b: { codes: [C.houmon, TERMINAL] }, tani: [1], exceptions: ["HX-T5"] }], exceptions: [x] };
    const answers = answersOf({ [`${haihanKey("HX-T5", C.oushin, C.houmon)}|${day(6)}`]: "いいえ", [`${haihanKey("HX-T5", C.oushin, TERMINAL)}|${day(6)}`]: "はい" });
    const r = g05Of([unit([C.oushin, TERMINAL], [6]), unit([C.houmon], [6])], { answers }, { db, config });
    expect(brief(r.findings)).toEqual([["G05.exception_none", "条件つき", C.oushin, C.houmon]]);
    expect(r.result.silenced).toEqual([{ hx: "HX-T5", count: 1 }]);
  });

  it("1 週間の表（tani 4）には例外を掛けない", () => {
    const config: HaihanConfig = { patterns: [{ id: "HP-T4", a: { codes: [C.shoshin] }, b: { codes: [C.gairaiReha] }, tani: [4], exceptions: ["HX-T1"] }], exceptions: [RECEIPT] };
    expect(brief(g05Of([unit([C.shoshin], [1]), unit([C.gairaiReha], [3])], { outpatient: true }, { config }).findings)).toEqual([["G05.week_cond", "条件つき", C.shoshin, C.gairaiReha]]);
  });
});

describe("出荷の決まりの形", () => {
  it("往診料×訪問診療料は、本体の行（HP-01：HX-01）とターミナルケア加算の行（HP-54：HX-01・HX-02）に分け、二重の死亡診断加算（HP-56）は例外なし。HX-01 は sameDayOushinAfterVisit を共有し、摘要欄の理由を要る", () => {
    expect(["HP-01", "HP-54", "HP-56"].map((id) => HAIHAN.patterns.find((x) => x.id === id)!.exceptions)).toEqual([["HX-01"], ["HX-01", "HX-02"], []]);
    const x = HAIHAN.exceptions.find((e) => e.id === "HX-01")!;
    expect([x.ask?.factKey, x.thenRequires?.comments]).toEqual(["sameDayOushinAfterVisit", [REASON]]);
  });
});

describe("2 回言わない（C-119・X-108）", () => {
  it("手書きの R17 が同じコメントコード（830100086）の記載もれを出していれば、exception_needs_comment を出さない。R17 が情報不足で止まった・出していないときは出す", () => {
    const g = g05Of(sameDay, { answers: answersOf(), facts: factsOf({ after: { [day(6)]: true } }) }).findings;
    expect(g.map((f) => f.messageKey)).toEqual(["G05.exception_needs_comment"]);
    const r17 = (messageKey: string, kind: Finding["kind"] = "記載もれ"): Finding => ({ ruleId: "R17", kind, lineRefs: ["C000"], messageKey, params: { rule: "T162-reason" }, reference: "" });
    expect(overlap({ findings: [r17("R17.comment_missing")] }, r2026, false, [], g)).toEqual({ findings: [], duplicate: 1, judged: 0 });
    expect(overlap({ findings: [r17("R17.missing_fact", "情報不足")] }, r2026, false, [], g).findings).toEqual(g);
    expect(overlap({ findings: [] }, r2026, false, [], g).findings).toEqual(g);
  });
});
