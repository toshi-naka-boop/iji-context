// 版が持つ診療行為コードの引き方と検査（design.md §11-1）。
// コードから区分を引く関数は、必ず版を受け取る（同じコードが、別の版では別の区分キーに当たることがある。版を決めない逆引きは持たない）
import type { Bundle, Revision } from "./types";

const CODE = /^\d{9}$/;

type Lookup = { kubun: Map<string, string>; bundle: Map<string, Bundle> };
const lookups = new WeakMap<Revision, Lookup>();
function lookupOf(rev: Revision): Lookup {
  let l = lookups.get(rev);
  if (!l) {
    l = { kubun: new Map(), bundle: new Map() };
    for (const [kubun, def] of Object.entries(rev.codes)) for (const code of [def.primary, ...def.accept]) l.kubun.set(code, kubun);
    for (const b of rev.bundles) for (const code of b.members) l.bundle.set(code, b);
    lookups.set(rev, l);
  }
  return l;
}

/** その版で、コードが当たる区分（primary か accept）。当たらなければ null */
export const kubunOfCode = (rev: Revision, code: string): string | null => lookupOf(rev).kubun.get(code) ?? null;

/** その版で、コードが項目になっている包括の検査。なければ null */
export const bundleOfCode = (rev: Revision, code: string): Bundle | null => lookupOf(rev).bundle.get(code) ?? null;

/** 包括の検査の、項目数から決まる区分。どの区分にも届かない項目数は null */
export function bundleKubun(bundle: Bundle, items: number): string | null {
  let kubun: string | null = null;
  for (const t of bundle.tiers) if (items >= t.min) kubun = t.kubun;
  return kubun;
}

/** 区分が包括の検査の区分なら、その包括と、その区分になる項目数の範囲（max は次の区分の手前。最後の区分は上限なし） */
export function bundleOfKubun(rev: Revision, kubun: string): { bundle: Bundle; min: number; max: number } | null {
  for (const bundle of rev.bundles) {
    const i = bundle.tiers.findIndex((t) => t.kubun === kubun);
    if (i >= 0) return { bundle, min: bundle.tiers[i].min, max: i + 1 < bundle.tiers.length ? bundle.tiers[i + 1].min - 1 : Number.POSITIVE_INFINITY };
  }
  return null;
}

/** 書き出しに使うコード。施設に入居する患者には、facility があればそれを使う。コードを 1 つ持たない区分（包括の検査・uncoded・その版にない区分）は例外 */
export function codeOf(rev: Revision, kubun: string, facilityResident = false): string {
  const def = Object.hasOwn(rev.codes, kubun) ? rev.codes[kubun] : undefined;
  if (!def) throw new Error(`版 ${rev.id} にコードのない区分: ${kubun}`);
  return facilityResident && def.facility ? def.facility : def.primary;
}

/**
 * 版のコードの検査（§11-1）：コードは 9 桁／1 つの版の中で、同じコードが 2 か所に現れない（codes の primary・accept と、bundles の members を合わせて）／
 * 点数表の各区分が codes・bundles・uncoded のちょうど 1 つに載っている／codes・bundles の区分は診療識別を持つ
 */
export function assertCodes(rev: Revision): void {
  const bad = (what: string): never => {
    throw new Error(`版 ${rev.id} のコードの表：${what}`);
  };
  const seen = new Map<string, string>();
  const take = (code: string, where: string) => {
    if (!CODE.test(code)) bad(`コードが 9 桁の数字でない（${where}）`);
    const prev = seen.get(code);
    // sharedCodes（EM §2-8 DUP-01）だけは、codes と bundles の 1 か所ずつに置ける（design.md §19-13 の 1）
    if (prev !== undefined && (rev.sharedCodes ?? []).includes(code) && prev.startsWith("bundles[") !== where.startsWith("bundles[")) return;
    if (prev !== undefined) bad(`同じコードが 2 か所にある: ${code}（${prev} と ${where}）`);
    seen.set(code, where);
  };
  const placed = new Map<string, number>();
  const place = (kubun: string) => placed.set(kubun, (placed.get(kubun) ?? 0) + 1);
  for (const [kubun, def] of Object.entries(rev.codes)) {
    place(kubun);
    for (const code of [def.primary, ...def.accept]) take(code, kubun);
    if (def.facility !== undefined && !def.accept.includes(def.facility)) bad(`facility が accept にない: ${kubun}`);
    if (def.base !== undefined && !Object.hasOwn(rev.codes, def.base)) bad(`base が codes にない: ${kubun}`);
  }
  rev.bundles.forEach((b, i) => {
    if (b.tiers.length === 0 || b.tiers.some((t, j) => t.min < 1 || (j > 0 && t.min <= b.tiers[j - 1].min))) bad(`bundles[${i}] の tiers は min の昇順`);
    for (const t of b.tiers) place(t.kubun);
    for (const code of b.members) take(code, `bundles[${i}]`);
  });
  for (const kubun of Object.keys(rev.uncoded)) place(kubun);
  for (const kubun of Object.keys(rev.points)) {
    const n = placed.get(kubun) ?? 0;
    if (n !== 1) bad(n === 0 ? `点数表の区分が codes・bundles・uncoded のどこにもない: ${kubun}` : `点数表の区分が codes・bundles・uncoded の 2 か所以上にある: ${kubun}`);
  }
  for (const kubun of placed.keys()) {
    if (!Object.hasOwn(rev.points, kubun)) bad(`点数表にない区分: ${kubun}`);
    if (!Object.hasOwn(rev.uncoded, kubun) && !/^\d{2}$/.test(rev.shikibetsu[kubun] ?? "")) bad(`診療識別がない: ${kubun}`);
  }
}
