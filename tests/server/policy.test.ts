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

  it("すべてのルートが route() を使い、自分のパスとメソッドの行を allow() で引いている", () => {
    for (const r of routes) {
      expect(/\broute\(/.test(r.src), r.file).toBe(true);
      const used = [...r.src.matchAll(/allow\("([^"]+)"\)/g)].map((m) => m[1]).sort();
      expect(used, r.file).toEqual([...r.keys].sort());
    }
  });

  it("開発用（dev）の行は 3 つだけ。ログインの確かめは route() が持ち、ルートの中には書かない", () => {
    const dev = Object.entries(POLICY).filter(([, rule]) => rule === "dev").map(([key]) => key);
    expect(dev).toEqual(["GET /api/eval", "GET /api/mentor-check", "GET /api/sdk-check"]);
    for (const r of routes.filter((x) => x.keys.some((k) => dev.includes(k)))) expect(/ログインしてください|\bviewer\b/.test(r.src), r.file).toBe(false);
    // ログインした人なら、ロールは問わない
    for (const role of ["clerk", "veteran", "manager", "doctor"] as const) expect(permits("dev", { role }, () => false)).toBe(true);
  });

  it("表にないキーは引けない", () => {
    expect(() => allow("POST /api/nowhere" as never)).toThrow(/権限表にない/);
  });

  it("ロールの行はそのロールだけ、solo の行は 1 人で使っているクリニックの持ち主にも許す", () => {
    const doctorOnly: Rule = POLICY["POST /api/doctor/[id]/approve"];
    expect(permits(doctorOnly, { role: "doctor" }, () => true)).toBe(true);
    expect(permits(doctorOnly, { role: "clerk" }, () => true)).toBe(false);
    expect(permits(doctorOnly, { role: "manager" }, () => true)).toBe(false);
    const invite: Rule = POLICY["POST /api/invites"];
    expect(permits(invite, { role: "manager" }, () => false)).toBe(true);
    expect(permits(invite, { role: "clerk" }, () => false)).toBe(false);
    expect(permits(invite, { role: "clerk" }, () => true)).toBe(true);
    const switchRole: Rule = POLICY["POST /api/auth/role"];
    expect(permits(switchRole, { role: "manager" }, () => false)).toBe(false);
    expect(permits(switchRole, { role: "doctor" }, () => true)).toBe(true);
  });
});
