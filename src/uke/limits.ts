// UKE を読むときの上限（spec FR-106。設計の値・たたき台）。画面（app/uke/page.tsx）からも読むので、Node 専用のものを読み込まない小さなファイルに分ける
export const UKE_LIMITS = {
  /** ファイルの大きさ（バイト） */
  maxBytes: 1024 * 1024,
  /** レコードの数（行数） */
  maxLines: 5000,
  /** 1 項目の文字数 */
  maxFieldLength: 100,
  /** 1 日の算定回数 */
  maxDailyCount: 9,
  /** 点数・合計点数 */
  maxPoints: 9_999_999,
  /** 数量データ（きざみの項目数） */
  maxQuantity: 99,
  /** レセプト 1 件の算定回数の合計（日ごとの回数 × 数量データを、全部の単位で足したもの）。算定日の列をこの数だけ作るので、上限がないとメモリを食い尽くす */
  maxClaimCount: 20_000,
} as const;

/** 請求 id に使える文字（英数字とハイフン、20 文字まで）。パスの区切り・. ・空白を通さない。取り込んだ請求の id（U12-3。src/uke/upload.ts）も、同梱の症例の id もこの形 */
export const UKE_CLAIM_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,19}$/;
