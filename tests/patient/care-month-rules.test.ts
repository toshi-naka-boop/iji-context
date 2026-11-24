// 認定の月の優先の規則（careCertFor。design.md §18-12 の 1）を、行の並びと診療月の表で縛る：X-370・X-380・C-530・C-533・X-400・X-401
import { describe, expect, it } from "vitest";
import { careCertFor, careLevelOf, type PatientFact } from "../../src/patient/facts";
import { month, YM } from "../helpers/period";

/** 行の書き方：要介護 n（始まり・終わりの月のずれ。終わりの日を "bad" にすると実在しない日）／認定なし・申請中・分からない（答えた月のずれ） */
type Spec = ["要介護", number, number, number | "bad"] | ["認定なし" | "申請中" | "分からない", number];
const rows = (specs: Spec[]): PatientFact[] =>
  specs.map((s, i) => {
    const base = { patientId: "P1", key: "careCert" as const, source: "介護保険証" as const, checkedAt: `${month(0)}-${String(10 + i).padStart(2, "0")}T09:00:00+09:00`, checkedBy: "new1" };
    if (s[0] === "要介護") return { ...base, value: { kind: "要介護", level: s[1], validFrom: `${month(s[2])}-01` }, validUntil: s[3] === "bad" ? `${month(4)}-30`.replace(/-\d\d$/, "-32") : `${month(s[3])}-28` };
    return { ...base, value: { kind: s[0], forMonth: month(s[1]) }, validUntil: null };
  });
/** 期待：数は careLevel（要介護 n→n、認定なし→0）、"?" は分からない */
const level = (specs: Spec[], m: number) => {
  const c = careLevelOf(careCertFor(rows(specs), month(m)), 3);
  return c.known ? c.value : "?";
};

// [名前, 行（残した順）, { 月のずれ: 期待 }]
const TABLE: [string, Spec[], Record<number, number | "?">][] = [
  ["認定なしは答えた月から 6 か月。前の月には効かない（X-354）", [["認定なし", 0]], { [-1]: "?", 0: 0, 5: 0, 6: "?" }],
  ["X-370：翌月からの要介護 3 のあとで、基準月の認定なしを答えても、翌月は 3", [["要介護", 3, 1, 7], ["認定なし", 0]], { 0: 0, 1: 3, 3: 3 }],
  ["X-380：要介護 1 を残したあと、翌月分で分からない → 翌月だけ分からない", [["要介護", 1, -9, 4], ["分からない", 1]], { 0: 1, 1: "?", 2: 1 }],
  ["X-380：同じ月の認定なしの訂正は、その月だけ", [["要介護", 1, -9, 4], ["認定なし", 1]], { 0: 1, 1: 0, 2: 1 }],
  ["C-530：前月の認定なし → 基準月の申請中 → 以降は分からない", [["認定なし", -1], ["申請中", 0]], { [-1]: 0, 0: "?", 1: "?", 2: "?" }],
  ["X-400：基準月の申請中を残したあとに、前月分の認定なしを残しても、基準月以降は分からない", [["申請中", 0], ["認定なし", -1]], { [-1]: 0, 0: "?", 1: "?" }],
  ["申請中のあとの月に答えた認定なしは効く（申請が却下された月など）", [["申請中", 0], ["認定なし", 1]], { 0: "?", 1: 0, 2: 0 }],
  ["同じ月の申請中のあとに残した認定なしは訂正として効く", [["申請中", 0], ["認定なし", 0]], { 0: 0, 1: 0 }],
  ["同じ月の認定なしのあとに残した申請中は、その月以降を断ち切る", [["認定なし", 0], ["申請中", 0]], { 0: "?", 1: "?" }],
  ["C-533：前月分の分からないは、基準月の認定なしを上書きしない", [["認定なし", 0], ["分からない", -1]], { [-1]: "?", 0: 0, 3: 0 }],
  ["C-533：基準月の分からないは、前月の認定なしをその月だけ上書きする", [["認定なし", -1], ["分からない", 0]], { [-1]: 0, 0: "?", 1: 0 }],
  ["X-401：期限が実在しない要介護 3 は、その期間を分からないにし、古い認定なしを復活させない", [["認定なし", -1], ["要介護", 3, 0, "bad"]], { [-1]: 0, 0: "?", 1: "?", 4: "?" }],
  ["X-401：同じ始まりの日で残し直せば（訂正）、効く", [["認定なし", -1], ["要介護", 3, 0, "bad"], ["要介護", 3, 0, 6]], { 0: 3, 1: 3 }],
];

describe("careCertFor の表", () => {
  for (const [name, specs, want] of TABLE) {
    it(name, () => {
      const got = Object.fromEntries(Object.keys(want).map((m) => [m, level(specs, Number(m))]));
      expect(got).toEqual(Object.fromEntries(Object.entries(want).map(([m, v]) => [m, v])));
    });
  }
  it("表の月は基準月からのずれ（基準月は config/demo.json）", () => {
    expect(month(0)).toBe(YM);
  });
});
