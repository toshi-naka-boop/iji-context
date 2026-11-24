// API Route：自分のクリニックの職員の一覧（採点 r1 事務長 #2）。事務長とクリニックの持ち主だけ（src/server/auth.ts の canManageStaff）
import { route } from "../../../src/server/http";
import { getAuth } from "../../../src/server/instance";
import { allow } from "../../../src/server/policy";

export const GET = route({ roles: allow("GET /api/staff") }, ({ user }) => getAuth().listStaff(user));

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
