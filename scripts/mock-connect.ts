// 模擬サーバー（ORCA API 形式・FHIR JP Core 形式）を手元で起動する。`npx tsx scripts/mock-connect.ts [ポート]`
// 認証の値は起動のたびにその場で作り、アプリ側に渡す環境変数の形で表示する（合成データしか返さない、手元だけの値）
import { randomBytes } from "node:crypto";
import { MOCK_PATIENT_SYSTEM, startMockConnect } from "../fixtures/connect/mock-server";

const auth = { orca: { user: "mock", password: randomBytes(12).toString("hex") }, fhir: { token: randomBytes(16).toString("hex") } };
const { port } = await startMockConnect(auth, Number(process.argv[2] ?? 8799));

console.log(`模擬サーバーを起動した: http://127.0.0.1:${port}（合成データ。Ctrl+C で止める）`);
console.log("アプリ側（本番でない環境）に渡す設定:");
console.log(
  [
    "RESEMEN_CONNECTORS=orca,fhir",
    `RESEMEN_CONNECT_ALLOW=127.0.0.1:${port}`,
    `RESEMEN_CONNECT_ORCA_URL=http://127.0.0.1:${port}/orca`,
    `RESEMEN_CONNECT_ORCA_USER=${auth.orca.user}`,
    `RESEMEN_CONNECT_ORCA_PASSWORD=${auth.orca.password}`,
    `RESEMEN_CONNECT_FHIR_URL=http://127.0.0.1:${port}/fhir`,
    `RESEMEN_CONNECT_FHIR_TOKEN=${auth.fhir.token}`,
    `RESEMEN_CONNECT_FHIR_PATIENT_SYSTEM=${MOCK_PATIENT_SYSTEM}`,
  ]
    .map((l) => `  export ${l}`)
    .join("\n"),
);
