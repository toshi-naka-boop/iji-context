// データベースを開く場所（spec FR-219）。開くのは src/db/open.ts の openDatabase だけで、公開のマスター（masters.db）の読み込みと作成だけを外す。
// ソースを走査し、ほかのファイルが SQLite のライブラリを読み込んで（型だけの読み込みは除く）直接開いていないことを確かめる
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repo = path.join(__dirname, "..", "..");

/** 直接開いてよいファイル：開く入口と、公開のマスターの読み込み・作成（暗号化しない。患者情報を含まない） */
const ALLOWED = ["src/db/open.ts", "src/masters/db.ts", "src/masters/build.ts", "scripts/build-masters.ts"];

function sources(dir: string): string[] {
  return readdirSync(path.join(repo, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === "node_modules" || e.name === "runs" ? [] : sources(path.join(dir, e.name))) : /\.(ts|tsx|mts|js|mjs|cjs)$/.test(e.name) ? [path.join(dir, e.name)] : [],
  );
}

/** SQLite を直接開く書き方（型だけの読み込み `import type` は開かないので除く） */
const LIBS = String.raw`(?:better-sqlite3(?:-multiple-ciphers)?|node:sqlite|sqlite3)`;
const PATTERNS = [
  // import Database from "better-sqlite3" / import { DatabaseSync } from "node:sqlite"（import type は除く）
  new RegExp(String.raw`^\s*import\s+(?!type\b)[^;]*?from\s*["']${LIBS}["']`, "m"),
  // 動的な読み込み・require
  new RegExp(String.raw`(?:import|require)\s*\(\s*["']${LIBS}["']\s*\)`),
  // 読み込み元によらず、Database・DatabaseSync を new する
  /\bnew\s+(?:Database|DatabaseSync|Sqlite|SQLite)\s*\(/,
];

/** 直接開いている書き方があるか */
export const opensDirectly = (source: string): boolean => PATTERNS.some((p) => p.test(source));

const files = [...["app", "src", "scripts", "eval"].flatMap(sources), "proxy.ts"].map((f) => f.split(path.sep).join("/"));

describe("データベースを開く場所（ソースを走査する）", () => {
  it("走査の対象に、ルート・サーバー・スクリプトのソースが入っている", () => {
    expect(files.length).toBeGreaterThan(200);
    for (const f of ["src/server/auth.ts", "src/server/app/context.ts", "src/server/dataset.ts", "scripts/reset-demo.ts", ...ALLOWED]) expect(files).toContain(f);
  });

  it("データベースを直接開くのは、開く入口と公開のマスターの読み込みだけ", () => {
    const hits = files.filter((f) => opensDirectly(readFileSync(path.join(repo, f), "utf8"))).sort();
    expect(hits).toEqual([...ALLOWED].sort());
  });

  it("直接開く処理を 1 つ足すと、検査が落ちる（どの書き方も見つける）", () => {
    const planted = [
      `import Database from "better-sqlite3";\nconst db = new Database(file);`,
      `import Database from "better-sqlite3-multiple-ciphers";`,
      `import { DatabaseSync } from "node:sqlite";`,
      `const { default: D } = await import("better-sqlite3");`,
      `const D = require("better-sqlite3-multiple-ciphers");`,
      `const db = new Database(path.join(dir, "app.db"));`,
    ];
    for (const p of planted) expect([p, opensDirectly(p)]).toEqual([p, true]);
    // 型だけの読み込み・開く入口を通すものは、直接開くことにならない
    for (const ok of [`import type Database from "better-sqlite3";`, `const db = openDatabase(file, "auth");`, `import { drizzle } from "drizzle-orm/better-sqlite3";`]) expect([ok, opensDirectly(ok)]).toEqual([ok, false]);
    // 実際のファイルの 1 つに足したときも落ちる
    const src = readFileSync(path.join(repo, "src/server/auth.ts"), "utf8");
    expect(opensDirectly(src)).toBe(false);
    expect(opensDirectly(`${src}\nimport Raw from "better-sqlite3";\nexport const raw = (f: string) => new Raw(f);\n`)).toBe(true);
  });
});
