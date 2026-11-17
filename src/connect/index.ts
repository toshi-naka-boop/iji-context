// コネクタの登録（spec FR-114）。既定で有効なのはフィクスチャ コネクタだけ。
// 外部につなぐコネクタ（orca・fhir）は、RESEMEN_CONNECTORS に名前を書いたときだけ有効になる。
// 有効にしても、接続先（RESEMEN_CONNECT_<ID>_URL）と許可リスト（RESEMEN_CONNECT_ALLOW）がなければ通信は拒否される（fetch.ts）
import { ConnectError } from "./fetch";
import { createFhirConnector, FHIR_ID } from "./fhir";
import { createFixtureConnector } from "./fixture";
import { createOrcaConnector, ORCA_ID } from "./orca";
import type { Connector } from "./types";

export type { ChartSource, ClaimSource, Connector, ConnectorChart, ConnectorClaims, ConnectorPatient, PatientSource, UnmappedLine } from "./types";
export { ConnectError, type ConnectErrorKind } from "./fetch";

const EXTERNAL: Record<string, () => Connector> = { [ORCA_ID]: createOrcaConnector, [FHIR_ID]: createFhirConnector };

/** 有効なコネクタの一覧。知らない名前が書いてあれば、黙って無視せずに止める */
export function enabledConnectors(root = process.cwd()): Connector[] {
  const names = (process.env.RESEMEN_CONNECTORS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const out = [createFixtureConnector(root)];
  for (const name of new Set(names)) {
    const make = EXTERNAL[name];
    if (!make) throw new ConnectError("?", "config", "RESEMEN_CONNECTORS に知らないコネクタの名前がある");
    out.push(make());
  }
  return out;
}

/** id でコネクタを引く。無効なコネクタは「ない」のと同じ */
export function connectorOf(id: string, root = process.cwd()): Connector {
  const c = enabledConnectors(root).find((x) => x.id === id);
  if (!c) throw new ConnectError("?", "config", "そのコネクタは有効になっていない");
  return c;
}
