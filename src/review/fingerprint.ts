// 点検のコードの指紋（spec FR-202 の I-1。design/iji-context/plan-i1.md「Fable の見立てで直すところ」5）。
// 記録を見る前（取り込んだとき）に固定し、判定のたびにも残す。指紋が変わったあとの判定は、別の回として数える（版の日付では分けない）。
// 指紋は、点検に関わるソース（手書きのルール・データで動く点検・患者情報チェック・UKE の読み取り・取り込んだレセプトの点検）の中身から作る。
// ソースのない置き方（本番のイメージは .next だけを持つ。Dockerfile）では、ビルドの id から作る：ビルドし直すと、コードが同じでも別の回になる（数えすぎない側）
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** 指紋に入れるもの（リポジトリ直下からの相対パス。フォルダは中の .ts と .json を全部） */
export const FINGERPRINT_SOURCES = ["src/engine", "src/generic", "src/patient", "src/uke", "src/masters", "src/server/app/uke-check.ts", "src/server/app/generic.ts", "config/generic-checks.json"];

function filesUnder(root: string, rel: string): string[] {
  const full = path.join(root, rel);
  if (!existsSync(full)) return [];
  if (statSync(full).isFile()) return [rel];
  return readdirSync(full, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? filesUnder(root, `${rel}/${e.name}`) : /\.(ts|json)$/.test(e.name) ? [`${rel}/${e.name}`] : []))
    .sort();
}

/** 点検のコードの指紋（"src:" か "build:" に続く sha256 の先頭 16 桁）。どちらも読めなければ "unknown" */
export function codeFingerprint(root: string): string {
  const files = FINGERPRINT_SOURCES.flatMap((r) => filesUnder(root, r));
  if (files.length > 0) {
    const h = createHash("sha256");
    for (const f of files) h.update(f).update("\0").update(readFileSync(path.join(root, f))).update("\0");
    return `src:${h.digest("hex").slice(0, 16)}`;
  }
  const buildId = path.join(root, ".next", "BUILD_ID");
  if (existsSync(buildId)) return `build:${createHash("sha256").update(readFileSync(buildId)).digest("hex").slice(0, 16)}`;
  return "unknown";
}
