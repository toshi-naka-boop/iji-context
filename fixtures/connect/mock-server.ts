// 模擬サーバー（spec FR-112）：ORCA API 形式と FHIR JP Core 形式の応答を、合成データ（orca.json・fhir.json）から返す。
// 自動テスト（tests/connect/）と手元の確認（scripts/mock-connect.ts）で同じものを使う。127.0.0.1 でだけ待ち受ける。
// パスや項目名は、コネクタと同じ定義（src/connect/orca.ts の ORCA_WIRE、src/connect/fhir.ts の FHIR_WIRE）から取る。
//
// パス：
//   /orca/api01rv2/patientgetv2?id=K1&format=json（GET・Basic 認証）
//   /orca/api01rv2/medicalgetv2?class=03&format=json（POST・Basic 認証）
//   /fhir/Patient?identifier=…｜/fhir/Coverage?beneficiary=…｜/fhir/Encounter｜/fhir/MedicationRequest｜/fhir/Condition（GET・Bearer 認証。1 ページ 1 件）
// 頭に /fault/<種類> を付けると、わざと壊した応答を返す（FAULTS を参照）
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FHIR_WIRE } from "../../src/connect/fhir";
import { ORCA_WIRE } from "../../src/connect/orca";

/** 壊した応答の種類 */
export const FAULTS = [
  /** JSON だが形が違う */
  "broken",
  /** content-type は JSON だが、本文が JSON でない */
  "notjson",
  /** content-type が text/html */
  "html",
  /** 大きい応答（content-length は正しい） */
  "huge",
  /** 大きい応答（content-length なし） */
  "huge-chunked",
  /** 大きい応答（content-length は小さく偽る） */
  "lying-length",
  /** 同じサーバーの正常なパスへのリダイレクト */
  "redirect",
  /** 応答が遅い（SLOW_MS 待つ） */
  "slow",
  /** ORCA：相手が失敗の結果（Api_Result）を返す */
  "api-error",
  /** ORCA：対応表にないコードの行を 1 つ混ぜる */
  "unmapped",
  /** FHIR：next リンクが別のホストを指す */
  "next-other-host",
  /** FHIR：next リンクが同じホストの、接続先の範囲の外を指す */
  "next-outside",
  /** FHIR：next リンクが自分自身を指し続ける */
  "next-loop",
] as const;
export type Fault = (typeof FAULTS)[number];

export const SLOW_MS = 3_000;
export const HUGE_BYTES = 5 * 1024 * 1024;
/** 対応表にないコード（実在しない並び） */
export const UNMAPPED_CODE = "000000000";
/** 模擬サーバーの患者番号の identifier system（医療機関コードの部分は架空の 10 桁） */
export const MOCK_PATIENT_SYSTEM = "urn:oid:1.2.392.100495.20.3.51.19999999999";

export type MockAuth = { orca: { user: string; password: string }; fhir: { token: string } };

const here = path.dirname(fileURLToPath(import.meta.url));
const load = <T>(file: string) => JSON.parse(readFileSync(path.join(here, file), "utf8")) as T;

type Resource = { resourceType: string; id: string; [k: string]: unknown };
type OrcaData = { patients: Record<string, unknown>; medical: Record<string, Record<string, { Medical_Information: unknown[] }>> };

const send = (res: ServerResponse, status: number, body: unknown, type = "application/json") => {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": `${type}; charset=utf-8`, "content-length": Buffer.byteLength(text) });
  res.end(text);
};

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let s = "";
    req.on("data", (c) => (s.length < 100_000 ? (s += c) : undefined));
    req.on("end", () => resolve(s));
  });

/** 壊した応答のうち、中身によらないもの。返したら true */
function commonFault(fault: Fault | null, req: IncomingMessage, res: ServerResponse, rest: string): boolean {
  if (fault === "notjson") send(res, 200, "<<これは JSON ではない>>");
  else if (fault === "html") send(res, 200, "<html><body>login</body></html>", "text/html");
  else if (fault === "redirect") res.writeHead(302, { location: `http://${req.headers.host}${rest}` }).end();
  else if (fault === "huge" || fault === "huge-chunked" || fault === "lying-length") {
    const headers: Record<string, string | number> = { "content-type": "application/json" };
    if (fault === "huge") headers["content-length"] = HUGE_BYTES + 9;
    if (fault === "lying-length") headers["content-length"] = 20;
    res.writeHead(200, headers);
    res.on("error", () => {});
    res.write('{"pad":"');
    res.write("x".repeat(HUGE_BYTES));
    res.end('"}');
  } else return false;
  return true;
}

function orca(data: OrcaData, fault: Fault | null, req: IncomingMessage, res: ServerResponse, url: URL, sub: string, body: string) {
  const failed = (root: string) => send(res, 200, { [root]: { Api_Result: "10" } });
  if (sub === ORCA_WIRE.patientPath && req.method === "GET") {
    const id = url.searchParams.get("id") ?? "";
    if (fault === "api-error" || !data.patients[id]) return failed(ORCA_WIRE.patientRoot);
    if (fault === "broken") return send(res, 200, { [ORCA_WIRE.patientRoot]: { Api_Result: "00", Patient_Information: { Patient_ID: id } } });
    return send(res, 200, data.patients[id]);
  }
  if (sub === ORCA_WIRE.medicalPath && req.method === "POST" && url.searchParams.get("class") === ORCA_WIRE.medicalClass) {
    let id = "";
    try {
      id = JSON.parse(body)[ORCA_WIRE.medicalRequestRoot].Patient_ID;
    } catch {
      return send(res, 400, { error: "bad request" });
    }
    if (fault === "api-error" || !data.medical[id]) return failed(ORCA_WIRE.medicalRoot);
    if (fault === "broken") return send(res, 200, { [ORCA_WIRE.medicalRoot]: { Api_Result: "00", Medical_Information: [{ Medication_Code: "x" }] } });
    const out = structuredClone(data.medical[id]);
    if (fault === "unmapped") out[ORCA_WIRE.medicalRoot].Medical_Information.push({ Medication_Code: UNMAPPED_CODE, Perform_Dates: ["2025-03-12"] });
    return send(res, 200, out);
  }
  send(res, 404, { error: "not found" });
}

function fhir(resources: Resource[], fault: Fault | null, req: IncomingMessage, res: ServerResponse, url: URL, type: string, prefix: string) {
  if (req.method !== "GET" || !(type in FHIR_WIRE.profiles)) return send(res, 404, { resourceType: "OperationOutcome" }, "application/fhir+json");
  if (fault === "broken") return send(res, 200, { resourceType: "Bundle", type: "searchset", entry: [{ resource: { resourceType: type, id: "broken" } }] }, "application/fhir+json");
  const p = url.searchParams;
  const s = FHIR_WIRE.search;
  const refOf = (r: Resource, key: string) => (r[key] as { reference?: string } | undefined)?.reference;
  const patientRef = (v: string | null) => (v === null ? null : v.startsWith("Patient/") ? v : `Patient/${v}`);
  const inRange = (value: string, conds: string[]) => conds.every((c) => (c.startsWith("ge") ? value.slice(0, 10) >= c.slice(2) : c.startsWith("le") ? value.slice(0, 10) <= c.slice(2) : true));
  let found = resources.filter((r) => r.resourceType === type);
  if (type === "Patient") {
    const [system, value] = (p.get("identifier") ?? "").split("|");
    found = found.filter((r) => (r.identifier as { system: string; value: string }[]).some((i) => i.system === system && i.value === value));
  } else if (type === "Coverage") {
    found = found.filter((r) => refOf(r, "beneficiary") === patientRef(p.get(s.coveragePatient)));
  } else if (type === "Encounter") {
    found = found.filter((r) => refOf(r, "subject") === patientRef(p.get(s.encounterPatient)) && inRange((r.period as { start: string }).start, p.getAll(s.encounterDate)));
  } else if (type === "MedicationRequest") {
    found = found.filter((r) => refOf(r, "subject") === patientRef(p.get(s.medicationPatient)) && inRange(r.authoredOn as string, p.getAll(s.medicationDate)));
  } else {
    found = found.filter((r) => refOf(r, "subject") === patientRef(p.get(s.conditionPatient)));
  }
  // 1 ページ 1 件。続きがあれば next リンクを付ける
  const page = Number(p.get("_page") ?? "1");
  const self = `http://${req.headers.host}${prefix}/fhir/${type}`;
  const next = new URLSearchParams(p);
  next.set("_page", String(page + 1));
  let nextUrl: string | null = page < found.length ? `${self}?${next}` : null;
  if (fault === "next-other-host") nextUrl = `https://other-host.invalid/fhir/${type}?${next}`;
  if (fault === "next-outside") nextUrl = `http://${req.headers.host}/elsewhere/${type}?${next}`;
  if (fault === "next-loop") nextUrl = `${self}?${p}`;
  send(
    res,
    200,
    {
      resourceType: "Bundle",
      type: "searchset",
      total: found.length,
      link: [{ relation: "self", url: `${self}?${p}` }, ...(nextUrl ? [{ relation: "next", url: nextUrl }] : [])],
      entry: found.slice(page - 1, page).map((resource) => ({ fullUrl: `${self}/${resource.id}`, resource, search: { mode: "match" } })),
    },
    "application/fhir+json",
  );
}

/** 模擬サーバーを作る。auth は呼ぶ側がその場で作った値（合っていない要求は 401） */
export function createMockConnect(auth: MockAuth): Server {
  const orcaData = load<OrcaData>("orca.json");
  const resources = load<{ resources: Resource[] }>("fhir.json").resources;
  const basic = `Basic ${Buffer.from(`${auth.orca.user}:${auth.orca.password}`, "utf8").toString("base64")}`;
  const bearer = `Bearer ${auth.fhir.token}`;
  const timers = new Set<NodeJS.Timeout>();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://mock.invalid");
    const m = /^(\/fault\/([a-z-]+))?\/(orca|fhir)\/(.+)$/.exec(url.pathname);
    if (!m || (m[2] && !(FAULTS as readonly string[]).includes(m[2]))) return send(res, 404, { error: "not found" });
    const [, prefix = "", faultName, kind, sub] = m;
    const fault = (faultName as Fault | undefined) ?? null;
    const body = req.method === "POST" ? await readBody(req) : "";
    if (req.headers.authorization !== (kind === "orca" ? basic : bearer)) return send(res, 401, { error: "unauthorized" });
    if (commonFault(fault, req, res, `/${kind}/${sub}${url.search}`)) return;
    const respond = () => (kind === "orca" ? orca(orcaData, fault, req, res, url, sub, body) : fhir(resources, fault, req, res, url, sub, prefix));
    if (fault !== "slow") return respond();
    const t = setTimeout(() => {
      timers.delete(t);
      respond();
    }, SLOW_MS);
    timers.add(t);
  });
  server.on("close", () => timers.forEach((t) => clearTimeout(t)));
  return server;
}

/** 127.0.0.1 で起動する（port 0 は空いている番号）。close は開いている接続も切る */
export async function startMockConnect(auth: MockAuth, port = 0): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createMockConnect(auth);
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(port, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
