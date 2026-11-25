// API Route：いまログインしている人（していなければ 401）。役割と、役割の切替・招待ができるかも返す
import { route } from "../../../../src/server/http";
import { getAuth } from "../../../../src/server/instance";
import { allow } from "../../../../src/server/policy";

export const GET = route({ roles: allow("GET /api/auth/me") }, ({ user, clerkId }) => ({
  login: user.login,
  name: user.name,
  role: user.role,
  clerkId,
  canSwitchRole: getAuth().isSolo(user),
  canInvite: getAuth().canInvite(user),
  // 職員の一覧・停止・役割の変更ができるか（事務長とクリニックの持ち主）
  canManageStaff: getAuth().canManageStaff(user),
  // クリニックの持ち主か（クリニックをまるごと消せるのは持ち主だけ）
  isOwner: getAuth().isOwner(user),
  // 停止していない事務長がいるか（いなければ、招待の欄は事務長の招待だけを作れる）
  hasManager: getAuth().activeManagers(user.tenantId) > 0,
  // クリニックの使い方（demo／real／undecided）と、未定のときにこの人が選べるか
  tenantKind: getAuth().tenantKind(user.tenantId),
  canChooseKind: getAuth().canChooseKind(user),
  // 仮のパスワードのままか（画面は、自分のパスワードに変える欄だけを出す）
  mustChangePassword: getAuth().mustChangePassword(user.id),
}));

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
