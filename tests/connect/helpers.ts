// 連携のテストの共通部品：模擬サーバーを 127.0.0.1 の空きポートで起動し、コネクタの設定（環境変数）を向ける
import { randomBytes } from "node:crypto";
import { vi } from "vitest";
import { MOCK_PATIENT_SYSTEM, startMockConnect, type Fault, type MockAuth } from "../../fixtures/connect/mock-server";
import { ConnectError } from "../../src/connect/fetch";

/** 認証の値は、その場で作る */
export const newAuth = (): MockAuth => ({ orca: { user: "mock", password: randomBytes(12).toString("hex") }, fhir: { token: randomBytes(16).toString("hex") } });

export type Mock = { port: number; auth: MockAuth; close: () => Promise<void> };

export async function startMock(): Promise<Mock> {
  const auth = newAuth();
  return { auth, ...(await startMockConnect(auth)) };
}

/** 模擬サーバーに向けた設定を入れる（fault を渡すと、壊した応答の経路に向ける）。戻すのは vi.unstubAllEnvs() */
export function pointAt(mock: Mock, fault?: Fault): void {
  const base = `http://127.0.0.1:${mock.port}${fault ? `/fault/${fault}` : ""}`;
  vi.stubEnv("RESEMEN_CONNECT_ALLOW", `127.0.0.1:${mock.port}`);
  vi.stubEnv("RESEMEN_CONNECT_ORCA_URL", `${base}/orca`);
  vi.stubEnv("RESEMEN_CONNECT_ORCA_USER", mock.auth.orca.user);
  vi.stubEnv("RESEMEN_CONNECT_ORCA_PASSWORD", mock.auth.orca.password);
  vi.stubEnv("RESEMEN_CONNECT_FHIR_URL", `${base}/fhir`);
  vi.stubEnv("RESEMEN_CONNECT_FHIR_TOKEN", mock.auth.fhir.token);
  vi.stubEnv("RESEMEN_CONNECT_FHIR_PATIENT_SYSTEM", MOCK_PATIENT_SYSTEM);
}

/** 失敗するはずの呼び出しから、ConnectError を取り出す（失敗しなければテストを落とす） */
export async function failure(run: () => Promise<unknown>): Promise<ConnectError> {
  try {
    await run();
  } catch (e) {
    if (e instanceof ConnectError) return e;
    throw e;
  }
  throw new Error("失敗するはずの呼び出しが成功した");
}
