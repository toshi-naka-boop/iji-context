// FR-207 の表（design.md §16-4-8。FR-210 のテストの範囲）の升の id。升の中に (1)(2) と番号を振った条件は、それぞれ別の id（round-65 C-413）。
// 全部の id に 1 件以上のテストがあることを、テストで確かめる（tests/generic/g11-structured.test.ts。段 19f で T8〜T15 を足して表の網羅を確かめる）
const COLUMNS = ["出る", "包括で出ない", "背反で出ない", "在医総管の月で出ない", "項目が取れず見ない", "そのほか出ない"] as const;

/** 升の中に番号のある列（列 → 番号の数） */
const NUMBERED: Record<string, Partial<Record<(typeof COLUMNS)[number], number>>> = {
  T6: { 背反で出ない: 4, 項目が取れず見ない: 10 },
};

/** 段 19c で入れた行（T1〜T6） */
export const FR207_ROWS = ["T1", "T2", "T3", "T4", "T5", "T6"] as const;

export const FR207_CELLS: readonly string[] = FR207_ROWS.flatMap((row) =>
  COLUMNS.flatMap((col) => {
    const n = NUMBERED[row]?.[col];
    return n ? Array.from({ length: n }, (_, i) => `${row}-${col}-${i + 1}`) : [`${row}-${col}`];
  }),
);
