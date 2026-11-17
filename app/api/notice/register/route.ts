// API Route：本人が確かめた通知の 1 項目を、地域層の知識の候補にする（状態は F5 の規則が決める）
import { route } from "../../../../src/server/http";
import { getApp } from "../../../../src/server/instance";
import { allow } from "../../../../src/server/policy";
import { noticeRegisterBody } from "../../../../src/server/schemas/knowledge";

export const POST = route({ roles: allow("POST /api/notice/register"), body: noticeRegisterBody }, ({ body }) =>
  getApp().registerNotice(body.notice, body.index, { reexamFiled: !!body.reexamFiled, fileName: body.fileName }),
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
