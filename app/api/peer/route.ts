// API Route：メンター同士の問い（ベテラン本人に届いたもの・解決したもの）。
// 誰が聞いたか（from_clerk）は、ベテランのロールと、その問いを出した本人にだけ返す
import { route } from "../../../src/server/http";
import { getApp } from "../../../src/server/instance";
import { allow } from "../../../src/server/policy";

export const GET = route({ roles: allow("GET /api/peer") }, ({ user, clerkId }) => getApp().peerListFor({ clerkId, role: user.role }));

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
