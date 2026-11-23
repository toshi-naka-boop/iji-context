// 電子カルテのコードの当て方（design.md §16-2。FR-206）。決まった規則だけで行い、LLM は使わない。
// (1) rece：診療年月の 1 枚に実在すればそのコード (2) yj：医薬品マスターの薬価基準収載医薬品コードの列でちょうど 1 行 (3) local：本人が一度選んだ対応表 (4) コードなし：名称の完全一致が 1 つ。
// どの規則でも、当てたコードは入力欄の種類の「当ててよい表」にあるときだけ使う（round-65 X-243）。決まらない行は判定の外にし、理由ごとに数える
import type { CodeRef, Coded } from "../connect/types";
import { hasRevision, resolveRevision } from "../engine/revisions";
import { pickSnapshot, type MastersDb } from "../masters/db";
import { normName } from "../notice/notice";
import { DEVICE_KINDS, DEVICE_KEYS, deviceOfRece, isDeviceKey } from "./devices";

/** 入力欄の種類（16-2） */
export const FIELDS = ["薬", "材料", "行為", "指導管理", "機器"] as const;
export type Field = (typeof FIELDS)[number];

/** 当ててよい表。shinryo_c100 は医科診療行為のうち区分番号 C100〜C121 の行、device はマスターでなく機器の種類（DEVICE_KINDS） */
export type MapTable = "iyakuhin" | "tokutei" | "shinryo" | "shinryo_c100" | "device";
export const FIELD_TABLES: Record<Field, MapTable> = { 薬: "iyakuhin", 材料: "tokutei", 行為: "shinryo", 指導管理: "shinryo_c100", 機器: "device" };
/** 指導管理の区分番号の範囲（第2部 第2節 第1款 在宅療養指導管理料） */
export const KANRI_KUBUN = { from: 100, to: 121 } as const;

/** 判定の外にした理由（点検の範囲に件数で出す） */
export const OUT_REASONS = {
  noMap: "対応表にないコード",
  yjAmbiguous: "YJ で 1 つに決まらない",
  yjUnreadable: "YJ を医薬品マスターから読めない",
  wrongTable: "対応先の表が違うコード",
  notInMaster: "診療年月のマスターにないコード",
  nameAmbiguous: "名称で 1 つに決まらない",
  blank: "コードも表示名もない",
  noMaster: "マスターがない",
} as const;
export type OutReason = (typeof OUT_REASONS)[keyof typeof OUT_REASONS];

export type Mapped = { ok: true; table: MapTable; code: string; name: string; by: "rece" | "yj" | "local" | "name" } | { ok: false; reason: OutReason };
/** 対応表の 1 行（ext_code_maps）。tbl は当ててよい表、code はコード（機器は区分キー） */
export type CodeMapRow = { connectorId: string; field: Field; system: CodeRef["system"]; extCode: string; tbl: MapTable; code: string };
export type MapContext = { db: MastersDb | null; yearMonth: string; connectorId: string; localMap: (field: Field, system: CodeRef["system"], value: string) => { tbl: MapTable; code: string } | null };

type Row = { code: string; name: string };

/** その診療年月の 1 枚の、表の行を引く道具（1 回の当て方の中で使い回す） */
function tablesOf(db: MastersDb | null, yearMonth: string) {
  if (!db || !hasRevision(yearMonth)) return null;
  const generation = resolveRevision(yearMonth).generation;
  const snap = (t: string) => pickSnapshot(db, t, yearMonth, generation)?.snapshot ?? null;
  const memo = new Map<string, Row[] | null>();
  const rows = (t: Exclude<MapTable, "device">): Row[] | null => {
    if (memo.has(t)) return memo.get(t)!;
    const base = t === "shinryo_c100" ? "shinryo" : t;
    const s = snap(base);
    const out = s
      ? t === "shinryo_c100"
        ? (db.prepare("SELECT code, name FROM shinryo WHERE snapshot = ? AND alpha = 'C' AND kubun_no BETWEEN ? AND ?").all(s, KANRI_KUBUN.from, KANRI_KUBUN.to) as Row[])
        : (db.prepare(`SELECT code, name FROM ${base} WHERE snapshot = ?`).all(s) as Row[])
      : null;
    memo.set(t, out);
    return out;
  };
  const hasYj = (db.prepare("PRAGMA table_info(iyakuhin)").all() as { name: string }[]).some((c) => c.name === "yj");
  const yj = (value: string): Row[] | null => {
    const s = snap("iyakuhin");
    return hasYj && s ? (db.prepare("SELECT code, name FROM iyakuhin WHERE snapshot = ? AND yj = ?").all(s, value) as Row[]) : null;
  };
  return { rows, yj };
}

/** 機器の欄の名称（DEVICE_KINDS の名称）の完全一致 */
function deviceByName(name: string): Mapped {
  const n = normName(name);
  const hits = DEVICE_KEYS.filter((k) => (DEVICE_KINDS[k].names as readonly string[]).some((x) => normName(x) === n));
  return hits.length === 1 ? { ok: true, table: "device", code: hits[0], name: DEVICE_KINDS[hits[0]].names[0], by: "name" } : { ok: false, reason: OUT_REASONS.nameAmbiguous };
}

/**
 * 1 つのコードと表示名を、入力欄の種類の当ててよい表に当てる（16-2 の規則 1〜4）。
 * 機器の欄は、マスターの実在でなく DEVICE_KINDS への所属で見る（round-66 C-422＝X-252）
 */
export function mapCoded(field: Field, coded: Coded, ctx: MapContext): Mapped {
  const table = FIELD_TABLES[field];
  const { code, name } = coded;
  if (!code && !name) return { ok: false, reason: OUT_REASONS.blank };

  if (table === "device") {
    if (code?.system === "rece") {
      const d = deviceOfRece(code.value);
      return d ? { ok: true, table, code: d.kind, name: DEVICE_KINDS[d.kind].names[0], by: "rece" } : { ok: false, reason: OUT_REASONS.wrongTable };
    }
    if (code?.system === "yj") return { ok: false, reason: OUT_REASONS.wrongTable };
    if (code?.system === "local") {
      const m = ctx.localMap(field, "local", code.value);
      if (!m) return { ok: false, reason: OUT_REASONS.noMap };
      return m.tbl === "device" && isDeviceKey(m.code) ? { ok: true, table, code: m.code, name: DEVICE_KINDS[m.code].names[0], by: "local" } : { ok: false, reason: OUT_REASONS.wrongTable };
    }
    return deviceByName(name!);
  }

  const t = tablesOf(ctx.db, ctx.yearMonth);
  if (!t) return { ok: false, reason: OUT_REASONS.noMaster };
  const allowed = t.rows(table);
  if (!allowed) return { ok: false, reason: OUT_REASONS.noMaster };
  const inAllowed = (c: string) => allowed.find((r) => r.code === c) ?? null;
  /** 当てたいコードが当ててよい表にないとき：ほかの表にあれば「表が違う」、どこにもなければ「マスターにない」 */
  const missing = (c: string): Mapped => {
    const elsewhere = (["shinryo", "iyakuhin", "tokutei"] as const).some((x) => x !== table && (t.rows(x) ?? []).some((r) => r.code === c)) || (table === "shinryo_c100" && (t.rows("shinryo") ?? []).some((r) => r.code === c));
    return { ok: false, reason: elsewhere ? OUT_REASONS.wrongTable : OUT_REASONS.notInMaster };
  };

  if (code?.system === "rece") {
    const r = inAllowed(code.value);
    return r ? { ok: true, table, code: r.code, name: r.name, by: "rece" } : missing(code.value);
  }
  if (code?.system === "yj") {
    if (field !== "薬") return { ok: false, reason: OUT_REASONS.wrongTable };
    const hits = t.yj(code.value);
    if (!hits) return { ok: false, reason: OUT_REASONS.yjUnreadable };
    return hits.length === 1 ? { ok: true, table, code: hits[0].code, name: hits[0].name, by: "yj" } : { ok: false, reason: OUT_REASONS.yjAmbiguous };
  }
  if (code?.system === "local") {
    const m = ctx.localMap(field, "local", code.value);
    if (!m) return { ok: false, reason: OUT_REASONS.noMap };
    if (m.tbl !== table) return { ok: false, reason: OUT_REASONS.wrongTable };
    const r = inAllowed(m.code);
    return r ? { ok: true, table, code: r.code, name: r.name, by: "local" } : missing(m.code);
  }
  // コードなし：名称の完全一致が 1 つ（§15-7 の規則 1）
  const n = normName(name!);
  const hits = allowed.filter((r) => normName(r.name) === n);
  return hits.length === 1 ? { ok: true, table, code: hits[0].code, name: hits[0].name, by: "name" } : { ok: false, reason: OUT_REASONS.nameAmbiguous };
}

/**
 * 対応を残せるか（POST /api/code-maps。16-2・16-7）。機器は DEVICE_KINDS のキー（none は不可）、ほかは診療年月の 1 枚の、その欄の当ててよい表に実在するコード。
 * 残せるなら当ててよい表、残せないなら理由
 */
export function checkMapTarget(field: Field, code: string, db: MastersDb | null, yearMonth: string): { ok: true; tbl: MapTable } | { ok: false; reason: string } {
  const table = FIELD_TABLES[field];
  if (table === "device") return isDeviceKey(code) ? { ok: true, tbl: table } : { ok: false, reason: "機器の欄には、機器の種類の一覧のキーだけを残せます" };
  const t = tablesOf(db, yearMonth);
  const rows = t?.rows(table);
  if (!rows) return { ok: false, reason: OUT_REASONS.noMaster };
  return rows.some((r) => r.code === code) ? { ok: true, tbl: table } : { ok: false, reason: `この欄（${field}）の当ててよい表にないコードです` };
}
