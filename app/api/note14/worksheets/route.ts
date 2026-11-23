// API Route（薄い入口。処理は src/server/app/note14.ts）：注14 の計算の道具の結果を残す（追記。design.md §15-13）。
// 残すのは事務長と責任者。監査ログは確認月と結果の種類だけ（入力の数・患者の情報は入れない）
import { route } from "../../../../src/server/http";
import { getApp } from "../../../../src/server/instance";
import { allow } from "../../../../src/server/policy";
import { note14WorksheetBody, type Note14WorksheetBody } from "../../../../src/server/schemas/note14";

/** 監査ログに書く結果の種類（処理のあとで読む） */
const results = new WeakMap<object, string>();

export const POST = route(
  { roles: allow("POST /api/note14/worksheets"), body: note14WorksheetBody, audit: { target: ({ body }) => `${body.checkMonth}・${results.get(body) ?? "—"}` } },
  ({ user, body }) => {
    const saved = getApp().saveNote14Worksheet(user, body as Note14WorksheetBody);
    results.set(body, saved.result);
    return saved;
  },
);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
