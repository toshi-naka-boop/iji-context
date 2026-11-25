// 通知の項目の対応づけの問題の文（画面からも読むので、サーバーだけの依存を持たない小さなモジュールに分ける）
export const PATIENT_NOT_FOUND = "患者（氏名と保険者番号）が見つからない";
export const PATIENT_MANY = "同じ患者の同じ月の請求が複数ある";
export const ITEM_NOT_FOUND = "項目名に当たる区分が見つからない";
export const ITEM_MANY = "項目名に当たる区分が複数ある";
/** 本人が区分を選べば消える問題 */
export const CHOOSABLE = [ITEM_NOT_FOUND, ITEM_MANY];
export const itemOutside = (codes: string[]) => `項目は区分の表にない行（${codes.join("・")}）で、知識にできない`;
