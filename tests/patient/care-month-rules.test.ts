// 認定の月の優先の規則（careCertFor。design.md §18-12 の 1「月の優先の規則の置き換え」。v39）を、名前つきの表と総当たりで縛る
import { describe, expect, it } from "vitest";
import { careCertFor, careLevelOf, type CareState, type PatientFact } from "../../src/patient/facts";
import { month, YM } from "../helpers/period";

/**
 * 行の書き方：
 *  要介護 n：[始まりの月のずれ（"bad" は実在しない日）, 終わりの月のずれ（その月の末日。"bad" は実在しない日）, 答えた月のずれ（省くと始まりの月）]
 *  認定なし・申請中・分からない：答えた月のずれ
 */
type Spec = ["要介護", number, number | "bad", number | "bad", number?] | ["認定なし" | "申請中" | "分からない", number];
const lastDay = (m: number) => {
  const [y, mm] = month(m).split("-").map(Number);
  return `${month(m)}-${String(new Date(Date.UTC(y, mm, 0)).getUTCDate()).padStart(2, "0")}`;
};
const rows = (specs: Spec[]): PatientFact[] =>
  specs.map((s, i) => {
    const base = { patientId: "P1", key: "careCert" as const, source: "介護保険証" as const, checkedAt: `${month(0)}-${String(10 + (i % 18)).padStart(2, "0")}T09:00:00+09:00`, checkedBy: "new1" };
    if (s[0] === "要介護") {
      const [, level, f, u, a] = s;
      const validFrom = f === "bad" ? `${month(0).slice(0, 4)}-02-30` : `${month(f)}-01`;
      const validUntil = u === "bad" ? `${month(4)}-32` : lastDay(u);
      return { ...base, value: { kind: "要介護", level, validFrom, forMonth: month(a ?? (f === "bad" ? 0 : f)) }, validUntil };
    }
    return { ...base, value: { kind: s[0], forMonth: month(s[1]) }, validUntil: null };
  });
/** 期待：数は careLevel（要介護 n→n、認定なし→0）、"?" は分からない（申請中も R03 には分からない） */
const level = (specs: Spec[], m: number) => {
  const c = careLevelOf(careCertFor(rows(specs), month(m)), 3);
  return c.known ? c.value : "?";
};

// [名前, 行（残した順）, { 月のずれ: 期待 }]
const TABLE: [string, Spec[], Record<number, number | "?">][] = [
  ["認定なしは答えた月から 6 か月。前の月には効かない（X-354）", [["認定なし", 0]], { [-1]: "?", 0: 0, 5: 0, 6: "?" }],
  ["X-370：翌月からの要介護 3（翌月に答えた）のあとで、基準月の認定なしを答えても、翌月は 3", [["要介護", 3, 1, 7], ["認定なし", 0]], { 0: 0, 1: 3, 3: 3 }],
  ["X-380：要介護 1 を残したあと、翌月分で分からない → 翌月だけ分からない", [["要介護", 1, -9, 4], ["分からない", 1]], { 0: 1, 1: "?", 2: 1 }],
  ["要介護 1 を残したあと、翌月分で認定なしを答えると、月と残した順で最新なので翌月から 0（v39 (a)）", [["要介護", 1, -9, 4], ["認定なし", 1]], { 0: 1, 1: 0, 2: 0 }],
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
  ["X-411：開始日が実在しない行を、正しい開始日で残し直せば、不正な行は消えたとみなす", [["要介護", 3, "bad", 4], ["要介護", 3, -7, 4, 0]], { [-1]: 3, 0: 3, 1: 3 }],
  ["(d)：不正な行は、あとに残した前の月の「認定なし」では消えない（その期間は分からない）", [["要介護", 3, "bad", 4], ["認定なし", -1]], { [-1]: 0, 0: "?", 1: "?" }],
  ["認定なし 10 月 → 要介護 3（11/1〜1/31）で、2・3 月は分からない（認定なしは復活しない）", [["認定なし", 0], ["要介護", 3, 1, 3]], { 0: 0, 1: 3, 3: 3, 4: "?", 5: "?" }],
];

describe("careCertFor の名前つきの表", () => {
  for (const [name, specs, want] of TABLE) {
    it(name, () => {
      expect(Object.fromEntries(Object.keys(want).map((m) => [m, level(specs, Number(m))]))).toEqual(want);
    });
  }
  it("表の月は基準月からのずれ（基準月は config/demo.json）", () => {
    expect(month(0)).toBe(YM);
  });
});

describe("careCertFor の総当たり（行の種類 4 つと不正な日付 × 3 か月 × 3 行まで × 残す順のすべて）", () => {
  // 行の種類：期間つき（基準月から 2 か月後の末日まで。答えた月を 0〜2）・不正な日付（答えた月を 0〜2）・認定なし・申請中・分からない（答えた月を 0〜2）
  const kinds: Spec[] = [0, 1, 2].flatMap((a): Spec[] => [["要介護", 3, 0, 2, a], ["要介護", 3, 0, "bad", a], ["認定なし", a], ["申請中", a], ["分からない", a]]);
  const seqs: Spec[][] = [];
  for (const a of kinds) {
    seqs.push([a]);
    for (const b of kinds) {
      seqs.push([a, b]);
      for (const c of kinds) seqs.push([a, b, c]);
    }
  }
  const answerMonth = (s: Spec) => (s[0] === "要介護" ? (s[4] as number) : s[1]);
  const invalid = (s: Spec) => s[0] === "要介護" && (s[2] === "bad" || s[3] === "bad");
  const isNone = (st: CareState) => st.known && st.segments.length === 1 && st.segments[0].kind === "認定なし";

  it(`性質 1：認定なし（0）が効く月には、それより後の月か後に残した申請中・期間つきの認定・（消えていない）不正な行がない（${seqs.length} 通り × 3 か月）`, () => {
    const bad: string[] = [];
    for (const seq of seqs)
      for (const m of [0, 1, 2]) {
        if (!isNone(careCertFor(rows(seq), month(m)))) continue;
        // 消えていない行（不正な行は、後に残した期間つきの行があれば消えたとみなす）
        const live = seq.map((s, i) => ({ s, i })).filter(({ s, i }) => !invalid(s) || !seq.slice(i + 1).some((x) => x[0] === "要介護"));
        const nones = live.filter(({ s }) => s[0] === "認定なし" && answerMonth(s) <= m && m <= answerMonth(s) + 5);
        const ok = nones.some((h) => live.every(({ s, i }) => s[0] === "認定なし" || s[0] === "分からない" || answerMonth(s) > m || (answerMonth(s) <= answerMonth(h.s) && i < h.i)));
        if (!ok) bad.push(`${JSON.stringify(seq)} @${m}`);
      }
    expect(bad).toEqual([]);
  });

  it("性質 2：最後に残した行がその月について答えた期間のない行なら、その月にはそれが効く（分からない→分からない、申請中→申請中、認定なし→認定なし）", () => {
    const bad: string[] = [];
    for (const seq of seqs) {
      const last = seq[seq.length - 1];
      if (last[0] === "要介護") continue;
      const m = last[1];
      const st = careCertFor(rows(seq), month(m));
      const got = !st.known ? "分からない" : st.segments[0].kind;
      if (got !== last[0]) bad.push(`${JSON.stringify(seq)} → ${got}`);
    }
    expect(bad).toEqual([]);
  });
});
