// knowledge/ の読み書き（design.md §3・§4-1・§5）。原子的書き込みと、状態変化直後の同期
import { assertTime } from "./time";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { syncSkills } from "../../scripts/sync-skills";
import { defaultPolarity, initialStatus, LAYER_SLUG, LAYERS } from "./layers";
import { transition } from "./machine";
import type {
  Basis,
  Effect,
  KnowledgeMeta,
  Layer,
  LifecycleEvent,
  Match,
  Polarity,
  SourceType,
  TransitionResult,
} from "./types";

export type StoreOptions = {
  knowledgeDir: string;
  /** 同期先（.claude/skills/）。テストでは一時ディレクトリ */
  skillsDir: string;
  /** 区分のキーの検査（任意）。渡されたときだけ、match の区分をすべて確かめ、偽なら書き込みを拒否する。本番の配線が渡す（design.md §3） */
  knownKubun?: (kubun: string) => boolean;
};

export type CreateInput = {
  layer: Layer;
  slug: string;
  summary: string;
  /** SKILL.md の本文（frontmatter は同期時に付く） */
  body: string;
  source: { type: SourceType; ref: string };
  /** 生成元が査定で、再審査申出中のとき true（contested で作る） */
  reexamFiled?: boolean;
  polarity?: Polarity;
  matchApprox?: boolean;
  conditionNote?: string | null;
  relates_to?: string | null;
  review_by?: string | null;
  empathy?: number;
  match: Match;
};

const SLUG_RE = /^[a-z0-9-]+$/;

/** キー順を固定した JSON（ハッシュ用） */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** SKILL.md 本文・match・polarity・matchApprox・conditionNote の内容ハッシュ先頭 12 桁（X-9・round-7 X-27） */
export function computeRev(
  body: string,
  match: Match,
  extra: { polarity: Polarity; matchApprox: boolean; conditionNote: string | null },
): string {
  return createHash("sha256")
    .update(body.replace(/\s+$/, ""))
    .update("\0")
    .update(canonical({ match, polarity: extra.polarity, matchApprox: extra.matchApprox, conditionNote: extra.conditionNote }))
    .digest("hex")
    .slice(0, 12);
}

const dirOf = (opts: StoreOptions, id: string) => path.join(opts.knowledgeDir, ...id.split("/"));

/** 一時ファイルに書いてから rename する */
function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

function validate(input: CreateInput, knownKubun?: (kubun: string) => boolean): void {
  if (knownKubun) {
    const m = input.match;
    const all = [...(m.kubunAll ?? []), ...(m.commentOn ?? []).map((c) => c.kubun), ...(m.consecutiveMonths ? [m.consecutiveMonths.kubun] : [])];
    const bad = all.find((k) => !knownKubun(k));
    if (bad !== undefined) throw new Error(`match の区分が区分の表にない: ${bad}`);
  }
  if (!SLUG_RE.test(input.slug)) throw new Error(`slug は英小文字・数字・ハイフンのみ: ${input.slug}`);
  const name = `iji-${LAYER_SLUG[input.layer]}-${input.slug}`;
  if (name.length > 64) throw new Error(`Skill 名が 64 文字を超える: ${name}`);
  if (input.summary.trim() === "" || input.summary.includes("\n") || input.summary.length > 1024) {
    throw new Error("summary は 1 行・1024 文字以内で必須");
  }
  const m = input.match;
  if (input.layer === "制度" && !m.ruleId) throw new Error("制度層の match には ruleId が必須");
  if (input.layer === "地域" && (!m.kubunAll || m.kubunAll.length === 0 || !m.payer || !m.prefecture)) {
    throw new Error("地域層の match には kubunAll・payer・prefecture が必須");
  }
  if (input.matchApprox && (!input.conditionNote || input.conditionNote.trim() === "")) {
    throw new Error("matchApprox の知識には conditionNote が必須");
  }
  if (m.codePair !== undefined) validatePair(input);
}

/** 背反の組の知識の 1 件の条件文の上限（字。design.md §14-1） */
export const PAIR_NOTE_MAX = 200;

/**
 * codePair を持つ知識（design.md §14-1）：ほかの match のキーを持たない・コードは 9 桁で小さい順・表は 1〜3・院内層かベテラン層・いつも近似で条件の文（1〜200 字）が要る。
 * 院内層の生成元は、allow は手動だけ、avoid は手動か返戻（ベテラン層は会議の修正版で、生成元はエスカレーション）
 */
function validatePair(input: CreateInput): void {
  const m = input.match;
  const p = m.codePair!;
  const others = (Object.keys(m) as (keyof Match)[]).filter((k) => k !== "codePair" && m[k] !== undefined);
  if (others.length > 0) throw new Error(`codePair を持つ知識は、ほかの match のキーを持たない: ${others.join(", ")}`);
  if (!/^\d{9}$/.test(p.a) || !/^\d{9}$/.test(p.b) || !(p.a < p.b)) throw new Error("codePair のコードは 9 桁で、小さい順に 2 つ");
  if (![1, 2, 3].includes(p.tani)) throw new Error("codePair の表は 1 日・同一月・同時（tani 1〜3）だけ");
  if (input.layer !== "院内" && input.layer !== "ベテラン") throw new Error("codePair を持てるのは院内層とベテラン層だけ");
  if (input.matchApprox !== true) throw new Error("codePair の知識は、いつも近似（matchApprox）");
  const note = input.conditionNote ?? "";
  if (note.trim() === "" || note.length > PAIR_NOTE_MAX) throw new Error(`codePair の知識の条件（conditionNote）は 1〜${PAIR_NOTE_MAX} 字`);
  const polarity = input.polarity ?? defaultPolarity(input.layer, input.source.type);
  if (input.layer === "院内" && !(polarity === "allow" ? input.source.type === "手動" : input.source.type === "手動" || input.source.type === "返戻")) {
    throw new Error(`院内層の背反の組の知識の生成元は、allow は手動、avoid は手動か返戻: ${polarity}・${input.source.type}`);
  }
}

/** 新しい知識を作る。層×生成元の組み合わせと match の必須項目を検証し、作成後に同期する */
export function createKnowledge(opts: StoreOptions, input: CreateInput, now: string): KnowledgeMeta {
  assertTime(now, "now");
  const status = initialStatus(input.layer, input.source.type, { reexamFiled: input.reexamFiled });
  validate(input, opts.knownKubun);
  const id = `${LAYER_SLUG[input.layer]}/${input.slug}`;
  const dir = dirOf(opts, id);
  if (existsSync(path.join(dir, "meta.json"))) throw new Error(`既に存在する知識: ${id}`);

  const polarity = input.polarity ?? defaultPolarity(input.layer, input.source.type);
  const matchApprox = input.matchApprox ?? false;
  const conditionNote = input.conditionNote ?? null;
  const meta: KnowledgeMeta = {
    id,
    layer: input.layer,
    status,
    summary: input.summary,
    rev: computeRev(input.body, input.match, { polarity, matchApprox, conditionNote }),
    polarity,
    matchApprox,
    conditionNote,
    source_event: { type: input.source.type, ref: input.source.ref, at: now },
    relates_to: input.relates_to ?? null,
    valid_from: now,
    review_by: input.review_by ?? null,
    hits: 0,
    misses: 0,
    last_hit_at: null,
    last_used_at: null,
    status_since: now,
    retired_reason: null,
    empathy: input.empathy ?? 0,
    official_seen: [],
    match: input.match,
    history: [{ at: now, from: "", to: status, event: "CREATE", actor: "system", basis: null }],
  };
  // 一時ディレクトリに書いてから rename する。途中で止まっても中途半端な知識を残さない（round-11 C-53）
  const tmp = `${dir}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  writeFileSync(path.join(tmp, "SKILL.md"), `${input.body.replace(/\s+$/, "")}\n`);
  writeFileSync(path.join(tmp, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  // meta.json のないディレクトリは、以前に止まった作成の残骸なので置き換える
  rmSync(dir, { recursive: true, force: true });
  renameSync(tmp, dir);
  syncSkills(opts);
  return meta;
}

export function readKnowledge(opts: StoreOptions, id: string): KnowledgeMeta | undefined {
  const file = path.join(dirOf(opts, id), "meta.json");
  if (!existsSync(file)) return undefined;
  const meta = JSON.parse(readFileSync(file, "utf8")) as KnowledgeMeta;
  // official_seen を足す前に書かれた meta.json は、空として読む（design.md §10 段 4）
  return { ...meta, official_seen: meta.official_seen ?? [] };
}

/** 全知識の meta（id 昇順） */
export function listKnowledge(opts: StoreOptions): KnowledgeMeta[] {
  const out: KnowledgeMeta[] = [];
  if (!existsSync(opts.knowledgeDir)) return out;
  for (const layerSlug of readdirSync(opts.knowledgeDir).sort()) {
    if (!LAYERS.some((l) => LAYER_SLUG[l] === layerSlug)) continue;
    for (const slug of readdirSync(path.join(opts.knowledgeDir, layerSlug)).sort()) {
      if (slug.includes(".tmp-")) continue; // 作成途中の一時ディレクトリは知識ではない（round-15 X-59）
      const meta = readKnowledge(opts, `${layerSlug}/${slug}`);
      if (meta) out.push(meta);
    }
  }
  return out;
}

/** イベントを適用して書き込む。状態が変わったら（または新規作成があれば）直後に同期する */
export function applyEvent(
  opts: StoreOptions,
  id: string,
  event: LifecycleEvent,
  now: string,
  /** 状態が変わるときに history に残す根拠（§4-4、v15） */
  basis: Basis | null = null,
): TransitionResult {
  const meta = readKnowledge(opts, id);
  if (!meta) throw new Error(`知識が見つからない: ${id}`);
  const result = transition(meta, event, now, basis);
  // 付随する作成を先に行う（失敗したら状態を書かない。作成は同じ元からは 1 回だけ。round-11 X-44）
  for (const effect of result.effects) runEffect(opts, effect, now);
  writeAtomic(path.join(dirOf(opts, id), "meta.json"), `${JSON.stringify(result.meta, null, 2)}\n`);
  if (result.meta.status !== meta.status) syncSkills(opts);
  return result;
}

/** 状態を変えない meta の書き込み（hits・misses・last_hit_at の数え直し用）。status は変えられない */
export function writeCounts(
  opts: StoreOptions,
  id: string,
  counts: Pick<KnowledgeMeta, "hits" | "misses" | "last_hit_at">,
): KnowledgeMeta {
  const meta = readKnowledge(opts, id);
  if (!meta) throw new Error(`知識が見つからない: ${id}`);
  if (meta.hits === counts.hits && meta.misses === counts.misses && meta.last_hit_at === counts.last_hit_at) return meta;
  const next = { ...meta, ...counts };
  writeAtomic(path.join(dirOf(opts, id), "meta.json"), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/** 改定の棚卸の記録を書く（状態・history は変えない。design.md §14-4） */
export function writeRevisionChecks(opts: StoreOptions, id: string, checks: NonNullable<KnowledgeMeta["revision_checks"]>): KnowledgeMeta {
  const meta = readKnowledge(opts, id);
  if (!meta) throw new Error(`知識が見つからない: ${id}`);
  const next = { ...meta, revision_checks: checks };
  writeAtomic(path.join(dirOf(opts, id), "meta.json"), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/** SKILL.md の本文 */
export function readBody(opts: StoreOptions, id: string): string {
  return readFileSync(path.join(dirOf(opts, id), "SKILL.md"), "utf8").replace(/\s+$/, "");
}

/**
 * 未検証の候補の本文に書き足す（round-9 C-44）。rev は内容が変わるので計算し直す。
 * over は、背反の組の知識（match.codePair）の修正版の向きと条件の文を、会議の回答の値に置き換えるとき（design.md §14-1。X-118）。
 * dropLinePrefix があれば、今の本文からその文字で始まる行を外してから書き足す（前の回答の「修正版の扱い」の行を置き換える。round-46 C-212）
 */
export function appendBody(opts: StoreOptions, id: string, text: string, over?: { polarity: Polarity; conditionNote: string; summary?: string; dropLinePrefix?: string }): KnowledgeMeta {
  const meta = readKnowledge(opts, id);
  if (!meta) throw new Error(`知識が見つからない: ${id}`);
  if (meta.status !== "未検証") throw new Error(`未検証でない知識には書き足さない: ${id}`);
  const { dropLinePrefix, ...metaOver } = over ?? {};
  const current = dropLinePrefix ? readBody(opts, id).split("\n").filter((l) => !l.startsWith(dropLinePrefix)).join("\n").replace(/\n{3,}/g, "\n\n") : readBody(opts, id);
  const body = `${current}\n\n${text.replace(/\s+$/, "")}`;
  const merged = { ...meta, ...metaOver };
  const next = { ...merged, rev: computeRev(body, merged.match, merged) };
  writeAtomic(path.join(dirOf(opts, id), "SKILL.md"), `${body}\n`);
  writeAtomic(path.join(dirOf(opts, id), "meta.json"), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/** 派生した知識の slug が Skill 名の上限（64 文字）を超えるときは、元の id のハッシュで短くする */
export function fitSlug(layer: Layer, slug: string, seed: string): string {
  if (`iji-${LAYER_SLUG[layer]}-${slug}`.length <= 64) return slug;
  return `d-${createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
}

/** 派生した知識の summary を 1024 文字以内に収める（元の summary を切り詰める。round-11 X-43） */
export function fitSummary(prefix: string, base: string, suffix: string): string {
  const room = 1024 - prefix.length - suffix.length;
  return `${prefix}${base.length > room ? `${base.slice(0, room - 1)}…` : base}${suffix}`;
}

/** 再審査で復活したとき、「この項目は再審査で認められた」を地域層の承認済み知識として作る */
function runEffect(opts: StoreOptions, effect: Effect, now: string): void {
  if (effect.type !== "CREATE_REEXAM_ALLOWED") return;
  const src = readKnowledge(opts, effect.sourceId);
  if (!src) throw new Error(`再審査の元知識が見つからない: ${effect.sourceId}`);
  if (listKnowledge(opts).some((m) => m.relates_to === src.id && m.source_event.type === "再審査")) return;
  const body = `${readFileSync(path.join(dirOf(opts, src.id), "SKILL.md"), "utf8").replace(/\s+$/, "")}`;
  const srcSlug = src.id.split("/")[1];
  createKnowledge(
    opts,
    {
      layer: "地域",
      slug: fitSlug("地域", `${srcSlug}-reexam-allowed`, src.id),
      summary: fitSummary("再審査で認められた: ", src.summary, ""),
      body: `この項目は再審査で認められた。\n\n元の知識:\n\n${body}`,
      source: { type: "再審査", ref: src.id },
      polarity: "allow",
      // 近似にしない（元の知識から引き継がない）。この知識の条件は「この区分を、この審査支払機関・都道府県が再審査で認めた」そのもの（design.md §3）
      matchApprox: false,
      conditionNote: null,
      relates_to: src.id,
      match: src.match,
    },
    now,
  );
}
