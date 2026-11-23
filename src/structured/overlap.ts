// 重なりの見分け（design.md §16-3。FR-206）：AI の取り出し（本人が確かめて当てたもの）と構造化データを、日＋コードで突き合わせる。決まった規則だけで、LLM は使わない。
// 両方にある → 構造化データを正にして文章の側をたたむ（回数・量は構造化データ）／文章にだけある → その種類を受け取っている月だけ「文章にあるがオーダーにない」と添える／
// 構造化データにだけある → 構造化データから候補にする／当てられない文章の行為 → 同じ日の同じ種類の構造化データの行為を横に並べ、本人が「同じ／違う／選ばない」を選ぶ（推し量らない）
import type { ActChild, ActFold, ChartAct } from "../chart/acts";
import type { Coded, StructuredChart, StructuredPart } from "../connect/types";
import { kubunOfCode } from "../engine/revisions/codes";
import type { Revision } from "../engine/revisions/types";
import { mapCoded, type Field, type MapContext, type Mapped, type OutReason } from "./code-map";

/** 文章にだけある行為の添え書き（16-3） */
export const ORDER_MISSING = "文章にあるがオーダーにない（口頭の指示・オーダーの入れ忘れの恐れ）";

/** 構造化データの行為 1 つ（突き合わせの単位）。kind：drug＝処方のオーダーの薬／proc＝注射・処置の行為／procDrug・material＝実施で使った薬・材料／visit＝訪問 */
export type SItem = {
  part: Exclude<StructuredPart, "homeCare">;
  kind: "drug" | "proc" | "procDrug" | "material" | "visit";
  /** 接続先の行の id（薬・材料は「行の id/位置」） */
  ref: string;
  date: string;
  /** 当てたコード（当てられなければ null） */
  code: string | null;
  tbl: "shinryo" | "iyakuhin" | "tokutei" | null;
  /** 表示名（接続先の表示名。なければ当てたマスターの名称） */
  name: string;
  quantity?: string;
  visitKind?: "訪問診療" | "往診" | null;
  out?: OutReason;
};

const DRUG_FIELD: Field = "薬";
const label = (c: Coded, m: Mapped) => c.name ?? (m.ok ? m.name : (c.code?.value ?? ""));
const tblOf = (m: Mapped): SItem["tbl"] => (m.ok && (m.table === "iyakuhin" || m.table === "tokutei") ? m.table : m.ok ? "shinryo" : null);

/** 構造化データの、突き合わせる 3 種類（訪問・処方のオーダー・注射と処置の実施）を、当てたコードつきの行為の並びにする（在宅療養の指示は 16-5 の機器で見る） */
export function itemsOf(s: StructuredChart, ctx: MapContext): SItem[] {
  const out: SItem[] = [];
  const one = (base: Omit<SItem, "code" | "tbl" | "name" | "out">, field: Field, c: Coded): SItem => {
    const m = mapCoded(field, c, ctx);
    return { ...base, code: m.ok ? m.code : null, tbl: tblOf(m), name: label(c, m), ...("reason" in m ? { out: m.reason } : {}) };
  };
  if (s.visits.status === "supported") for (const v of s.visits.items) out.push({ part: "visits", kind: "visit", ref: v.ref, date: v.date, code: null, tbl: null, name: v.kind ?? "訪問", visitKind: v.kind });
  if (s.orders.status === "supported")
    for (const o of s.orders.items) o.drugs.forEach((d, i) => out.push(one({ part: "orders", kind: "drug", ref: `${o.ref}/${i}`, date: o.date, ...(d.quantity ? { quantity: d.quantity } : {}) }, DRUG_FIELD, d)));
  if (s.procedures.status === "supported")
    for (const p of s.procedures.items) {
      out.push(one({ part: "procedures", kind: "proc", ref: p.ref, date: p.date, ...(p.count !== null ? { quantity: `${p.count}回` } : {}) }, "行為", p.act));
      p.items.forEach((x, i) =>
        out.push(one({ part: "procedures", kind: x.kind === "器材" ? "material" : "procDrug", ref: `${p.ref}/${i}`, date: p.date, ...(x.quantity !== null ? { quantity: `${x.quantity}${x.unit ?? ""}` } : {}) }, x.kind === "器材" ? "材料" : "薬", x)),
      );
    }
  return out;
}

/** 文章の行為が突き合わせる種類（16-3）。検査・そのほかの診療行為は突き合わせない（null） */
export function partOfAct(act: Pick<ChartAct, "category" | "match">, visitCodes: { visit: Set<string>; oushin: Set<string> }): { part: SItem["part"]; kinds: SItem["kind"][]; visitKind?: "訪問診療" | "往診" } | null {
  switch (act.category) {
    case "投薬":
      // 投薬の手技（第5部の行）は 16-4 の規則で見る（ここでは突き合わせない）
      return act.match && act.match.tbl !== "iyakuhin" ? null : { part: "orders", kinds: ["drug"] };
    case "注射":
    case "処置":
      return { part: "procedures", kinds: ["proc"] };
    case "器材":
      return { part: "procedures", kinds: ["material"] };
    case "診療行為": {
      const code = act.match?.code;
      if (code && visitCodes.visit.has(code)) return { part: "visits", kinds: ["visit"], visitKind: "訪問診療" };
      if (code && visitCodes.oushin.has(code)) return { part: "visits", kinds: ["visit"], visitKind: "往診" };
      return null;
    }
    default:
      return null;
  }
}

/** 版で同じ区分とみなすコード（§15-8 の「ある・ないの決め方」と同じ。区分に当たらないコードはそのコードだけ） */
export function sameCodesOf(rev: Revision): (code: string) => string[] {
  return (code) => {
    const k = kubunOfCode(rev, code);
    return k && Object.hasOwn(rev.codes, k) ? [rev.codes[k].primary, ...rev.codes[k].accept] : [code];
  };
}
/** 版の訪問診療料・往診料のコード（primary と accept） */
export function visitCodesOf(rev: Revision): { visit: Set<string>; oushin: Set<string> } {
  const codes = (ks: string[]) => new Set(ks.flatMap((k) => (Object.hasOwn(rev.codes, k) ? [rev.codes[k].primary, ...rev.codes[k].accept] : [])));
  return { visit: codes(rev.consts.visitKubun), oushin: codes([rev.consts.oushin.kubun]) };
}

/** 文章の行為 1 つの見分けの結果 */
export type ActOverlap =
  /** 両方にある（構造化データの行にたたむ）。quantity は構造化データの数（訪問は訪問の記録の数） */
  | { status: "folded"; refs: string[]; by: "rule" | "person"; quantity?: string }
  /** 文章にだけある。note は種類を受け取っている月だけ（ORDER_MISSING） */
  | { status: "textOnly"; note: string | null }
  /** 当てられない文章の行為。pairs は同じ日の同じ種類の構造化データの行為（「同じ／違う／選ばない」） */
  | { status: "unmatched"; pairs: SItem[] }
  /** 突き合わせない種類（検査・そのほかの診療行為・投薬の手技） */
  | { status: "notCompared" };

export type TextAct = { date: string; key: string; act: ChartAct };
export type OverlapResult = {
  acts: Map<string, ActOverlap>;
  /** 子（with）の見分け。鍵は「親の鍵/子の位置」 */
  children: Map<string, ActOverlap>;
  /** 構造化データにだけある行為（当てられたもの） */
  structuredOnly: SItem[];
  /** 構造化データの行為のうち、コードが判定の外になったもの（理由ごとの数） */
  out: Record<string, number>;
};

/**
 * 文章の行為と構造化データを突き合わせる（16-3）。acts は確かめた文章の行為（key は呼ぶ側の鍵）、parts は構造化データの種類ごとの申告。
 * fold は保存した印（本人が「同じ」を選んだもの・「違う」を選んだもの）
 */
export function overlap(acts: TextAct[], items: SItem[], parts: StructuredChart, rev: Revision): OverlapResult {
  const same = sameCodesOf(rev);
  const visitCodes = visitCodesOf(rev);
  const used = new Set<string>();
  const result: OverlapResult = { acts: new Map(), children: new Map(), structuredOnly: [], out: {} };
  const supported = (p: SItem["part"]) => parts[p].status === "supported";
  const sameDay = (date: string, kinds: SItem["kind"][], p: SItem["part"]) => items.filter((x) => x.date === date && x.part === p && kinds.includes(x.kind));
  const codeMatch = (x: SItem, code: string, tbl: string) => x.code !== null && (tbl === "shinryo" ? same(code).includes(x.code) : x.tbl === tbl && x.code === code);

  for (const t of acts) {
    const where = partOfAct(t.act, visitCodes);
    if (!where) {
      result.acts.set(t.key, { status: "notCompared" });
      continue;
    }
    const pool = sameDay(t.date, where.kinds, where.part);
    const fold: ActFold | undefined = t.act.fold;
    if (!t.act.match) {
      // 当てられない：本人が「同じ」を選んだ相手がその日にあれば、そこへたたむ。「違う」「選ばない」は当てられないまま
      const picked = fold?.by === "person" && fold.same !== false && fold.ref ? pool.find((x) => x.ref === fold.ref) : undefined;
      if (picked) {
        used.add(picked.ref);
        result.acts.set(t.key, { status: "folded", refs: [picked.ref], by: "person", ...(picked.quantity ? { quantity: picked.quantity } : {}) });
      } else result.acts.set(t.key, { status: "unmatched", pairs: pool.filter((x) => x.kind !== "visit" || x.visitKind !== null) });
      continue;
    }
    const m = t.act.match;
    if (where.part === "visits") {
      const visits = pool.filter((x) => x.visitKind === where.visitKind);
      if (visits.length > 0) {
        for (const v of visits) used.add(v.ref);
        result.acts.set(t.key, { status: "folded", refs: visits.map((v) => v.ref), by: "rule", quantity: `${visits.length}回` });
      } else result.acts.set(t.key, { status: "textOnly", note: supported("visits") ? ORDER_MISSING : null });
      continue;
    }
    const hit = pool.find((x) => !used.has(x.ref) && codeMatch(x, m.code, m.tbl));
    if (hit) {
      used.add(hit.ref);
      result.acts.set(t.key, { status: "folded", refs: [hit.ref], by: "rule", ...(hit.quantity ? { quantity: hit.quantity } : {}) });
    } else result.acts.set(t.key, { status: "textOnly", note: supported(where.part) ? ORDER_MISSING : null });

    // 子（with の薬・材料）：同じ日の実施で使った薬・材料と同じコード
    (t.act.with ?? []).forEach((c: ActChild, j) => {
      const key = `${t.key}/${j}`;
      if (!c.match) {
        result.children.set(key, { status: "unmatched", pairs: sameDay(t.date, [c.kind === "器材" ? "material" : "procDrug"], "procedures") });
        return;
      }
      const ch = items.find((x) => x.date === t.date && x.part === "procedures" && !used.has(x.ref) && (x.kind === "procDrug" || x.kind === "material") && codeMatch(x, c.match!.code, c.match!.tbl));
      if (ch) {
        used.add(ch.ref);
        result.children.set(key, { status: "folded", refs: [ch.ref], by: "rule", ...(ch.quantity ? { quantity: ch.quantity } : {}) });
      } else result.children.set(key, { status: "textOnly", note: supported("procedures") ? ORDER_MISSING : null });
    });
  }
  for (const x of items) {
    if (used.has(x.ref) || x.kind === "visit") continue;
    if (x.code === null) result.out[x.out ?? "判定の外"] = (result.out[x.out ?? "判定の外"] ?? 0) + 1;
    else result.structuredOnly.push(x);
  }
  return result;
}

/** 確かめる画面の構造化データの欄（design.md §16-7） */
export type StructuredReview = {
  source: "電子カルテ";
  parts: Record<"visits" | "orders" | "procedures" | "homeCare", "supported" | "unsupported">;
  day: { ref: string; kind: SItem["kind"]; name: string; quantity?: string; visitKind?: "訪問診療" | "往診" | null; mapped: boolean }[];
  acts: ({ status: "folded"; refs: string[] } | { status: "textOnly"; note: string | null } | { status: "unmatched"; pairs: StructuredReview["day"] } | { status: "notCompared" })[];
};
