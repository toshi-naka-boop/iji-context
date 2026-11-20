// UKE（F4）の型。記録条件仕様（医科用）令和8年8月版の主要列だけを扱う（EM §2-5 L-1・§2-10 表 4）
import type { ClaimLine, Comment, Payer } from "../engine/types";

/** UKE に載せる患者・保険の情報（同梱のものは合成。fixtures/uke/patients.json） */
export type UkePatient = {
  name: string;
  sex: 1 | 2;
  /** YYYYMMDD */
  birth: string;
  /** レセプト種別（別表5、4 桁） */
  receiptType: string;
  insurer: { number: string; symbol: string; no: string };
  kohi: { payerNo: string; recipientNo: string }[];
  /**
   * 傷病名。名称が src/uke/diseases.ts の表にあるものは傷病名マスターのコードで、ほかは未コード化（0000999）で名称を書く。
   * code は、読み取った UKE の傷病名コードが表になかったときだけ持つ（コードを保持し、名称は持たない＝name は空）。
   * outcome は転帰（1 継続、2 治ゆ、3 死亡、4 中止。既定 1）
   */
  diseases: { name: string; code?: string; start: string; main?: boolean; outcome?: 1 | 2 | 3 | 4 }[];
};

export type UkeClinic = { code: string; name: string; phone: string };

/** UKE の側の算定行。items は、包括の検査の区分の行が並べる検査項目のコード（読み取りが埋め、書き出しが使う。エンジンには渡さない） */
export type UkeLine = ClaimLine & { items?: string[] };

/**
 * 点検の対象外の単位（design.md §11-11）：診療年月の版の表で引けないコードを 1 つでも含む算定単位。まるごと点検の対象外にして、UKE に書いてあるまま残す。
 * unit は単位の番号（UkeClaim.units の添字）、codes は単位の行のコード（名称は持たない。マスターを同梱しない）、
 * points は 1 回分の点数、count は回数、days は 1〜31 日の回数（どれも UKE に書いてある値）
 */
export type UkeOther = { unit: number; codes: string[]; points: number | null; count: number; days: number[] };

/** レセプト 1 件分（コードを区分に引いたあと） */
export type UkeReceipt = {
  claimId: string;
  /** UKE の「カルテ番号等」の欄（患者ごとの番号。空のこともある。表示にだけ使う）。UKE から読んだレセプトだけが持つ */
  patientNo?: string;
  /** 診療年月 YYYY-MM */
  yearMonth: string;
  patient: UkePatient;
  lines: UkeLine[];
  /** 点検の対象外の単位。1 つでもあれば、lines は請求の一部でしかない（ClaimContext.partial になる）。なければ省く */
  others?: UkeOther[];
  /** UKE に書いてある請求の合計点数（HO と、KO の並び）。UKE から読んだレセプトだけが持つ。点検した行の小計とは別のもの */
  declared?: { ho: number | null; ko: number[] };
  /**
   * 保存済みのレセプトを読み直したら、いまの表では読めなかった（design.md §11-12。取り込んだ後にコードの表・点数表が変わった）。
   * 理由だけを持ち、lines・comments は空。点検には並べない（一覧には出す）
   */
  unreadable?: { reason: string };
  /**
   * 診療年月に当たる版がない（design.md §11-12）。コードを区分に引いていないので、lines・comments は空。
   * 月末の点検・提出には並べない（一覧には出す）。版を選んで試算できる（src/server/app/uke-check.ts の ukeTrial）
   */
  noRevision?: true;
  comments: Comment[];
  /** コメントを持つ出どころか（UKE は真。コメントの載らない連携は偽）。ClaimContext.commentsKnown になる */
  commentsKnown: boolean;
  /** 施設に入居する患者か（書き出しだけが読む。在宅ターミナルケア加算のコードを決める） */
  facilityResident?: boolean;
};

export type UkeFile = {
  payer: Payer;
  prefecture: string;
  clinic: UkeClinic;
  /** 請求年月 YYYY-MM */
  billingMonth: string;
  receipts: UkeReceipt[];
};

// ───────────────────────────────────────────────────────────────────────────
// 形式だけを読んだもの（parseUke の結果。版を見ない。コードは区分に引かず、そのまま持つ。design.md §11-12・§11-14）

/** 診療行為・医薬品・特定器材の 1 行。line は 1 起算の行番号。quantity は数量データ（使用量）の欄のまま */
export type UkeItem = { line: number; kind: "SI" | "IY" | "TO"; code: string; quantity: string };

/**
 * 点数・回数の算定単位。単位の終わりは点数が書いてある行で、line はその行。
 * points は 1 回分の点数、count は回数（単位の各行に同じ値）、days は 1〜31 日の回数（単位の各行に同じ値）
 */
export type UkeUnit = { line: number; items: UkeItem[]; points: number; count: number; days: number[] };

/**
 * コメント（診療行為などのレコードのコメント欄と、CO レコード）。
 * unit は、帰属が形式から決まるときの単位の番号（units の添字）：レコードのコメント欄と、単位の途中（点数の行より前）にある診療識別が空の CO。
 * それ以外（単位の前後の CO、診療識別つきの CO、レセプト全体へのコメントとそれに続く CO）は null（EM §2-10 表 4 の (e)）
 */
export type UkeComment = { line: number; code: string; raw: string; unit: number | null };

export type UkeClaim = {
  /** RE の行番号 */
  line: number;
  /** 「カルテ番号等」の欄（RE の 13 列目）。患者ごとの番号で、空でもよく、同じ患者の別の月・同じファイルの 2 枚目で重なる。請求 id にはしない（design.md §11-11） */
  patientNo: string;
  /** 診療年月 YYYY-MM */
  yearMonth: string;
  patient: UkePatient;
  /** HO に書いてある合計点数と、その行番号（HO がなければ null） */
  total: { line: number; points: number } | null;
  /** KO（公費）に書いてある合計点数（KO の並びの順） */
  kohiTotals: number[];
  units: UkeUnit[];
  comments: UkeComment[];
};

export type UkeParsed = {
  payer: Payer;
  prefecture: string;
  clinic: UkeClinic;
  /** 請求年月 YYYY-MM */
  billingMonth: string;
  claims: UkeClaim[];
  /** GO に書いてある総合計点数と、その行番号 */
  total: { line: number; points: number };
};
