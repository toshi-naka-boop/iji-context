// 令和8年度改定後の版（design.md §2-4・§2-5）。適用は 2026年6月〜2027年5月診療分
// 点数・区分番号の出典は evidence-master（EM）§2-2 の採用値だけ（R8-1〜R8-47）。採用値にない値は書かない。
// このファイルは書き換えない。次の改定・値の変更は、新しいファイルを足す（docs/revision-howto.md）
import { makeR01 } from "../rules/r01";
import { makeR02 } from "../rules/r02";
import { makeR03 } from "../rules/r03";
import { makeR04 } from "../rules/r04";
import { makeR05 } from "../rules/r05";
import { makeR06 } from "../rules/r06";
import { makeR07 } from "../rules/r07";
import { makeR08 } from "../rules/r08";
import { makeR09 } from "../rules/r09";
import { makeR10 } from "../rules/r10";
import { makeR11 } from "../rules/r11";
import { makeR12 } from "../rules/r12";
import { makeR13 } from "../rules/r13";
import { makeR14 } from "../rules/r14";
import { makeR15 } from "../rules/r15";
import { makeR16 } from "../rules/r16";
import type { KubunDef, Revision, RevisionConsts } from "./types";

const em = (name: string, no: string, points: number): KubunDef => ({ name, no, points, source: "EM" });

const points: Record<string, KubunDef> = {
  // C001 在宅患者訪問診療料(Ⅰ)（R8-1〜6）
  C001_1I: em("在宅患者訪問診療料(Ⅰ)1イ 同一建物居住者以外", "C001 1 イ", 890),
  C001_1RO: em("在宅患者訪問診療料(Ⅰ)1ロ 同一建物居住者", "C001 1 ロ", 215),
  C001_N13_DX: em("在宅医療DX情報活用加算1", "C001 注13", 11),
  C001_N13_DX2: em("在宅医療DX情報活用加算2", "C001 注13", 9),
  C001_N6_TERMINAL: em("在宅ターミナルケア加算（在支診 強化型以外）", "C001 注6", 4500),
  C001_N7_MITORI: em("看取り加算", "C001 注7", 3000),
  C001_N8_SHIBOU: em("死亡診断加算", "C001 注8", 200),
  // C000 往診料（R8-7・8）、A001 再診料（R8-47）
  C000: em("往診料", "C000", 720),
  C000_N1_KINKYU: em("緊急往診加算（在支診 強化型以外）", "C000 注1", 650),
  A001: em("再診料", "A001", 76),
  // C002 在宅時医学総合管理料（在支診 強化型以外・単一建物 1 人。R8-9〜18）
  C002_2I1: em("在医総管 2イ(1) 重症・月2回以上", "C002 2 イ(1)", 4585),
  C002_2RO1: em("在医総管 2ロ(1) 月2回以上", "C002 2 ロ(1)", 3685),
  C002_2NI1: em("在医総管 2ニ(1) 月1回", "C002 2 ニ(1)", 2285),
  C002_N4_IKOU: em("在宅移行早期加算", "C002 注4", 100),
  C002_N5_HINKAI1: em("頻回訪問加算（初回）", "C002 注5", 800),
  C002_N5_HINKAI2: em("頻回訪問加算（2回目以降）", "C002 注5", 300),
  C002_N10_HOKATSU: em("包括的支援加算", "C002 注10", 150),
  C002_N15_RENKEI: em("在宅医療情報連携加算", "C002 注15", 100),
  C002_N2: em("管理料 処方箋を交付しない場合の加算", "C002 注2", 300),
  // C002-2 施設入居時等医学総合管理料（在支診 強化型以外・単一建物 1 人。R8-19）
  "C002-2_2I1": em("施設入居時等医学総合管理料 2イ(1) 重症・月2回以上", "C002-2 2 イ(1)", 3285),
  "C002-2_2RO1": em("施設入居時等医学総合管理料 2ロ(1) 月2回以上", "C002-2 2 ロ(1)", 2585),
  "C002-2_2NI1": em("施設入居時等医学総合管理料 2ニ(1) 月1回", "C002-2 2 ニ(1)", 1625),
  // 在宅療養指導管理料・材料加算（R8-20〜24）
  C101_2I: em("在宅自己注射指導管理料 2イ", "C101 2 イ", 650),
  C153_2: em("注入器用注射針加算 2", "C153 2", 130),
  C103_2: em("在宅酸素療法指導管理料 2 その他", "C103 2", 2400),
  C158: em("酸素濃縮装置加算", "C158", 4000),
  C157_1: em("酸素ボンベ加算（携帯用）", "C157 1", 880),
  // F400 処方箋料（R8-25〜28）
  F400_3: em("処方箋料 3 その他", "F400 3", 60),
  F400_2: em("処方箋料 2 内服7種類以上", "F400 2", 32),
  F400_N4: em("特定疾患処方管理加算", "F400 注4", 56),
  F400_N6_1: em("一般名処方加算1", "F400 注6", 8),
  // 検査（R8-29〜37）。外来迅速検体検査加算は 1 項目あたりの点数で、行の回数を項目数とする
  D400_1: em("血液採取 静脈", "D400 1", 40),
  D005_5: em("末梢血液一般検査", "D005 5", 21),
  D005_9: em("HbA1c", "D005 9", 49),
  D007_10: em("血液化学検査 10項目以上", "D007 注 ハ", 103),
  D008_19: em("BNP", "D008 19", 130),
  D026_3: em("血液学的検査判断料", "D026 3", 125),
  D026_4: em("生化学的検査(Ⅰ)判断料", "D026 4", 144),
  D026_5: em("生化学的検査(Ⅱ)判断料", "D026 5", 144),
  D_GAIRAI_JINSOKU: em("外来迅速検体検査加算", "第3部第1節第1款 通則3", 10),
  // O001 外来・在宅ベースアップ評価料(Ⅰ)（通常の区分。R8-38〜41）
  O001_3I: em("外来・在宅ベースアップ評価料(Ⅰ) 訪問診療時イ", "O001 3 イ", 79),
  O001_3RO: em("外来・在宅ベースアップ評価料(Ⅰ) 訪問診療時ロ", "O001 3 ロ", 19),
  O001_2: em("外来・在宅ベースアップ評価料(Ⅰ) 再診時等", "O001 2", 4),
  O001_1: em("外来・在宅ベースアップ評価料(Ⅰ) 初診時", "O001 1", 17),
  // O100 外来・在宅物価対応料（R8-42〜44）
  O100_1HA: em("外来・在宅物価対応料 訪問診療時", "O100 ハ", 3),
  O100_1RO: em("外来・在宅物価対応料 再診時等", "O100 ロ", 2),
  O100_1I: em("外来・在宅物価対応料 初診時", "O100 イ", 2),
  // 管理料に包括される項目・DX 加算と併算定できない加算（R8-45・46）
  B000: em("特定疾患療養管理料", "B000 1", 225),
  A_DENSHI_RENKEI: em("電子的診療情報連携体制整備加算（再診時）", "A001 注19", 2),
};

const consts: RevisionConsts = {
  visitKubun: ["C001_1I", "C001_1RO"],
  kanri: {
    table: {
      在医総管: { イ: "C002_2I1", ロ: "C002_2RO1", ニ: "C002_2NI1" },
      施設総管: { イ: "C002-2_2I1", ロ: "C002-2_2RO1", ニ: "C002-2_2NI1" },
    },
    familyOf: { 居宅: "在医総管", 施設入居等: "施設総管" },
    // 注16：基準を満たさない施設は 2ロ に代えて 2ニ を算定する（R8-17。重症区分の 2イ は対象外）
    note16: { from: "ロ", to: "ニ" },
  },
  hokatsu: { kubun: "C002_N10_HOKATSU", careLevelMin: 3, tiers: ["ロ", "ニ"] },
  shidoKanriKubun: ["C101_2I", "C103_2"],
  bundled: { kubun: ["B000", "F400_3", "F400_2", "F400_N4", "F400_N6_1"], noRxAddition: "C002_N2" },
  tokutei: { kubun: "F400_N4", excludedDiseases: ["糖尿病", "高血圧", "脂質異常症"], minDays: 28 },
  rx: { oralKindsThreshold: 7, many: "F400_2", other: "F400_3" },
  baseUp: { visit: ["O001_3I", "O001_3RO"], revisit: "O001_2", overlapKey: "revisitBaseUpSameDay" },
  price: { visit: ["O100_1HA"], revisit: "O100_1RO", overlapKey: "revisitPriceSameDay" },
  terminal: { mitori: "C001_N7_MITORI", shibou: "C001_N8_SHIBOU", terminal: "C001_N6_TERMINAL", days: 14, minVisits: 2 },
  oushin: { kubun: "C000", kinkyu: "C000_N1_KINKYU", revisit: "A001" },
  tests: { judgement: ["D026_3", "D026_4", "D026_5"], bnp: "D008_19", bnpJudgement: "D026_5", rapid: "D_GAIRAI_JINSOKU", bloodDraw: "D400_1" },
  testItems: {
    末梢血液一般: { kubun: "D005_5", judgement: "D026_3" },
    HbA1c: { kubun: "D005_9", judgement: "D026_3" },
    血液化学10項目以上: { kubun: "D007_10", judgement: "D026_4" },
    BNP: { kubun: "D008_19", judgement: "D026_5" },
  },
  dx: { tiers: { "1": "C001_N13_DX", "2": "C001_N13_DX2" }, conflicts: ["A_DENSHI_RENKEI"] },
  weeklyVisitLimit: 3,
  weekStartsOn: 0,
  ikou: { kubun: "C002_N4_IKOU", months: 3, daysFromDischarge: 365 },
};

export const r2026: Revision = {
  id: "r2026",
  label: "令和8年度改定（2026年6月〜2027年5月診療分）",
  generation: "R8",
  kind: "改定",
  effectiveFrom: "2026-06",
  effectiveUntil: "2027-05",
  points,
  consts,
  rules: [makeR01, makeR02, makeR03, makeR04, makeR05, makeR06, makeR07, makeR08, makeR09, makeR10, makeR11, makeR12, makeR13, makeR14, makeR15, makeR16].map((make) => make(consts)),
};
