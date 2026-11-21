// クリニック（tenant）の種類（2026-11-22 利用者の判断）。クリニックを作るときに決め、後から変えない。画面からも読むので、Node 専用のものを読み込まない
// demo＝作り物のデータ入りで、今日はデモの時計（進められる）／real＝実在のデータで使う。作り物のデータを入れず、今日は実際の日付（日本時間）
export const TENANT_KINDS = ["demo", "real"] as const;
export type TenantKind = (typeof TENANT_KINDS)[number];

export const TENANT_KIND_LABELS: Record<TenantKind, string> = { demo: "デモで試す", real: "実在のデータで使う" };

export const isTenantKind = (x: unknown): x is TenantKind => typeof x === "string" && (TENANT_KINDS as readonly string[]).includes(x);
