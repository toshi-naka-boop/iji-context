// カルテの構造化データ（design.md §16-1・16-7・16-8。段 19a）：接続先から読んだ 4 種類を、その月の点検に使った形のまま残し、読み出す。
// 値（薬のコード・時刻・機器）は、ログ・監査ログ・エラー文・AI に送る文脈に出さない（件数と種類の名前だけ）。患者の識別子は返さない
import { createFixtureConnector, FIXTURE_ID } from "../../connect/fixture";
import { STRUCTURED_PARTS, type Part, type StructuredChart, type StructuredPart } from "../../connect/types";
import { readStructured } from "../../structured/read";
import { checkMapTarget, FIELDS, type Field, type MapContext, type MapTable } from "../../structured/code-map";
import { itemsOf, type SItem } from "../../structured/overlap";
import type { Coded } from "../../connect/types";
import { withMasters, type MastersDb } from "../../masters/db";
import type { G11Structured } from "../../generic/g11";
import { structuredConfig } from "../../structured/rule-codes";
import { YEAR_MONTH } from "../../demo/period";
import { resolveRevision } from "../../engine/revisions";
import { mapCoded } from "../../structured/code-map";
import type { InstructedDevice } from "../../structured/devices";
import { createDevices, type DeviceInput, type ProposalDecision } from "./devices";
import { badRequest } from "../errors";
import type { Clerks } from "./clerks";
import type { Clock } from "./clock";
import type { AppContext } from "./context";
import type { Patients } from "./patients";
import type { Uke } from "./uke";

/** 出どころの印（16-6）。構造化データの値は電子カルテ */
export const SOURCE_EHR = "電子カルテ";

type Row = { part: string; status: string; items: string; gaps: string; connector_id: string; fetched_at: string };

/** 読み出しの形：種類ごとの申告・件数・欠けの数・行と、出どころの印。患者の識別子は持たない */
export type StructuredView = {
  yearMonth: string;
  /** 読んだ接続先（まだ読んでいない・読める接続先がないときは null） */
  connectorId: string | null;
  fetchedAt: string | null;
  source: typeof SOURCE_EHR;
  parts: Record<StructuredPart, Part<unknown> & { count: number | null }>;
};

/** 4 種類のどれかを受け取っているか（どれも unsupported なら、構造化データのない請求） */
const hasStructured = (chart: StructuredChart | null): boolean => !!chart && STRUCTURED_PARTS.some((p) => chart[p].status === "supported");

const unsupportedAll = (): StructuredChart => ({ visits: { status: "unsupported" }, orders: { status: "unsupported" }, procedures: { status: "unsupported" }, homeCare: { status: "unsupported" } });

/** 対応表にない独自コードの一覧の 1 行（接続先・入力欄の種類・表示名・件数。患者・日は出さない） */
export type UnmappedCode = { connectorId: string; field: Field; extCode: string; names: string[]; count: number };

/** 構造化データの、コードを持つ欄と入力欄の種類（16-2 の表） */
function codedFields(chart: StructuredChart): { field: Field; coded: Coded }[] {
  const out: { field: Field; coded: Coded }[] = [];
  if (chart.orders.status === "supported") for (const o of chart.orders.items) for (const d of o.drugs) out.push({ field: "薬", coded: d });
  if (chart.procedures.status === "supported")
    for (const p of chart.procedures.items) {
      out.push({ field: "行為", coded: p.act });
      for (const x of p.items) out.push({ field: x.kind === "器材" ? "材料" : "薬", coded: x });
    }
  if (chart.homeCare.status === "supported")
    for (const h of chart.homeCare.items) {
      out.push({ field: "指導管理", coded: h.kind });
      for (const d of h.devices) out.push({ field: "機器", coded: d });
    }
  return out;
}

export function createStructured(ctx: AppContext, clock: Clock, uke: Uke, patients: Patients, clerks: Pick<Clerks, "clerk">) {
  const { sqlite, paths } = ctx;
  const devices = createDevices(ctx, clock, clerks);

  /** 請求の患者の、患者マスタの id（請求からその月の構造化データを引くとき） */
  const structuredPatientOf = (claimId: string): string => patients.ingest(uke.receiptOf(claimId).receipt.patient);

  /** 読んだ 4 種類を追記で残す（同じ患者・月・種類は、あとで最新の行を使う）。only を渡すと、その種類だけを残す（さかのぼる月の処方のオーダー。機器の変える案は作らない） */
  function saveStructured(patientId: string, yearMonth: string, connectorId: string, s: StructuredChart, only?: readonly StructuredPart[]): void {
    const at = clock.now();
    const put = sqlite.prepare("INSERT INTO chart_structured (patient_id, year_month, part, status, items, gaps, connector_id, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    sqlite.transaction(() => {
      for (const p of only ?? STRUCTURED_PARTS) {
        const part = s[p];
        put.run(patientId, yearMonth, p, part.status, JSON.stringify(part.status === "supported" ? part.items : []), JSON.stringify(part.status === "supported" ? part.gaps : {}), connectorId, at);
      }
      // 在宅療養の指示の機器は、患者の機器の「変える案」にする（16-5。確かめるまで判定に使わない）
      if (!only && s.homeCare.status === "supported") devices.syncProposals(patientId, yearMonth, connectorId, instructedOf(s, yearMonth, connectorId));
    })();
  }
  /** 在宅療養の指示の機器を、機器の種類に当てる（16-2 の機器の欄。表示名だけで決まらないものは種類なし） */
  function instructedOf(s: StructuredChart, yearMonth: string, connectorId: string): InstructedDevice[] {
    if (s.homeCare.status !== "supported") return [];
    const ctx: MapContext = { db: null, yearMonth, connectorId, localMap: localMapOf(connectorId) };
    return s.homeCare.items.flatMap((h) =>
      h.devices.map((d, i): InstructedDevice => {
        const m = mapCoded("機器", d, ctx);
        return { kind: m.ok ? (m.code as InstructedDevice["kind"]) : null, name: d.name, startedOn: d.startedOn, endedOn: d.endedOn, ref: `${h.ref}/${i}` };
      }),
    );
  }

  /** 残した種類（その患者・月） */
  const storedParts = (patientId: string, yearMonth: string): Set<string> =>
    new Set((sqlite.prepare("SELECT DISTINCT part FROM chart_structured WHERE patient_id = ? AND year_month = ?").all(patientId, yearMonth) as { part: string }[]).map((r) => r.part));

  /** 残した 4 種類の最新（1 つも残していなければ null） */
  function storedStructured(patientId: string, yearMonth: string): { chart: StructuredChart; connectorId: string; fetchedAt: string } | null {
    const rows = sqlite
      .prepare("SELECT part, status, items, gaps, connector_id, fetched_at FROM chart_structured WHERE id IN (SELECT MAX(id) FROM chart_structured WHERE patient_id = ? AND year_month = ? GROUP BY part)")
      .all(patientId, yearMonth) as Row[];
    if (rows.length === 0) return null;
    const chart = unsupportedAll();
    for (const r of rows) {
      if (!(STRUCTURED_PARTS as readonly string[]).includes(r.part)) continue;
      (chart as Record<string, Part<unknown>>)[r.part] = r.status === "supported" ? { status: "supported", items: JSON.parse(r.items) as unknown[], gaps: JSON.parse(r.gaps) as Record<string, number> } : { status: "unsupported" };
    }
    const latest = rows.reduce((a, b) => (a.fetched_at >= b.fetched_at ? a : b));
    return { chart, connectorId: latest.connector_id, fetchedAt: latest.fetched_at };
  }

  /** 同梱の合成データの患者なら、合成の接続先（FR-105）での患者の id（症例の id）。取り込んだ請求の患者は null（つなぐ接続先がない） */
  function fixturePatientOf(patientId: string, yearMonth: string): string | null {
    const r = uke.ukeReceipts().find((x) => x.yearMonth === yearMonth && patients.ingest(x.patient) === patientId && !uke.receiptOf(x.claimId).uploaded);
    return r ? r.claimId.split("-")[0] : null;
  }

  /**
   * その月の構造化データ（GET /api/chart/structured）。残してあれば最新を返す。なければ、読める接続先（いまは同梱の合成データだけ）から読んで残してから返す。
   * 読める接続先がなければ、4 種類とも unsupported（残さない）
   */
  async function chartStructured(patientId: string, yearMonth: string): Promise<StructuredView> {
    if (!YEAR_MONTH.test(yearMonth)) throw badRequest("診療年月は YYYY-MM で指定する", ["yearMonth"]);
    let stored = storedStructured(patientId, yearMonth);
    if (!stored) {
      const caseId = fixturePatientOf(patientId, yearMonth);
      if (caseId) {
        const chart = await createFixtureConnector(paths.root).chart!.getChart({ patientId: caseId, yearMonth });
        saveStructured(patientId, yearMonth, FIXTURE_ID, readStructured(chart));
        stored = storedStructured(patientId, yearMonth);
      }
    }
    const chart = stored?.chart ?? unsupportedAll();
    const parts = Object.fromEntries(STRUCTURED_PARTS.map((p) => [p, { ...chart[p], count: chart[p].status === "supported" ? chart[p].items.length : null }])) as StructuredView["parts"];
    return { yearMonth, connectorId: stored?.connectorId ?? null, fetchedAt: stored?.fetchedAt ?? null, source: SOURCE_EHR, parts };
  }

  /** 請求の患者と診療年月（UKE にない請求は null） */
  function claimPatientOf(claimId: string): { patientId: string; yearMonth: string } | null {
    try {
      const r = uke.receiptOf(claimId).receipt;
      return { patientId: patients.ingest(r.patient), yearMonth: r.yearMonth };
    } catch {
      return null;
    }
  }
  /**
   * 画面の操作（取り込んだ請求の点検・算定プレビュー・月末の点検・カルテの確かめる画面・患者の機器の欄）の前に、その請求の構造化データを接続先から読んで残す（C-440。16-1・16-7）。
   * 当月は 4 種類を、さかのぼる月（rxLookbackMonths）は処方のオーダーだけを、まだ残していなければ読む。読める接続先がない請求（取り込んだ実在の請求）は何もしない
   */
  async function ensureStructured(claimId: string): Promise<void> {
    const c = claimPatientOf(claimId);
    if (!c) return;
    const caseId = fixturePatientOf(c.patientId, c.yearMonth);
    if (!caseId) return;
    const connector = createFixtureConnector(paths.root).chart!;
    if (storedParts(c.patientId, c.yearMonth).size < STRUCTURED_PARTS.length) saveStructured(c.patientId, c.yearMonth, FIXTURE_ID, readStructured(await connector.getChart({ patientId: caseId, yearMonth: c.yearMonth })));
    // 構造化データを返さない接続先（当月が 4 種類とも unsupported）は、さかのぼる月を読まない
    if (!hasStructured(storedStructured(c.patientId, c.yearMonth)?.chart ?? null)) return;
    for (const ym of monthsBefore(c.yearMonth, structuredConfig().rxLookbackMonths))
      if (!storedParts(c.patientId, ym).has("orders")) saveStructured(c.patientId, ym, FIXTURE_ID, readStructured(await connector.getChart({ patientId: caseId, yearMonth: ym })), ["orders"]);
  }

  // ---------------------------------------------------------------------------
  // 独自コードの対応表（16-2。段 19b）

  type MapRow = { connector_id: string; field: string; system: string; ext_code: string; tbl: string; code: string };
  /** その接続先の対応表を引く道具 */
  function localMapOf(connectorId: string): MapContext["localMap"] {
    const rows = sqlite.prepare("SELECT connector_id, field, system, ext_code, tbl, code FROM ext_code_maps WHERE connector_id = ?").all(connectorId) as MapRow[];
    const byKey = new Map(rows.map((r) => [`${r.field}|${r.system}|${r.ext_code}`, { tbl: r.tbl as MapTable, code: r.code }]));
    return (field, system, value) => byKey.get(`${field}|${system}|${value}`) ?? null;
  }
  const mapContextOf = (db: MastersDb | null, yearMonth: string, connectorId: string): MapContext => ({ db, yearMonth, connectorId, localMap: localMapOf(connectorId) });

  /** 残した構造化データ（各患者・月・種類の最新）の、対応表にない独自コード（GET /api/code-maps）。同じ接続先・欄・コードは 1 行にまとめ、件数を数える */
  function unmappedCodes(): UnmappedCode[] {
    const rows = sqlite.prepare("SELECT patient_id, year_month, part, status, items, gaps, connector_id, fetched_at FROM chart_structured WHERE id IN (SELECT MAX(id) FROM chart_structured GROUP BY patient_id, year_month, part)").all() as (Row & { patient_id: string; year_month: string })[];
    const out = new Map<string, UnmappedCode>();
    const maps = new Map<string, MapContext["localMap"]>();
    for (const r of rows) {
      if (r.status !== "supported") continue;
      const chart = { ...unsupportedAll(), [r.part]: { status: "supported", items: JSON.parse(r.items) as unknown[], gaps: {} } } as StructuredChart;
      if (!maps.has(r.connector_id)) maps.set(r.connector_id, localMapOf(r.connector_id));
      for (const { field, coded } of codedFields(chart)) {
        if (coded.code?.system !== "local" || maps.get(r.connector_id)!(field, "local", coded.code.value)) continue;
        const k = `${r.connector_id}|${field}|${coded.code.value}`;
        const e = out.get(k) ?? { connectorId: r.connector_id, field, extCode: coded.code.value, names: [], count: 0 };
        e.count++;
        if (coded.name && !e.names.includes(coded.name)) e.names.push(coded.name);
        out.set(k, e);
      }
    }
    return [...out.values()].sort((a, b) => (a.connectorId + a.field + a.extCode < b.connectorId + b.field + b.extCode ? -1 : 1));
  }

  /**
   * 独自コードの対応を残す（POST /api/code-maps）。機器は DEVICE_KINDS のキー（none は不可）、ほかは診療年月の 1 枚の、その欄の当ててよい表に実在するコードだけ（C-422＝X-252・X-243）。
   * 同じ接続先・欄・独自コードの対応は置き換える（欄が違えば別の行で、互いを上書きしない）
   */
  function saveCodeMap(clerkId: string, input: { connectorId: string; field: Field; extCode: string; code: string; yearMonth: string }): { saved: true } {
    clerks.clerk(clerkId);
    if (!(FIELDS as readonly string[]).includes(input.field)) throw badRequest("入力欄の種類が違います", ["field"]);
    const target = withMasters((db) => checkMapTarget(input.field, input.code, db, input.yearMonth));
    if ("reason" in target) throw badRequest(target.reason, ["code"]);
    sqlite
      .prepare("INSERT INTO ext_code_maps (connector_id, field, system, ext_code, tbl, code, chosen_by, chosen_at) VALUES (?, ?, 'local', ?, ?, ?, ?, ?) ON CONFLICT(connector_id, field, system, ext_code) DO UPDATE SET tbl = excluded.tbl, code = excluded.code, chosen_by = excluded.chosen_by, chosen_at = excluded.chosen_at")
      .run(input.connectorId, input.field, input.extCode, target.tbl, input.code, clerkId, clock.now());
    return { saved: true };
  }

  /** 請求の患者・診療年月の、残した構造化データと当てたコードつきの行為（G11・確かめる画面が使う。読むだけで、接続先からは読まない） */
  function structuredItemsOf(claimId: string, yearMonth: string, db: MastersDb | null): { chart: StructuredChart; items: SItem[]; connectorId: string } | null {
    let patientId: string;
    try {
      patientId = structuredPatientOf(claimId);
    } catch {
      return null;
    }
    const stored = storedStructured(patientId, yearMonth);
    // 接続先が構造化データを返さない（4 種類とも unsupported）請求は、構造化データのない請求として扱う（C-440・v34 の 16-4-1）
    if (!stored || !hasStructured(stored.chart)) return null;
    return { chart: stored.chart, items: itemsOf(stored.chart, mapContextOf(db, yearMonth, stored.connectorId)), connectorId: stored.connectorId };
  }

  // ---------------------------------------------------------------------------
  // 規則で出す算定の入力（16-4・16-6。段 19c・19d）

  /** 医療事務が入れた訪問の時刻を追記で残す（POST /api/chart/structured/visit-time。16-6）。"HH:MM" で終了が開始より後。値はログ・監査ログに出さない */
  function saveVisitTime(clerkId: string, input: { claimId: string; date: string; ref?: string; start: string; end: string }): { saved: true } {
    clerks.clerk(clerkId);
    const ym = uke.receiptOf(input.claimId).receipt.yearMonth;
    if (!input.date.startsWith(`${ym}-`)) throw badRequest(`日付が診療年月（${ym}）の外です`, ["date"]);
    if (!(input.end > input.start)) throw badRequest("終了の時刻は開始の時刻より後にしてください（日をまたぐ記録は入れられません）", ["end"]);
    const patientId = structuredPatientOf(input.claimId);
    // ref は、その日の残した電子カルテの訪問の記録（最新）と照らす（C-442＝C-452）。訪問の記録が 1 件の日の ref なしは、その訪問に結び付ける。2 件以上の日は選んでもらう
    const visits = storedStructured(patientId, ym)?.chart.visits;
    const onDay = visits?.status === "supported" ? visits.items.filter((v) => v.date === input.date) : [];
    let ref = input.ref ?? null;
    if (ref !== null && !onDay.some((v) => v.ref === ref)) throw badRequest("その日の電子カルテの訪問の記録にない訪問です。点検を開き直して選んでください", ["ref"]);
    if (ref === null && onDay.length >= 2) throw badRequest(`その日の訪問の記録が ${onDay.length} 件あります。どの訪問の時刻かを選んでください`, ["ref"]);
    if (ref === null && onDay.length === 1) ref = onDay[0].ref;
    sqlite
      .prepare("INSERT INTO structured_inputs (patient_id, date, visit_ref, start, end, entered_by, entered_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(patientId, input.date, ref, input.start, input.end, clerkId, clock.now());
    return { saved: true };
  }
  /** その患者・月の、医療事務が入れた時刻（誰は医療事務の名前） */
  function visitTimesOf(patientId: string, yearMonth: string): G11Structured["times"] {
    const rows = sqlite
      .prepare("SELECT i.date, i.visit_ref, i.start, i.end, i.entered_at, COALESCE(c.name, '') AS name FROM structured_inputs i LEFT JOIN clerks c ON c.id = i.entered_by WHERE i.patient_id = ? AND i.date LIKE ? ORDER BY i.id")
      .all(patientId, `${yearMonth}-%`) as { date: string; visit_ref: string | null; start: string; end: string; entered_at: string; name: string }[];
    return rows.map((r) => ({ date: r.date, ref: r.visit_ref, start: r.start, end: r.end, by: r.name, at: r.entered_at }));
  }
  /** 当月の前の n か月（新しい月から） */
  const monthsBefore = (yearMonth: string, n: number): string[] =>
    Array.from({ length: n }, (_, i) => {
      const d = new Date(Date.UTC(Number(yearMonth.slice(0, 4)), Number(yearMonth.slice(5, 7)) - 2 - i, 1));
      return d.toISOString().slice(0, 7);
    });
  /** 同じ患者の、ほかの月の請求（取り込んだ・同梱の請求。さかのぼる月のカルテの文章を読むため） */
  function samePatientClaims(claimId: string, yearMonths: string[]): { yearMonth: string; claimId: string }[] {
    const patientId = structuredPatientOf(claimId);
    const want = new Set(yearMonths);
    return uke
      .ukeReceipts()
      .filter((x) => want.has(x.yearMonth) && x.claimId !== claimId && patients.ingest(x.patient) === patientId)
      .map((x) => ({ yearMonth: x.yearMonth, claimId: x.claimId }));
  }
  /**
   * G11 の規則の候補に渡す構造化データ（当月・さかのぼる月の処方のオーダー・医療事務が入れた時刻）。当月を残していなければ null（規則の候補を出さない）。
   * さかのぼる月は残した処方のオーダーだけを読み、残していない月は null（読めない。L-201）
   */
  function structuredRulesOf(claimId: string, yearMonth: string, db: MastersDb | null): Omit<G11Structured, "texts"> | null {
    const s = structuredItemsOf(claimId, yearMonth, db);
    if (!s) return null;
    const patientId = structuredPatientOf(claimId);
    const lookbackMonths = structuredConfig().rxLookbackMonths;
    const history = monthsBefore(yearMonth, lookbackMonths).map((ym) => {
      const st = storedStructured(patientId, ym);
      if (!st || st.chart.orders.status !== "supported") return { yearMonth: ym, orders: st ? st.chart.orders : null, items: [] };
      const only: StructuredChart = { ...unsupportedAll(), orders: st.chart.orders };
      return { yearMonth: ym, orders: st.chart.orders, items: itemsOf(only, mapContextOf(db, ym, st.connectorId)) };
    });
    return { chart: s.chart, items: s.items, history, lookbackMonths, times: visitTimesOf(patientId, yearMonth), devices: deviceRulesOf(claimId, patientId, yearMonth, s.chart, s.connectorId, db) };
  }

  /** 前の 2 か月の取り込んだ請求の、単位ごとのコードとコメント（材料加算の前の月の分。16-4-7） */
  const prevClaimsOf = (claimId: string, yearMonth: string): NonNullable<G11Structured["devices"]>["prev"] =>
    samePatientClaims(claimId, monthsBefore(yearMonth, 2)).map((x) => {
      const claim = uke.receiptOf(x.claimId).claim();
      return {
        yearMonth: x.yearMonth,
        units: claim.units.map((u, i) => ({ codes: u.items.map((it) => it.code), comments: claim.comments.filter((cm) => cm.unit === i).map((cm) => cm.code) })),
      };
    });
  /**
   * 構造化データのない請求の、材料加算の入力（v34 の 16-4-1：患者の情報の機器だけで決まる材料加算は、機器を確かめた患者なら今までどおり見る）。
   * 機器を確かめていない患者は null（入力を促さない。C-440）
   */
  function devicesOnlyOf(claimId: string, yearMonth: string): NonNullable<G11Structured["devices"]> | null {
    const c = claimPatientOf(claimId);
    if (!c) return null;
    const own = devices.deviceInputOf(c.patientId, yearMonth);
    if (!own.checked) return null;
    return { ...own, prev: prevClaimsOf(claimId, yearMonth), c103: false };
  }

  /**
   * 材料加算の入力（16-4-7）：患者の機器（効く行・確かめたか・決めていない案）、前の 2 か月の取り込んだ請求の単位ごとのコードとコメント、
   * 電子カルテの在宅療養の指示に C103 の 2 の指導管理があるか
   */
  function deviceRulesOf(claimId: string, patientId: string, yearMonth: string, chart: StructuredChart, connectorId: string, db: MastersDb | null): NonNullable<G11Structured["devices"]> {
    const prev = prevClaimsOf(claimId, yearMonth);
    const rev = resolveRevision(yearMonth);
    const c103Codes = new Set(Object.hasOwn(rev.codes, "C103_2") ? [rev.codes.C103_2.primary, ...rev.codes.C103_2.accept] : []);
    const ctx = mapContextOf(db, yearMonth, connectorId);
    const c103 = chart.homeCare.status === "supported" && chart.homeCare.items.some((h) => {
      const m = mapCoded("指導管理", h.kind, ctx);
      return m.ok && c103Codes.has(m.code);
    });
    return { ...devices.deviceInputOf(patientId, yearMonth), prev, c103 };
  }

  // ---------------------------------------------------------------------------
  // 患者の機器の画面と API（16-5・16-7。段 19e）。請求から患者を引く（患者の識別子は画面に出さない）

  /** 患者の機器の欄。structured：その請求に構造化データがあるか（ないときは画面で機器の入力を促さない。C-440） */
  const patientDevices = (claimId: string) => {
    const ym = uke.receiptOf(claimId).receipt.yearMonth;
    const patientId = structuredPatientOf(claimId);
    return { ...devices.devicesView(patientId, ym), structured: hasStructured(storedStructured(patientId, ym)?.chart ?? null) };
  };
  const savePatientDevice = (claimId: string, clerkId: string, input: DeviceInput) => devices.addDevice(structuredPatientOf(claimId), clerkId, input);
  const decideDeviceProposal = (claimId: string, id: number, clerkId: string, input: ProposalDecision) => devices.decideProposal(structuredPatientOf(claimId), id, clerkId, input);

  return { ensureStructured, devicesOnlyOf, saveStructured, storedStructured, chartStructured, structuredPatientOf, unmappedCodes, saveCodeMap, structuredItemsOf, mapContextOf, saveVisitTime, visitTimesOf, samePatientClaims, structuredRulesOf, monthsBefore, patientDevices, savePatientDevice, decideDeviceProposal, devices };
}

export type Structured = ReturnType<typeof createStructured>;
