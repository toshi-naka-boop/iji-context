// 一人ひとりの作業場所（Agent SDK の cwd）。spec FR-10・FR-12・FR-48、design.md §5
// - CLAUDE.md：本人についての記録。レセメンが記録から決まった規則で書き換える（LLM には書かせない）
// - .claude/skills：承認済みの知識（同期先）への参照。メンターは Skill のツールで必要なものだけを読む
// - Hooks：Skill を読む直前に知識の状態を確かめ、承認済みでなければ読ませない。読んだものを記録する
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { listKnowledge, type StoreOptions } from "../lifecycle/store";
import type { Question } from "../practice/practice";

/**
 * 作業場所の置き場所。Claude Code は cwd から上の階層の CLAUDE.md も読むので、
 * 上の階層に CLAUDE.md がある場所（ホームやこのリポジトリの中）には置かない（2026-11-06 実測）
 */
export function workspaceRoot(root = process.env.RESEMEN_WORKSPACES ?? path.join(tmpdir(), "resemen-workspaces")): string {
  const abs = path.resolve(root);
  for (let d = path.dirname(abs); ; d = path.dirname(d)) {
    for (const f of ["CLAUDE.md", "CLAUDE.local.md", path.join(".claude", "CLAUDE.md")]) {
      if (existsSync(path.join(d, f))) throw new Error(`作業場所の上の階層に ${path.join(d, f)} がある（メンターに読み込まれてしまう）。RESEMEN_WORKSPACES を別の場所にする`);
    }
    if (path.dirname(d) === d) break;
  }
  return abs;
}

/** 作業場所を用意する（何度呼んでもよい）。CLAUDE.md は中身が変わったときだけ書き換える */
export function ensureWorkspace(root: string, id: string, skillsDir: string, claudeMd: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`作業場所の id が不正: ${id}`);
  const dir = path.join(root, id);
  mkdirSync(path.join(dir, ".claude"), { recursive: true });
  const link = path.join(dir, ".claude", "skills");
  const target = path.resolve(skillsDir);
  mkdirSync(target, { recursive: true });
  let ok = false;
  try {
    ok = lstatSync(link).isSymbolicLink() && readlinkSync(link) === target;
  } catch {
    ok = false;
  }
  if (!ok) {
    rmSync(link, { recursive: true, force: true });
    symlinkSync(target, link);
  }
  const file = path.join(dir, "CLAUDE.md");
  if (!existsSync(file) || readFileSync(file, "utf8") !== claudeMd) {
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, claudeMd);
    renameSync(tmp, file);
  }
  return dir;
}

/** 同期先にある知識のスキル名（iji-*）。これだけを有効にし、Claude Code 同梱のスキルは出さない */
export function skillNames(skillsDir: string): string[] {
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith("iji-"))
    .map((e) => e.name)
    .sort();
}

/** 同期の世代（design.md §5）。変わっていたらメンターのセッションを作り直す */
export function skillsGeneration(skillsDir: string): string {
  const f = path.join(skillsDir, ".iji-generation");
  return existsSync(f) ? readFileSync(f, "utf8").trim() : "";
}

/** スキル名 → 知識 id（iji-system-r03 → system/r03） */
export function knowledgeIdOf(store: StoreOptions, name: string): string | null {
  return listKnowledge(store).find((m) => `iji-${m.id.replace("/", "-")}` === name)?.id ?? null;
}

/**
 * Skill を読む前後の Hooks。読む直前に知識の状態を確かめ、承認済み・院内以外でなければ読ませない
 * （同期の遅れで古い知識が残っていても、読む瞬間に止める）。読めたものは reads に知識 id で残す
 */
export function skillGuard(store: StoreOptions): { hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>; reads: string[] } {
  const reads: string[] = [];
  const nameOf = (input: unknown) => {
    const ti = (input as { tool_input?: { skill?: unknown } }).tool_input;
    return typeof ti?.skill === "string" ? ti.skill : "";
  };
  const allowed = (name: string) => {
    const m = listKnowledge(store).find((x) => `iji-${x.id.replace("/", "-")}` === name);
    return m && m.status === "承認済み" && m.layer !== "院内" ? m.id : null;
  };
  return {
    reads,
    hooks: {
      PreToolUse: [
        {
          matcher: "Skill",
          hooks: [
            async (input) =>
              allowed(nameOf(input))
                ? {}
                : { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: "この知識は今は使えません（承認済みではない）。使わずに答えてください" } },
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: "Skill",
          hooks: [
            async (input) => {
              const id = allowed(nameOf(input));
              if (id && !reads.includes(id)) reads.push(id);
              return {};
            },
          ],
        },
      ],
    },
  };
}

export type ClerkProfile = { name: string; callName: string; role: string; level: number; count: number; streak: number };

/** 本人についての CLAUDE.md（決まった規則で作る。直近 20 件で確認が入ったルールを数える） */
export function clerkMemo(p: ClerkProfile, questions: Question[]): string {
  const recent = questions
    // レベルの件数と同じく、終わった問い（次のレセプトへ進んだもの）だけを数える
    .filter((q) => q.confirmed && q.finishedAt)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
    .slice(0, 20);
  const miss = new Map<string, number>();
  for (const q of recent) for (const f of q.confirmed!.result.findings) if (f.kind !== "情報不足") miss.set(f.ruleId, (miss.get(f.ruleId) ?? 0) + 1);
  const missText = [...miss.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([r, n]) => `${r} ${n} 回`).join("、") || "なし";
  return [
    `# ${p.name}${p.callName}について`,
    "",
    "レセメンが記録から自動で書き換える。手で直さない。",
    "",
    `- 呼び方：${p.name}${p.callName}`,
    `- 役割：${p.role === "veteran" ? "ベテラン" : "医療事務"}`,
    `- レベル：Lv.${p.level}（処理 ${p.count} 件、いまの連続正解 ${p.streak} 件）`,
    `- 直近 ${recent.length} 件で確認が入ったルール：${missText}`,
    "",
    "今のレセプトが確認の入ったルールに関係するときだけ、前回より一歩先を本人に考えてもらう。関係しないときは触れない。数字をそのまま本人に読み上げない。",
    "",
  ].join("\n");
}
