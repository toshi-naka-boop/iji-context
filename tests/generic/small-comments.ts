// テスト用：手で作った数行のコメント関連テーブル・コメントマスター・傷病名マスターを、小さな masters.db（tests/generic/small-masters.ts）に足す（段 13。G07・G08）。
// 行は、EM §2-11 表 2 の錨（A17〜A21・A29〜A33・A85〜A104）に書いてある事実だけ（公開元の表を写さない）。コメントの名称は、A98 のほかは、ここで付けた仮の名称。
// あわせて、UKE の請求を、手書きのルールとデータで動く点検の両方に掛けて重ねる小道具（取り込んだレセプトの点検と同じ条件：事実は渡したものだけ・カルテ側の記録なし）
import { readFileSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import facilityJson from "../../config/facility.json";
import { evaluate } from "../../src/engine";
import { facilityOf, type FacilityJson } from "../../src/engine/facility";
import { hasRevision, resolveRevision } from "../../src/engine/revisions";
import type { ClaimContext } from "../../src/engine/types";
import { evaluateGeneric } from "../../src/generic";
import { mappedLinesOf, overlap } from "../../src/generic/overlap";
import type { GenericAboutMore } from "../../src/generic/types";
import { diseaseCodeOf } from "../../src/uke/diseases";
import type { UkeClaim } from "../../src/uke/types";
import { mapClaim, parseUke, withCommentLines } from "../../src/uke/uke";
import { put, smallMasters, source } from "./small-masters";

/** 錨のコード（EM §2-11 表 2） */
export const K = {
  zaiisoukan: "114032510", // A29 在宅時医学総合管理料 × 往診又は訪問診療年月日
  houmonDate: "850100106",
  sanso: "114003710", // A90・A91 在宅酸素療法指導管理料 × 動脈血酸素分圧又は飽和度（同じ枝番）
  pao2: "842100072",
  spo2: "842100044",
  oushin: "114000110", // A30 往診料 × 往診が必要となった理由（条件は文章）
  oushinReason: "830100086",
  ninchi: "113014710", // A31 認知症療養指導料 1 × 治療年月日（入院外で算定した場合）
  ninchiDate: "850100079",
  kokyu: "160073510", // A85 呼吸心拍監視 × 算定開始年月日
  kokyuStart: "850100186",
  echo: "160072210", // A86・A87 超音波検査（断層撮影法）（胸腹部）× 領域（選択）
  echoA: "820100681",
  echoF: "820100686",
  tokubetsu: "114044670", // A88・A89 特別地域訪問看護加算 × 患者住所／訪問に要する時間（別の枝番。両方要る）
  jusho: "830100095",
  jikan: "852100005",
  enkaku: "112709070", // A92・A93 看護師等遠隔診療補助加算 × 前回の対面診療の年月日／初回
  zenkai: "850190207",
  shokai: "820190492",
  shoshin2: "111011810", // A94 初診料（同一日複数科受診時の 2 科目）× 1 つ目の診療科（変更年月日 20261001）
  ka1: "830100923",
  shoshin: "111000110", // A95 初診料 × 結果のみを聞きに来院（算定しなかった場合のコメント）
  kekka: "820100001",
  adtralza: "629922401", // A96 医薬品（別表Ⅱ）× 医師要件
  ishi: "820600255",
  inatsu: "721007000", // A97 特定器材（別表Ⅳ）× 処置開始年月日
  shochi: "850900002",
  tokutei: "113001810", // A17 特定疾患療養管理料（傷病名関連区分 5）
  shohoKasan: "120005710", // A104 特定疾患処方管理加算（処方箋料）（同 5）
  tenkan: "113002850", // A18 てんかん指導料（同 7）
  nanbyo: "113002910", // A19 難病外来指導管理料（同 9。点検しない）
  hifu1: "113000910", // A20 皮膚科特定疾患指導管理料(Ⅰ)（同 3）
  hifu2: "113002310", // A21 皮膚科特定疾患指導管理料(Ⅱ)（同 4）
} as const;

/** 錨の傷病名（EM §2-11 表 2。A33・A99〜A103） */
export const D = { zensoku: "4939008", tounyou: "2500013", tenpousou: "6944006", taijou: "0539013", nousotchuTenkan: "3458023", tenkan: "3459001" } as const;

const LIVE = { change: "0", changed_on: "20260601", abolished_on: "99999999", hisantei: "0", nyugai: "0", joken: "01", tsuchi: "1" };

/** 小さな masters.db に、G07・G08 が読む表を足す。G07・G08 は準備できている */
export function commentMasters(snapshot = "20261001"): Database.Database {
  const db = smallMasters(":memory:", snapshot);
  source(db, "comment_kanren", snapshot);
  const row = (kouban: string, edaban: string, code: string, comment_code: string, more: Record<string, string> = {}) => put(db, "comment_kanren", snapshot, { ...LIVE, kouban, edaban, code, comment_code, ...more });
  row("0176", "01", K.zaiisoukan, K.houmonDate);
  row("0216", "01", K.sanso, K.pao2);
  row("0216", "01", K.sanso, K.spo2);
  row("0162", "03", K.oushin, K.oushinReason, { joken: "00" });
  row("0126", "00", K.ninchi, K.ninchiDate, { joken: "02", nyugai: "2" });
  row("0351", "00", K.kokyu, K.kokyuStart);
  row("0347", "01", K.echo, K.echoA);
  row("0347", "01", K.echo, K.echoF);
  row("0190", "01", K.tokubetsu, K.jusho);
  row("0190", "02", K.tokubetsu, K.jikan);
  row("0003", "00", K.enkaku, K.zenkai);
  row("0003", "00", K.enkaku, K.shokai);
  row("0001", "05", K.shoshin2, K.ka1, { changed_on: "20261001" });
  row("0001", "01", K.shoshin, K.kekka, { joken: "00", hisantei: "1" });
  row("0008", "01", K.adtralza, K.ishi, { tsuchi: "5" });
  row("0006", "01", K.inatsu, K.shochi, { tsuchi: "8", changed_on: "20261001" });
  // コメントマスター（COMMENT＝850100106 は small-masters が入れている）。A98 のほかは仮の名称
  put(db, "comment", snapshot, { code: K.kokyuStart, name: "算定開始年月日（呼吸心拍監視等）" });
  for (const code of [K.pao2, K.spo2, K.echoA, K.echoF, K.jusho, K.jikan, K.zenkai, K.shokai, K.ka1, K.ishi, K.shochi]) put(db, "comment", snapshot, { code, name: `手作りの定型文${code.slice(-4)}；` });
  // 診療行為：版のコードの表にないものを足し、傷病名関連区分を付ける（版の表にある特定疾患処方管理加算は、行を直す）
  const has = db.prepare("SELECT 1 FROM shinryo WHERE snapshot = ? AND code = ?");
  const shinryo = (code: string, name: string, shobyo_kanren = "0") => {
    if (has.get(snapshot, code)) db.prepare("UPDATE shinryo SET shobyo_kanren = ? WHERE snapshot = ? AND code = ?").run(shobyo_kanren, snapshot, code);
    else put(db, "shinryo", snapshot, { code, name, shobyo_kanren });
  };
  for (const [code, name] of [[K.ninchi, "認知症療養指導料１"], [K.kokyu, "呼吸心拍監視"], [K.echo, "超音波検査"], [K.tokubetsu, "特別地域訪問看護加算"], [K.enkaku, "看護師等遠隔診療補助加算"], [K.shoshin2, "初診料（２科目）"], [K.shoshin, "初診料"]]) shinryo(code, name);
  for (const [code, name, kanren] of [[K.tokutei, "特定疾患療養管理料（診療所）", "5"], [K.shohoKasan, "特定疾患処方管理加算（処方箋料）", "5"], [K.tenkan, "てんかん指導料", "7"], [K.nanbyo, "難病外来指導管理料１", "9"], [K.hifu1, "皮膚科特定疾患指導管理料（１）", "3"], [K.hifu2, "皮膚科特定疾患指導管理料（２）", "4"]]) shinryo(code, name, kanren);
  put(db, "iyakuhin", snapshot, { code: K.adtralza, name: "手作りの医薬品（別表Ⅱ）" });
  put(db, "tokutei", snapshot, { code: K.inatsu, name: "手作りの特定器材（別表Ⅳ）" });
  // 傷病名マスター（DISEASE＝4289018 は small-masters が入れている。区分は付けていない＝空）
  for (const [code, name, flag] of [[D.zensoku, "気管支喘息", "05"], [D.tounyou, "糖尿病", "00"], [D.tenpousou, "天疱瘡", "03"], [D.taijou, "帯状疱疹", "04"], [D.nousotchuTenkan, "脳卒中後てんかん", "08"], [D.tenkan, "てんかん", "07"]]) put(db, "shobyo", snapshot, { code, name, tokutei_shikkan: flag });
  db.prepare("INSERT OR REPLACE INTO checks_ready (check_id, ready, reason) VALUES ('G07', 1, ''), ('G08', 1, '')").run();
  return db;
}

const root = path.join(__dirname, "..", "..");
const facility = facilityOf(facilityJson as FacilityJson);
/** 事実は、どれも不明 */
export const unknownFacts = new Proxy({}, { get: () => ({ known: false }) }) as ClaimContext["facts"];

/** 同梱の UKE のレセプト（読めるもの・診療年月に版があるもの） */
export const claimsOf = (name: string): UkeClaim[] => parseUke(readFileSync(path.join(root, "fixtures", "uke", name))).claims.filter((c) => c.unsupported === undefined && hasRevision(c.yearMonth));

/** G07・G08 が読むものを付けた、請求について分かっていること */
export const aboutOf = (c: UkeClaim): GenericAboutMore => ({ yearMonth: c.yearMonth, generation: resolveRevision(c.yearMonth).generation, outpatient: true, birth: c.patient.birth, clinic: true, diseases: c.patient.diseases.map((d) => ({ code: d.code ?? diseaseCodeOf(d.name) })) });

/** UKE の請求を、手書きのルールとデータで動く点検の両方に掛けて、重ねる。shown は、重ねたあとに出す G07・G08 の指摘 */
export function checkUke(claim: UkeClaim, db: Database.Database, facts: ClaimContext["facts"] = unknownFacts) {
  const rev = resolveRevision(claim.yearMonth);
  const mapped = mapClaim(claim, rev);
  const g = evaluateGeneric(claim, db, aboutOf(claim));
  const ctx: ClaimContext = { claimId: "t", yearMonth: claim.yearMonth, facility, payer: "支払基金", prefecture: "", facts, events: [], recordsKnown: false, lines: mapped.lines.map(({ kubun, count, dates }) => ({ kubun, count, dates })), comments: withCommentLines(mapped.comments, claim), commentsKnown: true, partial: mapped.others.length > 0 };
  const hand = evaluate(ctx);
  const o = overlap(hand, rev, false, mappedLinesOf(mapped.lines, mapped.origins), g.findings);
  const mine = (fs: typeof g.findings) => fs.filter((f) => f.check === "G07" || f.check === "G08");
  return { hand, generic: mine(g.findings), shown: mine(o.findings), duplicate: o.duplicate, judged: o.judged, result: g };
}
