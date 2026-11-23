// カルテの構造化データの読み出し（design.md §16-1。FR-205）。接続先が返した 4 種類を、種類ごとの能力の申告と欠けの数の形にそろえる。
// 欠けの数は手元の決まった規則で数える（null の欄を欄の名前ごとに数える。接続先の申告した数は使わない）。LLM は使わない。AI には送らない
import { STRUCTURED_PARTS, type Coded, type ConnectorChart, type HomeCareOrder, type Part, type ProcRecord, type RxOrder, type StructuredChart, type StructuredPart, type Visit } from "../connect/types";

/** 形の違う行（ref・日付のない行など）の欠けの名前。行は捨て、数だけを残す */
export const BAD_ROW = "形が違う行";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** 時刻は "HH:MM"（時 00〜23・分 00〜59）。存在しない時刻（10:99・24:00）や形の違いは欠け（手入力の API と同じ検査。X-283） */
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const listOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** コードと表示名。コードの体系が 3 つのどれでもない・値が空なら、コードは null */
function codedOf(v: unknown): Coded {
  const o = isObj(v) ? v : {};
  const c = isObj(o.code) ? o.code : null;
  const system = c && (c.system === "rece" || c.system === "yj" || c.system === "local") ? c.system : null;
  const value = c ? strOrNull(c.value) : null;
  return { code: system && value ? { system, value } : null, name: strOrNull(o.name) };
}
const blank = (c: Coded) => c.code === null && c.name === null;

/** 欄ごとの欠けを数える入れ物 */
function tally() {
  const gaps: Record<string, number> = {};
  const add = (key: string, missing: boolean) => {
    if (missing) gaps[key] = (gaps[key] ?? 0) + 1;
  };
  return { gaps, add };
}

function visitsOf(raw: unknown[]): { items: Visit[]; gaps: Record<string, number> } {
  const { gaps, add } = tally();
  const items: Visit[] = [];
  for (const r of raw) {
    const o = isObj(r) ? r : null;
    const ref = o ? strOrNull(o.ref) : null;
    const date = o ? strOrNull(o.date) : null;
    if (!o || !ref || !date || !DATE.test(date)) {
      add(BAD_ROW, true);
      continue;
    }
    const time = (v: unknown) => (typeof v === "string" && TIME.test(v) ? v : null);
    const v: Visit = { ref, date, start: time(o.start), end: time(o.end), kind: o.kind === "訪問診療" || o.kind === "往診" ? o.kind : null };
    add("start", v.start === null);
    add("end", v.end === null);
    add("kind", v.kind === null);
    items.push(v);
  }
  return { items, gaps };
}

function ordersOf(raw: unknown[]): { items: RxOrder[]; gaps: Record<string, number> } {
  const { gaps, add } = tally();
  const items: RxOrder[] = [];
  for (const r of raw) {
    const o = isObj(r) ? r : null;
    const ref = o ? strOrNull(o.ref) : null;
    const date = o ? strOrNull(o.date) : null;
    if (!o || !ref || !date || !DATE.test(date)) {
      add(BAD_ROW, true);
      continue;
    }
    const drugs = listOf(o.drugs).map((d) => {
      const x = isObj(d) ? d : {};
      const coded = codedOf(x);
      const drug = { ...coded, days: numOrNull(x.days), quantity: strOrNull(x.quantity) };
      add("drugs.coded", blank(coded));
      add("drugs.days", drug.days === null);
      add("drugs.quantity", drug.quantity === null);
      return drug;
    });
    const v: RxOrder = { ref, date, place: o.place === "院内" || o.place === "院外" ? o.place : null, refills: numOrNull(o.refills), drugs };
    add("place", v.place === null);
    add("refills", v.refills === null);
    items.push(v);
  }
  return { items, gaps };
}

function proceduresOf(raw: unknown[]): { items: ProcRecord[]; gaps: Record<string, number> } {
  const { gaps, add } = tally();
  const items: ProcRecord[] = [];
  for (const r of raw) {
    const o = isObj(r) ? r : null;
    const ref = o ? strOrNull(o.ref) : null;
    const date = o ? strOrNull(o.date) : null;
    if (!o || !ref || !date || !DATE.test(date)) {
      add(BAD_ROW, true);
      continue;
    }
    const act = codedOf(o.act);
    add("act.coded", blank(act));
    const subs = listOf(o.items).map((i) => {
      const x = isObj(i) ? i : {};
      const coded = codedOf(x);
      const item = { ...coded, kind: x.kind === "器材" ? ("器材" as const) : ("薬" as const), quantity: numOrNull(x.quantity), unit: strOrNull(x.unit) };
      add("items.coded", blank(coded));
      add("items.quantity", item.quantity === null);
      add("items.unit", item.unit === null);
      return item;
    });
    const v: ProcRecord = { ref, date, act, count: numOrNull(o.count), items: subs };
    add("count", v.count === null);
    items.push(v);
  }
  return { items, gaps };
}

function homeCareOf(raw: unknown[]): { items: HomeCareOrder[]; gaps: Record<string, number> } {
  const { gaps, add } = tally();
  const items: HomeCareOrder[] = [];
  const day = (v: unknown) => (typeof v === "string" && DATE.test(v) ? v : null);
  for (const r of raw) {
    const o = isObj(r) ? r : null;
    const ref = o ? strOrNull(o.ref) : null;
    if (!o || !ref) {
      add(BAD_ROW, true);
      continue;
    }
    const kind = codedOf(o.kind);
    add("kind.coded", blank(kind));
    const devices = listOf(o.devices).map((d) => {
      const x = isObj(d) ? d : {};
      const coded = codedOf(x);
      const dev = { ...coded, startedOn: day(x.startedOn), endedOn: day(x.endedOn) };
      add("devices.coded", blank(coded));
      add("devices.startedOn", dev.startedOn === null);
      add("devices.endedOn", dev.endedOn === null);
      return dev;
    });
    const v: HomeCareOrder = { ref, kind, devices, startedOn: day(o.startedOn) };
    add("startedOn", v.startedOn === null);
    items.push(v);
  }
  return { items, gaps };
}

const READERS: Record<StructuredPart, (raw: unknown[]) => { items: unknown[]; gaps: Record<string, number> }> = { visits: visitsOf, orders: ordersOf, procedures: proceduresOf, homeCare: homeCareOf };

/** 1 つの種類を読む：申告が supported でなければ unsupported。items は形をそろえ、欠けは手元で数え直す */
function partOf(name: StructuredPart, raw: unknown): Part<unknown> {
  if (!isObj(raw) || raw.status !== "supported") return { status: "unsupported" };
  const { items, gaps } = READERS[name](listOf(raw.items));
  return { status: "supported", items, gaps };
}

/**
 * 接続先のカルテから、構造化データの 4 種類を読む（design.md §16-1）。structured のない接続先は 4 種類とも unsupported。
 * 0 件（supported で items が空）と unsupported は別のまま返す（空を「問題なし」と読ませない）
 */
export function readStructured(chart: Pick<ConnectorChart, "structured">): StructuredChart {
  const raw = (isObj(chart.structured) ? chart.structured : {}) as Record<string, unknown>;
  return Object.fromEntries(STRUCTURED_PARTS.map((p) => [p, partOf(p, raw[p])])) as StructuredChart;
}

/** 種類の件数（unsupported は null） */
export const countOf = (p: Part<unknown>): number | null => (p.status === "supported" ? p.items.length : null);
