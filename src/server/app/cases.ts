// 症例（合成 UKE ＋ 合成カルテ側の事実）
import { existsSync } from "node:fs";
import path from "node:path";
import { facilityOf, type FacilityJson } from "../../engine/facility";
import type { ClaimContext } from "../../engine/types";
import { applyPatientFacts } from "../../patient/facts";
import { toClaimContext } from "../../uke/cases";
import type { Clock } from "./clock";
import { json, type AppContext } from "./context";
import type { Patients } from "./patients";
import type { Uke } from "./uke";
import { notFound } from "../errors";

export function createCases(ctx: AppContext, clock: Clock, uke: Uke, patients: Patients) {
  const { paths, facility } = ctx;
  const { now } = clock;
  const { ukeFiles } = uke;
  const { latestPatientFacts, ingest, masterFacts } = patients;

  const fixtureFile = (claimId: string) => path.join(paths.root, "fixtures", "cases", `${claimId.split("-")[0]}.json`);
  /** 症例の JSON。facility は、その症例だけの施設の設定の上書き（design.md §2-7） */
  const fixtureOf = (claimId: string) => json<Omit<ClaimContext, "facility"> & { facility?: Partial<FacilityJson> }>(fixtureFile(claimId));
  /** 症例側が持つ負担割合（症例がない・値がないときは null）。患者マスタに負担割合が入っていないときに使う */
  function caseBurdenRatioOf(claimId: string): number | null {
    if (!existsSync(fixtureFile(claimId))) return null;
    const f = fixtureOf(claimId).facts.burdenRatio;
    return f.known ? f.value : null;
  }

  function cases(): ClaimContext[] {
    const files = ukeFiles();
    const out: ClaimContext[] = [];
    for (const file of files) {
      for (const r of file.receipts) {
        const c = fixtureOf(r.claimId);
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

  return { cases, caseOf, caseBurdenRatioOf };
}

export type Cases = ReturnType<typeof createCases>;
