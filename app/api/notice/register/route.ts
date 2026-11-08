// API Route：本人が確かめた通知の 1 項目を、地域層の知識の候補にする（状態は F5 の規則が決める）
import type { Notice } from "../../../../src/notice/notice";
import { body, authed } from "../../../../src/server/http";
import { getApp } from "../../../../src/server/instance";

export async function POST(req: Request) {
  return authed(req, async () => {
    const b = await body<{ notice: Notice; index: number; reexamFiled?: boolean; fileName: string }>(req);
    return getApp().registerNotice(b.notice, b.index, { reexamFiled: !!b.reexamFiled, fileName: b.fileName });
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
