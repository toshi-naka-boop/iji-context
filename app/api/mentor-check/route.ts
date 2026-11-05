// 動作確認用（開発時だけ）：メンターに K2（包括的支援加算を外した下書き）のヒントを 1 回もらう。
// 知識と医師確認の記録は一時ディレクトリに作り、終わったら消す
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { evaluate } from "../../../src/engine";
import type { ClaimContext } from "../../../src/engine/types";
import { askMentor } from "../../../src/mentor/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  if (process.env.NODE_ENV === "production") return new Response("Not Found", { status: 404 });
  const root = mkdtempSync(path.join(tmpdir(), "iji-mentor-check-"));
  const started = Date.now();
  try {
    const base = process.cwd();
    const k2 = JSON.parse(readFileSync(path.join(base, "fixtures/cases/K2.json"), "utf8"));
    const facility = JSON.parse(readFileSync(path.join(base, "config/facility.json"), "utf8"));
    const ctx: ClaimContext = { ...k2, facility, lines: k2.lines.filter((l: { kubun: string }) => l.kubun !== "C002_N10_HOKATSU") };
    const engine = evaluate(ctx);
    const deps = {
      store: { knowledgeDir: path.join(root, "knowledge"), skillsDir: path.join(root, "skills") },
      queryLog: { dir: path.join(root, "query-log") },
      askPeerMentor: async () => null,
      askHuman: async () => ({ queued: "check" }),
    };
    const r = await askMentor(deps, {
      clerkId: "check",
      sessionId: null,
      character: { id: "a", name: "仮キャラ", firstPerson: "僕", tone: "ていねい" },
      level: 1,
      ctx,
      engine,
      situation: "新人の誤り",
      message: "この請求を確定する前に、ヒントをください。",
      now: () => new Date().toISOString(),
    });
    return Response.json({ ok: true, ...r, ms: Date.now() - started });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e), ms: Date.now() - started }, { status: 500 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
