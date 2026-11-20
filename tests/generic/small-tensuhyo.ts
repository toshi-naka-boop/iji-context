// テスト用：手で作った数行の電子点数表（補助マスター・包括・背反・算定回数）を、小さな masters.db（tests/generic/small-masters.ts）に足す。
// 行は、EM §2-11 表 2 の錨（A16・A17・A34〜A64）に書いてある事実だけ（公開元の表を写さない）。錨にない値（A50 の背反区分）は、仮の値と断って入れる
import type Database from "better-sqlite3";
import { put, smallMasters, source } from "./small-masters";

/** 錨のコード（EM §2-11 表 2） */
export const C = {
  zaiisoukan: "114032510", // A34 在宅時医学総合管理料（月 1 回）
  shohosen: "120002910", // A35 処方箋料
  jutsugo: "113004610", // A40 手術後医学管理料（診療所）
  jutsuzen: "113004110", // A38 手術前医学管理料
  nyou: "160000310", // A39・A41 尿中一般物質定性半定量検査
  naishikyo: "160171310", // A36 血管内視鏡検査
  gas: "160027710", // A37 血液ガス分析
  chokucho: "150187210", // A42 直腸切除・切断術（切断術）
  jinkoukoumon: "150184510", // A43 人工肛門造設術
  shoshin: "111000110", // A44 初診料
  houmon: "114001110", // A44 在宅患者訪問診療料(Ⅰ) 1 イ
  saishin: "112007410", // A45 再診料
  oushin: "114000110", // A46 往診料
  sanso: "114003710", // A47 在宅酸素療法指導管理料
  jikochu: "114040610", // A47 在宅自己注射指導管理料
  mitori: "114018570", // A48 看取り加算
  shibou: "114018670", // A48 死亡診断加算
  denshi: "112709570", // A50 電子的診療情報連携体制整備加算（再診）
  dx: "114746310", // A50 在宅医療DX情報活用加算
  sansoKyunyu: "140005610", // A51 酸素吸入
  kyodo: "114061210", // A52 外来在宅共同指導料 2
  kyukyu: "114003010", // A54 救急搬送診療料
  pf4a: "160201050", // A55 血小板第4因子-ヘパリン複合体抗体
  pf4b: "160201150", // A55
  gairaiReha: "113013910", // A56 外来リハビリテーション診療料 1
  bnp: "160162350", // A58 BNP
  anp: "160116310", // A58 ANP
  handan: "160061810", // A62 血液学的検査判断料
  tokutei: "113001810", // A63 特定疾患療養管理料
} as const;

const LIVE = { change: "0", created_on: "20100401", abolished_on: "99999999" };

/** 背反の 1 行（片向き）。tani は 1＝1 日につき／2＝同一月内／3＝同時／4＝1 週間につき */
export const putHaihan = (db: Database.Database, snapshot: string, tani: number, code1: string, code2: string, kubun: string, tokurei: string, more: Record<string, string> = {}): void =>
  put(db, "haihan", snapshot, { ...LIVE, tani, code1, code2, kubun, tokurei, ...more });

/** 電子点数表つきの小さな masters.db。G04・G05・G06 は準備できている */
export function tensuhyoMasters(snapshot = "20261001"): Database.Database {
  const db = smallMasters(":memory:", snapshot);
  source(db, "tensuhyo", snapshot);
  // 包括：補助マスター（親。包括単位①とグループ番号①）と、包括・被包括テーブル（子）
  for (const [code, unit1, group1] of [[C.zaiisoukan, "2", "C002001"], [C.jutsugo, "1", "B001051"], [C.naishikyo, "3", "D324001"], [C.jutsuzen, "5", "B001041"], [C.chokucho, "6", "K740001"]])
    put(db, "hojo", snapshot, { ...LIVE, code, unit1, group1 });
  for (const [group_no, code, tokurei] of [["C002001", C.shohosen, "0"], ["B001051", C.nyou, "0"], ["D324001", C.gas, "0"], ["B001041", C.nyou, "1"], ["K740001", C.jinkoukoumon, "0"]])
    put(db, "houkatsu", snapshot, { ...LIVE, group_no, code, tokurei });
  // 背反：錨にある向きだけ（A44・A45・A46・A47・A50・A51・A54・A55・A58 は片向き、A48/A49・A52/A53・A56/A57 は両向き）。A50 の背反区分は錨にないので、仮に 3
  putHaihan(db, snapshot, 1, C.shoshin, C.houmon, "1", "0");
  putHaihan(db, snapshot, 1, C.saishin, C.houmon, "2", "0");
  putHaihan(db, snapshot, 1, C.oushin, C.houmon, "3", "1");
  putHaihan(db, snapshot, 2, C.sanso, C.jikochu, "3", "0");
  putHaihan(db, snapshot, 2, C.mitori, C.shibou, "1", "0");
  putHaihan(db, snapshot, 2, C.shibou, C.mitori, "2", "0");
  putHaihan(db, snapshot, 2, C.denshi, C.dx, "3", "0");
  putHaihan(db, snapshot, 2, C.sanso, C.sansoKyunyu, "1", "1");
  putHaihan(db, snapshot, 3, C.oushin, C.kyodo, "2", "0");
  putHaihan(db, snapshot, 3, C.kyodo, C.oushin, "1", "0");
  putHaihan(db, snapshot, 3, C.oushin, C.kyukyu, "2", "1");
  putHaihan(db, snapshot, 3, C.pf4a, C.pf4b, "3", "0");
  putHaihan(db, snapshot, 4, C.shoshin, C.gairaiReha, "2", "1");
  putHaihan(db, snapshot, 4, C.gairaiReha, C.shoshin, "1", "1");
  putHaihan(db, snapshot, 4, C.bnp, C.anp, "3", "0");
  // 算定回数（A60〜A62・A64）。単位コードは 121＝日／138＝週／131＝月
  for (const [code, unit_code, limit_count, tokurei] of [[C.houmon, 121, 1, "0"], [C.houmon, 138, 3, "1"], [C.handan, 131, 1, "0"], [C.dx, 131, 1, "0"]] as const)
    put(db, "kaisu", snapshot, { ...LIVE, code, unit_code, limit_count, tokurei });
  // 医科診療行為マスターの上限回数（A17：特定疾患療養管理料は 2。算定回数テーブルの行は入れない）
  db.prepare("UPDATE shinryo SET limit_count = 2 WHERE code = ?").run(C.tokutei);
  db.prepare("INSERT INTO checks_ready (check_id, ready, reason, missing) VALUES ('G04', 1, '', '[]'), ('G05', 1, '', '[]'), ('G06', 1, '', '[]')").run();
  return db;
}
