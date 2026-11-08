// 区分→点数（2024 年度改定後、2025 年 3 月時点）。design.md §2-4
// 出典は 2 つに限る：report-A 項目21 の点数セット表（A21）／EM §5・§5-1（EM5）
// 点数未収載（null）の区分に点数を付けるときは、先に EM に行を足す

export type KubunDef = { name: string; points: number | null; source: "A21" | "EM5" | "未収載" };

export const POINTS: Record<string, KubunDef> = {
  // C001 在宅患者訪問診療料(Ⅰ)
  C001_1I: { name: "在宅患者訪問診療料(Ⅰ)1イ 同一建物居住者以外", points: 888, source: "A21" },
  C001_1RO: { name: "在宅患者訪問診療料(Ⅰ)1ロ 同一建物居住者", points: 213, source: "A21" },
  C001_N13_DX: { name: "在宅医療DX情報活用加算", points: 10, source: "A21" },
  C001_N6_TERMINAL: { name: "在宅ターミナルケア加算（在支診 強化型以外）", points: 4500, source: "A21" },
  C001_N7_MITORI: { name: "看取り加算", points: 3000, source: "A21" },
  C001_N8_SHIBOU: { name: "死亡診断加算", points: 200, source: "A21" },
  // C000 往診料
  C000: { name: "往診料", points: 720, source: "A21" },
  C000_N1_KINKYU: { name: "緊急往診加算（在支診 強化型以外）", points: 650, source: "A21" },
  // C002 在宅時医学総合管理料（在支診 強化型以外・単一建物 1 人）
  C002_2I1: { name: "在医総管 2イ(1) 重症・月2回以上", points: 4585, source: "A21" },
  C002_2RO1: { name: "在医総管 2ロ(1) 月2回以上", points: 3685, source: "A21" },
  C002_2NI1: { name: "在医総管 2ニ(1) 月1回", points: 2285, source: "A21" },
  C002_N4_IKOU: { name: "在宅移行早期加算", points: 100, source: "EM5" },
  C002_N5_HINKAI1: { name: "頻回訪問加算（初回）", points: 800, source: "A21" },
  C002_N5_HINKAI2: { name: "頻回訪問加算（2回目以降）", points: 300, source: "A21" },
  C002_N10_HOKATSU: { name: "包括的支援加算", points: 150, source: "A21" },
  C002_N15_RENKEI: { name: "在宅医療情報連携加算", points: 100, source: "A21" },
  C002_N2: { name: "在医総管 処方箋を交付しない場合の加算", points: null, source: "未収載" },
  // 在宅療養指導管理料・材料加算
  C101_2I: { name: "在宅自己注射指導管理料 2イ", points: 650, source: "A21" },
  C153_2: { name: "注入器用注射針加算 2", points: 130, source: "A21" },
  C103_2: { name: "在宅酸素療法指導管理料 2 その他", points: 2400, source: "A21" },
  C158: { name: "酸素濃縮装置加算", points: 4000, source: "A21" },
  C157_1: { name: "酸素ボンベ加算（携帯用）", points: 880, source: "A21" },
  // F400 処方箋料
  F400_3: { name: "処方箋料 3 その他", points: 60, source: "A21" },
  F400_2: { name: "処方箋料 2 内服7種類以上", points: 32, source: "A21" },
  F400_N4: { name: "特定疾患処方管理加算", points: 56, source: "A21" },
  F400_N6_1: { name: "一般名処方加算1", points: 10, source: "A21" },
  // 検査
  D400_1: { name: "血液採取 静脈", points: 40, source: "A21" },
  D005_5: { name: "末梢血液一般検査", points: 21, source: "A21" },
  D005_9: { name: "HbA1c", points: 49, source: "A21" },
  D007_10: { name: "血液化学検査 10項目以上", points: 103, source: "A21" },
  D008_18: { name: "BNP", points: 130, source: "A21" },
  D026_3: { name: "血液学的検査判断料", points: 125, source: "A21" },
  D026_4: { name: "生化学的検査(Ⅰ)判断料", points: 144, source: "A21" },
  D026_5: { name: "生化学的検査(Ⅱ)判断料", points: 144, source: "A21" },
  D_GAIRAI_JINSOKU: { name: "外来迅速検体検査加算", points: null, source: "未収載" },
  // ベースアップ評価料
  O100_3I: { name: "外来・在宅ベースアップ評価料(Ⅰ) 訪問診療時イ", points: 28, source: "A21" },
  O100_3RO: { name: "外来・在宅ベースアップ評価料(Ⅰ) 訪問診療時ロ", points: 7, source: "A21" },
  O100_SAISHIN: { name: "外来・在宅ベースアップ評価料(Ⅰ) 再診時等", points: 2, source: "A21" },
  // 違反フィクスチャ用（点数未収載）
  B000: { name: "特定疾患療養管理料", points: null, source: "未収載" },
  A_IRYOJOHO: { name: "医療情報取得加算", points: null, source: "未収載" },
  A_DXSUISHIN: { name: "医療DX推進体制整備加算", points: null, source: "未収載" },
};

/** 区分の点数。未知の区分は例外（黙って 0 点にしない） */
export function pointsOf(kubun: string): number | null {
  const def = POINTS[kubun];
  if (!def) throw new Error(`未知の区分: ${kubun}`);
  return def.points;
}
