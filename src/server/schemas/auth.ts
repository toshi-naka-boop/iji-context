// ログイン・登録・役割の切替・招待・監査ログの入力
import { z } from "zod";
import { ROLES } from "../roles";
import { TENANT_KINDS } from "../tenant-kind";

// ログイン ID・名前・パスワードの細かい規則と文言は validateRegistration（src/server/auth.ts）が持つ。ここは型と長さの上限だけ
export const loginBody = z.strictObject({ login: z.string().max(64), password: z.string().max(256) });
export const registerBody = z.strictObject({ login: z.string().max(64), name: z.string().max(64), password: z.string().max(256), inviteCode: z.string().max(64).optional(), kind: z.enum(TENANT_KINDS).optional() });
/** 未定のクリニックの使い方を選ぶ（POST /api/tenant/kind） */
export const tenantKindBody = z.strictObject({ kind: z.enum(TENANT_KINDS) });
export const roleBody = z.strictObject({ role: z.enum(ROLES) });
export const inviteBody = z.strictObject({ role: z.enum(ROLES) });
/** 招待の id（src/server/auth.ts の inviteId が作る形。招待コードでもそのハッシュでもない） */
export const inviteParams = z.strictObject({ id: z.string().regex(/^[0-9a-f]{16}$/) });
/** 注意書きへの同意。画面が見せた注意書きの版（config/notice.json の version） */
export const consentBody = z.strictObject({ version: z.string().min(1).max(32) });
export const auditQuery = z.strictObject({ limit: z.coerce.number().int().min(1).max(500).optional() });
/** 職員（同じクリニックの利用者）の id（src/server/auth.ts の insertUser が作る形） */
export const staffParams = z.strictObject({ id: z.string().regex(/^t[0-9a-f]{12}$/) });
/** 職員の役割を変える（POST /api/staff/[id]/role） */
export const staffRoleBody = z.strictObject({ role: z.enum(ROLES) });
/** クリニックをまるごと消す（POST /api/tenant/erase）。確かめに、持ち主のログイン ID を入れる */
export const eraseTenantBody = z.strictObject({ login: z.string().max(64) });
/** 持ち主を引き継ぐ（POST /api/staff/[id]/owner）。本人のパスワードを入れ直す */
export const ownerTransferBody = z.strictObject({ password: z.string().max(256) });
