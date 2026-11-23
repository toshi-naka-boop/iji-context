// フィクスチャ コネクタ（spec FR-105）：同梱の合成データ（fixtures/ の UKE・症例・カルテ）を、境界の型で返す。
// 既定で有効なのはこのコネクタだけ。外への通信はしない
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ClaimContext } from "../engine/types";
import type { Chart } from "../uke/crosscheck";
import type { UkeFile, UkeReceipt } from "../uke/types";
import { readUke } from "../uke/uke";
import { recordOfUke } from "../patient/profile";
import { assertQuery, type Connector, type StructuredChart } from "./types";

export const FIXTURE_ID = "fixture";
const UKE_FILES = ["kokuhoren.UKE", "shiharaikikin.UKE"];
/** 患者とカルテを引ける UKE：見本の 2 本と、受け入れの症例 K12・K13（kozoka.UKE。design.md §16-10 の E-13。fixtures/structured/K12・K13.json の構造化データを返す）。請求（getClaims）は見本の 2 本のまま */
const PATIENT_UKE_FILES = [...UKE_FILES, "kozoka.UKE"];

const isoDate = (yyyymmdd: string) => `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;

/** 患者の id は、症例の id（請求 id の頭。K1 など）を使う */
const patientIdOf = (r: UkeReceipt) => r.claimId.split("-")[0];

/** 合成の構造化データを、その月の分にする（申告と欠けの数は読む側が数え直す。src/structured/read.ts） */
function structuredOf(file: Record<string, unknown> | null, yearMonth: string): { structured?: StructuredChart } {
  if (!file) return {};
  const part = (name: string, dated: boolean) => {
    const p = file[name] as { status?: unknown; items?: unknown } | undefined;
    if (!p || p.status !== "supported") return { status: "unsupported" };
    const items = Array.isArray(p.items) ? p.items : [];
    return { status: "supported", items: dated ? items.filter((x) => typeof (x as { date?: unknown })?.date === "string" && (x as { date: string }).date.startsWith(`${yearMonth}-`)) : items, gaps: {} };
  };
  return { structured: { visits: part("visits", true), orders: part("orders", true), procedures: part("procedures", true), homeCare: part("homeCare", false) } as StructuredChart };
}

export function createFixtureConnector(root = process.cwd()): Connector {
  const fixtures = path.join(root, "fixtures");
  const read = (names: string[]): UkeFile[] => names.map((f) => readUke(readFileSync(path.join(fixtures, "uke", f))));
  const files = (): UkeFile[] => read(UKE_FILES);
  const json = <T>(dir: string, patientId: string): T | null => {
    const file = path.join(fixtures, dir, `${patientId}.json`);
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : null;
  };
  const receiptOf = (patientId: string): UkeReceipt => {
    assertQuery(patientId, null);
    const r = read(PATIENT_UKE_FILES)
      .flatMap((f) => f.receipts)
      .find((x) => patientIdOf(x) === patientId);
    if (!r) throw new Error(`合成データにない患者: ${patientId}`);
    return r;
  };

  return {
    id: FIXTURE_ID,
    label: "同梱の合成データ",
    patient: {
      async getPatient(patientId) {
        const { patient } = receiptOf(patientId);
        // 負担割合は症例の事実から。有効期間は合成データにないので null（患者情報チェックでは「情報不足」になる）
        const ratio = json<ClaimContext>("cases", patientId)?.facts.burdenRatio;
        const record = recordOfUke(patient);
        return { ...record, patientId, coverages: record.coverages.map((c) => (c.kind === "医保" ? { ...c, burdenRatio: ratio?.known ? ratio.value : null } : c)) };
      },
    },
    claims: {
      async getClaims({ yearMonth, patientIds }) {
        assertQuery(null, yearMonth);
        const wanted = (r: UkeReceipt) => r.yearMonth === yearMonth && (!patientIds || patientIds.includes(patientIdOf(r)));
        return {
          files: files()
            .map((f) => ({ ...f, receipts: f.receipts.filter(wanted) }))
            .filter((f) => f.receipts.length > 0),
          // 同梱の UKE のコードはすべて版のコードの表にある（表にないコードは readUke が拒否する）
          unmapped: [],
        };
      },
    },
    chart: {
      async getChart({ patientId, yearMonth }) {
        assertQuery(patientId, yearMonth);
        const { patient } = receiptOf(patientId);
        const chart = json<Chart>("charts", patientId);
        const inMonth = (x: { date: string }) => x.date.startsWith(`${yearMonth}-`);
        return {
          patientId,
          yearMonth,
          entries: (chart?.entries ?? []).filter(inMonth).map(({ date, s, a, p }) => ({ date, s, a, p })),
          prescriptions: (chart?.prescriptions ?? []).filter(inMonth).map(({ date, category }) => ({ date, category })),
          // 合成カルテは傷病名の一覧を持たないので、UKE の傷病名（SY）を返す
          diseases: patient.diseases.map((d) => ({ name: d.name, start: isoDate(d.start) })),
          // 構造化データ（design.md §16-1）：fixtures/structured/<患者>.json があるときだけ。日のある 3 種類はその月の行だけを返す。ファイルのない患者は持たない（4 種類とも unsupported）
          ...structuredOf(json<Record<string, unknown>>("structured", patientId), yearMonth),
        };
      },
    },
  };
}
