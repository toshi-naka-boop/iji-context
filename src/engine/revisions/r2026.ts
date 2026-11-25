// 令和8年度改定後の版（design.md §2-4・§2-5）。適用は 2026年6月〜2027年5月診療分
// 点数・区分番号の出典は evidence-master（EM）§2-2 の採用値だけ（R8-1〜R8-93）。採用値にない値は書かない。診療行為コードは r2026-codes.ts（EM §2-8）、摘要欄の記載は r2026-comments.ts（EM §2-10）、令和6年度から変わった点は r2026-changes.ts（EM §2-9）。
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
import { makeR17 } from "../rules/r17";
import { makeR18 } from "../rules/r18";
import { makeR19 } from "../rules/r19";
import { makeR20 } from "../rules/r20";
import { makeR21 } from "../rules/r21";
import { careCodes, carePoints, careShikibetsu } from "./r2026-care";
import { withVisit2Reads } from "../visit2";
import { changes } from "./r2026-changes";
import { bandCodes, bandPoints, bandRows, bandShikibetsu } from "./r2026-band";
import { note14Codes, note14Pairs, note14Points, note14Shikibetsu, note14WithNote8 } from "./r2026-note14";
import { bundles, codes as baseCodes, imagingSiteComments, sharedCodes, shikibetsu as baseShikibetsu } from "./r2026-codes";
import { commentCodes, comments } from "./r2026-comments";
import { kisaiYoshi } from "./r2026-kisai";
import { kanriRows } from "./kanri";
import type { KanriRow, KubunDef, Revision, RevisionConsts } from "./types";

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
  D007_5: em("血液化学検査 5〜7項目", "D007 注 イ", 93),
  D007_8: em("血液化学検査 8〜9項目", "D007 注 ロ", 99),
  D007_10: em("血液化学検査 10項目以上", "D007 注 ハ", 103),
  D008_19: em("BNP", "D008 19", 130),
  // D008 内分泌学的検査の包括（R8-305。項目数で決まる。design.md §19-1）
  D008_3: em("内分泌学的検査 3〜5項目", "D008 注", 410),
  D008_6: em("内分泌学的検査 6〜7項目", "D008 注", 623),
  D008_8: em("内分泌学的検査 8項目以上", "D008 注", 900),
  // D013 肝炎ウイルス関連検査の包括（R8-307。項目数で決まる。design.md §19-1）
  D013_3: em("肝炎ウイルス関連検査 3項目", "D013 注", 290),
  D013_4: em("肝炎ウイルス関連検査 4項目", "D013 注", 360),
  D013_5: em("肝炎ウイルス関連検査 5項目以上", "D013 注", 425),
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
  // 実務の算定 A：施設の種別で分かれる区分（EM §2-2 R8-49〜R8-77。design.md §15-4）。単一建物 1 人の区分だけ
  C001_N6_TERMINAL_1B: em("在宅ターミナルケア加算（機能強化型・病床あり）", "C001 注6", 6500),
  C001_N6_TERMINAL_1N: em("在宅ターミナルケア加算（機能強化型・病床なし）", "C001 注6", 5500),
  C001_N6_TERMINAL_3: em("在宅ターミナルケア加算（在支診以外）", "C001 注6", 3500),
  C000_N1_KINKYU_1B: em("緊急往診加算（機能強化型・病床あり）", "C000 注1", 850),
  C000_N1_KINKYU_1N: em("緊急往診加算（機能強化型・病床なし）", "C000 注1", 750),
  C000_N1_KINKYU_3: em("緊急往診加算（在支診以外・定める患者）", "C000 注1", 325),
  C002_1B_I1: em("在医総管 1イ(1)① 機能強化型・病床あり・重症・月2回以上", "C002 1 イ(1)", 5385),
  C002_1B_RO1: em("在医総管 1イ(2)① 機能強化型・病床あり・月2回以上", "C002 1 イ(2)", 4485),
  C002_1B_NI1: em("在医総管 1イ(4)① 機能強化型・病床あり・月1回", "C002 1 イ(4)", 2745),
  C002_1N_I1: em("在医総管 1ロ(1)① 機能強化型・病床なし・重症・月2回以上", "C002 1 ロ(1)", 4985),
  C002_1N_RO1: em("在医総管 1ロ(2)① 機能強化型・病床なし・月2回以上", "C002 1 ロ(2)", 4085),
  C002_1N_NI1: em("在医総管 1ロ(4)① 機能強化型・病床なし・月1回", "C002 1 ロ(4)", 2505),
  C002_3I1: em("在医総管 3イ(1) 在支診以外・重症・月2回以上", "C002 3 イ(1)", 3435),
  C002_3RO1: em("在医総管 3ロ(1) 在支診以外・月2回以上", "C002 3 ロ(1)", 2735),
  C002_3NI1: em("在医総管 3ニ(1) 在支診以外・月1回", "C002 3 ニ(1)", 1745),
  "C002-2_1B_I1": em("施設入居時等医学総合管理料 1イ(1)① 機能強化型・病床あり・重症・月2回以上", "C002-2 1 イ(1)", 3885),
  "C002-2_1B_RO1": em("施設入居時等医学総合管理料 1イ(2)① 機能強化型・病床あり・月2回以上", "C002-2 1 イ(2)", 3185),
  "C002-2_1B_NI1": em("施設入居時等医学総合管理料 1イ(4)① 機能強化型・病床あり・月1回", "C002-2 1 イ(4)", 1965),
  "C002-2_1N_I1": em("施設入居時等医学総合管理料 1ロ(1)① 機能強化型・病床なし・重症・月2回以上", "C002-2 1 ロ(1)", 3585),
  "C002-2_1N_RO1": em("施設入居時等医学総合管理料 1ロ(2)① 機能強化型・病床なし・月2回以上", "C002-2 1 ロ(2)", 2885),
  "C002-2_1N_NI1": em("施設入居時等医学総合管理料 1ロ(4)① 機能強化型・病床なし・月1回", "C002-2 1 ロ(4)", 1785),
  "C002-2_3I1": em("施設入居時等医学総合管理料 3イ(1) 在支診以外・重症・月2回以上", "C002-2 3 イ(1)", 2435),
  "C002-2_3RO1": em("施設入居時等医学総合管理料 3ロ(1) 在支診以外・月2回以上", "C002-2 3 ロ(1)", 1935),
  "C002-2_3NI1": em("施設入居時等医学総合管理料 3ニ(1) 在支診以外・月1回", "C002-2 3 ニ(1)", 1265),
  // 注8 の減算は所定点数の 100 分の 80（R8-73。マスターは点数識別 6）。決まった点数を持たないので未収載（合計は出さない）
  C002_N8_GENSAN: { name: "在医総管・施設総管 注8（在支診以外の減算。所定点数の100分の80）", no: "C002 注8", points: null, source: "未収載" },
  C002_N9_IKO1: em("在宅療養移行加算1（在支診以外）", "C002 注9 イ", 316),
  C002_N9_IKO2: em("在宅療養移行加算2（在支診以外）", "C002 注9 ロ", 216),
  C002_N9_IKO3: em("在宅療養移行加算3（在支診以外）", "C002 注9 ハ", 216),
  C002_N9_IKO4: em("在宅療養移行加算4（在支診以外）", "C002 注9 ニ", 116),
  // 在宅医療充実体制加算・在宅療養実績加算（R8-78〜89）。導出・要件の判定はしない（C〜I の手順に回した。L-92）
  C001_N6_JUJITSU: em("在宅医療充実体制加算（在宅ターミナルケア加算に）", "C001 注6", 2000),
  C001_N6_JISSEKI1: em("在宅療養実績加算1（在宅ターミナルケア加算に）", "C001 注6", 750),
  C001_N6_JISSEKI2: em("在宅療養実績加算2（在宅ターミナルケア加算に）", "C001 注6", 500),
  C000_N8_JUJITSU: em("在宅医療充実体制加算（往診料）", "C000 注8", 200),
  C000_N8_JISSEKI1: em("在宅療養実績加算1（往診料）", "C000 注8", 75),
  C000_N8_JISSEKI2: em("在宅療養実績加算2（往診料）", "C000 注8", 50),
  C002_N7_JUJITSU1: em("在宅医療充実体制加算（在医総管・1人）", "C002 注7 イ(1)", 800),
  C002_N7_JISSEKI1_1: em("在宅療養実績加算1（在医総管・1人）", "C002 注7 ロ(1)", 300),
  C002_N7_JISSEKI2_1: em("在宅療養実績加算2（在医総管・1人）", "C002 注7 ハ(1)", 200),
  "C002-2_N3_JUJITSU1": em("在宅医療充実体制加算（施設総管・1人）", "C002-2 注3 イ(1)", 600),
  "C002-2_N3_JISSEKI1_1": em("在宅療養実績加算1（施設総管・1人）", "C002-2 注3 ロ(1)", 225),
  "C002-2_N3_JISSEKI2_1": em("在宅療養実績加算2（施設総管・1人）", "C002-2 注3 ハ(1)", 150),
  // O001 外来・在宅ベースアップ評価料(Ⅰ) の注5 の区分（R8-90〜93）
  O001_1_N5: em("外来・在宅ベースアップ評価料(Ⅰ) 初診時（注5）", "O001 1 注5", 23),
  O001_2_N5: em("外来・在宅ベースアップ評価料(Ⅰ) 再診時等（注5）", "O001 2 注5", 6),
  O001_3I_N5: em("外来・在宅ベースアップ評価料(Ⅰ) 訪問診療時イ（注5）", "O001 3 イ 注5", 107),
  O001_3RO_N5: em("外来・在宅ベースアップ評価料(Ⅰ) 訪問診療時ロ（注5）", "O001 3 ロ 注5", 26),
  // 単一建物 2 人以上の管理料の区分（EM §2-2 R8-95〜R8-190。段 17f。r2026-band.ts）
  ...bandPoints,
  // 介護保険・ほかの医療機関との調整の区分（EM §2-8。v37 21c。r2026-care.ts）
  ...carePoints,
};
// 注14 の減の行（EM §2-8 の「注14 の減算の行」。段 17h。r2026-note14.ts）
Object.assign(points, note14Points(points));
const codes = { ...baseCodes, ...bandCodes, ...note14Codes, ...careCodes };
const shikibetsu = { ...baseShikibetsu, ...bandShikibetsu, ...note14Shikibetsu, ...careShikibetsu };
const normalKanriRows: KanriRow[] = [
  ...kanriRows({
    在医総管: { "1B": ["C002_1B_I1", "C002_1B_RO1", "C002_1B_NI1"], "1N": ["C002_1N_I1", "C002_1N_RO1", "C002_1N_NI1"], "2": ["C002_2I1", "C002_2RO1", "C002_2NI1"], "3": ["C002_3I1", "C002_3RO1", "C002_3NI1"] },
    施設総管: {
      "1B": ["C002-2_1B_I1", "C002-2_1B_RO1", "C002-2_1B_NI1"],
      "1N": ["C002-2_1N_I1", "C002-2_1N_RO1", "C002-2_1N_NI1"],
      "2": ["C002-2_2I1", "C002-2_2RO1", "C002-2_2NI1"],
      "3": ["C002-2_3I1", "C002-2_3RO1", "C002-2_3NI1"],
    },
  }),
  ...bandRows,
];
/** 減の行は、組の通常の区分と同じ族・種別・区分・人数の区分（note14Pairs） */
const reducedKanriRows: KanriRow[] = Object.entries(note14Pairs).map(([kubun, normal]) => ({ ...normalKanriRows.find((r) => r.kubun === normal)!, kubun, note14: note14WithNote8.includes(kubun) ? "注8減" : "減" }));

const consts: RevisionConsts = {
  visitKubun: ["C001_1I", "C001_1RO"],
  // 介護保険・ほかの医療機関との調整（R20・R21。design.md §18-3・§18-4）。訪問診療料(Ⅰ)2 は他の保険医療機関の求めによる（EM R8-274）。
  // referralMonths：求めた日を含む月から 6 月まで（R8-274 ③）。stayDays：利用開始後 30 日まで、priorDays：利用開始前 30 日以内（R8-248・R8-250）
  visit2Kubun: ["C001_2I", "C001_2RO"],
  care: { renkei: "C010", shiji: "C007", referralMonths: 6, stayDays: 30, priorDays: 30 },
  kanri: {
    // 族×種別×区分（design.md §15-4 の表。EM R8-9〜11・19・55〜72）の単一建物 1 人の区分と、人数の区分の行（EM R8-95〜R8-190。段 17f）、注14 の減の行（段 17h）
    rows: [...normalKanriRows, ...reducedKanriRows],
    note14Pairs,
    familyOf: { 居宅: "在医総管", 施設入居等: "施設総管" },
    // 注16：基準を満たさない施設は、月2回以上の区分に代えて月1回の区分を算定する（R8-17。どの種別も。重症区分は対象外）
    note16: { enabled: true, from: "ロ", to: "ニ" },
  },
  hokatsu: { kubun: "C002_N10_HOKATSU", careLevelMin: 3, disabilityLevelMin: 2, tiers: ["ロ", "ニ"] },
  shidoKanriKubun: ["C101_2I", "C103_2"],
  bundled: { kubun: ["B000", "F400_3", "F400_2", "F400_N4", "F400_N6_1"], noRxAddition: "C002_N2" },
  tokutei: { kubun: "F400_N4", excludedDiseases: ["糖尿病", "高血圧", "脂質異常症"], minDays: 28 },
  rx: { oralKindsThreshold: 7, many: "F400_2", other: "F400_3" },
  // 注5：同じ区分の通常 → 注5（EM R8-90〜93）
  baseUp: { visit: ["O001_3I", "O001_3RO"], revisit: "O001_2", overlapKey: "revisitBaseUpSameDay", note5: { O001_1: "O001_1_N5", O001_2: "O001_2_N5", O001_3I: "O001_3I_N5", O001_3RO: "O001_3RO_N5" } },
  price: { visit: ["O100_1HA"], revisit: "O100_1RO", overlapKey: "revisitPriceSameDay" },
  // 在宅ターミナルケア加算・緊急往診加算は種別ごとの区分（EM R8-5・8・49〜54）。R09・R10・R18 と導出 D02・D12 が同じ表を引く
  terminal: { mitori: "C001_N7_MITORI", shibou: "C001_N8_SHIBOU", terminal: { "1B": "C001_N6_TERMINAL_1B", "1N": "C001_N6_TERMINAL_1N", "2": "C001_N6_TERMINAL", "3": "C001_N6_TERMINAL_3" }, days: 14, minVisits: 2 },
  oushin: { kubun: "C000", kinkyu: { "1B": "C000_N1_KINKYU_1B", "1N": "C000_N1_KINKYU_1N", "2": "C000_N1_KINKYU", "3": "C000_N1_KINKYU_3" }, revisit: "A001" },
  tests: { judgement: ["D026_3", "D026_4", "D026_5"], bnp: "D008_19", bnpJudgement: "D026_5", rapid: "D_GAIRAI_JINSOKU", bloodDraw: "D400_1" },
  testItems: {
    末梢血液一般: { kubun: "D005_5", judgement: "D026_3" },
    HbA1c: { kubun: "D005_9", judgement: "D026_3" },
    "血液化学5〜7項目": { kubun: "D007_5", judgement: "D026_4" },
    "血液化学8〜9項目": { kubun: "D007_8", judgement: "D026_4" },
    血液化学10項目以上: { kubun: "D007_10", judgement: "D026_4" },
    BNP: { kubun: "D008_19", judgement: "D026_5" },
  },
  dx: { tiers: { "1": "C001_N13_DX", "2": "C001_N13_DX2" }, conflicts: ["A_DENSHI_RENKEI"] },
  // 注14 の基準を確かめる確認月（EM R8-201：毎年 2・5・8・11 月）と、計算の道具の値（EM R8-194〜R8-200。design.md §15-13）
  note14: {
    checkMonths: [2, 5, 8, 11],
    // R8-194：2,100 回未満
    visitThreshold: 2100,
    // R8-196：直近 3 月間・直近 1 年間
    periodMonths: { short: 3, long: 12 },
    // R8-195：令和6年3月31日以前に開設したものを除く
    excludeOpenedOnOrBefore: "2024-03-31",
    // R8-197：5 つ以上の保険医療機関
    referralMin: 5,
    // R8-198：看取り 20 件以上、又は重症児の実績 10 件以上
    mitoriMin: 20,
    jushojiMin: 10,
    // R8-199：(②−③)×10 ≦ 7×(①＋②)。R8-200：⑤×2 ≧ ①＋②
    ratio199: { num: 7, den: 10 },
    ratio200: { num: 1, den: 2 },
    // EM §2-8 の「数えるためだけの行」（注14 の訪問診療回数。版の区分には入れない）
    countRows: [
      { code: "114001110", reading: "both" },
      { code: "114030310", reading: "both" },
      { code: "114042110", reading: "both" },
      { code: "114042210", reading: "both" },
      { code: "114706310", reading: "both" },
      { code: "114706410", reading: "both" },
      { code: "114042810", reading: "otsu" },
      { code: "114046310", reading: "otsu" },
      { code: "114706610", reading: "otsu" },
    ],
  },
  weeklyVisitLimit: 3,
  weekStartsOn: 0,
  ikou: { kubun: "C002_N4_IKOU", months: 3, daysFromDischarge: 365 },
  // 在宅療養移行加算1〜4（EM R8-74〜77。「3 を算定する患者」に限る）
  ikouGrade3: ["C002_N9_IKO1", "C002_N9_IKO2", "C002_N9_IKO3", "C002_N9_IKO4"],
  // C〜I の手順に回した区分（L-92。EM R8-73〜89）
  deferred: [
    "C001_N6_JUJITSU",
    "C001_N6_JISSEKI1",
    "C001_N6_JISSEKI2",
    "C000_N8_JUJITSU",
    "C000_N8_JISSEKI1",
    "C000_N8_JISSEKI2",
    "C002_N7_JUJITSU1",
    "C002_N7_JISSEKI1_1",
    "C002_N7_JISSEKI2_1",
    "C002-2_N3_JUJITSU1",
    "C002-2_N3_JISSEKI1_1",
    "C002-2_N3_JISSEKI2_1",
    "C002_N9_IKO1",
    "C002_N9_IKO2",
    "C002_N9_IKO3",
    "C002_N9_IKO4",
    "C002_N8_GENSAN",
  ],
};

export const r2026: Revision = {
  id: "r2026",
  label: "令和8年度改定（2026年6月〜2027年5月診療分）",
  generation: "R8",
  kind: "改定",
  effectiveFrom: "2026-06",
  effectiveUntil: "2027-05",
  points,
  codes,
  bundles,
  imagingSiteComments,
  sharedCodes,
  // EM §2-8 で、r2026 の点数表の区分はすべてコード（か包括の項目）が決まっている
  uncoded: {},
  shikibetsu,
  consts,
  comments,
  commentCodes,
  kisaiYoshi,
  // 訪問診療料(Ⅰ)2 の行で「決められない」に置くルールは、(Ⅰ)2 を読む区分として申告する（design.md §18-12 の 8。src/engine/visit2.ts）
  rules: withVisit2Reads([
    makeR01(consts, points),
    ...[makeR02, makeR03, makeR04, makeR05, makeR06, makeR07, makeR08, makeR09, makeR10, makeR11, makeR12, makeR13, makeR14, makeR15, makeR16].map((make) => make(consts)),
    makeR17({ consts, comments, commentCodes }),
    makeR18(consts, points),
    makeR19(consts, points),
    makeR20(consts),
    makeR21(consts),
  ], { consts }),
  changes,
};
