// 訪問カルテの入力の上限。画面（app/chart/page.tsx）からも読むので、Node 専用のものを読み込まない小さなファイルに分ける

/** 自由記述・SOAP の各欄の上限（字） */
export const MAX_CHART_TEXT = 4000;
