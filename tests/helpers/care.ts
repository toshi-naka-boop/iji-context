// 介護保険・ほかの医療機関との調整のテストの道具（design.md §18。v37）：合成の UKE（患者ごとに 1 枚）を作って取り込む
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ClaimLine } from "../../src/engine/types";
import { openApp, type App } from "../../src/server/app";
import type { UkeFile, UkeReceipt } from "../../src/uke/types";
import { readUke, writeUke } from "../../src/uke/uke";

export const repo = path.join(__dirname, "..", "..");

/** 見本の UKE の 1 枚目を土台に、患者 n 番（架空の名前・番号）の請求を作る */
export function receiptOf(n: number, yearMonth: string, lines: ClaimLine[]): UkeReceipt {
  const base = readUke(readFileSync(path.join(repo, "fixtures", "uke", "shiharaikikin.UKE"))).receipts[0];
  return { ...base, claimId: `C${n}-${yearMonth}`, yearMonth, patient: { ...base.patient, name: `架空 介護${n}`, birth: "19400101", insurer: { number: "06139991", symbol: "88", no: String(700 + n) } }, lines, comments: [] };
}

export function fileOf(receipts: UkeReceipt[]): UkeFile {
  const base = readUke(readFileSync(path.join(repo, "fixtures", "uke", "shiharaikikin.UKE")));
  return { ...base, receipts };
}

/** 一時ディレクトリの app（医療事務 new1 つき）。close で片づける */
export function tempApp(): { app: App; close: () => void } {
  const tmp = mkdtempSync(path.join(tmpdir(), "iji-care-"));
  const app = openApp({ root: repo, dbFile: path.join(tmp, "app.db"), knowledgeDir: path.join(tmp, "knowledge"), skillsDir: path.join(tmp, "skills"), queryLogDir: path.join(tmp, "query-log") });
  app.upsertClerk({ id: "new1", name: "新人", callName: "さん", characterId: "a", role: "clerk" });
  return { app, close: () => { app.close(); rmSync(tmp, { recursive: true, force: true }); } };
}

/** 取り込んで、取り込んだ請求の id（取り込んだ順） */
export function upload(app: App, file: UkeFile): string[] {
  return app.uploadUke("new1", writeUke(file)).filter((u) => u.uploaded).flatMap((u) => u.receipts.map((r) => r.claimId));
}
