// カルテの画面（app/chart/page.tsx）が AI の API（SOAP 整理・事実の読み取り・画像の取り込み）を呼ぶ口（app/get-json.ts の postJson）。
// 500 などが返ったときに、画面が出す文が決まった文になり、例外として返る（画面は catch でエラーの文を出し、finally でボタンを戻す）
import { afterEach, describe, expect, it, vi } from "vitest";
import { postJson } from "../../app/get-json";
import { INTERNAL_ERROR } from "../../src/server/http";

const respond = (status: number, body: string, type = "application/json") => vi.fn(async () => new Response(body, { status, headers: { "content-type": type } }));

afterEach(() => vi.unstubAllGlobals());

describe("postJson（カルテの画面の AI の呼び出し）", () => {
  for (const url of ["/api/chart/soap", "/api/chart", "/api/chart/image"]) {
    it(`${url} が 500（サーバーの決まった JSON）を返すと、その文の例外になる`, async () => {
      vi.stubGlobal("fetch", respond(500, JSON.stringify({ error: INTERNAL_ERROR, errorId: "abcd1234" })));
      await expect(postJson(url, { text: "x" })).rejects.toThrow(INTERNAL_ERROR);
    });
    it(`${url} が JSON でない 500・502（HTML や空の本文）を返しても、JSON の読み取りの例外ではなく、決まった文の例外になる`, async () => {
      for (const [status, body] of [[500, "<!DOCTYPE html><html>Internal Server Error</html>"], [502, ""]] as const) {
        vi.stubGlobal("fetch", respond(status, body, "text/html"));
        await expect(postJson(url, { text: "x" })).rejects.toThrow("うまくいきませんでした。時間をおいて、もう一度試してください");
      }
    });
  }
  it("つながらない（fetch が失敗する）ときは、そのまま例外になる（画面の catch に届く）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await expect(postJson("/api/chart/soap", { text: "x" })).rejects.toThrow("Failed to fetch");
  });
  it("成功した応答は本文を返し、POST の JSON で送る", async () => {
    const f = respond(200, JSON.stringify({ note: { s: "a" }, unmatched: [] }));
    vi.stubGlobal("fetch", f);
    await expect(postJson("/api/chart/soap", { text: "x" })).resolves.toEqual({ note: { s: "a" }, unmatched: [] });
    expect(f).toHaveBeenCalledWith("/api/chart/soap", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x" }) });
  });
});
