// 利用者のロール（spec FR-132）。画面からも読むので、Node 専用のものを読み込まない小さなファイルに分ける
export const ROLES = ["clerk", "veteran", "manager", "doctor"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = { clerk: "事務", veteran: "ベテラン", manager: "事務長", doctor: "医師" };

export const isRole = (x: unknown): x is Role => typeof x === "string" && (ROLES as readonly string[]).includes(x);
