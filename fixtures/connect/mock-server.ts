// 模擬サーバー（spec FR-112）：ORCA API 形式と FHIR JP Core 形式の応答を、合成データ（orca.json・fhir.json）から返す。
// 自動テスト（tests/connect/）と手元の確認（scripts/mock-connect.ts）で同じものを使う。127.0.0.1 でだけ待ち受ける。
// パスや項目名は、コネクタと同じ定義（src/connect/orca.ts の ORCA_WIRE、src/connect/fhir.ts の FHIR_WIRE）から取る。
//
// パス：
//   /orca/api01rv2/patientgetv2?id=K1&format=json（GET・Basic 認証）
//   /fhir/Patient?identifier=…｜/fhir/Coverage?beneficiary=…｜/fhir/Encounter｜/fhir/MedicationRequest｜/fhir/Condition（GET・Bearer 認証。1 ページ 1 件）
//   /orca/api01rv2/medicalgetv2?class=03（POST・Basic 認証。要求も応答も xml2 形式。診療月診療コード情報）
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
  /** ORCA の診療行為：閉じていないタグのある XML */
  "xml-broken",
  /** ORCA の診療行為：DOCTYPE と実体の宣言つきの XML */
  "xml-doctype",
  /** ORCA の診療行為：__proto__ という名前の要素がある XML */
  "xml-proto",
  /** ORCA の診療行為：架空コードの表にないコードの行が 1 つ混じる */
  "unknown-code",
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
/** 模擬サーバーの患者番号の identifier system（医療機関コードの部分は架空の 10 桁） */
export const MOCK_PATIENT_SYSTEM = "urn:oid:1.2.392.100495.20.3.51.19999999999";

export type MockAuth = { orca: { user: string; password: string }; fhir: { token: string } };

const here = path.dirname(fileURLToPath(import.meta.url));
const load = <T>(file: string) => JSON.parse(readFileSync(path.join(here, file), "utf8")) as T;

type Resource = { resourceType: string; id: string; [k: string]: unknown };
type OrcaMedical = { Patient_Information: { Patient_ID: string }; Perform_Date: string; Medical_List_Information: Record<string, string>[] };
type OrcaData = { patients: Record<string, unknown>; medical: Record<string, OrcaMedical> };

/** 架空コードの表にないコード（unknown-code 用。表のコードは 99 で始まる） */
const UNKNOWN_CODE = "980000001";

/** xml2 形式にする（日レセ API の応答の書き方）：オブジェクトは type="record"、配列は type="array" で中の要素名は「〜_child」、値は type="string" */
function xml2(name: string, v: unknown): string {
  if (Array.isArray(v)) return `<${name} type="array">${v.map((x) => xml2(`${name}_child`, x)).join("")}</${name}>`;
  if (v && typeof v === "object") return `<${name} type="record">${Object.entries(v).map(([k, x]) => xml2(k, x)).join("")}</${name}>`;
  return `<${name} type="string">${String(v).replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</${name}>`;
}

const send = (res: ServerResponse, status: number, body: unknown, type = "application/json") => {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": `${type}; charset=utf-8`, "content-length": Buffer.byteLength(text) });
  res.end(text);
};

/** 壊した応答のうち、中身によらないもの。返したら true */
function commonFault(fault: Fault | null, req: IncomingMessage, res: ServerResponse, rest: string): boolean {
  if (fault === "notjson") send(res, 200, "<<これは JSON ではない>>");
  else if (fault === "html") send(res, 200, "<html><body>login</body></html>", "text/html");
  else if (fault === "redirect") res.writeHead(302, { location: `http://${req.headers.host}${rest}` }).end();
  else if (fault === "huge" || fault === "huge-chunked" || fault === "lying-length") {
    // content-type は頼まれた形に合わせる（コネクタが大きさの検査まで進むように）
    const headers: Record<string, string | number> = { "content-type": req.headers.accept === ORCA_WIRE.xmlType ? ORCA_WIRE.xmlType : "application/json" };
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

/** 診療行為（診療月診療コード情報）。要求の本文から患者番号と診療年月を読み、その月の診療行為を xml2 形式で返す */
async function orcaMedical(data: OrcaData, fault: Fault | null, req: IncomingMessage, res: ServerResponse, url: URL) {
  if (req.method !== "POST" || url.searchParams.get("class") !== ORCA_WIRE.medicalClass || !String(req.headers["content-type"]).startsWith(ORCA_WIRE.xmlType)) return send(res, 404, { error: "not found" });
  let body = "";
  for await (const chunk of req.setEncoding("utf8")) body += chunk;
  const item = (name: string) => new RegExp(`<${name} type="string">([^<]*)</${name}>`).exec(body)?.[1] ?? "";
  const xml = (text: string) => send(res, 200, text, ORCA_WIRE.xmlType);
  const wrap = (content: Record<string, unknown>) => `<${ORCA_WIRE.xmlRoot}>${xml2(ORCA_WIRE.medicalRoot, content)}</${ORCA_WIRE.xmlRoot}>`;
  if (!body.includes(`<${ORCA_WIRE.medicalRequestRoot} type="record">`)) return xml(wrap({ Api_Result: "97" }));
  if (fault === "api-error") return xml(wrap({ Api_Result: "89" }));
  const found = data.medical[item("Patient_ID")];
  if (!found) return xml(wrap({ Api_Result: ORCA_WIRE.notFoundResult }));
  const { Medical_List_Information: rows, ...head } = found;
  const ok = { Api_Result: "00", ...head };
  // 合成データのない月は、診療行為のない応答（診療年月は頼まれた月）
  const month = item("Perform_Date").slice(0, 7);
  if (month !== found.Perform_Date) return xml(wrap({ ...ok, Perform_Date: month }));
  if (fault === "broken") return xml(wrap({ ...ok, Medical_List_Information: rows.map(({ Perform_Calendar: _dropped, ...r }) => r) }));
  if (fault === "unknown-code") return xml(wrap({ ...ok, Medical_List_Information: [...rows, { ...rows[0], Medication_Code: UNKNOWN_CODE }] }));
  const good = wrap({ ...ok, Medical_List_Information: rows });
  if (fault === "xml-broken") return xml(good.replace("</Perform_Date>", ""));
  if (fault === "xml-doctype") return xml(`<!DOCTYPE ${ORCA_WIRE.xmlRoot} [<!ENTITY e "${found.Perform_Date}">]>${good.replace(`>${found.Perform_Date}</Perform_Date>`, ">&e;</Perform_Date>")}`);
  if (fault === "xml-proto") return xml(good.replace("<Perform_Date", `<__proto__ type="record"><polluted type="string">1</polluted></__proto__><Perform_Date`));
  xml(good);
}

function orca(data: OrcaData, fault: Fault | null, req: IncomingMessage, res: ServerResponse, url: URL, sub: string) {
  if (sub === ORCA_WIRE.medicalPath) return void orcaMedical(data, fault, req, res, url);
  if (sub !== ORCA_WIRE.patientPath || req.method !== "GET" || url.searchParams.get("format") !== "json") return send(res, 404, { error: "not found" });
  const id = url.searchParams.get("id") ?? "";
  const result = (code: string) => send(res, 200, { [ORCA_WIRE.patientRoot]: { Api_Result: code } });
  if (fault === "api-error") return result("89");
  if (!data.patients[id]) return result(ORCA_WIRE.notFoundResult);
  if (fault === "broken") return send(res, 200, { [ORCA_WIRE.patientRoot]: { Api_Result: "00", Patient_Information: { Patient_ID: id } } });
  send(res, 200, data.patients[id]);
}

function fhir(resources: Resource[], fault: Fault | null, req: IncomingMessage, res: ServerResponse, url: URL, type: string, prefix: string) {
  if (req.method !== "GET" || !(type in FHIR_WIRE.profiles)) return send(res, 404, { resourceType: "OperationOutcome" }, "application/fhir+json");
  if (fault === "broken") return send(res, 200, { resourceType: "Bundle", type: "searchset", entry: [{ resource: { resourceType: type, id: "broken" } }] }, "application/fhir+json");
  const p = url.searchParams;
  const s = FHIR_WIRE.search;
  const refOf = (r: Resource, key: string) => (r[key] as { reference?: string } | undefined)?.reference;
  // 参照の検索は、仕様の例にある 2 つの書き方（Patient/[id] と [id]）のどちらも受ける
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

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://mock.invalid");
    const m = /^(\/fault\/([a-z-]+))?\/(orca|fhir)\/(.+)$/.exec(url.pathname);
    if (!m || (m[2] && !(FAULTS as readonly string[]).includes(m[2]))) return send(res, 404, { error: "not found" });
    const [, prefix = "", faultName, kind, sub] = m;
    const fault = (faultName as Fault | undefined) ?? null;
    if (req.headers.authorization !== (kind === "orca" ? basic : bearer)) return send(res, 401, { error: "unauthorized" });
    if (commonFault(fault, req, res, `/${kind}/${sub}${url.search}`)) return;
    const respond = () => (kind === "orca" ? orca(orcaData, fault, req, res, url, sub) : fhir(resources, fault, req, res, url, sub, prefix));
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
