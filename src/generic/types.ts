// データで動く点検（design.md §12-2・§12-3）の型。手書きのルール（src/engine/。区分キーで動く）とは別の道で、UKE の単位とコードのまま点検する
import type { Facts } from "../engine/types";
import type { CodePair } from "../lifecycle/types";
import type { LocalPairKnowledge } from "./local-pair";
import type { MastersDb } from "../masters/db";
import type { UkeComment, UkeItem, UkeUnit } from "../uke/types";

export type GenericCheckId = "G01" | "G02" | "G03" | "G04" | "G05" | "G06" | "G07" | "G08" | "G09";
export type GenericKind = "コード" | "点数" | "行の属性" | "包括" | "背反" | "回数" | "記載もれ" | "傷病名" | "適応";

/** 点検の一覧（design.md §12-3 の表の順） */
export const GENERIC_CHECKS: { id: GenericCheckId; kind: GenericKind }[] = [
  { id: "G01", kind: "コード" },
  { id: "G02", kind: "点数" },
  { id: "G03", kind: "行の属性" },
  { id: "G04", kind: "包括" },
  { id: "G05", kind: "背反" },
  { id: "G06", kind: "回数" },
  { id: "G07", kind: "記載もれ" },
  { id: "G08", kind: "傷病名" },
  { id: "G09", kind: "適応" },
];

export type GenericFinding = {
  check: GenericCheckId;
  kind: GenericKind;
  /** 条件つき＝データが「条件あり」とだけ言っている／公開元が一律に適用しないと断っている／言い切りに上げていない種類（config/generic-checks.json の certain にない） */
  certainty: "確定" | "条件つき";
  /** 当たる単位（UKE の中の並び） */
  units: number[];
  /** 当たる行のコード（画面は名称を添える） */
  codes: string[];
  /** 定型文（src/messages.ts の GENERIC_TEXT）。値は params */
  messageKey: string;
  params: Record<string, string>;
  /** どのデータのどの行か（表の名前と、行を特定する鍵） */
  source: { data: string; ref: string };
};

/**
 * 点検する請求。UKE の単位とコードのまま（parseUke の UkeClaim をそのまま渡せる）。この段（G01）が読むのは、単位の行の種類とコードだけ。
 * カルテから導いた算定行は、区分をコードに直してから渡す（src/generic/overlap.ts の claimOfLines）
 */
export type GenericClaim = {
  units: { items: Pick<UkeItem, "kind" | "code">[] }[];
  /** コメント（行のコメント欄と CO。parseUke の UkeClaim.comments をそのまま渡せる。G07 が読むのはコードだけ）。コメントを持たない請求（区分キーから作った単位）は省く：必須コメント（G07）は掛けない */
  comments?: (Pick<UkeComment, "code"> & Partial<UkeComment>)[];
};

/**
 * 請求について分かっていること：診療年月と、使うマスターの世代（診療年月の版の世代。試算では選んだ版の世代）。
 * answers・facts は、背反の特例条件の例外（G05。design.md §13-2・§13-3）が読む。取り込んだレセプトの点検だけが渡す（月末の点検・算定プレビュー・measure-generic は渡さない＝どの問いも未決で、問いは出さない）：
 * answers＝請求ごとの事実（claim_facts）の、その key・日付（請求ごとの事実は null）の最新の答え（なければ・取り消してあれば null）／facts＝その請求の ClaimContext.facts（sameDayOf が読む形）
 */
export type GenericAbout = {
  yearMonth: string;
  generation: string;
  answers?: (key: string, date: string | null) => string | null;
  facts?: Facts;
  /**
   * 背反の組の院内の知識（design.md §14-3）。取り込んだレセプトの点検・月末の点検・算定プレビューが渡す（measure-generic は渡さない）：
   * localKnowledge＝その組（同じ tani）の院内層・ベテラン層の codePair の知識（保管は除く）／level＝本人のレベル（F10）／
   * pressedAt＝押した事実（local:*）の、その key・日付（同一月の表は null）の最新の時刻（なければ・取り消してあれば null。取り込んだレセプトの点検だけが渡す）
   */
  localKnowledge?: (pair: CodePair) => LocalPairKnowledge[];
  level?: number;
  pressedAt?: (key: string, date: string | null) => string | null;
};

/**
 * 動かさなかった点検と理由（「問題なし」と区別する。design.md §12-1）。
 * noMasters＝masters.db がない／notReady＝要る表がない・錨がない（checks_ready）／noSnapshot＝診療年月の世代の 1 枚がない／notBuilt＝この点検は、まだ入っていない
 */
export type GenericNotRun = { check: GenericCheckId; kind: GenericKind; reason: "noMasters" | "notReady" | "noSnapshot" | "notBuilt"; detail: string };

/**
 * 1 回の点検で、点検 1 つあたりに返す指摘の数の上限（round-32 S-9）。超えた分は、数だけを omitted に返す（画面は「ほか N 件」）。
 * 正しいレセプトでは、点検 1 つの指摘は数十件まで。親子の組で増える包括（G04）・背反（G05）を細工したレセプトで、メモリと応答の大きさが際限なく増えないようにする
 */
export const FINDING_LIMIT = 200;

/** omitted＝上限を超えたので返さなかった指摘の数（点検ごと。超えなかった点検は載せない）。silenced＝特例の例外に当たるので出さなかった数（例外の id ごと） */
export type GenericResult = {
  findings: GenericFinding[];
  ran: { check: GenericCheckId; kind: GenericKind }[];
  notRun: GenericNotRun[];
  omitted?: { check: GenericCheckId; kind: GenericKind; count: number }[];
  silenced?: { hx: string; count: number }[];
  /** 院内の知識で「条件に当たる」と押したので出さなかった数（知識の id ごと。design.md §14-3） */
  localSilenced?: { id: string; count: number }[];
  /** 指摘に添えた承認済みの院内の知識の id（USED を出す。design.md §14-3） */
  localUsed?: string[];
};

/**
 * 点検の指摘。more は、上限（FINDING_LIMIT）に達したあと、指摘を作らずに数えただけの数（組を数え上げる G04・G05 が使う）。
 * silenced は、背反の特例条件の例外に当たるので出さなかった組と日の、当たった例外の id（1 件ごとに 1 つ。G05 が使う。design.md §13-2 の 2）
 */
export type GenericFound = GenericFinding[] & { more?: number; silenced?: string[]; localSilenced?: string[]; localUsed?: string[] };

/** 点検 1 つ。run は、動かせなければ skip（理由）を返す。certainty は点検が決めた値で、言い切りに上げるかは evaluateGeneric が一覧で決める */
export type GenericCheck = {
  id: GenericCheckId;
  kind: GenericKind;
  run(claim: GenericClaim, masters: MastersDb, about: GenericAbout): GenericFound | { skip: string };
};

// ───────────────────────────────────────────────────────────────────────────
// G02（点数の検算）・G03（行の属性）が読むもの。どれも「あれば読む」（区分キーから作った単位は持たない。持たない項目に依る部分は点検せず、点検の範囲に出す）

/** UKE の単位と行が持つ項目のうち、G02 が読むもの（parseUke の UkeUnit をそのまま渡せる）。points のない単位（区分キーから作った単位）は検算しない */
export type GenericUnitDetail = Partial<Pick<UkeUnit, "points" | "count" | "days">> & { items: (Pick<UkeItem, "kind" | "code"> & Partial<Pick<UkeItem, "line" | "quantity" | "shikibetsu" | "unitPrice">>)[] };

/**
 * 請求について分かっていることのうち、G03・G07・G08・G09 が読むもの。分からない項目は省く（その項目に依る点検はしない）：
 * outpatient＝入院外のレセプトか（parseUke が読めるのは入院外だけ。G07 も読む）／birth＝生年月日（YYYYMMDD）／clinic＝施設が診療所か（偽＝病院）
 */
export type GenericAboutMore = GenericAbout & {
  outpatient?: boolean;
  birth?: string;
  clinic?: boolean;
  /** 傷病名（SY のコード。未コード化は 0000999）。G08・G09 が読む。持たない請求（区分キーの行）は省く：傷病名の要件・適応は点検しない。suspected＝疑い病名（修飾語 8002「の疑い」つき。G09 が読む） */
  diseases?: { code: string; suspected?: boolean }[];
};

/** 検算（G02）の数（design.md §12-6）。units＝点数の書いてある単位、checked＝再計算できた単位、matched＝そのうち UKE の点数と合った単位、excluded＝検算の対象外の単位（理由ごと） */
export type RecalcSummary = { units: number; checked: number; matched: number; excluded: { reason: string; text: string; count: number }[] };
