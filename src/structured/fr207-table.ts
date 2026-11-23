// FR-207 の表（design.md §16-4-8。FR-210 のテストの範囲）の升の id。升の中に (1)(2) と番号を振った条件は、それぞれ別の id（round-65 C-413）。
// 全部の id に 1 件以上のテストがあることを、テストで確かめる（tests/generic/g11-structured.test.ts。段 19f の tests/structured/fr207-table.test.ts が、テストの名前を集めて表の網羅を確かめる）
const COLUMNS = ["出る", "包括で出ない", "背反で出ない", "在医総管の月で出ない", "項目が取れず見ない", "そのほか出ない"] as const;

/** 升の中に番号のある列（列 → 番号の数） */
const NUMBERED: Record<string, Partial<Record<(typeof COLUMNS)[number], number>>> = {
  T6: { 背反で出ない: 4, 項目が取れず見ない: 10 },
  T7: { 項目が取れず見ない: 2 },
};

/** 段 19c・19d で入れた行（T1〜T7）と、段 19e で入れた材料加算の行（T8〜T15） */
export const FR207_ROWS = ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9", "T10", "T11", "T12", "T13", "T14", "T15"] as const;

export const FR207_CELLS: readonly string[] = FR207_ROWS.flatMap((row) =>
  COLUMNS.flatMap((col) => {
    const n = NUMBERED[row]?.[col];
    return n ? Array.from({ length: n }, (_, i) => `${row}-${col}-${i + 1}`) : [`${row}-${col}`];
  }),
);
