// 週次の整理のテスト用ハーネス（一時ディレクトリ＋インメモリ SQLite）
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CREATE_SQL } from "../../src/db/schema";
import { importResult, type Outcome, type ResultKind } from "../../src/lifecycle/applications";
import type { Calendar } from "../../src/lifecycle/calendar";
import { meetingReview, submit, type ReviewDeps, type ReviewHooks } from "../../src/lifecycle/review";
import { applyEvent, computeRev, createKnowledge, readBody, readKnowledge, type CreateInput } from "../../src/lifecycle/store";
import type { KnowledgeMeta, Polarity } from "../../src/lifecycle/types";
import { makeCtx } from "./helpers";

/** config/calendar.json と同じ（改定は偶数年 6/1、支払基金の改選は奇数年 6/1、東京都の国保連は未設定） */
export const CAL: Calendar = {
  revision: { parity: "even", monthDay: "06-01" },
  shiharaiKikin: { parity: "odd", monthDay: "06-01" },
  kokuhoren: { 東京都: null },
};

export const T0 = "2025-03-01T00:00:00+09:00";

export function harness() {
  const root = mkdtempSync(path.join(tmpdir(), "iji-review-"));
  const store = { knowledgeDir: path.join(root, "knowledge"), skillsDir: path.join(root, "skills") };
  const sqlite = new Database(":memory:");
  sqlite.exec(CREATE_SQL);
  const deps: ReviewDeps = {
    db: drizzle(sqlite),
    store,
    calendar: CAL,
    ruleKubun: (id) => (id === "R01" ? ["C002"] : []),
  };
  let seq = 0;

  const h = {
    deps,
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    get: (id: string): KnowledgeMeta => {
      const m = readKnowledge(store, id);
      if (!m) throw new Error(`なし: ${id}`);
      return m;
    },
    /** 地域層の承認済み知識（既定は国保連・東京都なので改選で落ちない） */
    regional: (slug: string, over: Partial<CreateInput> & { polarity?: Polarity } = {}, at = T0): string => {
      const m = createKnowledge(
        store,
        {
          layer: "地域",
          slug,
          summary: `${slug} の知識`,
          body: `${slug} の本文`,
          source: { type: "返戻", ref: `src-${slug}` },
          polarity: "allow",
          match: { kubunAll: ["C001"], payer: "国保連", prefecture: "東京都" },
          ...over,
        },
        at,
      );
      if (m.status === "未検証") applyEvent(store, m.id, { type: "VERIFY_APPROVE" }, at);
      return m.id;
    },
    /** 制度層（R01、関係ありの区分は C002） */
    system: (slug = "r01", at = T0): string =>
      createKnowledge(store, { layer: "制度", slug, summary: "R01", body: "R01 本文", source: { type: "初期投入", ref: "init" }, match: { ruleId: "R01" } }, at).id,
    /** 提出確定。kubun は確定版の算定区分 */
    submit: (
      submissionId: string,
      at: string,
      o: { claimId?: string; kubun?: string[]; applied?: string[]; earlier?: string[][]; yearMonth?: string; payer?: "支払基金" | "国保連" } = {},
    ) => {
      const claimId = o.claimId ?? `claim-${submissionId}`;
      // 知識の既定（国保連・東京都）に合わせる
      const payer = o.payer ?? "国保連";
      const ctx = makeCtx({ claimId, payer, kubun: o.kubun ?? ["C001"], ...(o.yearMonth ? { yearMonth: o.yearMonth } : {}) });
      submit(deps, {
        submissionId,
        final: { ctx, applied: o.applied ?? [] },
        earlier: (o.earlier ?? []).map((k) => ({ ctx: makeCtx({ claimId, payer, kubun: k }), applied: o.applied ?? [] })),
        now: at,
      });
    },
    result: (submissionId: string, outcome: Outcome, kubun: string[], at: string, kind: ResultKind = "原審査", resultId?: string) =>
      importResult(deps.db, { resultId: resultId ?? `r${++seq}`, submissionId, kind, outcome, kubun }, at),
    review: (at: string, hooks?: ReviewHooks) => meetingReview(deps, at, hooks),
    /** meta.json を直接書き換える（polarity の変更など、API のない操作の再現） */
    rewrite: (id: string, f: (m: KnowledgeMeta) => void) => {
      const file = path.join(store.knowledgeDir, ...id.split("/"), "meta.json");
      const m = JSON.parse(readFileSync(file, "utf8")) as KnowledgeMeta;
      f(m);
      m.rev = computeRev(readBody(store, id), m.match, m);
      writeFileSync(file, `${JSON.stringify(m, null, 2)}\n`);
    },
  };
  return h;
}
