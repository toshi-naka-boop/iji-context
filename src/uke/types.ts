// 合成 UKE（F4）の型。記録条件仕様（医科用）令和6年6月版の主要列だけを扱う（EM 12-1、report-A 項目12）
import type { ClaimLine, Payer } from "../engine/types";

/** UKE に載せる患者・保険の情報（合成。fixtures/uke/patients.json） */
export type UkePatient = {
  name: string;
  sex: 1 | 2;
  /** YYYYMMDD */
  birth: string;
  /** レセプト種別（別表5、4 桁） */
  receiptType: string;
  insurer: { number: string; symbol: string; no: string };
  kohi: { payerNo: string; recipientNo: string }[];
  /** 傷病名。未コード化（0000999）で名称を載せる。outcome は転帰（1 継続、2 治ゆ、3 死亡、4 中止。既定 1） */
  diseases: { name: string; start: string; main?: boolean; outcome?: 1 | 2 | 3 | 4 }[];
};

export type UkeClinic = { code: string; name: string; phone: string };

/** UKE から読み取れるレセプト 1 件分 */
export type UkeReceipt = {
  claimId: string;
  /** 診療年月 YYYY-MM */
  yearMonth: string;
  patient: UkePatient;
  lines: ClaimLine[];
  /** CO レコード。直前の SI の区分に付く */
  comments: { kubun: string; code: string }[];
};

export type UkeFile = {
  payer: Payer;
  prefecture: string;
  clinic: UkeClinic;
  /** 請求年月 YYYY-MM */
  billingMonth: string;
  receipts: UkeReceipt[];
};
