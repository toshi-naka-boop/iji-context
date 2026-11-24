// 令和8年度改定後の版の、介護保険・ほかの医療機関との調整（R20・R21）に要る区分（design.md §18-4。v37 21c）。
// 点数・名称・コードは EM §2-8 の行（C001_2I・C001_2RO・C007・C010。基本マスター M8 の値のまま。EM §2-11 のデータ源から読む値）。診療識別は EM §2-8 の列（集計先の上 2 桁）
import type { CodeDef, KubunDef } from "./types";

const em = (name: string, no: string, points: number): KubunDef => ({ name, no, points, source: "EM" });
const one = (primary: string): CodeDef => ({ primary, accept: [] });

export const carePoints: Record<string, KubunDef> = {
  // C001 在宅患者訪問診療料(Ⅰ)2（他の保険医療機関の求めによる。EM §2-13 R8-274）
  C001_2I: em("在宅患者訪問診療料(Ⅰ)2イ 同一建物居住者以外", "C001 2 イ", 886),
  C001_2RO: em("在宅患者訪問診療料(Ⅰ)2ロ 同一建物居住者", "C001 2 ロ", 189),
  // C007 訪問看護指示料（R8-284）、C010 在宅患者連携指導料（R8-265）
  C007: em("訪問看護指示料", "C007", 300),
  C010: em("在宅患者連携指導料", "C010", 900),
};

export const careCodes: Record<string, CodeDef> = {
  C001_2I: one("114042110"), // 在宅患者訪問診療料（１）２（同一建物居住者以外）
  C001_2RO: one("114042210"), // 在宅患者訪問診療料（１）２（同一建物居住者）
  C007: one("114008010"), // 訪問看護指示料
  C010: one("114015310"), // 在宅患者連携指導料
};

export const careShikibetsu: Record<string, string> = { C001_2I: "14", C001_2RO: "14", C007: "14", C010: "14" };
