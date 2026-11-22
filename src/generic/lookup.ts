// 基本マスターを引いて、画面とエンジンに渡すものを作る（design.md §12-4・§12-5）：行・コメント・傷病名の名称と、対象外の単位のコードの区分番号。
// 引くのは、診療年月に使う 1 枚（pickSnapshot）。世代の 1 枚がないマスターの分は、空のまま返す（近い世代で代用しない）
import type { Revision } from "../engine/revisions/types";
import type { Outside } from "../engine/types";
import { checkReady, hasShisetsu, hasShisetsuGroups, nameOf, pickSnapshot, shinryoOf, sourcesOf, type MastersDb, type NamedMaster, type ShinryoRow } from "../masters/db";
import type { GenericAbout } from "./types";

const snapshotOf = (db: MastersDb, table: NamedMaster, about: GenericAbout): string | null => pickSnapshot(db, table, about.yearMonth, about.generation)?.snapshot ?? null;

/** 区分番号の表示（例 "C001"、"C002-2"）。区分番号のない行為（アルファベット部が * や -）は null */
const noLabel = (r: ShinryoRow): string | null => (/^[A-Z]$/.test(r.alpha) ? `${r.alpha}${String(r.kubun_no).padStart(3, "0")}${r.eda > 0 ? `-${r.eda}` : ""}` : null);

/**
 * 名称。items は診療行為・医薬品・特定器材のコード → 名称（診療行為は区分番号も）、comments はコメントコード → 定型文、diseases は傷病名コード → 傷病名。
 * マスターにないコードは載らない（画面はコードだけを出す）。todokede＝施設基準のある診療行為（指摘にはせず、名称に「届出が要ります」と添える。design.md §12-3 の G03。
 * 施設基準の列の読み方を確かめた masters.db〔G03 の準備ができている〕のときだけ付ける。施設基準のある行は、組ごとの 3 列のどれかが 0 でない行。design.md §15-3）
 */
export type RowNames = { items: Record<string, { name: string; no: string | null; todokede?: true }>; comments: Record<string, string>; diseases: Record<string, string> };

export function rowNamesOf(db: MastersDb, about: GenericAbout, codes: { items: { kind: "SI" | "IY" | "TO"; code: string }[]; comments: string[]; diseases: string[] }): RowNames {
  const out: RowNames = { items: {}, comments: {}, diseases: {} };
  const snap = { SI: snapshotOf(db, "shinryo", about), IY: snapshotOf(db, "iyakuhin", about), TO: snapshotOf(db, "tokutei", about), comment: snapshotOf(db, "comment", about), shobyo: snapshotOf(db, "shobyo", about) };
  // 組ごとの列のない古い masters.db では印を付けず、G03 の点検の範囲と設定の画面に理由を出す（design.md §15-3。code M-8）
  const todokede = checkReady(db, "G03")?.ready === true && hasShisetsuGroups(db);
  for (const { kind, code } of codes.items) {
    const s = snap[kind];
    if (s === null) continue;
    if (kind === "SI") {
      const r = shinryoOf(db, s, code);
      if (r) out.items[code] = { name: r.name, no: noLabel(r), ...(todokede && hasShisetsu(r) ? { todokede: true as const } : {}) };
    } else {
      const name = nameOf(db, kind === "IY" ? "iyakuhin" : "tokutei", s, code);
      if (name !== null) out.items[code] = { name, no: null };
    }
  }
  const put = (to: Record<string, string>, table: "comment" | "shobyo", list: string[]) => {
    const s = snap[table];
    if (s === null) return;
    for (const code of list) {
      const name = nameOf(db, table, s, code);
      if (name !== null) to[code] = name;
    }
  };
  put(out.comments, "comment", codes.comments);
  put(out.diseases, "shobyo", codes.diseases);
  return out;
}

const MASTER_TITLE: Record<NamedMaster, string> = { shinryo: "医科診療行為", iyakuhin: "医薬品", tokutei: "特定器材", comment: "コメント", shobyo: "傷病名" };

/**
 * 使う 1 枚についての断り書き（design.md §12-1。点検の範囲の説明に出す）。マスターの名前を並べる。
 * later＝診療年月より前の 1 枚がなく、後の 1 枚で代えている／newer＝読み方を確かめた版（EM §2-11）より新しい 1 枚
 */
export function sheetNotesOf(db: MastersDb, about: GenericAbout): { later: string[]; newer: string[] } {
  const out = { later: [] as string[], newer: [] as string[] };
  for (const table of Object.keys(MASTER_TITLE) as NamedMaster[]) {
    const pick = pickSnapshot(db, table, about.yearMonth, about.generation);
    if (pick === null) continue;
    if (pick.later) out.later.push(MASTER_TITLE[table]);
    if (sourcesOf(db).some((s) => s.dataset === table && s.snapshot === pick.snapshot && s.verified !== null && s.snapshot > s.verified)) out.newer.push(MASTER_TITLE[table]);
  }
  return out;
}

/** 区分番号の鍵（コード表用番号の章・部・区分番号。枝番・項番は入れない：訪問診療料(Ⅱ) のような別の項や、同じ区分の注加算も同じ鍵になる。design.md §12-4） */
const noKey = (r: ShinryoRow): string => `${r.sho}/${r.bu}/${r.kubun_no}`;

/**
 * 対象外の単位のコードを基本マスターで引いて、エンジンに渡す形にする（ClaimContext.outside）。
 * 医科診療行為マスターの、診療年月に使う 1 枚がなければ undefined（エンジンは、対象外の単位があればどのルールも止める。v23 のまま）。
 * 対象外の単位のコードは、行の種類を持っていない（UkeOther）ので、3 つのマスターを順に引く：医科診療行為にあれば区分番号つき、医薬品・特定器材にあれば区分番号なし、どれにもなければ「マスターにない」
 */
export function outsideOf(db: MastersDb, rev: Revision, yearMonth: string, codes: string[]): Outside | undefined {
  const about = { yearMonth, generation: rev.generation };
  const si = snapshotOf(db, "shinryo", about);
  if (si === null) return undefined;
  const iy = snapshotOf(db, "iyakuhin", about);
  const to = snapshotOf(db, "tokutei", about);
  const noOf: Record<string, string[]> = {};
  for (const kubun of Object.keys(rev.points)) {
    const own = Object.hasOwn(rev.codes, kubun) ? [rev.codes[kubun].primary] : rev.bundles.filter((b) => b.tiers.some((t) => t.kubun === kubun)).flatMap((b) => b.members);
    const nos = [...new Set(own.flatMap((code) => {
      const r = shinryoOf(db, si, code);
      return r ? [noKey(r)] : [];
    }))];
    if (nos.length > 0) noOf[kubun] = nos;
  }
  return {
    codes: [...new Set(codes)].map((code) => {
      const r = shinryoOf(db, si, code);
      if (r) return { code, known: true, no: noKey(r) };
      const known = (iy !== null && nameOf(db, "iyakuhin", iy, code) !== null) || (to !== null && nameOf(db, "tokutei", to, code) !== null);
      return { code, known, no: null };
    }),
    noOf,
  };
}
