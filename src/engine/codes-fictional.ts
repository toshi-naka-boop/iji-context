// 区分→架空の 9 桁レセ電コード。実在のマスターとは無関係（README に「架空コード」と明記する）
import { POINTS } from "./points-2024";

const KUBUNS = Object.keys(POINTS);

/** 架空コード：先頭 "99" ＋区分表の並び順を 7 桁で。区分表の並びを変えるとコードも変わる */
export function fictionalCode(kubun: string): string {
  const i = KUBUNS.indexOf(kubun);
  if (i < 0) throw new Error(`未知の区分: ${kubun}`);
  return `99${String(i + 1).padStart(7, "0")}`;
}

export function kubunOfCode(code: string): string {
  const i = Number(code.slice(2)) - 1;
  if (!code.startsWith("99") || code.length !== 9 || !KUBUNS[i]) throw new Error(`未知のコード: ${code}`);
  return KUBUNS[i];
}
