// 症例（合成 UKE ＋ 合成カルテ側の事実）
import path from "node:path";
import type { ClaimContext } from "../../engine/types";
import { applyPatientFacts, patientKeyOf } from "../../patient/facts";
import { toClaimContext } from "../../uke/cases";
import type { Clock } from "./clock";
import { json, type AppContext } from "./context";
import type { Patients } from "./patients";
import type { Uke } from "./uke";

export function createCases(ctx: AppContext, clock: Clock, uke: Uke, patients: Patients) {
  const { paths, facility } = ctx;
  const { now } = clock;
  const { ukeFiles } = uke;
  const { latestPatientFacts } = patients;

  function cases(): ClaimContext[] {
    const files = ukeFiles();
    const out: ClaimContext[] = [];
    for (const file of files) {
      for (const r of file.receipts) {
        const k = r.claimId.split("-")[0];
        const c = json<ClaimContext>(path.join(paths.root, "fixtures", "cases", `${k}.json`));
        const facts = applyPatientFacts(c.facts, latestPatientFacts(patientKeyOf(r.patient)), now());
        out.push(toClaimContext(file, r.claimId, { facility, facts, events: c.events, history: c.history }));
      }
    }
    return out;
  }
  const caseOf = (claimId: string): ClaimContext => {
    const c = cases().find((x) => x.claimId === claimId);
    if (!c) throw new Error(`症例がない: ${claimId}`);
    return c;
  };

  return { cases, caseOf };
}

export type Cases = ReturnType<typeof createCases>;
