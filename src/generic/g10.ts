// G10 施設基準（design.md §15-5）：請求の診療行為のコードごとに、医科診療行為マスターの施設基準の組（shisetsu_g1〜g3。§15-3）を読み、
// 施設の申告の三値（src/facility/declaration.ts の declarationView）で「持つ・持たない・分からない」を決める。組の中は「どれか」、組のあいだは「どれも」。
// 名寄せ（8032）は 4 つに開く。注14 の基準（4101）を含む行は判定しない。算定日の分かる単位は日ごとに比べる（C-217）。
// 指摘はどれも条件つきから始める（言い切りの一覧に載せるまで。L-101）。手書きのルール（R18・R12）と 2 回言わない決まりは src/generic/overlap.ts
import { GRADE_CODES, HOSPITAL_CODES, HOSPITAL_SIDE_CODES, NAYOSE, NOTE14_CODE } from "../facility/codes";
import { codeKey, GRADE_KEY, LISTED_CODES, type DeclarationView, type On, type Tri, type UnknownReason } from "../facility/declaration";
import type { Revision } from "../engine/revisions/types";
import { pickSnapshot, shinryoOf, type MastersDb, type ShinryoRow } from "../masters/db";
import { LATER_NOTE } from "./g02";
import type { TimedClaim } from "./tensuhyo";
import type { GenericAbout, GenericCheck, GenericClaim, GenericFinding } from "./types";

type Result = "held" | "not" | "unknown";
/** 組 1 つの、その日（または月）の結果。tris は組のコードごとの三値 */
type GroupOn = { result: Result; tris: Map<string, Tri> };
/** 行 1 つ（コード 1 つ）の判定。groups は組ごとの、比べた日ごとの結果（ons と同じ並び） */
type LineJudge = { code: string; row: ShinryoRow; units: number[]; ons: On[]; result: Result; groups: { codes: string[]; on: GroupOn[] }[]; later: boolean };

const isHospital = (c: string) => (HOSPITAL_CODES as readonly string[]).includes(c) || (HOSPITAL_SIDE_CODES as readonly string[]).includes(c);

/** 行の施設基準の組（名寄せは開く）。組がなければ空。注14 の基準を含む組があれば "note14"（判定しない） */
export function groupsOf(r: ShinryoRow): string[][] | "note14" {
  const groups = [r.shisetsu_g1, r.shisetsu_g2, r.shisetsu_g3].filter((v) => v !== undefined && v !== "" && v !== "0").map((v) => v.split("/"));
  if (groups.some((g) => g.includes(NOTE14_CODE))) return "note14";
  return groups.map((g) => [...new Set(g.flatMap((c) => NAYOSE[c] ?? [c]))]);
}

/** 組の結果：どれかが持つ → 持つ、全部が持たない → 持たない、ほか → 分からない。行の結果：どれかの組が持たない → 持たない、全部の組が持つ → 持つ、ほか → 分からない */
function judgeOn(view: DeclarationView, groups: string[][], on: On): { result: Result; groups: GroupOn[] } {
  const gs = groups.map((codes): GroupOn => {
    const tris = new Map(codes.map((c) => [c, view.held(c, on)]));
    const vs = [...tris.values()].map((t) => t.v);
    return { tris, result: vs.includes("held") ? "held" : vs.every((v) => v === "not") ? "not" : "unknown" };
  });
  return { groups: gs, result: gs.some((g) => g.result === "not") ? "not" : gs.every((g) => g.result === "held") ? "held" : "unknown" };
}

/** 日ごとの結果を合わせる：1 日でも持たない → 持たない、全部の日で持つ → 持つ、ほか → 分からない */
const merge = (rs: Result[]): Result => (rs.includes("not") ? "not" : rs.every((r) => r === "held") ? "held" : "unknown");

/** コードのある単位の算定日（"YYYY-MM-DD"）と、算定日の分からない単位があれば診療年月（day なし） */
function onsOf(claim: TimedClaim, units: number[], yearMonth: string): On[] {
  const days = new Set<number>();
  let untimed = false;
  for (const i of units) {
    const d = claim.units[i].days;
    if (d === undefined || !d.some((n) => n > 0)) untimed = true;
    else d.slice(0, 31).forEach((n, k) => n > 0 && days.add(k + 1));
  }
  return [...[...days].sort((a, b) => a - b).map((d) => ({ yearMonth, day: `${yearMonth}-${String(d).padStart(2, "0")}` })), ...(untimed ? [{ yearMonth }] : [])];
}

function lineOf(view: DeclarationView, row: ShinryoRow, groups: string[][], ons: On[]): { result: Result; groups: { codes: string[]; on: GroupOn[] }[] } {
  const per = ons.map((on) => judgeOn(view, groups, on));
  return { result: merge(per.map((p) => p.result)), groups: groups.map((codes, k) => ({ codes, on: per.map((p) => p.groups[k]) })) };
}

/** 判定の中身。lines は施設基準の要る行（注14 の行は除く）、note14 は判定しなかった行の数。申告を渡していない・1 枚がないときは skip */
export function judgeG10(claim: GenericClaim, masters: MastersDb, about: GenericAbout): { lines: LineJudge[]; note14: number; snapshot: string } | { skip: string } {
  const view = about.declaration;
  if (!view) return { skip: "施設の申告を渡していないので、施設基準は見ていません" };
  const seen = new Map<string, number[]>();
  claim.units.forEach((u, i) => {
    for (const it of u.items) if (it.kind === "SI") seen.set(it.code, [...new Set([...(seen.get(it.code) ?? []), i])]);
  });
  const pick = pickSnapshot(masters, "shinryo", about.yearMonth, about.generation);
  if (pick === null) return { skip: `診療年月の世代（${about.generation}）の診療行為のマスターがありません` };
  const end = `${about.yearMonth.replace("-", "")}31`;
  const lines: LineJudge[] = [];
  let note14 = 0;
  for (const [code, units] of seen) {
    // マスターにないコードは G01 が言う
    const row = shinryoOf(masters, pick.snapshot, code);
    if (!row) continue;
    const groups = groupsOf(row);
    if (groups === "note14") {
      note14++;
      continue;
    }
    if (groups.length === 0) continue;
    const ons = onsOf(claim as TimedClaim, units, about.yearMonth);
    lines.push({ code, row, units, ons, ...lineOf(view, row, groups, ons), later: pick.later && row.changed_on > end });
  }
  return { lines, note14, snapshot: pick.snapshot };
}

const dayText = (on: On) => (on.day ? `${Number(on.day.slice(5, 7))}月${Number(on.day.slice(8, 10))}日` : null);

/** 施設基準の名称とコード（表 4 にないコードは名称を推し量らない。L-90） */
const kijunText = (view: DeclarationView, c: string) => {
  const name = view.nameOf(c);
  return name ? `「${name}」（${c}）` : `コード ${c}（名称は表 4 にありません）`;
};

/** 組のうち文に出すコード：在支病・病院の側のコードは、組にほかのコードがあれば出さない（そちらで決まる。§15-3） */
const shownOf = (codes: string[]) => (codes.some((c) => !isHospital(c)) ? codes.filter((c) => !isHospital(c)) : codes);

const NOT_TEXT: Record<string, string> = {
  hospital: "病院の施設基準（診療所は持たない）",
  notified_no: "届出なし",
  requirement_not_met: "要件を満たさない",
  grade_lacks: "申告の種別では持たないコード",
};
const UNKNOWN_TEXT: Record<UnknownReason, string> = {
  no_row: "ない",
  no_month_row: "その診療月にない",
  no_from_month: "その診療月にない（いつの診療月からが空）",
  no_check_date: "確かめた日か確かめ直す日を欠いている",
  expired: "確かめ直す日を過ぎた",
  notified_unknown: "分からない（届出の有無）",
  requirement_unknown: "分からない（要件）",
  no_start_on: "算定開始年月日が空",
  mid_month_start: "月の途中から算定開始で、算定日が分からない",
  grade_unknown: "分からない（施設の種別）",
  grade_requirement_not_met: "分からない（種別の要件を満たさないと申告されている）",
};

/** 組のコードごとの理由の文（v が持たない・分からないの日だけ）。全部のコードで同じ理由なら 1 つにまとめる */
function reasonText(view: DeclarationView, group: { codes: string[]; on: GroupOn[] }, ons: On[], v: "not" | "unknown"): string {
  const per = shownOf(group.codes).map((c) => {
    const texts: string[] = [];
    const before: string[] = [];
    let beforeStart = "";
    group.on.forEach((g, k) => {
      if (g.result !== v) return;
      const t = g.tris.get(c)!;
      if (t.v === "not" && t.reason === "before_start") {
        beforeStart = t.startOn ?? "";
        before.push(dayText(ons[k]) ?? "診療月");
      } else if (t.v === "not") texts.push(NOT_TEXT[t.reason]);
      else if (t.v === "unknown") texts.push(t.reason === "no_row" && !LISTED_CODES.includes(c) && !GRADE_CODES.includes(c) ? "一覧にない" : UNKNOWN_TEXT[t.reason]);
    });
    if (before.length > 0) texts.push(`算定開始年月日（${beforeStart}）より前の算定日（${before.join("・")}）`);
    return { c, text: [...new Set(texts)].join("・") };
  }).filter((x) => x.text !== "");
  if (new Set(per.map((x) => x.text)).size === 1) return per[0].text;
  return per.map((x) => `${kijunText(view, x.c)}は${x.text}`).join("、");
}

/** 施設の申告の画面の、その組の申告の項目（種別で決まるコードは種別の行）。reconfirm は「確かめ直す日を過ぎた」で、その行を選んだ「変わりなし」を開ける */
function declOf(group: { codes: string[]; on: GroupOn[] }): { item: string; reconfirm: boolean }[] {
  const out = new Map<string, boolean>();
  for (const c of shownOf(group.codes)) {
    if (isHospital(c)) continue;
    const item = GRADE_CODES.includes(c) ? GRADE_KEY : codeKey(c);
    const expired = group.on.some((g) => {
      const t = g.tris.get(c);
      return t?.v === "unknown" && t.reason === "expired";
    });
    out.set(item, (out.get(item) ?? false) || expired);
  }
  return [...out].map(([item, reconfirm]) => ({ item, reconfirm }));
}

const groupKey = (r: ShinryoRow) => `${r.shisetsu_g1}|${r.shisetsu_g2}|${r.shisetsu_g3}`;

/**
 * 施設基準で分かれるコードの「正しい側」（design.md §15-5。L-91）：同じ 1 枚から、区分番号の鍵（章・部・区分番号・枝番・項番）と点数識別が同じで、
 * 施設基準の組が元の行と違う行を集め、同じ申告・同じ算定日で「持つ」になる行がちょうど 1 行ならその行。0 行・2 行以上・「分からない」が混じるときは null
 */
function sideOf(same: (r: ShinryoRow) => ShinryoRow[], view: DeclarationView, line: LineJudge): ShinryoRow | null {
  const r = line.row;
  const others = same(r).filter((o) => o.code !== r.code && groupKey(o) !== groupKey(r));
  const held: ShinryoRow[] = [];
  for (const o of others) {
    const groups = groupsOf(o);
    if (groups === "note14") return null;
    const res = lineOf(view, o, groups, line.ons).result;
    if (res === "unknown") return null;
    if (res === "held") held.push(o);
  }
  return held.length === 1 ? held[0] : null;
}

/** 正しい側を探す行（持たない行のうち、版の区分のコードでないもの）と、その結果 */
function sidesOf(masters: MastersDb, snapshot: string, about: GenericAbout, lines: LineJudge[]): Map<string, ShinryoRow | null> {
  const out = new Map<string, ShinryoRow | null>();
  const want = lines.filter((l) => l.result === "not" && !about.sideless?.has(l.code));
  if (want.length === 0) return out;
  // 同じ区分番号の鍵と点数識別の行は、鍵ごとに 1 回だけ引く
  const stmt = masters.prepare("SELECT * FROM shinryo WHERE snapshot = ? AND sho = ? AND bu = ? AND kubun_no = ? AND eda = ? AND kou = ? AND point_kind = ? ORDER BY code");
  const cache = new Map<string, ShinryoRow[]>();
  const same = (r: ShinryoRow) => {
    const key = [r.sho, r.bu, r.kubun_no, r.eda, r.kou, r.point_kind].join("/");
    if (!cache.has(key)) cache.set(key, stmt.all(snapshot, r.sho, r.bu, r.kubun_no, r.eda, r.kou, r.point_kind) as ShinryoRow[]);
    return cache.get(key)!;
  };
  for (const l of want) out.set(l.code, sideOf(same, about.declaration!, l));
  return out;
}

export const g10: GenericCheck = {
  id: "G10",
  kind: "施設基準",
  run(claim, masters, about) {
    const j = judgeG10(claim, masters, about);
    if ("skip" in j) return j;
    const view = about.declaration!;
    const sides = sidesOf(masters, j.snapshot, about, j.lines);
    const out: GenericFinding[] = [];
    for (const l of j.lines) {
      if (l.result === "held") continue;
      // 持たない行は持たない組を、分からない行は分からない組を、組ごとに 1 件で言う（手書きのルールと 2 回言わない決まりは組のコードで決める）
      const v = l.result;
      const side = v === "not" ? sides.get(l.code) : undefined;
      for (const g of l.groups) {
        if (!g.on.some((x) => x.result === v)) continue;
        const shown = shownOf(g.codes);
        out.push({
          check: "G10",
          kind: "施設基準",
          certainty: l.later ? "条件つき" : "確定",
          units: l.units,
          codes: [l.code],
          messageKey: v === "not" ? "G10.not_held" : "G10.unknown",
          params: {
            code: l.code,
            name: l.row.name,
            kijun: `${shown.map((c) => kijunText(view, c)).join("・")}${shown.length > 1 ? "のどれか" : ""}`,
            kijunCodes: g.codes.join("/"),
            reason: reasonText(view, g, l.ons, v),
            side: side ? `。同じ区分番号で、申告の施設基準を満たす行は「${side.name}」（${side.code}）です。算定できるかは確かめてください` : "",
            later: l.later ? LATER_NOTE : "",
            decl: JSON.stringify({ month: about.yearMonth, items: declOf(g) }),
          },
          source: { data: "shinryo", ref: `code=${l.code}` },
        });
      }
    }
    return out;
  },
};

/** 点検の範囲に出す文（G10 が動いたときだけ）：施設基準の要る行の数と三値の内訳、注14 の基準の行、正しい側を 1 つに決められなかった行 */
export function g10NotDone(claim: GenericClaim, masters: MastersDb, about: GenericAbout): string[] {
  const j = judgeG10(claim, masters, about);
  if ("skip" in j) return [];
  const n = (r: Result) => j.lines.filter((l) => l.result === r).length;
  const undecided = [...sidesOf(masters, j.snapshot, about, j.lines).values()].filter((s) => s === null).length;
  return [
    `施設基準の要る行：${j.lines.length} 行（申告で持つ ${n("held")}・持たない ${n("not")}・分からない ${n("unknown")}）`,
    ...(j.note14 > 0 ? [`注14 の基準の行は見ていません：${j.note14} 行`] : []),
    ...(undecided > 0 ? [`正しい側をマスターで 1 つに決められなかった行：${undecided} 行（見ていません）`] : []),
  ];
}

/** 全部の行の表の印（design.md §15-5）：施設基準の要る行のコード → 申告あり（held）／申告では持たない（not）／申告が分からない（unknown）。G10 が動かないときは null */
export function g10MarksOf(claim: GenericClaim, masters: MastersDb, about: GenericAbout): Record<string, Result> | null {
  const j = judgeG10(claim, masters, about);
  if ("skip" in j) return null;
  return Object.fromEntries(j.lines.map((l) => [l.code, l.result]));
}

/** 正しい側を添えないコード（版の区分：施設の種別を見る手書きのルール R18 の区分のコード。正しい側は R18 が言う。design.md §15-5。L-91） */
export function sidelessOf(rev: Revision): ReadonlySet<string> {
  const kubun = rev.rules.find((r) => r.id === "R18")?.kubun ?? [];
  return new Set(kubun.flatMap((k) => (Object.hasOwn(rev.codes, k) ? [rev.codes[k].primary] : [])));
}
