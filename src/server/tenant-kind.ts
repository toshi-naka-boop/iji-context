// クリニック（tenant）の種類（2026-11-22 利用者の判断）。クリニックを作るときに決め、後から変えない。画面からも読むので、Node 専用のものを読み込まない
// demo＝作り物のデータ入りで、今日はデモの時計（進められる）／real＝実在のデータで使う。作り物のデータを入れず、今日は実際の日付（日本時間）。
// undecided＝種類を持つ前に作られたクリニック（未定）。事務長（1 人で使っているクリニックは持ち主）が次に入ったときに一度だけ demo か real を選ぶ。
// 選ぶまでは安全側に倒す：作り物を入れず・見せず、片づけ（reset-demo）の対象にせず、今日は実際の日付。点検などの操作はさせない
export const TENANT_KINDS = ["demo", "real"] as const;
export type TenantKind = (typeof TENANT_KINDS)[number];

export const TENANT_KIND_LABELS: Record<TenantKind, string> = { demo: "デモで試す", real: "実在のデータで使う" };

/** 種類ごとの説明（登録の画面と、未定のクリニックで選ぶ画面に出す） */
export const TENANT_KIND_NOTES: Record<TenantKind, string> = {
  demo: "作り物のデータ（症例・院内ルール・見本の UKE）入りで始まります。今日はデモの日付で、事務長が日付を進められます。",
  real: "作り物のデータは入れず、見せません。今日は実際の日付（日本時間）で、日付は進められません。",
};

/** クリニックの今の状態（選べる種類と、未定） */
export type TenantStatus = TenantKind | "undecided";

export const isTenantKind = (x: unknown): x is TenantKind => typeof x === "string" && (TENANT_KINDS as readonly string[]).includes(x);
