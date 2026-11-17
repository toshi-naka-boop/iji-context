// 合成 UKE：デモ用の 2 本の読み込みと、利用者ごとの取り込みの記録
import { readFileSync } from "node:fs";
import path from "node:path";
import type { UkePatient } from "../../uke/types";
import { parseUke } from "../../uke/uke";
import type { Clerks } from "./clerks";
import type { AppContext } from "./context";

export function createUke(ctx: AppContext, clerks: Clerks) {
  const { paths, setting, setSetting } = ctx;
  const { clerk } = clerks;

  const UKE_FILES = ["fixtures/uke/kokuhoren.UKE", "fixtures/uke/shiharaikikin.UKE"];
  const ukeFiles = () => UKE_FILES.map((f) => parseUke(readFileSync(path.join(paths.root, f))));
  /** UKE の取り込み（利用者ごとに記録。今回はデモ用の 2 本を選んで取り込むだけ） */
  const importedUke = (clerkId: string): string[] => JSON.parse(setting(`uke:${clerkId}`) ?? "[]") as string[];
  function ukeList(clerkId: string) {
    const done = importedUke(clerkId);
    return UKE_FILES.map((f, i) => {
      const u = ukeFiles()[i];
      const name = path.basename(f);
      return { name, payer: u.payer, prefecture: u.prefecture, billingMonth: u.billingMonth, receipts: u.receipts.map((x) => ({ claimId: x.claimId, patient: x.patient.name })), imported: done.includes(name) };
    });
  }
  function importUke(clerkId: string, name: string) {
    clerk(clerkId);
    if (!UKE_FILES.some((f) => path.basename(f) === name)) throw new Error(`取り込める UKE ではない: ${name}`);
    const done = importedUke(clerkId);
    if (!done.includes(name)) setSetting(`uke:${clerkId}`, JSON.stringify([...done, name]));
    return ukeList(clerkId);
  }
  /** 取り込んだ UKE に入っているレセプト（月末の点検の対象） */
  const importedClaims = (clerkId: string): string[] => ukeList(clerkId).filter((u) => u.imported).flatMap((u) => u.receipts.map((x) => x.claimId));
  function patientOf(claimId: string): UkePatient {
    const r = ukeFiles().flatMap((f) => f.receipts).find((x) => x.claimId === claimId);
    if (!r) throw new Error(`UKE にないレセプト: ${claimId}`);
    return r.patient;
  }

  return { ukeFiles, ukeList, importUke, importedClaims, patientOf };
}

export type Uke = ReturnType<typeof createUke>;
