// 症例（合成 UKE ＋ 合成カルテ側の事実）。アップロードで受け取った、同梱の症例にないレセプトは、カルテ側の事実を持たない
import { evaluate } from "../../engine";
import { FACT_KEYS, facilityOf, type FacilityJson } from "../../engine/facility";
import { resolveRevision } from "../../engine/revisions";
import type { ClaimContext, EngineResult, FacilityFactKey, Facts } from "../../engine/types";
import { DECLARED_KEYS } from "../../facility/declaration";
import { outsideOf } from "../../generic/lookup";
import { withMasters } from "../../masters/db";
import { addDays } from "../../engine/rules/util";
import { kanriKubun } from "../../engine/predicates";
import { applyPatientFacts, buildingBandOfRows, careLevelOf, careStateOf } from "../../patient/facts";
import { monthRange } from "../../demo/period";
import { residenceFactOf, type Care } from "./care";
import { toClaimContext } from "../../uke/cases";
import { caseFileOf } from "./case-files";
import { facilityJsonOf, todayOf } from "./facility";
import type { ClaimFacts } from "./claim-facts";
import type { Clock } from "./clock";
import { json, type AppContext } from "./context";
import type { Patients } from "./patients";
import type { Uke } from "./uke";
import type { UkeFile, UkeReceipt } from "../../uke/types";
import { notFound } from "../errors";

/** カルテ側の事実がないレセプトの事実：どれも「不明」。推測で埋めない（年齢・保険種別・負担割合だけは、UKE から作った患者マスタで上書きする） */
export const UNKNOWN_FACTS: Facts = {
  age: { known: false },
  insurance: { known: false },
  burdenRatio: { known: false },
  careLevel: { known: false },
  table7: { known: false },
  table8_2: { known: false },
  disabilitySupportLevel: { known: false },
  table8_3Other: { known: false },
  mainDisease: { known: false },
  homeOxygen: { known: false },
  deathPlace: { known: false },
  visitsComplete: { known: false },
  acuteExacerbation: { known: false },
  emergencyEligible: { known: false },
  residence: { known: false },
  contactDocProvided: { known: false },
  sameDaySeparate: { known: false },
  sameDayOushinAfterVisit: { known: false },
  dischargeJointGuidance: { known: false },
  rxLongPsychotropic: { known: false },
  rapidSameDayDocumented: { known: false },
  comprehensiveCare: { known: false },
};

type Fixture = Omit<ClaimContext, "facility"> & { facility?: Partial<FacilityJson> };
/** 症例の JSON。facility は、その症例だけの施設の設定の上書き（design.md §2-7）。請求 id はパスに使わず、表を引く（表にない請求 id は null） */
const caseFixtureOf = (root: string, claimId: string): Fixture | null => {
  const file = caseFileOf(root, claimId);
  return file ? json<Fixture>(file) : null;
};

/**
 * 請求の土台：同梱の症例の事実・出来事・記録の有無・過去の月と、症例ごとの上書きを重ねた施設の設定。症例のないレセプトは、事実をどれも「不明」、出来事の記録なし、施設は標準の設定。
 * 取り込んだレセプトの点検（contextOf）と、scripts/measure-generic.ts が同じ作り方で使う（round-32 O-17）。患者マスタ・利用者が確かめた事実は、contextOf がこの上に重ねる
 */
/**
 * declared は、facility のうち施設の申告から来た値のキー（facilityBasis を declaration にする。症例ごとの上書きがあれば case）。
 * 渡さなければ facilityBasis は症例ごとの上書きだけを持つ（design.md §15-4 の「出どころの見分け」）
 */
export function caseBaseOf(root: string, facility: FacilityJson, claimId: string, declared: readonly FacilityFactKey[] = []): Pick<ClaimContext, "facts" | "events" | "recordsKnown" | "facility" | "history" | "facilityBasis"> {
  const c = caseFixtureOf(root, claimId) ?? { facts: UNKNOWN_FACTS, events: [], recordsKnown: false, facility: undefined, history: undefined };
  const overridden = Object.keys(c.facility ?? {});
  const facilityBasis: ClaimContext["facilityBasis"] = Object.fromEntries([...declared.map((k) => [k, "declaration"]), ...overridden.filter((k) => (FACT_KEYS as string[]).includes(k)).map((k) => [k, "case"])]);
  return { facts: c.facts, events: c.events, recordsKnown: c.recordsKnown, facility: facilityOf(facility, c.facility), history: c.history, facilityBasis };
}

/** 在宅がん医療総合診療料（C003）の区分番号の鍵（医科診療行為マスターの 章 2／部 2／区分番号 3。利用前 30 日の訪問に数える。design.md §18-3 X-360） */
const C003_NO = "2/2/3";

/**
 * care を渡さない作り方（scripts・一部のテスト）では、介護・ほかの機関の申告を重ねない（申告なしとして判定する）
 */
export function createCases(ctx: AppContext, clock: Clock, uke: Uke, patients: Patients, claimFacts: Pick<ClaimFacts, "withClaimFacts">, care?: Care) {
  const { paths } = ctx;
  const { now } = clock;
  const { ukeFiles } = uke;
  const { latestPatientFacts, buildingBandRows, careRows, ingest, masterFacts } = patients;

  const fixtureOf = (claimId: string): Fixture | null => caseFixtureOf(paths.root, claimId);
  /** 症例側が持つ負担割合（症例がない・値がないときは null）。患者マスタに負担割合が入っていないときに使う */
  function caseBurdenRatioOf(claimId: string): number | null {
    const f = fixtureOf(claimId)?.facts.burdenRatio;
    if (!f) return null;
    return f.known ? f.value : null;
  }

  /** UKE のレセプト 1 件を、カルテ側の事実・患者マスタと合わせた請求にする */
  function contextOf(file: UkeFile, r: UkeReceipt): ClaimContext {
    // 症例（カルテ側の事実）のないレセプトは、事実をどれも「不明」、出来事の記録なし（recordsKnown が偽）、施設は標準の設定として並べる。
    // 施設の設定は、config の既定値にクリニックで残した設定と、その診療年月の施設の申告を重ねたもの（FR-148・FR-188。src/server/app/facility.ts）。症例ごとの上書きはその上に重なる
    const c = caseBaseOf(paths.root, facilityJsonOf(ctx, todayOf(clock), r.yearMonth), r.claimId, DECLARED_KEYS);
    // 年齢・保険種別は、症例の JSON の値ではなく患者マスタから出す（design.md §6）。
    // 負担割合は UKE に載っていないので、患者マスタに入っているときだけ上書きする（「分からない」で症例側の値を消さない）
    const patientId = ingest(r.patient);
    const master = masterFacts(patientId, r.yearMonth);
    const merged = { ...c.facts, age: master.age, insurance: master.insurance, burdenRatio: master.burdenRatio.known ? master.burdenRatio : c.facts.burdenRatio };
    // 患者ごとに確かめた情報を重ね、その上に、この請求について確かめた事実（その月・その日の出来事）を重ねる
    // 期限は今日ではなく診療年月で比べる（design.md §18-1。判断 A）。単一建物の人数の区分は、その診療年月で効く行（いつの診療月から。design.md §15-4）。
    // 要介護度は認定の行の全部から決める（月の途中で区分が変わった 2 行。R03 の要介護 3 以上かの境は、その月の版の値）。認定の行がなければカルテ側の値のまま
    const rows = careRows(patientId);
    const certState = careStateOf(rows, r.yearMonth);
    // 月の途中で区分が変わり、区間で値が違う月は careLevelMixed（R17 の包括的支援加算の状態の記載を比べない。design.md §18-12 の 4）
    const mixed = certState.known && new Set(certState.segments.map((s) => s.level)).size > 1;
    const careLevel = rows.length > 0 ? { careLevel: careLevelOf(certState, resolveRevision(r.yearMonth).consts.hokatsu.careLevelMin), ...(mixed ? { careLevelMixed: { known: true as const, value: true } } : {}) } : {};
    // 住まいの種別（design.md §18-2。判断 B）：診療年月に効く申告があれば、2 値の residence はそこから導く。なければ今までの 2 値の行（患者の事実 residence）を使う
    const rt = care?.residenceTypeOf(patientId, r.yearMonth);
    const residence = rt ? { residenceType: rt.fact, residence: residenceFactOf(rt.fact) } : {};
    const facts = claimFacts.withClaimFacts(r.claimId, { ...applyPatientFacts(merged, latestPatientFacts(patientId), r.yearMonth), ...careLevel, ...residence, buildingBand: buildingBandOfRows(buildingBandRows(patientId), r.yearMonth) });
    // 介護・ほかの機関の申告（design.md §18-3・§18-4）。申告のない請求は持たない（R20・R21 の場面は「見ていません」）
    const careFacts = care?.careFactsOf(patientId, r.yearMonth, certState, (start) => priorVisitOf(patientId, r.yearMonth, start));
    const others = care?.otherFactsOf(patientId, r.yearMonth);
    const claim = { ...toClaimContext(file, r.claimId, { facility: c.facility, facts, events: c.events, recordsKnown: c.recordsKnown, history: c.history }), facilityBasis: c.facilityBasis, ...(careFacts ? { care: careFacts } : {}), ...(others ? { others } : {}) };
    // 対象外の単位があり、基本マスターが入っていれば、そのコードを引いて渡す：エンジンは、止めるかどうかをルールごとに決める（design.md §12-4）。
    // マスターがなければ渡さない（対象外の単位が 1 つでもあれば、どのルールも止まる。今までどおり）
    if (!r.others?.length) return claim;
    const outside = withMasters((db) => (db ? outsideOf(db, resolveRevision(r.yearMonth), r.yearMonth, r.others!.flatMap((o) => o.codes)) : undefined));
    return outside ? { ...claim, outside } : claim;
  }
  /**
   * 短期入所・宿泊の開始日の前日から遡って 30 日に、当院が訪問診療料等（訪問診療料・在医総管・施医総管・在がん総診）を算定していたか（design.md §18-3。X-360・X-351）。
   * 取り込んである当院の請求（当月と、その 30 日に掛かる前の月）の算定日を探す。1 つでもあれば true。掛かる月の請求がどれも取り込んであって 1 つもなければ false。
   * 開始日がない・掛かる月の請求を取り込んでいない・在がん総診を引く基本マスターがない（対象外の単位がある請求で）ときは null（分からない）
   */
  function priorVisitOf(patientId: string, yearMonth: string, start: string | null): boolean | null {
    if (start === null) return null;
    const from = addDays(start, -(resolveRevision(yearMonth).consts.care?.priorDays ?? 30));
    const to = addDays(start, -1);
    const months = [...new Set([from.slice(0, 7), to.slice(0, 7), yearMonth])].filter((m) => m >= from.slice(0, 7) && m <= to.slice(0, 7));
    let unknown = false;
    for (const m of months) {
      const mine = ukeFiles().flatMap((f) => f.receipts.filter((x) => x.yearMonth === m && ingest(x.patient) === patientId));
      if (mine.length === 0) {
        unknown = true;
        continue;
      }
      for (const x of mine) {
        const rev = resolveRevision(m);
        const kubun = new Set([...rev.consts.visitKubun, ...(rev.consts.visit2Kubun ?? []), ...kanriKubun(rev.consts)]);
        const inRange = (d: string) => d >= from && d <= to;
        if (x.lines.some((l) => kubun.has(l.kubun) && l.dates.some(inRange))) return true;
        const others = x.others ?? [];
        if (others.length === 0) continue;
        const outside = withMasters((db) => (db ? outsideOf(db, rev, m, others.flatMap((o) => o.codes)) : undefined));
        if (!outside) {
          unknown = true;
          continue;
        }
        const c003 = new Set(outside.codes.filter((o) => o.no === C003_NO).map((o) => o.code));
        const { start: ms } = monthRange(m);
        if (others.some((o) => o.codes.some((code) => c003.has(code)) && o.days.some((n, i) => n > 0 && inRange(addDays(ms, i))))) return true;
      }
    }
    return unknown ? null : false;
  }

  /** 診療年月の版で読めたレセプトの請求（版のないレセプト・読み直しで読めなかったレセプトは入らない。src/server/app/uke.ts の ukeFiles） */
  const cases = (): ClaimContext[] => ukeFiles().flatMap((file) => file.receipts.map((r) => contextOf(file, r)));
  const caseOf = (claimId: string): ClaimContext => {
    const c = cases().find((x) => x.claimId === claimId);
    if (!c) throw notFound(`症例がない: ${claimId}`);
    return c;
  };

  /** 同梱の症例にないレセプト（アップロードで受け取ったもの）か。カルテ側の事実・出来事・合成カルテを持たない */
  const isUploaded = (claimId: string): boolean => fixtureOf(claimId) === null;
  /** 判定。カルテ側の記録がないレセプト（recordsKnown が偽）の扱いは、エンジンが決める（design.md §11-6） */
  const judge = (ctx: ClaimContext): EngineResult => evaluate(ctx);

  /**
   * 試算の土台（design.md §11-12）：一覧にあるレセプト 1 件の、事実・施設の設定・審査支払機関など。診療年月に版がないレセプトでも作れる。
   * 行とコメントは、試算が選んだ版で引いたものに入れ替える（src/server/app/uke-check.ts）。月末の点検（cases）には並ばない
   */
  const trialBaseOf = (claimId: string): ClaimContext => {
    const { file, receipt } = uke.receiptOf(claimId);
    return contextOf(file, receipt);
  };

  return { cases, caseOf, caseBurdenRatioOf, isUploaded, judge, trialBaseOf };
}

export type Cases = ReturnType<typeof createCases>;
