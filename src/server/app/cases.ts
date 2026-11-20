// 症例（合成 UKE ＋ 合成カルテ側の事実）。アップロードで受け取った、同梱の症例にないレセプトは、カルテ側の事実を持たない
import { evaluate } from "../../engine";
import { facilityOf, type FacilityJson } from "../../engine/facility";
import type { ClaimContext, EngineResult, Facts } from "../../engine/types";
import { applyPatientFacts } from "../../patient/facts";
import { toClaimContext } from "../../uke/cases";
import { caseFileOf } from "./case-files";
import type { ClaimFacts } from "./claim-facts";
import type { Clock } from "./clock";
import { json, type AppContext } from "./context";
import type { Patients } from "./patients";
import type { Uke } from "./uke";
import type { UkeFile, UkeReceipt } from "../../uke/types";
import { notFound } from "../errors";

/** カルテ側の事実がないレセプトの事実：どれも「不明」。推測で埋めない（年齢・保険種別・負担割合だけは、UKE から作った患者マスタで上書きする） */
const UNKNOWN_FACTS: Facts = {
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

export function createCases(ctx: AppContext, clock: Clock, uke: Uke, patients: Patients, claimFacts: Pick<ClaimFacts, "withClaimFacts">) {
  const { paths, facility } = ctx;
  const { now } = clock;
  const { ukeFiles } = uke;
  const { latestPatientFacts, ingest, masterFacts } = patients;

  type Fixture = Omit<ClaimContext, "facility"> & { facility?: Partial<FacilityJson> };
  /** 症例の JSON。facility は、その症例だけの施設の設定の上書き（design.md §2-7）。請求 id はパスに使わず、表を引く（表にない請求 id は null） */
  const fixtureOf = (claimId: string): Fixture | null => {
    const file = caseFileOf(paths.root, claimId);
    return file ? json<Fixture>(file) : null;
  };
  /** 症例側が持つ負担割合（症例がない・値がないときは null）。患者マスタに負担割合が入っていないときに使う */
  function caseBurdenRatioOf(claimId: string): number | null {
    const f = fixtureOf(claimId)?.facts.burdenRatio;
    if (!f) return null;
    return f.known ? f.value : null;
  }

  /** UKE のレセプト 1 件を、カルテ側の事実・患者マスタと合わせた請求にする */
  function contextOf(file: UkeFile, r: UkeReceipt): ClaimContext {
    // 症例（カルテ側の事実）のないレセプトは、事実をどれも「不明」、出来事の記録なし（recordsKnown が偽）、施設は標準の設定として並べる
    const c = fixtureOf(r.claimId) ?? { facts: UNKNOWN_FACTS, events: [], recordsKnown: false, facility: undefined, history: undefined };
    // 年齢・保険種別は、症例の JSON の値ではなく患者マスタから出す（design.md §6）。
    // 負担割合は UKE に載っていないので、患者マスタに入っているときだけ上書きする（「分からない」で症例側の値を消さない）
    const patientId = ingest(r.patient);
    const master = masterFacts(patientId, r.yearMonth);
    const merged = { ...c.facts, age: master.age, insurance: master.insurance, burdenRatio: master.burdenRatio.known ? master.burdenRatio : c.facts.burdenRatio };
    // 患者ごとに確かめた情報を重ね、その上に、この請求について確かめた事実（その月・その日の出来事）を重ねる
    const facts = claimFacts.withClaimFacts(r.claimId, applyPatientFacts(merged, latestPatientFacts(patientId), now()));
    return toClaimContext(file, r.claimId, { facility: facilityOf(facility, c.facility), facts, events: c.events, recordsKnown: c.recordsKnown, history: c.history });
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
