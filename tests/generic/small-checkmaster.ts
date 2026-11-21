// テスト用：手で作った数行のチェックマスタ（医薬品適応関連・医科診療行為傷病名関連・医薬品併用禁忌関連）を、小さな masters.db（tests/generic/small-comments.ts）に足す（段 14。G09）。
// 行は、EM §2-11 表 2 の錨（A65〜A69・A105〜A108）に書いてある事実（公開元の表を写さない）。錨にない行（廃止の行・量だけの行・G08 と重なる行）は、仮の行と断って入れる。
// 名称は、錨に書いてあるもののほかは、ここで付けた仮の名称
import type Database from "better-sqlite3";
import { r2026 } from "../../src/engine/revisions/r2026";
import { commentMasters, D, K } from "./small-comments";
import { DRUG, put, source } from "./small-masters";

/** 錨のコード（EM §2-11 表 2） */
export const M = {
  pentasa: "621867201", // A65・A66 医薬品適応関連の例の薬
  riva: "622972801", // A108 リバーロキサバン錠 15mg
  buscopan: "620008918", // A68・A69 併用の組の例（Ｌ）
  primperan: "620003796", // A68・A69 併用の組の例（Ｒ）
  bnp: r2026.codes.D008_19.primary, // A105・A106 ＢＮＰ
  marker: "113001310", // A107 悪性腫瘍特異物質治療管理料（その他・1 項目）
  shohosen: r2026.codes.F400_3.primary, // 処方箋料（EM §2-8）
} as const;

/** 錨の傷病名（EM §2-11 表 2）。crohn・uc は A65・A66、nvaf は A108、shinfuzen・dcm は A105・A106、igan は A107 */
export const S = { crohn: "5559001", uc: "5569003", nvaf: "8846906", shinfuzen: "4289015", dcm: "4254028", igan: "1519006" } as const;

/** 小さな masters.db に、G09 が読む表を足す。G07・G08・G09 は準備できている */
export function checkMasters(snapshot = "20261001"): Database.Database {
  const db = commentMasters(snapshot);
  source(db, "checkmaster", snapshot);
  const tekio = (code: string, shobyo: string, change = "0") => put(db, "cm_tekio", snapshot, { code, shobyo, sex: "0", age_upper: 999.99, check_kubun: "1", max_dose: 99999.99999, max_days: 999, change });
  tekio(M.pentasa, S.crohn);
  tekio(M.pentasa, S.uc);
  tekio(M.riva, S.nvaf);
  // 仮の行：傷病名を条件にしない量の行（0000000）、廃止の傷病名の行、外れ値の行だけの薬、廃止の行だけの薬
  tekio(M.pentasa, "0000000");
  tekio(M.pentasa, S.shinfuzen, "9");
  tekio(M.buscopan, "0000001");
  tekio(DRUG, S.crohn, "9");
  const si = (code: string, shobyo: string, utagai: string) => put(db, "cm_si_shobyo", snapshot, { code, shobyo, sex: "0", age_upper: 999.99, nyugai: "0", utagai, change: "0" });
  si(M.bnp, S.shinfuzen, "0");
  si(M.bnp, S.dcm, "0");
  si(M.marker, S.igan, "1");
  // 仮の行：傷病名の要件（G08）も見る診療行為（特定疾患療養管理料 × 気管支喘息。確定病名のみ）
  si(K.tokutei, D.zensoku, "1");
  const pair = (code_l: string, code_r: string, change = "0") => put(db, "cm_heiyo_kinki", snapshot, { code_l, code_r, change });
  pair(M.buscopan, M.primperan);
  pair(M.primperan, M.buscopan);
  // 仮の行：廃止の組
  pair(M.pentasa, M.riva, "9");
  pair(M.riva, M.pentasa, "9");
  for (const [code, name] of [[M.pentasa, "手作りの薬（適応の例）"], [M.riva, "リバーロキサバン錠１５ｍｇ（手作り）"], [M.buscopan, "手作りの薬（併用Ｌ）"], [M.primperan, "手作りの薬（併用Ｒ）"]]) put(db, "iyakuhin", snapshot, { code, name });
  put(db, "shinryo", snapshot, { code: M.marker, name: "悪性腫瘍特異物質治療管理料（その他・１項目）", alpha: "B", sho: 2, bu: 1, kubun_no: 1 });
  for (const [code, name] of [[S.crohn, "手作りの傷病名Ａ"], [S.uc, "手作りの傷病名Ｂ"], [S.nvaf, "非弁膜症性心房細動"], [S.shinfuzen, "心不全"], [S.dcm, "特発性拡張型心筋症"], [S.igan, "胃癌"]]) put(db, "shobyo", snapshot, { code, name });
  db.prepare("INSERT OR REPLACE INTO checks_ready (check_id, ready, reason, missing) VALUES ('G09', 1, '', '[]')").run();
  return db;
}
