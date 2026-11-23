// API Route（薄い入口。処理は src/server/app/devices.ts）。患者の在宅療養の機器（design.md §16-5・16-7。段 19e）。
// GET：診療年月に効く行・変更の記録・確かめたか・決めていない変える案／POST：機器の行を追記する（医療事務が入れた）。請求から患者を引き、患者の識別子は返さない
import { route } from "../../../../src/server/http";
import { getApp } from "../../../../src/server/instance";
import { allow } from "../../../../src/server/policy";
import { deviceBody, devicesQuery } from "../../../../src/server/schemas/patients";

export const GET = route({ roles: allow("GET /api/patient/devices"), query: devicesQuery }, ({ query }) => getApp().patientDevices(query.claimId));

// 監査ログは機器の種類の鍵だけ（月・区分は残さない）
export const POST = route({ roles: allow("POST /api/patient/devices"), body: deviceBody, audit: { target: ({ body }) => body.kind } }, ({ body, clerkId }) =>
  getApp().savePatientDevice(body.claimId, clerkId, { kind: body.kind, fromMonth: body.fromMonth, ...(body.endMonth !== undefined ? { endMonth: body.endMonth } : {}), ...(body.c150 ? { c150: body.c150 } : {}) }),
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
