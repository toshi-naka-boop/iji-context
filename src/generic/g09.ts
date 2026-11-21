// G09 適応・併用（design.md §12-3）：審査支払機関が公開しているチェックマスタ（［チ］＝コンピュータチェック対象事例 仕様書。列の意味は src/masters/layout.ts）で、
// レセプトの医薬品・診療行為が「コンピュータチェックの対象」に当たるかを見る。指摘は全部、条件つき（言い切りの文を持たない）：公開元が、コンピュータチェックは診療内容の適否について
// 一律に適用するものではなく、個別の症例ごとに審査委員会が判断する、と断っている（公開のページ・更新内容の資料。EM §2-11）。指摘が出ても、査定されると決まったわけではない。
// 作ったもの：
//   iy_no_disease＝医薬品適応関連マスタに傷病名の行がある薬で、表の傷病名コードのどれも、レセプトの傷病名（SY）にない
//   si_no_disease＝医科診療行為傷病名関連マスタに行がある診療行為で、同じ／si_suspected＝表の傷病名が、疑い病名としてだけある（表が、その行為には確定病名だけを対象にしている）
//   heiyo_kinki＝医薬品併用禁忌関連マスタにある組が、同じ日に両方ある（公開元の事例は「同日に算定された場合」。表には、併用禁忌のほかに併用注意などの組も入っていて、どれかは表から分からない）
// 作っていないもの（点検の範囲に「していない」と出す）：量と日数（最大投与量・最長投与日数。単位と、1 日あたりか・どの期間かが仕様書に書かれていない。投与量グループ・漫然投与グループの表は
//   取り込んでいない）、傷病名との禁忌（表を取り込んでいない）、性別・年齢の条件の読み分け（列の読み方を、値ごとに原文で確かめられていない）、同じ成分の薬をまとめること
// 言わない場合（正しい請求に出さない側に倒す）：
//   表に載っていない薬・診療行為（チェックの対象外。「問題なし」とも言わない。点検の範囲に数を出す）。廃止でない行が 1 つもないコードも同じ
//   未コード化の傷病名（0000999）か、持っているマスターにない傷病名コードが SY にあるレセプト（名前では当てない）、傷病名を持たない請求（区分キーの行）
//   院外処方の薬（医科のレセプトに載らない。L-66）
//   性別・年齢の条件つきの行（性別 0 以外、年齢が 000.00〜999.99 以外。廃止でない傷病名の行）が 1 つでもある薬・診療行為の適応（条件を読めないので、その薬・診療行為には言わない。
//   点検の範囲に数を出す。公開元の事例は「添付文書に記載された年齢〔性別〕に適応となる傷病名が記載されてない場合」で、条件を読まないと、当たり・外れのどちらも決まらない）
// 数え方：SY のコードと表の傷病名コードの完全一致（修飾語は見ない）。廃止の行も、当たりに数える。転帰のある傷病名も数える（SY に転帰の日付がなく、
//   診療年月より前に終わったかが決まらない。G08 と同じ）。疑い病名（修飾語 8002）は、薬では数える（表に列がない）。診療行為では、表の「疑い病名」が 1（確定病名のみ）の行にだけ、数えない
// 同じコードが複数の単位・複数の日にあっても、指摘はコードごとに 1 件（当たる単位は units に全部入れる）
import { nameOf, pickSnapshot, shinryoOf, sourcesOf, type MastersDb } from "../masters/db";
import { UNCODED_DISEASE } from "../uke/diseases";
import type { GenericTiming } from "./tensuhyo";
import type { GenericAbout, GenericAboutMore, GenericCheck, GenericClaim, GenericFinding } from "./types";

/** 指摘の出どころに出す表の名前（［チ］p2 の呼び名） */
export const CM_TABLE = { tekio: "チェックマスタ 医薬品適応関連マスタファイル", si: "チェックマスタ 医科診療行為傷病名関連マスタファイル", heiyo: "チェックマスタ 医薬品併用禁忌関連マスタファイル" } as const;

/** 文に並べる、表の傷病名の数（多いときは、先頭のいくつかと残りの数） */
const SHOWN = 3;
/** レセプトの傷病名がこの数までなら、傷病名ごとに索引で引く。超えたら、表の側を読む */
const LOOKUPS = 50;
/** 傷病名コードの行（0000000＝傷病名を条件にしない量・日数、0000001〜3＝外れ値 は、傷病名ではない。［チ］p18） */
const REAL = "0000003";
/** 公開元が「令和8年度診療報酬改定に伴う新規事例の公開は次回以降」としている版（更新内容の資料 2026年10月30日現在。EM §2-11） */
const BEFORE_R8_CASES: ReadonlySet<string> = new Set(["20261030"]);

/** 適応を点検しない理由：none＝傷病名を持たない／uncoded＝未コード化の傷病名がある／unknown＝マスターにない傷病名コードがある */
type Why = "none" | "uncoded" | "unknown";
/** 見た数：all＝レセプトにあるコードの数（重複を除く）、inTable＝そのうち表にあるコード、conditioned＝そのうち性別・年齢の条件つきの行があるので適応を見なかったコード */
type Seen = { all: number; inTable: number; conditioned: number };
export type G09Look = { findings: GenericFinding[]; iy: Seen; si: Seen; why: Why | null; snapshot: string; later: boolean; shohosen: boolean };

/** コード → そのコードのある単位（請求の units の添字） */
function unitsOf(claim: GenericClaim, kind: "SI" | "IY"): Map<string, number[]> {
  const seen = new Map<string, number[]>();
  claim.units.forEach((u, i) => {
    for (const it of u.items) {
      if (it.kind !== kind) continue;
      const units = seen.get(it.code) ?? [];
      if (!units.includes(i)) units.push(i);
      seen.set(it.code, units);
    }
  });
  return seen;
}

/**
 * レセプトのコードを表で引く。診療年月の世代のチェックマスタ・傷病名マスターがなければ skip。
 * 点検の範囲（g09NotDone）と数える道具（scripts/measure-generic.ts）も、これを読む
 */
export function g09Look(claim: GenericClaim, masters: MastersDb, about: GenericAbout): G09Look | { skip: string } {
  const pick = pickSnapshot(masters, "checkmaster", about.yearMonth, about.generation);
  if (pick === null) return { skip: `診療年月の世代（${about.generation}）のチェックマスタがありません` };
  const snap = { shobyo: pickSnapshot(masters, "shobyo", about.yearMonth, about.generation)?.snapshot ?? null, iyakuhin: pickSnapshot(masters, "iyakuhin", about.yearMonth, about.generation)?.snapshot ?? null, shinryo: pickSnapshot(masters, "shinryo", about.yearMonth, about.generation)?.snapshot ?? null };
  if (snap.shobyo === null) return { skip: `診療年月の世代（${about.generation}）の傷病名のマスターがありません` };
  const s = pick.snapshot;
  const drugs = unitsOf(claim, "IY");
  const acts = unitsOf(claim, "SI");
  const out: G09Look = { findings: [], iy: { all: drugs.size, inTable: 0, conditioned: 0 }, si: { all: acts.size, inTable: 0, conditioned: 0 }, why: null, snapshot: s, later: pick.later, shohosen: false };

  // レセプトの傷病名。confirmed＝疑い病名でない記載が 1 つでもあるコード
  const diseases = (about as GenericAboutMore).diseases;
  const codes = new Set<string>();
  const confirmed = new Set<string>();
  if (diseases === undefined) out.why = "none";
  else if (diseases.some((d) => d.code === UNCODED_DISEASE)) out.why = "uncoded";
  else {
    const known = masters.prepare("SELECT 1 FROM shobyo WHERE snapshot = ? AND code = ?");
    for (const d of diseases) {
      if (!known.get(snap.shobyo, d.code)) out.why = "unknown";
      codes.add(d.code);
      if (d.suspected !== true) confirmed.add(d.code);
    }
  }
  const diseaseName = (code: string): string => {
    const name = nameOf(masters, "shobyo", snap.shobyo!, code);
    return name ? `「${name}」（${code}）` : code;
  };
  /** 表の傷病名（廃止でない行）の数と、先頭のいくつか（コードの順。名称を出せるように、持っている傷病名マスターにあるコードを先に並べる） */
  const listed = (table: "cm_tekio" | "cm_si_shobyo", code: string): { count: string; shown: string; diseases: string } => {
    const n = (masters.prepare(`SELECT count(DISTINCT shobyo) AS n FROM ${table} WHERE snapshot = ? AND code = ? AND shobyo > ? AND change <> '9'`).get(s, code, REAL) as { n: number }).n;
    const first = (masters.prepare(`SELECT DISTINCT c.shobyo FROM ${table} c WHERE c.snapshot = ? AND c.code = ? AND c.shobyo > ? AND c.change <> '9' ORDER BY NOT EXISTS (SELECT 1 FROM shobyo m WHERE m.snapshot = ? AND m.code = c.shobyo), c.shobyo LIMIT ${SHOWN}`).all(s, code, REAL, snap.shobyo) as { shobyo: string }[]).map((r) => r.shobyo);
    return { count: String(n), shown: first.join(","), diseases: `${first.map(diseaseName).join("、")}${n > first.length ? ` ほか ${n - first.length} 件` : ""}` };
  };

  /**
   * 表の、そのコードの行のうち、傷病名がレセプトにあるもの。ふつうは、レセプトの傷病名ごとに索引で引く。傷病名が多いレセプトでは、表の側（1 つのコードの行）を読む
   * （細工したレセプトでも、引く回数が コードの数 × 傷病名の数 に膨らまない）
   */
  const matcher = (table: "cm_tekio" | "cm_si_shobyo", cols: string) => {
    const one = masters.prepare(`SELECT ${cols} FROM ${table} WHERE snapshot = ? AND code = ? AND shobyo = ?`);
    const all = masters.prepare(`SELECT ${cols} FROM ${table} WHERE snapshot = ? AND code = ? AND shobyo > ?`);
    return (code: string): { shobyo: string; utagai?: string }[] =>
      codes.size <= LOOKUPS ? [...codes].flatMap((d) => (d > REAL ? (one.all(s, code, d) as { shobyo: string }[]) : [])) : (all.all(s, code, REAL) as { shobyo: string }[]).filter((r) => codes.has(r.shobyo));
  };

  /** 性別・年齢の条件つきの行（廃止でない傷病名の行）があるか。あれば、そのコードの適応は見ない */
  const conditioned = (table: "cm_tekio" | "cm_si_shobyo") => masters.prepare(`SELECT 1 FROM ${table} WHERE snapshot = ? AND code = ? AND shobyo > ? AND change <> '9' AND (sex <> '0' OR age_lower <> 0 OR age_upper <> 999.99) LIMIT 1`);

  // 適応（医薬品）
  const inTekio = masters.prepare("SELECT 1 FROM cm_tekio WHERE snapshot = ? AND code = ? AND shobyo > ? AND change <> '9' LIMIT 1");
  const condTekio = conditioned("cm_tekio");
  const hitTekio = matcher("cm_tekio", "shobyo");
  for (const [code, units] of drugs) {
    if (!inTekio.get(s, code, REAL)) continue;
    out.iy.inTable++;
    if (condTekio.get(s, code, REAL)) {
      out.iy.conditioned++;
      continue;
    }
    if (out.why !== null || hitTekio(code).length > 0) continue;
    out.findings.push({
      check: "G09",
      kind: "適応",
      certainty: "条件つき",
      units,
      codes: [code],
      messageKey: "G09.iy_no_disease",
      params: { code, name: (snap.iyakuhin && nameOf(masters, "iyakuhin", snap.iyakuhin, code)) || "名称は、持っているマスターにありません", ...listed("cm_tekio", code) },
      source: { data: CM_TABLE.tekio, ref: `医薬品コード=${code}` },
    });
  }

  // 適応（診療行為）。処方箋料（F400）の行があるかも、ここで見る
  const inSi = masters.prepare("SELECT 1 FROM cm_si_shobyo WHERE snapshot = ? AND code = ? AND change <> '9' LIMIT 1");
  const condSi = conditioned("cm_si_shobyo");
  const hitSi = matcher("cm_si_shobyo", "shobyo, utagai");
  for (const [code, units] of acts) {
    const row = snap.shinryo ? shinryoOf(masters, snap.shinryo, code) : null;
    if (row?.alpha === "F" && row.kubun_no === 400) out.shohosen = true;
    if (!inSi.get(s, code)) continue;
    out.si.inTable++;
    if (condSi.get(s, code, REAL)) {
      out.si.conditioned++;
      continue;
    }
    if (out.why !== null) continue;
    // 表が確定病名だけを対象にしている行（疑い病名 1）は、確定の記載があるときだけ当たり。suspected＝疑い病名としてだけあった、表の傷病名
    const suspected: string[] = [];
    let hit = false;
    for (const r of hitSi(code)) {
      if (r.utagai !== "1" || confirmed.has(r.shobyo)) hit = true;
      else if (!suspected.includes(r.shobyo)) suspected.push(r.shobyo);
    }
    if (hit) continue;
    out.findings.push({
      check: "G09",
      kind: "適応",
      certainty: "条件つき",
      units,
      codes: [code],
      messageKey: suspected.length > 0 ? "G09.si_suspected" : "G09.si_no_disease",
      params: { code, name: row?.name ?? "名称は、持っているマスターにありません", ...listed("cm_si_shobyo", code), ...(suspected.length > 0 ? { found: suspected.map(diseaseName).join("、") } : {}) },
      source: { data: CM_TABLE.si, ref: `医科診療行為コード=${code}` },
    });
  }

  // 併用：表の組が、同じ日に両方ある。算定日の分からない単位は見ない
  const pairsOf = masters.prepare("SELECT code_r FROM cm_heiyo_kinki WHERE snapshot = ? AND code_l = ? AND change <> '9'");
  const daysOf = (units: number[]): Set<number> => new Set(units.flatMap((u) => ((claim.units[u] as GenericTiming).days ?? []).flatMap((n, i) => (n > 0 ? [i + 1] : []))));
  const done = new Set<string>();
  for (const [a, unitsA] of drugs) {
    for (const { code_r: b } of pairsOf.all(s, a) as { code_r: string }[]) {
      const unitsB = drugs.get(b);
      const key = [a, b].sort().join("/");
      if (unitsB === undefined || a === b || done.has(key)) continue;
      done.add(key);
      const daysB = daysOf(unitsB);
      const days = [...daysOf(unitsA)].filter((d) => daysB.has(d)).sort((x, y) => x - y);
      if (days.length === 0) continue;
      const name = (code: string) => (snap.iyakuhin && nameOf(masters, "iyakuhin", snap.iyakuhin, code)) || "名称は、持っているマスターにありません";
      out.findings.push({
        check: "G09",
        kind: "適応",
        certainty: "条件つき",
        units: [...new Set([...unitsA, ...unitsB])].sort((x, y) => x - y),
        codes: [a, b],
        messageKey: "G09.heiyo_kinki",
        params: { a, b, nameA: name(a), nameB: name(b), days: days.join("・") },
        source: { data: CM_TABLE.heiyo, ref: `医薬品コード（Ｌ）=${a}, 医薬品コード（Ｒ）=${b}` },
      });
    }
  }
  return out;
}

/** チェックマスタの 1 枚についての断り書き（src/generic/lookup.ts の sheetNotesOf と同じ意味） */
export function checkmasterNotesOf(db: MastersDb, about: GenericAbout): { later: boolean; newer: boolean } {
  const pick = pickSnapshot(db, "checkmaster", about.yearMonth, about.generation);
  if (pick === null) return { later: false, newer: false };
  return { later: pick.later, newer: sourcesOf(db).some((x) => x.dataset === "checkmaster" && x.snapshot === pick.snapshot && x.verified !== null && x.snapshot > x.verified) };
}

const WHY_TEXT: Record<Why, string> = {
  none: "適応・併用は、傷病名と薬の行を持つレセプトにだけ掛けます。ここの行には傷病名が付いていないので、点検していません",
  uncoded: "未コード化の傷病名（0000999）があるので、適応は点検していません（名称では当てません）",
  unknown: "持っているマスターにない傷病名コードがあるので、適応は点検していません",
};

/** G09 の見出しの下に出す、公開元の但し書きの趣旨（自分の言葉。原文は写さない） */
export const G09_CAVEAT = "審査支払機関のコンピュータチェックは、診療内容の適否を一律に決めるものではなく、症例ごとに審査委員会が判断するとされています。ここに出るのは「チェックの対象に当たる」ことだけで、査定されると決まったわけではありません。何も出ないことも、問題がないという意味ではありません";

/** G09 が見たもの・見ていないもの（点検の範囲の説明に出す。数は、このレセプトの行について） */
export function g09NotDone(claim: GenericClaim, masters: MastersDb, about: GenericAbout): string[] {
  const r = g09Look(claim, masters, about);
  if ("skip" in r) return [];
  // 傷病名を持たない請求（区分キーの行。薬の行もない）は、掛けていないことだけを言う
  if (r.why === "none") return [WHY_TEXT.none];
  return [
    `適応・併用：${G09_CAVEAT}`,
    `適応の表にある薬 ${r.iy.inTable}／レセプトの薬 ${r.iy.all}、表にある診療行為 ${r.si.inTable}／レセプトの診療行為 ${r.si.all}。表にない薬・診療行為は、チェックの対象外なので見ていません（適応が広い・問題がない、という意味ではありません）`,
    ...(r.iy.conditioned + r.si.conditioned > 0 ? [`表にある薬のうち ${r.iy.conditioned}、診療行為のうち ${r.si.conditioned} は、表に性別・年齢の条件つきの行があるので、適応を見ていません（条件の読み方を、公開元の仕様書で確かめられていないため）`] : []),
    `${r.shohosen ? "このレセプトには処方箋料があります。" : ""}院外処方の薬の適応・量は、このレセプトからは見られません（医科のレセプトに薬が載らないため）`,
    ...(r.why !== null ? [WHY_TEXT[r.why]] : []),
    "量と日数（最大投与量・最長投与日数）、傷病名との禁忌、性別・年齢の条件の読み分け、同じ成分の薬をまとめた量、過去の月にまたがる日数は、点検していません（表の値の単位と数え方が、公開元の仕様書に書かれていないため。要る表の一部は取り込んでいません）",
    "疑い病名は、薬では当たりに数えています。診療行為では、表が確定病名だけを対象にしている行に限って、数えていません。転帰（治ゆ・中止など）のある傷病名も、当たりに数えています。併用の組は、同じ日に両方あるものだけを見ています",
    `チェックマスタは ${r.snapshot.slice(0, 4)}年${Number(r.snapshot.slice(4, 6))}月${Number(r.snapshot.slice(6, 8))}日 公開の版です${BEFORE_R8_CASES.has(r.snapshot) ? "（公開元は、令和8年度診療報酬改定に伴う新しい事例の公開は次回以降としています。改定で変わった取扱いは、まだ反映されていないことがあります）" : ""}`,
  ];
}

export const g09: GenericCheck = {
  id: "G09",
  kind: "適応",
  run(claim, masters, about) {
    const r = g09Look(claim, masters, about);
    return "skip" in r ? r : r.findings;
  },
};
