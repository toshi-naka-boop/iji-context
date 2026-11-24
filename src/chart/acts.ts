// カルテから取り出す「行ったこと」（acts）とその日の処方の記載（rx）の形と、決まった規則の検査（design.md §15-6。FR-192）。
// 取り出すのは AI（src/chart/extract.ts の同じ 1 回の呼び出し）。書かれた名前・量・引用はカルテの文字のまま。マスターを引く語（lookup）は候補出しにだけ使い、判定に使わない。
// この file は画面からも読むので、DB やマスターを読み込まない

export const ACT_CATEGORIES = ["診療行為", "検査", "処置", "注射", "投薬", "器材"] as const;
export type ActCategory = (typeof ACT_CATEGORIES)[number];
export const CHILD_KINDS = ["薬", "器材"] as const;
export type ChildKind = (typeof CHILD_KINDS)[number];

/** マスターの表（基本マスター 3 本） */
export const MASTER_TABLES = ["shinryo", "iyakuhin", "tokutei"] as const;
export type Tbl = (typeof MASTER_TABLES)[number];

/** 当てた結果。by：name＝名称の完全一致が 1 つ／alias＝前に選んだもの／candidate＝候補から選んだ／search＝探して選んだ／doctor＝医師の略語の答えの語の候補から選んだ（FR-211） */
export type ActMatch = { tbl: Tbl; code: string; name: string; by: "name" | "alias" | "candidate" | "search" | "doctor" };

/** abbrev：書かれた名前の分からない略語の印（FR-211。保存のときにサーバーが付け直す。src/chart/abbrev.ts） */
export type ActChild = { kind: ChildKind; written: string; lookup: string[]; quantity?: string; quote: string; match?: ActMatch | null; abbrev?: string[] };
export type ChartAct = {
  category: ActCategory;
  /** カルテに書かれた名前（書かれたとおり） */
  written: string;
  /** マスターを引く語（0〜5 個）。候補出しにだけ使う */
  lookup: string[];
  /** 書かれた回数・量を文字のまま */
  quantity?: string;
  /** カルテの文字をそのまま写した部分 */
  quote: string;
  with?: ActChild[];
  /** 確かめたあとだけ持つ（当てられないものは null） */
  match?: ActMatch | null;
  /** たたんだ印（design.md §16-3）。当てられない行為に本人が「同じ（ref の構造化データの行為）」「違う（same: false）」を選んだときだけ持つ */
  fold?: ActFold;
  /** 書かれた名前の分からない略語の印（FR-211。保存のときにサーバーが付け直す。画面から来た値は使わない） */
  abbrev?: string[];
};
/**
 * 医師に略語を聞く行為か（FR-211）：書かれた名前に印があり（印は名称の完全一致がないときだけ付く）、当てておらず、たたんでもいない。
 * 子（with）は、子に印があり当てておらず、親をたたんでいないとき
 */
/** 取り出した直後に画面に出す略語の印のまとめ（FR-211）：カルテの文全体の印の語と、医師に聞く記載の数。マスターがなければ「見ていません」の文 */
export type AbbrevSummary = { marks: string[]; asked: number } | { unseen: string };
/** 聞く記載の答えの状態（FR-211）：asking＝医師に確かめ中／unresolved＝医師が判定不能・その他と答えた／answered＝指すものの記入がある（候補から選ぶ） */
export type AbbrevState = "asking" | "unresolved" | "answered";
export const askedAct = (a: Pick<ChartAct, "abbrev" | "match" | "fold">): boolean => (a.abbrev?.length ?? 0) > 0 && !a.match && !a.fold;
export const askedChild = (a: Pick<ChartAct, "fold">, c: Pick<ActChild, "abbrev" | "match">): boolean => (c.abbrev?.length ?? 0) > 0 && !c.match && !a.fold;
/**
 * たたむ印（design.md §16-3）。kind：order＝構造化データの行為／rule＝規則で出す算定／device＝患者の情報の機器。by：rule＝規則でたたんだ／person＝本人が選んだ。
 * same が false の印は「違う」を選んだ記録（たたまない）
 */
export type ActFold = { kind: "order" | "rule" | "device"; ref?: string; by: "rule" | "person"; same?: false };
/** その日の処方の記載（文を写すだけ。院内か院外かは AI に分けさせない） */
export type RxNote = { quote: string };
/** その日の院内・院外（本人が選ぶ。初期値は src/chart/rx-default.ts） */
export type RxChoice = "outside" | "inside" | "unknown";

export const MAX_LOOKUP = 5;

const squash = (s: string) => s.replace(/\s+/g, "");
const str = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/** コードの形の語（数字だけの語・9 桁の数字を含む語）。LLM がコードを書いても候補出しに使わない */
const codeLike = (w: string) => {
  const n = w.normalize("NFKC").replace(/\s/g, "");
  return /^[0-9]+$/.test(n) || /[0-9]{9}/.test(n);
};

/** マスターを引く語の検査：配列でなければ空。空の語・コードの形の語・同じ語を捨て、5 個までにする（行為は捨てない） */
export function cleanLookup(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const w of raw) {
    if (!str(w) || codeLike(w)) continue;
    const t = w.trim();
    if (!out.includes(t)) out.push(t);
  }
  return out.slice(0, MAX_LOOKUP);
}

type Dropped = { fact: unknown; why: string };

/** 量の検査：文字が、その行の引用の中にあるときだけ残す（推し量って埋めない） */
function quantityOf(raw: unknown, quote: string, item: unknown, dropped: Dropped[], byPerson: boolean): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (byPerson && str(raw)) return raw.trim();
  if (!str(raw) || !squash(quote).includes(squash(raw))) {
    dropped.push({ fact: item, why: "量が引用の中にない（量だけを捨てた）" });
    return undefined;
  }
  return raw.trim();
}

/**
 * 取り出した「行ったこと」と処方の記載を検査する（決まった規則。validateFacts と同じ流儀）。
 * 形が違う・種類が範囲外・引用がカルテにない行為は捨てる（with の子も同じ。子を捨てても親は残す）。量は引用の中にない文字なら量だけ捨てる。
 * lookup は cleanLookup。rx は引用がカルテにあるものだけを残し、ほかの項目（form など）は持たない。match は持たせない（当てるのは手元。src/chart/match.ts）。
 * byPerson：本人が確かめて直した行為（保存のとき）。量は本人が直せるので、引用の中にあるかを見ない（引用がカルテにあるかは見る）
 */
export function validateActs(raw: unknown, noteText: string, byPerson = false): { acts: ChartAct[]; rx: RxNote[]; dropped: Dropped[] } {
  const text = squash(noteText);
  const inNote = (q: string) => text.includes(squash(q));
  const o = (raw ?? {}) as { acts?: unknown; rx?: unknown };
  const acts: ChartAct[] = [];
  const rx: RxNote[] = [];
  const dropped: Dropped[] = [];
  for (const a of Array.isArray(o.acts) ? o.acts : []) {
    const x = a as Partial<Record<keyof ChartAct, unknown>> | null;
    if (!x || !str(x.written) || !str(x.quote)) dropped.push({ fact: a, why: "形が違う" });
    else if (!(ACT_CATEGORIES as readonly string[]).includes(x.category as string)) dropped.push({ fact: a, why: "取り出す種類の外" });
    else if (!inNote(x.quote)) dropped.push({ fact: a, why: "カルテにない言葉から取っている" });
    else {
      const quote = x.quote.trim();
      const act: ChartAct = { category: x.category as ActCategory, written: x.written.trim(), lookup: cleanLookup(x.lookup), quote };
      const q = quantityOf(x.quantity, quote, a, dropped, byPerson);
      if (q !== undefined) act.quantity = q;
      const children: ActChild[] = [];
      for (const c of Array.isArray(x.with) ? x.with : []) {
        const y = c as Partial<Record<keyof ActChild, unknown>> | null;
        if (!y || !str(y.written) || !str(y.quote)) dropped.push({ fact: c, why: "形が違う" });
        else if (!(CHILD_KINDS as readonly string[]).includes(y.kind as string)) dropped.push({ fact: c, why: "取り出す種類の外" });
        else if (!inNote(y.quote)) dropped.push({ fact: c, why: "カルテにない言葉から取っている" });
        else {
          const cq = y.quote.trim();
          const child: ActChild = { kind: y.kind as ChildKind, written: y.written.trim(), lookup: cleanLookup(y.lookup), quote: cq };
          const qq = quantityOf(y.quantity, cq, c, dropped, byPerson);
          if (qq !== undefined) child.quantity = qq;
          children.push(child);
        }
      }
      if (children.length > 0) act.with = children;
      acts.push(act);
    }
  }
  for (const r of Array.isArray(o.rx) ? o.rx : []) {
    const q = (r as { quote?: unknown } | null)?.quote;
    if (!str(q)) dropped.push({ fact: r, why: "形が違う" });
    else if (!inNote(q)) dropped.push({ fact: r, why: "カルテにない言葉から取っている" });
    else rx.push({ quote: q.trim() });
  }
  return { acts, rx, dropped };
}

/** 引く表（category で決める）。投薬は医薬品と医科診療行為の第5部 投薬（区分番号 F。C-224）、器材は特定器材、ほかは医科診療行為 */
export type TableKey = "shinryo" | "iyakuhin" | "tokutei" | "toyaku";
export const TABLE_KEYS = ["shinryo", "iyakuhin", "tokutei", "toyaku"] as const;
export const tableKeyOfAct = (c: ActCategory): TableKey => (c === "投薬" ? "toyaku" : c === "器材" ? "tokutei" : "shinryo");
export const tableKeyOfChild = (k: ChildKind): TableKey => (k === "薬" ? "iyakuhin" : "tokutei");

/**
 * 確かめる画面での並べ方（design.md §15-7。C-221・C-213・C-233）。請求は見ない（引数に請求を持たない）。
 * show＝当てる一覧に出す／hidden＝見ない薬（たたむ。消す・直すだけ）／optional＝院内の日の投薬の組で、名前で当たらない薬（選ぶのは任意）。
 * 投薬で第5部に当たったもの（投薬の手技）と、投薬でない行為、with の子（手技の薬・器材）はいつも show
 */
export type Fold = "show" | "hidden" | "optional";
export function foldOfAct(act: Pick<ChartAct, "category">, initial: ActMatch | null, dispensing: RxChoice, rxChoice: RxChoice | null): Fold {
  if (act.category !== "投薬" || initial?.tbl === "shinryo") return "show";
  const seen = dispensing === "inside" && rxChoice === "inside";
  if (!seen) return "hidden";
  return initial ? "show" : "optional";
}

/** 保存する形（chart_notes.acts の JSON）。rxChoice は院内処方もある施設で処方の記載がある日だけ持つ。rxChoiceBy：規則で出た初期値のままか、本人が直したか（判定には使わない） */
export type StoredActs = {
  acts: ChartAct[];
  rx: RxNote[];
  rxChoice: RxChoice | null;
  rxChoiceBy: "rule" | "person" | null;
  /**
   * 処方の日の「確かめた」の印（design.md §16-4-1。C-410）。本人が欄の値を選び直したとき、または「この日の院内・院外を確かめた」を押したときだけ付く（初期値のまま保存しただけでは付かない）。
   * rxHash はそのときの処方の文の指紋で、文が変わったら印はないものとして読む
   */
  rxConfirmed?: { by: string; at: string; rxHash: string } | null;
  /**
   * 略語の印（FR-211）：marks はカルテの文全体の印の語（S・O だけの語を含む。数を出すだけ）、at は保存した日時（医師への問いの営業日を数える起点）。
   * noMaster はマスターがない・版のない診療年月で、印を付けていない（見ていません）
   */
  abbrev?: { marks: string[]; at: string } | { noMaster: true; at: string };
};
