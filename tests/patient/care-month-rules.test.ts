// 認定の全会一致の規則（careCertFor。design.md §18-12 の 1「全会一致の規則（v40）」）を、名前つきの表と総当たりで縛る。
// 総当たりの性質は、実装の式を写さず、設計の文から書く（C-553）
import { describe, expect, it } from "vitest";
import { careCertFor, careLevelOf, type CareState, type PatientFact } from "../../src/patient/facts";
import { month, YM } from "../helpers/period";

/**
 * 行の書き方：
 *  要介護 n：[始まりの月のずれ（"bad" は実在しない日）, 終わりの月のずれ（その月の末日。"bad" は実在しない日）, 答えた月のずれ（省くと始まりの月）, 申請の結果ですか（省くと聞いていない）]
 *  認定なし・申請中・分からない：答えた月のずれ
 */
type Dated = ["要介護", number, number | "bad", number | "bad", number?, ("はい" | "いいえ" | "分からない")?];
type Spec = Dated | ["認定なし" | "申請中" | "分からない", number];
const lastDay = (m: number) => {
  const [y, mm] = month(m).split("-").map(Number);
  return `${month(m)}-${String(new Date(Date.UTC(y, mm, 0)).getUTCDate()).padStart(2, "0")}`;
};
const answerOf = (s: Spec): number => (s[0] === "要介護" ? (s[4] ?? (s[2] === "bad" ? 0 : s[2])) : s[1]);
const rows = (specs: Spec[]): PatientFact[] =>
  specs.map((s, i) => {
    const base = { patientId: "P1", key: "careCert" as const, source: "介護保険証" as const, checkedAt: `${month(0)}-${String(10 + (i % 18)).padStart(2, "0")}T09:00:00+09:00`, checkedBy: "new1" };
    if (s[0] === "要介護") {
      const [, level, f, u, , app] = s;
      const validFrom = f === "bad" ? `${month(0).slice(0, 4)}-02-30` : `${month(f)}-01`;
      const validUntil = u === "bad" ? `${month(4)}-32` : lastDay(u);
      return { ...base, value: { kind: "要介護", level, validFrom, forMonth: month(answerOf(s)), ...(app ? { fromApplication: app } : {}) }, validUntil };
    }
    return { ...base, value: { kind: s[0], forMonth: month(s[1]) }, validUntil: null };
  });
/** forMonth を持たない今までの行（確かめた日の月を答えた月として読む）：答えた月を確かめた日に移す */
const legacyRows = (specs: Spec[]): PatientFact[] =>
  rows(specs).map((r, i) => {
    const { forMonth, ...v } = r.value as { forMonth: string };
    return { ...r, value: v as PatientFact["value"], checkedAt: `${forMonth}-${String(10 + i).padStart(2, "0")}T09:00:00+09:00` };
  });
/** 期待：数は careLevel（要介護 n→n、認定なし→0）、"?" は分からない（申請中も R03 には分からない） */
const levelWith = (make: (s: Spec[]) => PatientFact[]) => (specs: Spec[], m: number) => {
  const c = careLevelOf(careCertFor(make(specs), month(m)), 3);
  return c.known ? c.value : "?";
};

// [名前, 行（残した順）, { 月のずれ: 期待 }]
const TABLE: [string, Spec[], Record<number, number | "?">][] = [
  ["認定なしは答えた月から 6 か月。前の月には効かない（X-354）", [["認定なし", 0]], { [-1]: "?", 0: 0, 5: 0, 6: "?" }],
  ["翌月からの要介護 3（翌月に答えた）のあとで、基準月の認定なしを答えると、翌月以降は両方が負けずに食い違うので分からない（v40 で 3 から変わる）", [["要介護", 3, 1, 7], ["認定なし", 0]], { 0: 0, 1: "?", 3: "?", 6: 3 }],
  ["X-380：要介護 1 を残したあと、翌月分で分からない → 翌月だけ分からない", [["要介護", 1, -9, 4], ["分からない", 1]], { 0: 1, 1: "?", 2: 1 }],
  ["要介護 1（前に答えた）のあと翌月分で認定なし → 認定なしが月と順の両方で勝つので翌月から 0（v40 で次の月が 1 から 0 に変わる）", [["要介護", 1, -9, 4], ["認定なし", 1]], { 0: 1, 1: 0, 2: 0 }],
  ["C-530：前月の認定なし → 基準月の申請中 → 以降は分からない", [["認定なし", -1], ["申請中", 0]], { [-1]: 0, 0: "?", 1: "?", 2: "?" }],
  ["X-400：基準月の申請中を残したあとに、前月分の認定なしを残しても、基準月以降は分からない", [["申請中", 0], ["認定なし", -1]], { [-1]: 0, 0: "?", 1: "?" }],
  ["X-410：翌月分の認定なし → あとから基準月分の申請中 → 翌月以降は分からない", [["認定なし", 1], ["申請中", 0]], { 0: "?", 1: "?", 2: "?" }],
  ["申請中のあとの月に答えた認定なしは効く（申請が却下された月など）", [["申請中", 0], ["認定なし", 1]], { 0: "?", 1: 0, 2: 0 }],
  ["同じ月の申請中のあとに残した認定なしは訂正として効く", [["申請中", 0], ["認定なし", 0]], { 0: 0, 1: 0 }],
  ["同じ月の認定なしのあとに残した申請中は、その月以降を断ち切る", [["認定なし", 0], ["申請中", 0]], { 0: "?", 1: "?" }],
  ["C-533：前月分の分からないは、基準月の認定なしを上書きしない", [["認定なし", 0], ["分からない", -1]], { [-1]: "?", 0: 0, 3: 0 }],
  ["C-533：基準月の分からないは、前月の認定なしをその月だけ上書きする", [["認定なし", -1], ["分からない", 0]], { [-1]: 0, 0: "?", 1: 0 }],
  ["X-401：期限が実在しない要介護 3 は、その期間を分からないにし、古い認定なしを復活させない", [["認定なし", -1], ["要介護", 3, 0, "bad"]], { [-1]: 0, 0: "?", 1: "?", 4: "?" }],
  ["X-401：同じ始まりの日で残し直せば（訂正）、効く", [["認定なし", -1], ["要介護", 3, 0, "bad"], ["要介護", 3, 0, 6]], { 0: 3, 1: 3 }],
  ["X-411：開始日が実在しない行を、正しい開始日で残し直せば、不正な行は負けて消える", [["要介護", 3, "bad", 4], ["要介護", 3, -7, 4, 0]], { [-1]: 3, 0: 3, 1: 3 }],
  ["(d)：不正な行は、あとに残した前の月の認定なしでは負けない（答えた前の月は、不正な行がまだ語らないので 0）", [["要介護", 3, "bad", 4], ["認定なし", -1]], { [-1]: 0, 0: "?", 1: "?" }],
  ["X-420：10/10 に認定なし、11/10 に要介護 3（10/1〜1/31）を残すと 10〜1 月は 3。終わったあとの 2 月も、認定なしは間の月について語る後の行に負けるので分からない（v41 (1)）", [["認定なし", 0], ["要介護", 3, 0, 3, 1]], { 0: 3, 1: 3, 3: 3, 4: "?" }],
  ["X-421：要介護 3（10 月分）・認定なし（11 月分）・申請中（10 月分、最後）の順で、11 月は認定なしと申請中が負けずに残るので分からない（v40 で 3 から変わる）", [["要介護", 3, 0, 3, 0], ["認定なし", 1], ["申請中", 0]], { 0: "?", 1: "?", 2: "?" }],
  ["認定なし 10 月 → 要介護 3（11/1〜1/31）で、11〜1 月は 3。2・3 月は、認定なしが間の月について語る後の要介護 3 に負けるので分からない（v41 (1)）", [["認定なし", 0], ["要介護", 3, 1, 3]], { 0: 0, 1: 3, 3: 3, 4: "?", 5: "?" }],
  ["v41 (2)：期間の重ならない認定どうしは捨て合わない（前の認定の月は前の値、後の月は後の値。月の途中で区分が変わった続いた 2 行は tests/patient/care-cert.test.ts の名前つきのテスト）", [["要介護", 1, -6, 0, -6], ["要介護", 3, 1, 6, 1]], { 0: 1, 1: 3, 2: 3 }],
  ["C-550：要介護 1（10 月分で答えた）→ 申請中（10 月分）→ 要介護 3（翌々月から。10 月分）：10 月は申請中が残るので分からない", [["要介護", 1, -6, 5, 0], ["申請中", 0], ["要介護", 3, 6, 9, 0]], { 0: "?", 6: 3 }],
  ["C-550：要介護 1 → 分からない（10 月分）→ 要介護 2（翌々月から。10 月分）：10 月は分からない", [["要介護", 1, -6, 5, 0], ["分からない", 0], ["要介護", 2, 6, 9, 0]], { 0: "?" }],
  ["C-551：11 月分の申請中のあとで、10 月分として要介護 1（4 月〜3 月）を入れても、11 月は分からない（残す順で答えが割れない）", [["申請中", 1], ["要介護", 1, -6, 5, 0]], { 0: 1, 1: "?" }],
  ["C-551 の逆の順：要介護 1 → 11 月分の申請中：11 月は分からない", [["要介護", 1, -6, 5, 0], ["申請中", 1]], { 0: 1, 1: "?" }],
  ["C-552：認定なし（9 月分）→ 不正な要介護 3（10 月分）→ 要介護 1（翌 4 月から。11 月分）：10〜1 月は分からない（認定なしは復活しない）", [["認定なし", -1], ["要介護", 3, 0, "bad", 0], ["要介護", 1, 6, 9, 1]], { [-1]: 0, 0: "?", 1: "?", 3: "?" }],
  ["申請の結果ですか「はい」の期間つきの認定は申請中に勝つ", [["申請中", 0], ["要介護", 3, -1, 5, 0, "はい"]], { 0: 3, 1: 3 }],
  ["「いいえ（前からの認定）」「分からない」の期間つきの認定は申請中を捨てない（両方残って分からない）", [["申請中", 0], ["要介護", 3, -1, 5, 0, "いいえ"]], { 0: "?", 1: "?" }],
];

describe("careCertFor の名前つきの表", () => {
  for (const [name, specs, want] of TABLE) {
    it(name, () => {
      expect(Object.fromEntries(Object.keys(want).map((m) => [m, levelWith(rows)(specs, Number(m))]))).toEqual(want);
    });
    // forMonth を持たない今までの行（確かめた日の月で読む）でも同じ答え（X-420）
    it(`${name}（forMonth のない行）`, () => {
      expect(Object.fromEntries(Object.keys(want).map((m) => [m, levelWith(legacyRows)(specs, Number(m))]))).toEqual(want);
    });
  }
  it("表の月は基準月からのずれ（基準月は config/demo.json）", () => {
    expect(month(0)).toBe(YM);
  });
});

describe("careCertFor の総当たり（C-553・C-562）", () => {
  // 月の幅は 0〜5（6 か月の窓の切れ目と、認定が終わったあとの月を含む）。期間つきの行：0〜1 月で終わる要介護 3／0〜5 月の要介護 1（3 未満）／
  // 2 月から始まる要介護 3（始まりの日が違い、0・1 月には当たらない）／申請の結果「いいえ」の要介護 3（0〜5 月）／不正な日付。期間のない行：認定なし・申請中・分からない。答えた月は 0〜2
  const kinds: Spec[] = [0, 1, 2].flatMap((a): Spec[] => [
    ["要介護", 3, 0, 1, a],
    ["要介護", 1, 0, 5, a],
    ["要介護", 3, 2, 5, a],
    ["要介護", 3, 0, 5, a, "いいえ"],
    ["要介護", 3, 0, "bad", a],
    ["認定なし", a],
    ["申請中", a],
    ["分からない", a],
  ]);
  const MONTHS = [0, 1, 2, 3, 4, 5];
  const seqs: Spec[][] = [];
  for (const a of kinds) {
    seqs.push([a]);
    for (const b of kinds) {
      seqs.push([a, b]);
      for (const c of kinds) seqs.push([a, b, c]);
    }
  }
  /**
   * 設計の文から（実装の式は写さない）：行が語る月の一覧と、行の値（確定の値は "要介護3"・"認定なし"、ほかは null）。
   * 期間つきの認定は期間の月、認定なし・申請中は答えた月から 6 か月、分からないは答えた月だけ、不正な日付の行は答えた月から先のずっと（ここでは 0〜5 の範囲で）
   */
  const spoken = (s: Spec): { months: number[]; value: string | null } => {
    const range = (a: number, b: number) => MONTHS.filter((k) => k >= a && k <= b);
    if (s[0] === "要介護") {
      if (s[2] === "bad" || s[3] === "bad") return { months: range(answerOf(s), 99), value: null };
      return { months: range(s[2], s[3]), value: `要介護${s[1]}` };
    }
    if (s[0] === "分からない") return { months: [s[1]], value: null };
    return { months: range(s[1], s[1] + 5), value: s[0] === "認定なし" ? "認定なし" : null };
  };
  /**
   * 設計の文（v40・v41）：「行 X は、X の答えた月から M までのどれかの月について語る別の行 Y が、答えた月が X と同じか後で、かつ X より後に残したとき、M では捨てる」。
   * 例外：いいえ・分からないの期間つきの認定は申請中を捨てない（v40）／期間の重ならない認定どうしは捨て合わない（v41 (2)）／分からないは M について語るときだけ（C-533）
   */
  const isDiscarded = (seq: Spec[], xi: number, m: number): boolean => {
    const x = seq[xi];
    const window = MONTHS.filter((k) => k >= Math.min(answerOf(x), m) && k <= m);
    return seq.some((y, yi) => {
      const ys = spoken(y);
      const speaksInWindow = y[0] === "分からない" ? ys.months.includes(m) : ys.months.some((k) => window.includes(k));
      if (!speaksInWindow) return false;
      if (answerOf(y) < answerOf(x) || yi <= xi) return false;
      if (x[0] === "申請中" && y[0] === "要介護" && y[5] !== undefined && y[5] !== "はい") return false;
      const px = x[0] === "要介護" && x[2] !== "bad" && x[3] !== "bad" ? spoken(x).months : null;
      const py = y[0] === "要介護" && y[2] !== "bad" && y[3] !== "bad" ? ys.months : null;
      if (px && py && !px.some((k) => py.includes(k))) return false;
      return true;
    });
  };
  const valueOf = (st: CareState): string | null => {
    if (!st.known) return null;
    if (st.segments.length !== 1) return "区間";
    const g = st.segments[0];
    return g.kind === "認定なし" ? "認定なし" : g.kind === "要介護" ? `要介護${g.level}` : null;
  };

  it(`性質 1：値が出た月では、M について語る行のうち捨てられていない行はすべてその値を持つ（${seqs.length} 通り × ${MONTHS.length} か月）`, () => {
    const bad: string[] = [];
    for (const seq of seqs)
      for (const m of MONTHS) {
        const v = valueOf(careCertFor(rows(seq), month(m)));
        if (v === null) continue;
        const kept = seq.map((_, i) => i).filter((i) => spoken(seq[i]).months.includes(m) && !isDiscarded(seq, i, m));
        if (kept.length === 0 || kept.some((i) => spoken(seq[i]).value !== v)) bad.push(`${JSON.stringify(seq)} @${m} → ${v}`);
      }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it("性質 2（逆）：捨てられていない行の中に、値の違う行か、申請中・分からない・不正な行があれば、分からない（申請中だけなら申請中）", () => {
    const bad: string[] = [];
    for (const seq of seqs)
      for (const m of MONTHS) {
        const kept = seq.map((_, i) => i).filter((i) => spoken(seq[i]).months.includes(m) && !isDiscarded(seq, i, m));
        const values = new Set(kept.map((i) => spoken(seq[i]).value));
        if (!(kept.length === 0 || values.has(null) || values.size > 1)) continue;
        const st = careCertFor(rows(seq), month(m));
        if (st.known && !st.segments.every((g) => g.kind === "申請中")) bad.push(`${JSON.stringify(seq)} @${m} → ${JSON.stringify(st)}`);
      }
    expect(bad.slice(0, 5)).toEqual([]);
  });
});
