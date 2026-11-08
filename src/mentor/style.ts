// 伝え方のタイプ（spec FR-20・決定25）：本人の自己申告を任意で受け付ける。診断はしない。
// 話し方の好み（選択式）と 16 タイプ（任意）を、メンターへの指示に「本人の申告」として入れる
export const PREFERENCES = ["結論から短く", "順を追って丁寧に", "励まし多めで", "一緒に考える問いかけで"] as const;
export const TYPES16 = ["INTJ", "INTP", "ENTJ", "ENTP", "INFJ", "INFP", "ENFJ", "ENFP", "ISTJ", "ISFJ", "ESTJ", "ESFJ", "ISTP", "ISFP", "ESTP", "ESFP"] as const;

export type Style = { preference?: (typeof PREFERENCES)[number]; type16?: (typeof TYPES16)[number] };

export function validateStyle(s: Style): Style {
  if (s.preference !== undefined && !(PREFERENCES as readonly string[]).includes(s.preference)) throw new Error(`話し方の好みが不正: ${s.preference}`);
  if (s.type16 !== undefined && !(TYPES16 as readonly string[]).includes(s.type16)) throw new Error(`16 タイプが不正: ${s.type16}`);
  return { ...(s.preference ? { preference: s.preference } : {}), ...(s.type16 ? { type16: s.type16 } : {}) };
}

/** 指示に入れる行（申告がなければ空） */
export function styleLines(s: Style | undefined): string[] {
  if (!s?.preference && !s?.type16) return [];
  return [
    "",
    "相手の伝え方の好み（本人の申告。診断ではない。守ることと食い違うときは、守ることを優先する）：",
    ...(s.preference ? [`- 話し方の好み：${s.preference}。ヒントや解説の伝え方をこれに合わせる`] : []),
    ...(s.type16 ? [`- 本人が申告した 16 タイプ：${s.type16}。伝え方の参考にするだけで、性格を決めつけたり、タイプを話題にしたりしない`] : []),
  ];
}
