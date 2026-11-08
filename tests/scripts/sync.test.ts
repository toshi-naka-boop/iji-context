import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { syncSkills } from "../../scripts/sync-skills";
import { applyEvent, createKnowledge, type CreateInput, type StoreOptions } from "../../src/lifecycle/store";

let root: string;
let opts: StoreOptions;
const NOW = "2025-03-31T00:00:00+09:00";

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "iji-sync-"));
  opts = { knowledgeDir: path.join(root, "knowledge"), skillsDir: path.join(root, "skills") };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** ディレクトリ配下の全ファイルを 相対パス→内容 にする */
function snapshot(dir: string, base = dir): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(dir).sort()) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) Object.assign(out, snapshot(p, base));
    else out[path.relative(base, p)] = readFileSync(p, "utf8");
  }
  return out;
}

const sys = (slug: string): CreateInput => ({
  layer: "制度", slug, summary: `制度 ${slug}`, body: `本文 ${slug}`, source: { type: "初期投入", ref: "init" }, match: { ruleId: "R01" },
});
const regional = (slug: string): CreateInput => ({
  layer: "地域", slug, summary: `地域 ${slug}: コロン入り "引用符" あり`, body: `本文 ${slug}`, source: { type: "返戻", ref: "r" },
  match: { kubunAll: ["C001"], payer: "支払基金", prefecture: "東京都" },
});
const local = (slug: string): CreateInput => ({
  layer: "院内", slug, summary: "院内", body: "本文", source: { type: "手動", ref: "m" }, match: {},
});
const veteran = (slug: string): CreateInput => ({
  layer: "ベテラン", slug, summary: "ベテラン", body: "本文", source: { type: "エスカレーション", ref: "e" }, match: {},
});

function seed(o: StoreOptions, order: "fwd" | "rev" = "fwd") {
  const items: [CreateInput, boolean][] = [
    [sys("r01-rule"), false],
    [regional("c001-return"), true],
    [regional("c002-unverified"), false],
    [veteran("v1"), true],
    [local("l1"), true],
  ];
  for (const [input, approve] of order === "fwd" ? items : [...items].reverse()) {
    const m = createKnowledge(o, input, NOW);
    if (approve) applyEvent(o, m.id, { type: "VERIFY_APPROVE" }, NOW);
  }
}

describe("syncSkills", () => {
  it("一時ディレクトリで 2 回実行し、2 回の出力が完全に一致する", () => {
    seed(opts);
    syncSkills(opts);
    const first = snapshot(opts.skillsDir);
    syncSkills(opts);
    expect(snapshot(opts.skillsDir)).toEqual(first);
  });

  it("出力は入力だけで決まる（作成順・走査順に依存しない）", () => {
    const other: StoreOptions = { knowledgeDir: path.join(root, "k2"), skillsDir: path.join(root, "s2") };
    seed(opts, "fwd");
    seed(other, "rev");
    syncSkills(opts);
    syncSkills(other);
    expect(snapshot(other.skillsDir)).toEqual(snapshot(opts.skillsDir));
  });

  it("承認済みかつ院内以外だけが入り、各 SKILL.md に name と description がある", () => {
    seed(opts);
    const r = syncSkills(opts);
    expect(r.names).toEqual(["iji-regional-c001-return", "iji-system-r01-rule", "iji-veteran-v1"].sort());
    const snap = snapshot(opts.skillsDir);
    expect(Object.keys(snap).sort()).toEqual([
      ".iji-generation",
      "iji-regional-c001-return/SKILL.md",
      "iji-system-r01-rule/SKILL.md",
      "iji-veteran-v1/SKILL.md",
    ]);
    for (const [file, content] of Object.entries(snap)) {
      if (!file.endsWith("SKILL.md")) continue;
      const m = content.match(/^---\nname: (.+)\ndescription: (.+)\n---\n/);
      expect(m, file).not.toBeNull();
      expect(m![1]).toBe(path.dirname(file));
      expect(m![1]).toMatch(/^[a-z0-9-]{1,64}$/);
      expect(JSON.parse(m![2]).length).toBeGreaterThan(0);
      expect(JSON.parse(m![2]).length).toBeLessThanOrEqual(1024);
    }
    expect(snap["iji-regional-c001-return/SKILL.md"]).toContain('description: "地域 c001-return: コロン入り \\"引用符\\" あり"');
    expect(snap["iji-system-r01-rule/SKILL.md"]).toContain("本文 r01-rule");
  });

  it("承認済みの知識を要再検証に遷移させると、同期先から消える", () => {
    seed(opts);
    syncSkills(opts);
    expect(Object.keys(snapshot(opts.skillsDir))).toContain("iji-regional-c001-return/SKILL.md");
    applyEvent(opts, "regional/c001-return", { type: "TRIGGER", trigger: "reappointment" }, "2025-06-01T00:00:00+09:00");
    expect(Object.keys(snapshot(opts.skillsDir))).not.toContain("iji-regional-c001-return/SKILL.md");
  });

  it("古い iji-* は全削除され、iji- 以外のエントリは残る", () => {
    seed(opts);
    mkdirSync(path.join(opts.skillsDir, "iji-stale"), { recursive: true });
    writeFileSync(path.join(opts.skillsDir, "iji-stale", "SKILL.md"), "古い");
    mkdirSync(path.join(opts.skillsDir, "other-skill"), { recursive: true });
    writeFileSync(path.join(opts.skillsDir, "other-skill", "SKILL.md"), "別物");
    syncSkills(opts);
    const snap = snapshot(opts.skillsDir);
    expect(Object.keys(snap)).not.toContain("iji-stale/SKILL.md");
    expect(snap["other-skill/SKILL.md"]).toBe("別物");
  });

  it("世代は内容が変わったときだけ変わる", () => {
    seed(opts);
    const a = syncSkills(opts).generation;
    expect(syncSkills(opts).generation).toBe(a);
    expect(readFileSync(path.join(opts.skillsDir, ".iji-generation"), "utf8").trim()).toBe(a);
    applyEvent(opts, "regional/c001-return", { type: "TRIGGER", trigger: "idle" }, "2025-10-01T00:00:00+09:00");
    expect(syncSkills(opts).generation).not.toBe(a);
  });

  it("knowledge/ が空・存在しなくても動く", () => {
    const r = syncSkills(opts);
    expect(r.names).toEqual([]);
  });

  it("規則に合わない知識があると、既存の出力を消さずに例外にする", () => {
    seed(opts);
    syncSkills(opts);
    const before = snapshot(opts.skillsDir);
    const metaPath = path.join(opts.knowledgeDir, "veteran", "v1", "meta.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    meta.summary = "あ".repeat(1025);
    writeFileSync(metaPath, JSON.stringify(meta));
    expect(() => syncSkills(opts)).toThrow();
    expect(snapshot(opts.skillsDir)).toEqual(before);
  });
});
