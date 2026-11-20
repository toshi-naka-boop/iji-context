// 傷病名 → 傷病名マスターのコード（design.md §11-1）。EM §2-8「傷病名」の表で、基本名称が完全一致した行だけ（修飾語は使わない）。
// 表にない傷病名は、未コード化（0000999）で名称を書く。マスターは同梱しない

/** 未コード化傷病名のコード */
export const UNCODED_DISEASE = "0000999";

export const DISEASE_CODES: Record<string, string> = {
  慢性心不全: "4289018",
  高血圧症: "8833421",
  "２型糖尿病": "2500015",
  脳梗塞後遺症: "4389014",
  パーキンソン病: "3320002",
  心房細動: "4273006",
};

const NAME_OF = new Map(Object.entries(DISEASE_CODES).map(([name, code]) => [code, name]));

/** 書き出しに使う傷病名コード（表になければ未コード化） */
export const diseaseCodeOf = (name: string): string => (Object.hasOwn(DISEASE_CODES, name) ? DISEASE_CODES[name] : UNCODED_DISEASE);

/** 傷病名コードの名称（表にあるコードだけ。ほかは null） */
export const diseaseNameOf = (code: string): string | null => NAME_OF.get(code) ?? null;
