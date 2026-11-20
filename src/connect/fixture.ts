// フィクスチャ コネクタ（spec FR-105）：同梱の合成データ（fixtures/ の UKE・症例・カルテ）を、境界の型で返す。
// 既定で有効なのはこのコネクタだけ。外への通信はしない
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ClaimContext } from "../engine/types";
import type { Chart } from "../uke/crosscheck";
import type { UkeFile, UkeReceipt } from "../uke/types";
import { readUke } from "../uke/uke";
import { recordOfUke } from "../patient/profile";
import { assertQuery, type Connector } from "./types";

export const FIXTURE_ID = "fixture";
const UKE_FILES = ["kokuhoren.UKE", "shiharaikikin.UKE"];

const isoDate = (yyyymmdd: string) => `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;

/** 患者の id は、症例の id（請求 id の頭。K1 など）を使う */
const patientIdOf = (r: UkeReceipt) => r.claimId.split("-")[0];

export function createFixtureConnector(root = process.cwd()): Connector {
  const fixtures = path.join(root, "fixtures");
  const files = (): UkeFile[] => UKE_FILES.map((f) => readUke(readFileSync(path.join(fixtures, "uke", f))));
  const json = <T>(dir: string, patientId: string): T | null => {
    const file = path.join(fixtures, dir, `${patientId}.json`);
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : null;
  };
  const receiptOf = (patientId: string): UkeReceipt => {
    assertQuery(patientId, null);
    const r = files()
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
        };
      },
    },
  };
}
