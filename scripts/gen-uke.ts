// 合成 UKE 2 本を fixtures/uke/ に書き出す（spec FR-05）。`npx tsx scripts/gen-uke.ts`
// 入力は fixtures/cases/K1〜K6.json と fixtures/uke/patients.json。出力は入力だけで決まる
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ClaimContext } from "../src/engine/types";
import { buildUkeFiles, type UkeSources } from "../src/uke/cases";
import { writeUke } from "../src/uke/uke";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CASES = ["K1", "K2", "K3", "K4", "K5", "K6"];
export const UKE_FILES = { 国保連: "fixtures/uke/kokuhoren.UKE", 支払基金: "fixtures/uke/shiharaikikin.UKE" } as const;
/** 請求年月（2025 年 3 月診療分を 4 月に請求） */
export const BILLING_MONTH = "2025-04";

export function loadSources(): { cases: ClaimContext[]; src: UkeSources } {
  const cases = CASES.map((k) => JSON.parse(readFileSync(path.join(root, "fixtures", "cases", `${k}.json`), "utf8")) as ClaimContext);
  const src = JSON.parse(readFileSync(path.join(root, "fixtures", "uke", "patients.json"), "utf8")) as UkeSources;
  return { cases, src };
}

export function generate(): Record<keyof typeof UKE_FILES, Buffer> {
  const { cases, src } = loadSources();
  const files = buildUkeFiles(cases, src, BILLING_MONTH);
  return { 国保連: writeUke(files.国保連), 支払基金: writeUke(files.支払基金) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const out = generate();
  for (const [payer, file] of Object.entries(UKE_FILES)) {
    writeFileSync(path.join(root, file), out[payer as keyof typeof UKE_FILES]);
    console.log(`書き出し: ${file}`);
  }
}
