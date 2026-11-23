// カルテの構造化データ（design.md §16-1・16-7・16-8。段 19a）：接続先から読んだ 4 種類を、その月の点検に使った形のまま残し、読み出す。
// 値（薬のコード・時刻・機器）は、ログ・監査ログ・エラー文・AI に送る文脈に出さない（件数と種類の名前だけ）。患者の識別子は返さない
import { createFixtureConnector, FIXTURE_ID } from "../../connect/fixture";
import { STRUCTURED_PARTS, type Part, type StructuredChart, type StructuredPart } from "../../connect/types";
import { readStructured } from "../../structured/read";
import { YEAR_MONTH } from "../../demo/period";
import { badRequest } from "../errors";
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

const unsupportedAll = (): StructuredChart => ({ visits: { status: "unsupported" }, orders: { status: "unsupported" }, procedures: { status: "unsupported" }, homeCare: { status: "unsupported" } });

export function createStructured(ctx: AppContext, clock: Clock, uke: Uke, patients: Patients) {
  const { sqlite, paths } = ctx;

  /** 読んだ 4 種類を追記で残す（同じ患者・月・種類は、あとで最新の行を使う） */
  function saveStructured(patientId: string, yearMonth: string, connectorId: string, s: StructuredChart): void {
    const at = clock.now();
    const put = sqlite.prepare("INSERT INTO chart_structured (patient_id, year_month, part, status, items, gaps, connector_id, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    sqlite.transaction(() => {
      for (const p of STRUCTURED_PARTS) {
        const part = s[p];
        put.run(patientId, yearMonth, p, part.status, JSON.stringify(part.status === "supported" ? part.items : []), JSON.stringify(part.status === "supported" ? part.gaps : {}), connectorId, at);
      }
    })();
  }

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

  /** 請求の患者の、患者マスタの id（請求からその月の構造化データを引くとき） */
  const structuredPatientOf = (claimId: string): string => patients.ingest(uke.receiptOf(claimId).receipt.patient);

  return { saveStructured, storedStructured, chartStructured, structuredPatientOf };
}

export type Structured = ReturnType<typeof createStructured>;
