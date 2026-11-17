// 請求 id → 同梱の合成データのファイル（fixtures/cases/・fixtures/charts/）の表引き（spec FR-108）。
// 請求 id は UKE の中身から来る値なので、ファイルパスの組み立てには使わない。表にある症例の番号だけを、表に書いたファイル名に写す。
// 症例は EM 5-1 の表にあるものだけ。足すときは EM 5-1 に行を足してから、ここにも足す
import path from "node:path";

const CASE_FILES: ReadonlyMap<string, string> = new Map([
  ["K1", "K1.json"],
  ["K2", "K2.json"],
  ["K3", "K3.json"],
  ["K4", "K4.json"],
  ["K5", "K5.json"],
  ["K6", "K6.json"],
  ["K7", "K7.json"],
]);
/** 合成カルテのある症例（K6 は合成カルテを持たない） */
const CHART_FILES: ReadonlyMap<string, string> = new Map([
  ["K1", "K1.json"],
  ["K2", "K2.json"],
  ["K3", "K3.json"],
  ["K4", "K4.json"],
  ["K5", "K5.json"],
  ["K7", "K7.json"],
]);

/** 請求 id の頭（最初のハイフンの前）が症例の番号 */
const caseNoOf = (claimId: string): string => claimId.split("-")[0];

/** 症例の JSON のパス。表にない請求 id は null */
export function caseFileOf(root: string, claimId: string): string | null {
  const file = CASE_FILES.get(caseNoOf(claimId));
  return file ? path.join(root, "fixtures", "cases", file) : null;
}

/** 合成カルテのパス。表にない請求 id・合成カルテのない症例は null */
export function chartFileOf(root: string, claimId: string): string | null {
  const file = CHART_FILES.get(caseNoOf(claimId));
  return file ? path.join(root, "fixtures", "charts", file) : null;
}
