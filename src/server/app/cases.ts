// 症例（合成 UKE ＋ 合成カルテ側の事実）。アップロードで受け取った、同梱の症例にないレセプトは、カルテ側の事実を持たない
import { evaluate, rulesOf } from "../../engine";
import { facilityOf, type FacilityJson } from "../../engine/facility";
import type { ClaimContext, EngineResult, Facts, Finding } from "../../engine/types";
import { applyPatientFacts } from "../../patient/facts";
import { toClaimContext } from "../../uke/cases";
import { caseFileOf } from "./case-files";
import type { Clock } from "./clock";
import { json, type AppContext } from "./context";
import type { Patients } from "./patients";
import type { Uke } from "./uke";
import { notFound } from "../errors";

/** カルテ側の事実がないレセプトの事実：どれも「不明」。推測で埋めない（年齢・保険種別・負担割合だけは、UKE から作った患者マスタで上書きする） */
const UNKNOWN_FACTS: Facts = {
  age: { known: false },
  insurance: { known: false },
  burdenRatio: { known: false },
  careLevel: { known: false },
  table7: { known: false },
  table8_2: { known: false },
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
  rapidSameDayDocumented: { known: false },
  comprehensiveCare: { known: false },
};
/**
 * 出来事（訪問・往診・処方・退院・死亡・管理料の算定開始月）の記録を読んで判定するルールと、その記録から出る指摘。
 * エンジンは、載っていない出来事を「なかった」と読む。カルテ側の記録がないレセプトでは「分からない」なので、
 * これらの指摘は出さず、そのルールを情報不足（訪問の記録がそろっているか）として返す
 */
const RECORD_FINDINGS: Record<string, string[]> = {
  R05: ["R05.no_rx_addition_with_rx"],
  R06: ["R06.under_28_days"],
  R07: ["R07.use_seven_or_more", "R07.not_seven_or_more"],
  R09: ["R09.terminal_visits"],
  R14: ["R14.missing", "R14.not_eligible"],
};
/** カルテ側の記録がないレセプトの判定結果：記録がないと決められない指摘を、情報不足に置き換える（合計・行ごとの点数はそのまま） */
function withoutRecords(r: EngineResult, ctx: ClaimContext): EngineResult {
  const findings: Finding[] = r.findings.filter((f) => !RECORD_FINDINGS[f.ruleId]?.includes(f.messageKey));
  for (const rule of rulesOf(ctx.yearMonth)) {
    if (!RECORD_FINDINGS[rule.id] || !r.applied.includes(rule.id)) continue;
    if (findings.some((f) => f.ruleId === rule.id && f.kind === "情報不足")) continue;
    findings.push({
      ruleId: rule.id,
      kind: "情報不足",
      lineRefs: rule.kubun.filter((k) => ctx.lines.some((l) => l.kubun === k)),
      missing: { target: "clerk", field: "visitsComplete" },
      messageKey: `${rule.id}.missing_fact`,
      reference: rule.reference,
    });
  }
  return { ...r, findings };
}

export function createCases(ctx: AppContext, clock: Clock, uke: Uke, patients: Patients) {
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

  function cases(): ClaimContext[] {
    const files = ukeFiles();
    const out: ClaimContext[] = [];
    for (const file of files) {
      for (const r of file.receipts) {
        // 症例（カルテ側の事実）のないレセプトは、事実をどれも「不明」、出来事の記録なし、施設は標準の設定として並べる
        const c = fixtureOf(r.claimId) ?? { facts: UNKNOWN_FACTS, events: [], facility: undefined, history: undefined };
        // 年齢・保険種別は、症例の JSON の値ではなく患者マスタから出す（design.md §6）。
        // 負担割合は UKE に載っていないので、患者マスタに入っているときだけ上書きする（「分からない」で症例側の値を消さない）
        const patientId = ingest(r.patient);
        const master = masterFacts(patientId, r.yearMonth);
        const merged = { ...c.facts, age: master.age, insurance: master.insurance, burdenRatio: master.burdenRatio.known ? master.burdenRatio : c.facts.burdenRatio };
        const facts = applyPatientFacts(merged, latestPatientFacts(patientId), now());
        out.push(toClaimContext(file, r.claimId, { facility: facilityOf(facility, c.facility), facts, events: c.events, history: c.history }));
      }
    }
    return out;
  }
  const caseOf = (claimId: string): ClaimContext => {
    const c = cases().find((x) => x.claimId === claimId);
    if (!c) throw notFound(`症例がない: ${claimId}`);
    return c;
  };

  /** 同梱の症例にないレセプト（アップロードで受け取ったもの）か。カルテ側の事実・出来事・合成カルテを持たない */
  const isUploaded = (claimId: string): boolean => fixtureOf(claimId) === null;
  /** 判定。カルテ側の記録がないレセプトは、記録がないと決められない指摘を情報不足にして返す */
  const judge = (ctx: ClaimContext): EngineResult => (isUploaded(ctx.claimId) ? withoutRecords(evaluate(ctx), ctx) : evaluate(ctx));

  return { cases, caseOf, caseBurdenRatioOf, isUploaded, judge };
}

export type Cases = ReturnType<typeof createCases>;
