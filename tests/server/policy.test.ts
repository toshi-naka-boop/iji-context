// 権限表の網羅（spec FR-133）：app/api/**/route.ts の全ルート・全メソッドが権限表に載っている。表にないルートを 1 つ足すと、ここが落ちる
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { allow, permits, POLICY, type Rule } from "../../src/server/policy";

const apiDir = path.join(__dirname, "..", "..", "app", "api");

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? routeFiles(path.join(dir, e.name)) : e.name === "route.ts" ? [path.join(dir, e.name)] : []));
}
/** ファイルが export しているメソッド（export async function POST / export const POST） */
const methodsOf = (src: string) => [...src.matchAll(/^export\s+(?:async\s+function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/gm)].map((m) => m[1]);
const routes = routeFiles(apiDir).map((file) => {
  const src = readFileSync(file, "utf8");
  const url = `/api/${path.relative(apiDir, path.dirname(file)).split(path.sep).join("/")}`;
  return { file, src, keys: methodsOf(src).map((m) => `${m} ${url}`) };
});

describe("権限表", () => {
  it("すべてのルート・メソッドが権限表に載っていて、表に余分な行もない", () => {
    const actual = routes.flatMap((r) => r.keys).sort();
    expect(actual.length).toBeGreaterThan(50);
    expect(Object.keys(POLICY).sort()).toEqual(actual);
  });

  it("すべての行が、外部へ送るか（external）と患者の情報を扱うか（patientData）を申告している（既定値はない。design.md §11-11）", () => {
    for (const [key, r] of Object.entries(POLICY) as [string, Record<string, unknown>][]) {
      expect([key, Object.keys(r).sort()]).toEqual([key, ["external", "patientData", "rule"]]);
      expect([key, ["ai", "voice", "none"].includes(r.external as string), typeof r.patientData]).toEqual([key, true, "boolean"]);
    }
    // ログインなしで呼べる行は、外部へ送らず、患者の情報も扱わない（同意を確かめる相手がいない）
    for (const [key, r] of Object.entries(POLICY)) if (r.rule === "public") expect([key, r.external, r.patientData]).toEqual([key, "none", false]);
    // 設計書が挙げている入口（表が正）
    const declared = (keys: string[]) => keys.map((k) => [k, POLICY[k as keyof typeof POLICY].external, POLICY[k as keyof typeof POLICY].patientData]);
    const ai = ["POST /api/chart", "POST /api/chart/soap", "POST /api/chart/image", "POST /api/mentor", "POST /api/proxy", "POST /api/notice"];
    expect(declared(ai)).toEqual(ai.map((k) => [k, "ai", true]));
    const voice = ["POST /api/voice/listen", "POST /api/voice/speak"];
    expect(declared(voice).map(([k, e]) => [k, e])).toEqual(voice.map((k) => [k, "voice"]));
    const patient = ["POST /api/chart/[id]", "POST /api/uke/upload", "POST /api/uke", "GET /api/doctor", "POST /api/doctor/[id]/answer", "GET /api/peer", "POST /api/peer/[id]/answer", "POST /api/notice/register"];
    expect(declared(patient)).toEqual(patient.map((k) => [k, "none", true]));
    // 開発用の、AI を呼ぶ確認の入口
    expect(declared(["GET /api/eval", "GET /api/mentor-check", "GET /api/sdk-check"]).map(([, e]) => e)).toEqual(["ai", "ai", "ai"]);
  });

  it("すべてのルートが route() を使い、自分のパスとメソッドの行を allow() で引いている", () => {
    for (const r of routes) {
      expect(/\broute\(/.test(r.src), r.file).toBe(true);
      const used = [...r.src.matchAll(/allow\("([^"]+)"\)/g)].map((m) => m[1]).sort();
      expect(used, r.file).toEqual([...r.keys].sort());
    }
  });

  it("開発用（dev）の行は 3 つだけ。ログインの確かめは route() が持ち、ルートの中には書かない", () => {
    const dev = Object.entries(POLICY).filter(([, r]) => r.rule === "dev").map(([key]) => key);
    expect(dev).toEqual(["GET /api/eval", "GET /api/mentor-check", "GET /api/sdk-check"]);
    for (const r of routes.filter((x) => x.keys.some((k) => dev.includes(k)))) expect(/ログインしてください|\bviewer\b/.test(r.src), r.file).toBe(false);
    // ログインした人なら、ロールは問わない
    for (const role of ["clerk", "veteran", "manager", "doctor"] as const) expect(permits("dev", { role }, () => false)).toBe(true);
  });

  it("時計を進めるのは、事務長と、開発ではどのロールでも（本番でも 404 にしない。real のクリニックで断るのはハンドラ）", () => {
    const clock: Rule = POLICY["POST /api/clock"].rule;
    expect(clock).toEqual({ roles: ["manager"], dev: true });
    const env = process.env.NODE_ENV;
    try {
      (process.env as Record<string, string>).NODE_ENV = "production";
      expect(permits(clock, { role: "manager" }, () => true)).toBe(true);
      for (const role of ["clerk", "veteran", "doctor"] as const) expect(permits(clock, { role }, () => true)).toBe(false);
      (process.env as Record<string, string>).NODE_ENV = "development";
      for (const role of ["clerk", "veteran", "manager", "doctor"] as const) expect(permits(clock, { role }, () => false)).toBe(true);
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = env;
    }
  });

  it("表にないキーは引けない", () => {
    expect(() => allow("POST /api/nowhere" as never)).toThrow(/権限表にない/);
  });

  it("ロールの行はそのロールだけ、solo の行は 1 人で使っているクリニックの持ち主にも許す", () => {
    const doctorOnly: Rule = POLICY["POST /api/doctor/[id]/approve"].rule;
    expect(permits(doctorOnly, { role: "doctor" }, () => true)).toBe(true);
    expect(permits(doctorOnly, { role: "clerk" }, () => true)).toBe(false);
    expect(permits(doctorOnly, { role: "manager" }, () => true)).toBe(false);
    const invite: Rule = POLICY["POST /api/invites"].rule;
    expect(permits(invite, { role: "manager" }, () => false)).toBe(true);
    expect(permits(invite, { role: "clerk" }, () => false)).toBe(false);
    expect(permits(invite, { role: "clerk" }, () => true)).toBe(true);
    const switchRole: Rule = POLICY["POST /api/auth/role"].rule;
    expect(permits(switchRole, { role: "manager" }, () => false)).toBe(false);
    expect(permits(switchRole, { role: "doctor" }, () => true)).toBe(true);
  });
});
