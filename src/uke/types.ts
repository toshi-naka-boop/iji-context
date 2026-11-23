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
   * outcome は転帰（1 継続、2 治ゆ、3 死亡、4 中止。既定 1）。
   * modifiers は修飾語コード（4 桁ずつ、20 個まで。名称は持たない）、note は補足コメント（どちらも、あるときだけ）
   */
  diseases: { name: string; code?: string; start: string; main?: boolean; outcome?: 1 | 2 | 3 | 4; modifiers?: string[]; note?: string }[];
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
   * 読めなかったレセプト。保存済みのレセプトを読み直したら、いまの表では読めなかった（design.md §11-12。取り込んだ後にコードの表・点数表が変わった）か、
   * 未対応のレセプト（入院・臓器提供者のレセプト情報つき・未対応のレコードつき。UkeClaim.unsupported）。
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

/**
 * 診療行為・医薬品・特定器材の 1 行。line は 1 起算の行番号。quantity は数量データ（SI）・使用量（IY・TO）の欄のまま。
 * shikibetsu は、その行に書いてある診療識別（別表20。省略された行は空）。
 * 特定器材（TO）の行だけが持つ：unitCode＝単位コード、unitPrice＝単価（どちらも欄のまま。書いていなければ空）。商品名及び規格又はサイズは持たない。
 * unitCode は、いまの点検のどれも読まない。残す理由：UKE の欄を書いてあるまま持つ（tests/uke/keep-fields.test.ts が縛る）ことと、マスターの単位と食い違う器材の検算（作っていない）に要る欄であること（round-32 O-20）
 * 行のコメント欄は UkeClaim.comments に入り、line が同じものがその行のコメント（design.md §12-2）
 */
export type UkeItem = { line: number; kind: "SI" | "IY" | "TO"; code: string; quantity: string; shikibetsu: string; unitCode?: string; unitPrice?: string };

/**
 * 点数・回数の算定単位。単位の終わりは点数が書いてある行で、line はその行。
 * points は 1 回分の点数、count は回数（単位の各行に同じ値）、days は 1〜31 日の回数（単位の各行に同じ値）、futan は負担区分（別表21。点数の行のもの）、
 * shikibetsu は診療識別（単位の先頭の行に書いてあるもの。省略されていれば空のままで、前の単位から引き継がない。引き継ぎ方は使う側が決める）。
 * いまの点検は読まない（検算 G02 は、行の診療識別から引き継ぎを決める。src/generic/g02.ts）。残す理由：UKE の欄を書いてあるまま持つ（tests/uke/keep-fields.test.ts が縛る。round-32 O-20）
 */
export type UkeUnit = { line: number; items: UkeItem[]; points: number; count: number; days: number[]; futan: string; shikibetsu: string };

/**
 * コメント（診療行為などのレコードのコメント欄と、CO レコード）。
 * unit は、帰属が形式から決まるときの単位の番号（units の添字）：レコードのコメント欄と、単位の途中（点数の行より前）にある診療識別が空の CO。
 * それ以外（単位の前後の CO、診療識別つきの CO、レセプト全体へのコメントとそれに続く CO）は null（EM §2-10 表 4 の (e)）
 */
export type UkeComment = { line: number; code: string; raw: string; unit: number | null };

export type UkeClaim = {
  /** RE の行番号 */
  line: number;
  /** 「カルテ番号等」の欄（RE の項目 14）。患者ごとの番号で、空でもよく、同じ患者の別の月・同じファイルの 2 枚目で重なる。請求 id にはしない（design.md §11-11） */
  patientNo: string;
  /**
   * 読めないレセプトの理由（定型文。src/uke/uke.ts の UNREADABLE）：入院のレセプト、臓器提供者のレセプト情報を含むレセプト、未対応のレコードを含むレセプト。
   * 保険・公費と、そこまでに読んだものは持つが、units・comments は空にする。同じファイルのほかのレセプトは読む
   */
  unsupported?: string;
  /** 診療年月 YYYY-MM */
  yearMonth: string;
  patient: UkePatient;
  /** HO に書いてある合計点数と、その行番号（HO がなければ null） */
  total: { line: number; points: number } | null;
  /** HO に書いてある診療実日数（HO がなければ null） */
  realDays: number | null;
  /** KO（公費）に書いてある合計点数（KO の並びの順） */
  kohiTotals: number[];
  units: UkeUnit[];
  comments: UkeComment[];
  // ここから下は、読んで持つだけ（使い道は別の段）。番号（枝番など）は持たない。AI に渡す文脈（src/llm/outbound.ts の claimForAi）には入らない
  /** 資格確認（SN）：負担者種別（別表28）と確認区分（別表29） */
  eligibility: { payerKind: string; confirmation: string }[];
  /** 受診日等（JD）：負担者種別（別表28）と、1〜31 日の受診等区分（別表30。受診等のない日は 0） */
  visits: { payerKind: string; days: number[] }[];
  /** 窓口負担額（MF）の区分（別表31）。金額の項目は予備で、医療機関は記録しない */
  copay: string[];
  /** 包括評価対象外理由（GR）：医科点数表算定理由（別表17）と DPC コード */
  dpcExclusions: { reason: string; dpcCode: string }[];
  /** 症状詳記（SJ）：症状詳記区分（別表23。省略された行は、前の行の区分）と文 */
  notes: { kind: string; text: string }[];
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
