// 承認済みの知識だけを .claude/skills/ へ同期する決定的スクリプト（design.md §5、FR-48）
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { LAYER_SLUG } from "../src/lifecycle/layers";
import type { KnowledgeMeta } from "../src/lifecycle/types";

export type SyncOptions = {
  /** knowledge/ のパス */
  knowledgeDir: string;
  /** .claude/skills/ のパス（テストでは一時ディレクトリ） */
  skillsDir: string;
};

export type SyncResult = {
  /** 書き出した Skill 名（昇順） */
  names: string[];
  /** 出力内容のハッシュ先頭 12 桁。内容が変わったときだけ変わる */
  generation: string;
};

const NAME_RE = /^[a-z0-9-]+$/;
const GENERATION_FILE = ".iji-generation";

/** 同期対象を集める。承認済みかつ院内以外（FR-12）。走査順に依存しないよう name 昇順で返す */
function collect(knowledgeDir: string): { name: string; content: string }[] {
  const out: { name: string; content: string }[] = [];
  if (!existsSync(knowledgeDir)) return out;
  for (const layerSlug of readdirSync(knowledgeDir).sort()) {
    const layerPath = path.join(knowledgeDir, layerSlug);
    for (const slug of readdirSync(layerPath).sort()) {
      const dir = path.join(layerPath, slug);
      const metaPath = path.join(dir, "meta.json");
      if (!existsSync(metaPath)) continue;
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as KnowledgeMeta;
      if (meta.status !== "承認済み" || meta.layer === "院内") continue;
      if (meta.id !== `${layerSlug}/${slug}` || LAYER_SLUG[meta.layer] !== layerSlug) {
        throw new Error(`meta.json の id・layer が置き場所と一致しない: ${layerSlug}/${slug}`);
      }
      const name = `iji-${layerSlug}-${slug}`;
      if (!NAME_RE.test(name) || name.length > 64) {
        throw new Error(`Skill 名が規則（英小文字・数字・ハイフン、64 文字以内）に合わない: ${name}`);
      }
      if (meta.summary.length > 1024 || meta.summary.includes("\n")) {
        throw new Error(`summary は 1 行・1024 文字以内: ${name}`);
      }
      const body = readFileSync(path.join(dir, "SKILL.md"), "utf8").replace(/\s+$/, "");
      // description は JSON 文字列として書く（YAML の二重引用スカラーとして有効）
      const content = `---\nname: ${name}\ndescription: ${JSON.stringify(meta.summary)}\n---\n\n${body}\n`;
      out.push({ name, content });
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** .claude/skills/iji-* を全削除してから書き出す。検証は削除の前にすべて済ませる */
export function syncSkills(opts: SyncOptions): SyncResult {
  const skills = collect(opts.knowledgeDir);
  mkdirSync(opts.skillsDir, { recursive: true });
  for (const entry of readdirSync(opts.skillsDir)) {
    if (entry.startsWith("iji-")) rmSync(path.join(opts.skillsDir, entry), { recursive: true, force: true });
  }
  const hash = createHash("sha256");
  for (const s of skills) {
    const dir = path.join(opts.skillsDir, s.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), s.content);
    hash.update(s.name).update("\0").update(s.content).update("\0");
  }
  const generation = hash.digest("hex").slice(0, 12);
  writeFileSync(path.join(opts.skillsDir, GENERATION_FILE), `${generation}\n`);
  return { names: skills.map((s) => s.name), generation };
}

// 直接実行（npx tsx scripts/sync-skills.ts）。リポジトリ直下で実行する前提
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = syncSkills({
    knowledgeDir: path.resolve("knowledge"),
    skillsDir: path.resolve(".claude/skills"),
  });
  console.log(`同期完了: ${result.names.length} 件（世代 ${result.generation}）`);
}
