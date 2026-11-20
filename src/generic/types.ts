// データで動く点検（design.md §12-2・§12-3）の型。手書きのルール（src/engine/。区分キーで動く）とは別の道で、UKE の単位とコードのまま点検する
import type { MastersDb } from "../masters/db";
import type { UkeItem } from "../uke/types";

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
 * カルテから導いた算定行は、区分をコードに直してから渡す（unitsOfLines）
 */
export type GenericClaim = { units: { items: Pick<UkeItem, "kind" | "code">[] }[] };

/** 請求について分かっていること。この段が使うのは、診療年月と、使うマスターの世代（診療年月の版の世代。試算では選んだ版の世代）だけ */
export type GenericAbout = { yearMonth: string; generation: string };

/**
 * 動かさなかった点検と理由（「問題なし」と区別する。design.md §12-1）。
 * noMasters＝masters.db がない／notReady＝要る表がない・錨がない（checks_ready）／noSnapshot＝診療年月の世代の 1 枚がない／notBuilt＝この点検は、まだ入っていない
 */
export type GenericNotRun = { check: GenericCheckId; kind: GenericKind; reason: "noMasters" | "notReady" | "noSnapshot" | "notBuilt"; detail: string };

export type GenericResult = { findings: GenericFinding[]; ran: { check: GenericCheckId; kind: GenericKind }[]; notRun: GenericNotRun[] };

/** 点検 1 つ。run は、動かせなければ skip（理由）を返す。certainty は点検が決めた値で、言い切りに上げるかは evaluateGeneric が一覧で決める */
export type GenericCheck = {
  id: GenericCheckId;
  kind: GenericKind;
  run(claim: GenericClaim, masters: MastersDb, about: GenericAbout): GenericFinding[] | { skip: string };
};
