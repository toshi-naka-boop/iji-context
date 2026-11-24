// 点数の検算（G02。design.md §12-3）の式：単位（点数・回数の算定単位）の 1 回分の点数を、マスターの行から再計算する。
// 式は、原文で確かめたものだけ（EM §2-11「式の錨」に、原文の計算例を置く）。確かめていない形は、理由つきで「検算の対象外」にする（合っているとは数えない）。
//   診療行為：点数（点数識別 3）の合算。注加算・通則加算（告示等識別 7・9）は基本項目と同じ単位に書き、合わせた点数を最後の行に書く（作成手引き 第10章 2(6) ア・イ、p27〜30）。
//     点数（マイナス）（点数識別 8）は同じ単位で引く（同 ケ、p32）。きざみ（きざみ値計算識別 1）は、数量データから［基］p32〜33 の点数算定式 1・2 と上下限エラー処理の表で
//   薬剤料：単位の薬価の合計（薬価 × 使用量）から。投薬（告示 F200）・注射（G100）は 15 円以下 1 点、超えたら（薬価 − 15 円）÷ 10 円を切り上げて 1 点を足す。
//     在宅（C200）・検査（D500）・画像診断（E300）・リハビリテーション（H100）・精神科専門療法（I100）・処置（J300）・手術（K940）・麻酔（L200）は 15 円以下を算定せず、超えたら同じ式
//   特定器材料：材料価格 × 使用量 ÷ 10 円を四捨五入（告示 B200・C300・E400 ほか「材料価格を 10 円で除して得た点数」、端数は［基］p22〜23 項番22 と作成手引き p41 の点数計算方法）。
//     酸素は TO に書いた購入単価 × 使用量 × 補正率を 1 円未満で四捨五入してから（留意事項通知 酸素の価格、作成手引き p40〜41）。％加算・乗算割合は、直前の器材に掛ける
//   包括の検査：版の表（EM §2-8 の bundles）にある群だけ。項目数が最初の区分に届かなければ、項目の点数の合算。
//     検体と採血の回数は UKE にないので、群の行だけの単位は三段で判定する（design.md §19-4 の 1。確定は置かない）：
//     (1) 表の値に合う／(2) 同じ日の 2 回目以降の採血の項目（D013 は血液でない検体の項目も）を表の外と読んだ値に合う／(3) どれとも合わない
// 原文の記録例が、上の式と違う決め方をしている形は、検算しない（作成手引き 第15章の記録例を全部通して見つけたもの）：
//   同じ区分番号のきざみの行が 2 つ以上ある単位（麻酔の区分をまたぐ時間、アナログとデジタルの同時撮影は、行を合わせて数える。p83・p97・p99）／
//   きざみの行のある単位・医薬品の単位に、コメントが付いている（6 歳未満の自己血貯血は患者体重のコメントから、残量廃棄はコメントの使用量から計算する。p81〜82・p58）／
//   検査の薬剤で回数が 2 以上（皮内反応検査のアレルゲンは、1 箇所分の使用量に回数を掛けた量で点数を書く。p88）。ページは作成手引きの PDF のページ
// 作っていない形：％加算・％減算（点数識別 5・6。対象になる所定点数と端数の扱いを、原文で確かめていない）、金額・購入価格・減点の行、診療行為と薬剤・器材が混ざった単位
import { iyakuhinOf, shinryoOf, tokuteiOf, type MastersDb, type ShinryoRow } from "../masters/db";

/** 検算の対象外にした理由 */
export type ExcludeReason = "notInMaster" | "mixed" | "percent" | "amount" | "purchase" | "bundleNoTable" | "bundleMixed" | "bundleSplit" | "shikibetsu" | "quantity" | "fraction" | "noPrice" | "deviceRate" | "kizamiCombined" | "commented" | "perCount";

/** 理由の文（点検の範囲の説明と、scripts/measure-generic.ts が出す） */
export const EXCLUDE_TEXT: Record<ExcludeReason, string> = {
  notInMaster: "マスターにないコードがある",
  mixed: "診療行為・医薬品・特定器材が同じ単位にある（その書き方の点数の決め方を確かめていない）",
  percent: "％加算・％減算（逓減を含む）がある（対象になる所定点数と端数の扱いを確かめていない）",
  amount: "金額・減点で書く行がある（食事療養、薬剤料の逓減など）",
  purchase: "購入価格で算定する（購入価格の器材、マスターと違う単価が書いてある器材、単価のない酸素）",
  bundleNoTable: "包括の検査で、項目数ごとの点数の表を持っていない群",
  bundleMixed: "包括の検査と、ほかの行が同じ単位にある",
  bundleSplit: "同じ群の包括の検査が、同じ日の複数の単位に分かれている",
  shikibetsu: "診療識別から薬剤料の式が決まらない",
  quantity: "数量・使用量が読めない（きざみの下限に届かない数量を含む）",
  fraction: "端数の扱いが決まらない（きざみでない行の点数に端数がある、％加算の器材で円の丸め方によって点数が変わる）",
  noPrice: "薬価がマスターにない（0 円）",
  deviceRate: "％加算・乗算割合の器材の付け先がない",
  kizamiCombined: "同じ区分番号のきざみの行が 2 つ以上ある（行を合わせて数える決まりがある）",
  commented: "きざみの行のある単位・医薬品の単位に、コメントが付いている（患者体重・残量廃棄など、コメントの値で計算する場合がある）",
  perCount: "検査の薬剤で、回数が 2 以上（使用量に回数を掛けて計算する書き方がある）",
};

/** 単位の 1 行。quantity は数量データ（SI）・使用量（IY・TO）、unitPrice は単価（TO）。どれも UKE の欄のまま */
export type RecalcItem = { kind: "SI" | "IY" | "TO"; code: string; quantity?: string; unitPrice?: string };
/** 診療年月に使う 1 枚（マスターごと。その行の種類が単位になければ null でよい） */
export type RecalcSnapshots = { SI: string | null; IY: string | null; TO: string | null };
/**
 * 包括の検査の群（版の表から）。tiers は min の昇順。name は区分番号（D007 など。文に出す）。
 * bloodOnly＝注が「1 回に採取した血液」だけを数え、同じ日の検体を合わせる決まり（留意事項 D001 (10)・D004 (14)。R8-332・R8-333）が当たらない群（D013。免疫学的検査）
 */
export type RecalcBundle = { name?: string; members: string[]; tiers: { min: number; points: number }[]; bloodOnly?: boolean };

/**
 * 三段の判定の結果（design.md §19-4 の 1）。stage 1＝表の値（基本）に合う／2＝表の外と読んだ値に合う（read は外と読んだ行のコード、more はほかにも合う読みがある）／3＝どれとも合わない。
 * lower＝請求の点数が基本より小さい
 */
export type BundleTier = { stage: 1 } | { stage: 2; read: string[]; more: boolean; lower: boolean } | { stage: 3; lower: boolean };

/** 一部外しの k の上限と、一部外しを試す単位の項目数の上限（design.md §19-4 の 1。22a の数えで (2) は多くなかったので、設計の値のまま） */
export const BUNDLE_MAX_OUT = 3;
export const BUNDLE_MAX_ITEMS = 12;
/** 名前に血液でない検体が付いた行（D007・D008 では外の候補にしない） */
const NON_BLOOD = /（(尿|髄液|胸水|腹水)）/;

export type Recalc =
  | { ok: true; points: number; formula: string; table: "shinryo" | "iyakuhin" | "tokutei"; rows: { code: string; changedOn: string }[]; tier?: BundleTier; bundle?: RecalcBundle }
  | { ok: false; reason: ExcludeReason };

const no = (reason: ExcludeReason): Recalc => ({ ok: false, reason });
/** 小数の誤差を持ち込まないよう、点は 100 分の 1 の整数で計算する */
const halfUp = (n: number, unit: number): number => Math.floor((n + unit / 2) / unit);
/**
 * 金額は、途中で丸めずに整数（BigInt）で持つ（round-32 codex-4）：価格（薬価・材料価格・単価）は小数第 2 位まで、使用量は小数第 5 位まで（UKE の欄の形）なので、
 * 価格 × 使用量は 1,000 万分の 1 円（YEN7）で割り切れる。％加算・乗算割合を掛けた器材は、桁（10 の何乗分の 1 円か）を足していく
 */
const YEN7 = BigInt(10_000_000);
/** 小数の文字を、10 の places 乗分の 1 の整数にする。形に合わない・桁が多いときは null */
const fixed = (text: string | undefined, places: number): bigint | null => {
  const m = text === undefined ? null : /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (m === null || (m[2] ?? "").length > places) return null;
  return BigInt(m[1] + (m[2] ?? "").padEnd(places, "0"));
};
/** マスターの価格（小数第 2 位まで）を 100 分の 1 円の整数に。それより細かい値は null（その形の丸めを確かめていない） */
const cents = (price: number): bigint | null => (Math.abs(price * 100 - Math.round(price * 100)) < 1e-6 ? BigInt(Math.round(price * 100)) : null);
const pow10 = (n: number): bigint => BigInt(10) ** BigInt(n);
/** v ÷ 10^s 円を、unit 円単位で四捨五入した数（unit 円が何個か） */
const halfUpYen = (v: bigint, s: number, unit: bigint): bigint => (v + (unit * pow10(s)) / BigInt(2)) / (unit * pow10(s));

/** 薬剤料の式の種類。one＝15 円以下は 1 点（投薬 F200・注射 G100）／none＝15 円以下は算定しない（C200・D500・E300・H100・I100・J300・K940・L200） */
export type DrugRule = "one" | "none";
/**
 * 診療識別（記録条件仕様 別表20）→ 薬剤料の式。21 内服・22 屯服・23 外用＝投薬、31〜33＝注射、14 在宅、40 処置、50 手術、54 麻酔、60 検査・病理、70 画像診断、
 * 80 その他（リハビリテーション・精神科専門療法。どちらの薬剤料も同じ式）。ここにない診療識別（初診・再診・医学管理・調剤・処方など）の薬剤は、式を決めない
 */
export const DRUG_RULE: Record<string, DrugRule> = { "21": "one", "22": "one", "23": "one", "31": "one", "32": "one", "33": "one", "14": "none", "40": "none", "50": "none", "54": "none", "60": "none", "70": "none", "80": "none" };

/** 薬価の合計（1,000 万分の 1 円の整数）から点数。15 円との比較と「10 円又はその端数ごとに 1 点」を整数で行う */
export function drugPoints(yen7: bigint, rule: DrugRule): number {
  if (yen7 <= BigInt(15) * YEN7) return rule === "one" ? 1 : 0;
  return Number((yen7 - BigInt(15) * YEN7 + BigInt(10) * YEN7 - BigInt(1)) / (BigInt(10) * YEN7)) + 1;
}

/**
 * きざみ（［基］p32〜33）。戻り値は 100 分の 1 点。数量が「下限値 − きざみ値」以下で、上下限エラー処理が 2・3（点数を算定しない）のときは null。
 * 点数算定式 1：基本点数 ＋ 切上げ（（データ − 下限値）÷ きざみ値）× きざみ点数。式 2 は、データの代わりに上限値
 */
export function kizamiCenti(r: Pick<ShinryoRow, "points" | "kizami_lower" | "kizami_upper" | "kizami_step" | "kizami_points" | "kizami_error">, data: number): number | null {
  const base = Math.round(r.points * 100);
  if (r.kizami_step <= 0) return null;
  if (data <= r.kizami_lower - r.kizami_step) return r.kizami_error === "0" || r.kizami_error === "1" ? base : null;
  if (data <= r.kizami_lower) return base;
  const upTo = data > r.kizami_upper && (r.kizami_error === "1" || r.kizami_error === "3") ? r.kizami_upper : data;
  return base + Math.ceil((upTo - r.kizami_lower) / r.kizami_step) * Math.round(r.kizami_points * 100);
}

/**
 * 包括の検査の三段（design.md §19-4 の 1）。基本＝表(n)。外の候補を区分番号・号・コードの昇順に並べ、k ＝ 1〜上限の小さい順に、各 k の中は辞書順で
 * 「表(n−k)＋外した k 行の素の合算」を試し（n が上限を超える単位と、n−k が下限に届かない k は試さない）、最後に全部外し（外の候補を全部外す）を試す。最初に合った組を返す
 */
export function bundleTier(bundle: RecalcBundle, rows: Pick<ShinryoRow, "code" | "name" | "points" | "kubun_no" | "kou">[], uke: number): { base: number; tier: BundleTier } {
  const n = rows.length;
  const min = bundle.tiers[0].min;
  const raw = (idx: number[]) => idx.reduce((s, i) => s + rows[i].points, 0);
  const table = (idx: number[]) => bundle.tiers.filter((t) => t.min <= idx.length).at(-1)?.points ?? raw(idx);
  const all = rows.map((_, i) => i);
  const base = table(all);
  const lower = uke < base;
  if (uke === base) return { base, tier: { stage: 1 } };
  const cand = all
    .filter((i) => bundle.bloodOnly === true || !NON_BLOOD.test(rows[i].name))
    .sort((a, b) => rows[a].kubun_no - rows[b].kubun_no || rows[a].kou - rows[b].kou || (rows[a].code < rows[b].code ? -1 : rows[a].code > rows[b].code ? 1 : 0));
  const value = (out: number[]) => table(all.filter((i) => !out.includes(i))) + raw(out);
  const tries: number[][] = [];
  const combos = (from: number, k: number, pick: number[]) => {
    if (pick.length === k) tries.push(pick);
    else for (let j = from; j < cand.length; j++) combos(j + 1, k, [...pick, cand[j]]);
  };
  if (n <= BUNDLE_MAX_ITEMS) for (let k = 1; k <= Math.min(BUNDLE_MAX_OUT, cand.length) && n - k >= min; k++) combos(0, k, []);
  tries.push(cand);
  const hits = tries.filter((t) => t.length > 0 && value(t) === uke);
  if (hits.length === 0) return { base, tier: { stage: 3, lower } };
  const read = hits[0].map((i) => rows[i].code);
  return { base, tier: { stage: 2, read, more: hits.some((h) => h.map((i) => rows[i].code).join() !== read.join()), lower } };
}

function recalcShinryo(db: MastersDb, snapshot: string, items: RecalcItem[], bundles: RecalcBundle[], commented: boolean, uke?: number): Recalc {
  const rows: ShinryoRow[] = [];
  for (const it of items) {
    const r = shinryoOf(db, snapshot, it.code);
    if (!r) return no("notInMaster");
    rows.push(r);
  }
  if (rows.some((r) => r.point_kind === "5" || r.point_kind === "6")) return no("percent");
  if (rows.some((r) => r.point_kind === "4")) return no("purchase");
  if (rows.some((r) => r.point_kind !== "3" && r.point_kind !== "8")) return no("amount");
  const used = rows.map((r) => ({ code: r.code, changedOn: r.changed_on }));
  const steps = rows.filter((r) => r.kizami_kind === "1");
  if (new Set(steps.map((r) => `${r.alpha}/${r.kubun_no}/${r.eda}`)).size !== steps.length) return no("kizamiCombined");
  if (steps.length > 0 && commented) return no("commented");
  // 包括の検査（包括対象検査が 0 でない行）
  const grouped = rows.filter((r) => r.houkatsu_kensa !== "0");
  if (grouped.length > 0) {
    if (grouped.some((r) => !bundles.some((b) => b.members.includes(r.code)))) return no("bundleNoTable");
    const bundle = bundles.find((b) => rows.every((r) => b.members.includes(r.code)));
    if (!bundle || grouped.length !== rows.length) return no("bundleMixed");
    if (rows.some((r) => !Number.isInteger(r.points))) return no("fraction");
    const formula = `包括の検査（${bundle.name ? `${bundle.name} の表。` : ""}${rows.length} 項目）`;
    // UKE の点数が分からない呼び出し（式の錨）は、表の値（項目数が下限に届かなければ素の合算）だけを返す
    if (uke === undefined) {
      const tier = bundle.tiers.filter((t) => t.min <= rows.length).at(-1);
      return { ok: true, points: tier ? tier.points : rows.reduce((s, r) => s + r.points, 0), formula, table: "shinryo", rows: used };
    }
    const t = bundleTier(bundle, rows, uke);
    return { ok: true, points: t.base, formula, table: "shinryo", rows: used, tier: t.tier, bundle };
  }
  // 100 分の 1 点で足す。きざみの行は、行ごとに四捨五入する（［基］p33 の点数算定式は、式の全体を四捨五入する。留意事項通知 第2章第4部 エックス線診断料の端数処理の例も、診断料・撮影料ごと）。
  // きざみでない行の点数に端数があるもの（丸め方を確かめていない）は、検算しない
  let sum = 0;
  let kizami = false;
  for (const [i, r] of rows.entries()) {
    let v = Math.round(r.points * 100);
    if (r.kizami_kind === "1") {
      const q = items[i].quantity;
      if (q === undefined || !/^\d+$/.test(q)) return no("quantity");
      const k = kizamiCenti(r, Number(q));
      if (k === null) return no("quantity");
      v = halfUp(k, 100) * 100;
      kizami = true;
    } else if (v % 100 !== 0) return no("fraction");
    sum += r.point_kind === "8" ? -v : v;
  }
  const minus = rows.some((r) => r.point_kind === "8");
  return { ok: true, points: sum / 100, formula: `診療行為の点数の合算${kizami ? "（きざみの計算を含む）" : ""}${minus ? "（減算を含む）" : ""}`, table: "shinryo", rows: used };
}

function recalcIyakuhin(db: MastersDb, snapshot: string, items: RecalcItem[], shikibetsu: string, shikibetsuSure: boolean, commented: boolean, count: number): Recalc {
  if (commented) return no("commented");
  if (shikibetsu === "60" && count > 1) return no("perCount");
  // 1,000 万分の 1 円（薬価の 100 分の 1 円 × 使用量の 10 万分の 1）
  let yen = BigInt(0);
  const used: { code: string; changedOn: string }[] = [];
  for (const it of items) {
    const r = iyakuhinOf(db, snapshot, it.code);
    if (!r) return no("notInMaster");
    if (r.price_kind !== "1") return no("amount");
    if (r.price <= 0) return no("noPrice");
    const price = cents(r.price);
    if (price === null) return no("fraction");
    const q = fixed(it.quantity, 5);
    if (q === null || q <= BigInt(0)) return no("quantity");
    yen += price * q;
    used.push({ code: r.code, changedOn: r.changed_on });
  }
  const rule = DRUG_RULE[shikibetsu];
  if (rule === undefined) return no("shikibetsu");
  // 15 円以下は、区分によって 1 点か算定しないかが分かれる。診療識別を前の行から引き継いでいて、あいだにコメントレコードがあるとき（そこに診療識別が書いてあり得る）は、決めない
  if (!shikibetsuSure && yen <= BigInt(15) * YEN7) return no("shikibetsu");
  return { ok: true, points: drugPoints(yen, rule), formula: rule === "one" ? "薬剤料（15 円以下は 1 点）" : "薬剤料（15 円以下は算定しない）", table: "iyakuhin", rows: used };
}

function recalcTokutei(db: MastersDb, snapshot: string, items: RecalcItem[]): Recalc {
  /** 器材 1 つと、それに掛ける％加算・乗算割合。金額は yen ÷ 10^scale 円（途中で丸めない） */
  const groups: { yen: bigint; scale: number; oxygen: boolean; rated: boolean }[] = [];
  const used: { code: string; changedOn: string }[] = [];
  for (const it of items) {
    const r = tokuteiOf(db, snapshot, it.code);
    if (!r) return no("notInMaster");
    used.push({ code: r.code, changedOn: r.changed_on });
    const last = groups.at(-1);
    if (r.price_kind === "5" || r.price_kind === "9") {
      // ％加算は、マスターの割合を直前の器材に掛ける。乗算割合は、書いてある数量（気圧数）を掛ける（作成手引き p40〜41）
      if (!last) return no("deviceRate");
      if (r.price_kind === "9") {
        const q = fixed(it.quantity, 5);
        if (q === null || q <= BigInt(0)) return no("quantity");
        [last.yen, last.scale] = [last.yen * q, last.scale + 5];
      } else {
        // 1 ＋ 割合 ÷ 100（割合は小数第 2 位まで）＝（10000 ＋ 割合の 100 倍）÷ 10000
        const pct = cents(r.price);
        if (pct === null) return no("fraction");
        [last.yen, last.scale] = [last.yen * (BigInt(10_000) + pct), last.scale + 4];
      }
      last.rated = true;
      continue;
    }
    if (r.price_kind !== "1") return no("purchase");
    const q = fixed(it.quantity, 5);
    if (q === null || q <= BigInt(0)) return no("quantity");
    const master = cents(r.price);
    if (master === null) return no("fraction");
    const given = it.unitPrice !== undefined && it.unitPrice !== "";
    const written = given ? fixed(it.unitPrice, 2) : null;
    const oxygen = ["2", "3", "4", "5"].includes(r.sanso);
    let price = master;
    if (oxygen) {
      // 酸素のマスターの金額は上限。書いてある購入単価で計算する
      if (written === null || written > master) return no("purchase");
      price = written;
    } else if (given && written !== master) return no("purchase");
    // 100 分の 1 円 × 10 万分の 1 ＝ 1,000 万分の 1 円
    groups.push({ yen: price * q, scale: 7, oxygen, rated: false });
  }
  if (groups.length === 0) return no("deviceRate");
  // 金額を、同じ桁（いちばん細かい桁）にそろえる
  const scale = Math.max(...groups.map((g) => g.scale));
  const exact = (g: (typeof groups)[number]) => g.yen * pow10(scale - g.scale);
  const yenRound = (g: (typeof groups)[number]) => halfUpYen(g.yen, g.scale, BigInt(1)) * pow10(scale);
  // 酸素の価格は 1 円未満を四捨五入する。フィルムの乳幼児の加算（材料価格 × 1.1）は、円で丸めるかどうかを確かめていないので、どちらでも同じ点数になるときだけ検算する
  const asIs = groups.map((g) => (g.oxygen ? yenRound(g) : exact(g)));
  const rounded = groups.map((g) => (g.oxygen || g.rated ? yenRound(g) : exact(g)));
  const total = (list: bigint[]) => Number(halfUpYen(list.reduce((s, y) => s + y, BigInt(0)), scale, BigInt(10)));
  const points = total(asIs);
  // 点数の四捨五入は、単位の価格を合算してから（作成手引き 第15章 (10) キの例：器材ごとに丸めると 36 点、合算してからだと原文どおり 37 点。EM §2-11 F28）
  if (points !== total(rounded)) return no("fraction");
  return { ok: true, points, formula: "特定器材料（価格 × 使用量 ÷ 10 円を四捨五入）", table: "tokutei", rows: used };
}

/**
 * 単位 1 つの 1 回分の点数を再計算する。行の種類が 1 つだけの単位を扱う（混ざった単位は対象外）。
 * shikibetsu は、その単位の診療識別（省略されていれば、前の行から引き継いだもの）。shikibetsuSure が偽＝引き継ぎが確かでない。
 * commented＝その単位にコメントが付いている（行のコメント欄、単位の中・直前・直後のコメントレコード）。count＝回数
 * uke＝UKE に書いてある 1 回分の点数（包括の検査の三段に使う。省けば表の値だけ）
 */
export function recalcUnit(db: MastersDb, snapshots: RecalcSnapshots, items: RecalcItem[], opt: { shikibetsu: string; shikibetsuSure: boolean; bundles: RecalcBundle[]; commented?: boolean; count?: number; uke?: number }): Recalc {
  const kinds = new Set(items.map((it) => it.kind));
  if (kinds.size !== 1) return no("mixed");
  const kind = items[0].kind;
  const snapshot = snapshots[kind];
  if (snapshot === null) return no("notInMaster");
  if (kind === "SI") return recalcShinryo(db, snapshot, items, opt.bundles, opt.commented === true, opt.uke);
  if (kind === "IY") return recalcIyakuhin(db, snapshot, items, opt.shikibetsu, opt.shikibetsuSure, opt.commented === true, opt.count ?? 1);
  return recalcTokutei(db, snapshot, items);
}
