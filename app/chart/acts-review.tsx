"use client";
// カルテの「行ったこと」を確かめる（design.md §15-6・15-7・15-9。FR-192・FR-193）：足す・直す・消す・候補から選ぶ。
// 候補はどれも診療年月の基本マスターに実在するコードだけ。名前の完全一致が 1 つのときだけ当てた状態で出し、ほかは本人が選ぶ（選ばなければ「当てられない」のまま残る）。
// 前に選んだものは選んだ状態の初期値で出す（L-95）。請求は見ない（C-233）。保存は、事実と同じ 1 回の確かめ（呼び出し側の「確定する」）
import { useEffect, useState } from "react";
import { ABBREV_DICT_OPTIONS, ABBREV_NODICT_OPTIONS, ACT_CATEGORIES, foldOfAct, tableKeyOfAct, tableKeyOfChild, type AbbrevSummary, type ActCategory, type ActChild, type ActMatch, type ChartAct, type RxChoice, type RxNote, type TableKey } from "../../src/chart/acts";
import type { Candidate, ItemMatch } from "../../src/chart/match";
import { VisitTimeInput, type VisitRef } from "../visit-time-input";
import type { StructuredReview } from "../../src/structured/overlap";
import { getJson, postJson } from "../get-json";

/**
 * rxMark：処方の日の「確かめた」の印が効く日か（n2＝在医総管の月のオーダーのない処方の日、chozai＝オーダーのない在医総管のない月の院内の日。効かない日は null。design.md §16-4-1）。
 * visitTime：訪問の時刻の入力欄を出す日か（design.md §16-6。visits はその日の電子カルテの訪問）
 */
export type ActsReview = { dispensing: RxChoice; rxDefault: RxChoice; aliasCount: number; mastersPresent: boolean; matches: { act: ItemMatch; with: ItemMatch[] }[]; structured?: StructuredReview | null; rxMark?: "n2" | "chozai" | null; visitTime?: { visits: VisitRef[] } | null };
type Sel = { m: ItemMatch; sel: ActMatch | null };
export type ChildRow = ActChild & Sel & { keep: boolean };
export type ActRow = Omit<ChartAct, "with"> & Sel & { keep: boolean; with: ChildRow[] };

/** 取り出した行為と当て方から、画面の行を作る（初期値は当てた・前に選んだもの） */
export function rowsOf(acts: ChartAct[], review: ActsReview): ActRow[] {
  return acts.map((a, i) => {
    const m = review.matches[i] ?? { act: { initial: null, candidates: [] }, with: [] };
    return { ...a, keep: true, m: m.act, sel: m.act.initial, with: (a.with ?? []).map((c, j) => ({ ...c, keep: true, m: m.with[j] ?? { initial: null, candidates: [] }, sel: m.with[j]?.initial ?? null })) };
  });
}

/** 保存する形（消したものを外し、選んだコードを match に入れる） */
export function actsToSave(rows: ActRow[]): ChartAct[] {
  return rows
    .filter((r) => r.keep)
    .map(({ keep: _k, m: _m, sel, with: w, fold, ...a }) => {
      const kids = w.filter((c) => c.keep).map(({ keep: _ck, m: _cm, sel: cs, ...c }) => ({ ...c, quantity: c.quantity || undefined, match: cs }));
      return { ...a, quantity: a.quantity || undefined, match: sel, ...(kids.length ? { with: kids } : {}), ...(fold && !sel ? { fold } : {}) };
    });
}

export const RX_LABEL: Record<RxChoice, string> = { outside: "院外処方箋", inside: "院内", unknown: "分からない" };
const key = (c: Pick<Candidate, "tbl" | "code">) => `${c.tbl}|${c.code}`;

/** 1 行の当て方（当てた・選ぶ・当てられない）と、名前で探す入口（B の欄の当てられない行為も使う。app/torikawasure.tsx） */
export function MatchPicker(props: { item: Sel; table: TableKey; ym: string; written: string; lookup: string[]; onChange: (s: Sel) => void; at?: { noteId: number; index: number; child?: number } }) {
  const { item, onChange } = props;
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Candidate[]>([]);
  const [err, setErr] = useState("");
  const options = [...item.m.candidates, ...found.filter((f) => !item.m.candidates.some((c) => key(c) === key(f)))];
  if (item.sel && !options.some((c) => key(c) === key(item.sel!))) options.unshift({ tbl: item.sel.tbl, code: item.sel.code, name: item.sel.name, prior: item.sel.by === "alias" });
  async function reload() {
    setErr("");
    try {
      // at（保存したカルテの行為の位置）を渡すと、略語を医師に聞いた行為には医師の答えの語で候補を出す（FR-211）
      // at（そのカルテの行為の位置）を渡すと、そのカルテの略語による止め方で候補を出す（FR-211 辞書方式の決め 2・4）
      const at = props.at ? { noteId: String(props.at.noteId), index: String(props.at.index), ...(props.at.child !== undefined ? { child: String(props.at.child) } : {}) } : {};
      const m = await getJson<ItemMatch>(`/api/chart/acts/candidates?${new URLSearchParams({ table: props.table, ym: props.ym, written: props.written, lookup: props.lookup.join("|"), ...at })}`);
      onChange({ m, sel: m.initial });
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  async function search() {
    if (!q.trim()) return;
    setErr("");
    try {
      const r = await getJson<Omit<Candidate, "prior">[]>(`/api/masters/search?${new URLSearchParams({ table: props.table, ym: props.ym, q })}`);
      setFound(r.map((x) => ({ ...x, prior: false })));
      if (r.length === 0) setErr("見つかりませんでした");
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  const pick = (v: string) => {
    if (!v) return onChange({ ...item, sel: null });
    const c = options.find((o) => key(o) === v)!;
    const inFound = found.some((f) => key(f) === v) && !item.m.candidates.some((x) => key(x) === v);
    const by: ActMatch["by"] = item.m.initial?.by === "name" && key(item.m.initial) === v ? "name" : c.prior ? "alias" : inFound ? "search" : "candidate";
    onChange({ ...item, sel: { tbl: c.tbl, code: c.code, name: c.name, by } });
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {item.sel?.by === "name" ? (
        <div>当てた：{item.sel.name}（{item.sel.code}）</div>
      ) : (
        <label>
          {options.length === 0 ? "候補がありません。名前で探してください：" : "候補から選んでください："}
          <select value={item.sel ? key(item.sel) : ""} onChange={(e) => pick(e.target.value)} style={{ maxWidth: 420 }}>
            <option value="">当てられない（選ばない）</option>
            {options.map((c) => (
              <option key={key(c)} value={key(c)}>{c.prior ? "（前に選んだもの）" : ""}{c.name}（{c.code}）</option>
            ))}
          </select>
        </label>
      )}
      <div className="chips">
        {item.sel?.by === "name" && <button onClick={() => onChange({ ...item, sel: null, m: { ...item.m, initial: null } })}>選び直す</button>}
        <button onClick={reload}>候補を引き直す</button>
        <input value={q} placeholder="マスターを名前で探す" onChange={(e) => setQ(e.target.value)} style={{ width: 180 }} />
        <button onClick={search}>探す</button>
      </div>
      {err && <div className="muted">{err}</div>}
    </div>
  );
}

/**
 * 略語のまとめ（FR-211。plan-fr211.md「辞書方式の決め」2〜4。カルテを書いた直後と貼った直後に出す）。印がなければ何も出さない。
 * 辞書にある略語は、意味の候補（万病辞書・クリニックの辞書）と「その他」「判定不能」から選ぶ。候補は正しいとはかぎらない。Lv.4 までは必ず医師確認に回し、Lv.5 からは回すかを選ぶ。
 * 辞書にない略語は「算定に関係なし」か「医師に聞く」を選び、このカルテだけ LLM の候補と自動の当て方を止める。どれも確定と月末の点検は止めない（「医師確認中」の札だけ）
 */
export function AbbrevSummaryNote({ abbrev, noteId }: { abbrev: AbbrevSummary | undefined; noteId: number }) {
  const [cur, setCur] = useState<AbbrevSummary | undefined>(abbrev);
  const [draft, setDraft] = useState<Record<string, { option: string; meaning: string; ask: boolean }>>({});
  const [err, setErr] = useState("");
  // 開いたときに読み直す（医師の答えが来ていれば出す。反証 round-101 X-511）
  useEffect(() => {
    if (!abbrev || "unseen" in abbrev || abbrev.marks.length === 0) return;
    getJson<AbbrevSummary>(`/api/chart/abbrev-selections?${new URLSearchParams({ noteId: String(noteId) })}`)
      .then(setCur)
      .catch(() => {});
  }, [noteId, abbrev]);
  const a = cur ?? abbrev;
  if (!a) return null;
  if ("unseen" in a) return <p className="muted" style={{ margin: 0 }}>{a.unseen}</p>;
  if (a.marks.length === 0) return null;
  async function save(token: string, d: { option: string; meaning: string; ask: boolean }) {
    setErr("");
    try {
      setCur(await postJson<AbbrevSummary>("/api/chart/abbrev-selections", { noteId: String(noteId), token, option: d.option, ...(d.meaning.trim() ? { meaning: d.meaning.trim() } : {}), askDoctor: d.ask }));
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  return (
    <div className="notice" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div>略語：{a.marks.join("・")}。意味を選んでください（選ばなくても確定できます）。</div>
      {a.stopped ? (
        <div className="muted">
          {a.hold ? "辞書にない略語があるので" : "略語の意味を選び終えるまで"}、このカルテの行ったことは自動で当てず、AI の挙げた語でも候補を出しません。名前の候補と、名前で探す欄から選んでください。
        </div>
      ) : (
        <div className="muted">略語の意味を選び終えました。行ったことの「候補を引き直す」で、AI の挙げた語と自動の当て方が戻ります。</div>
      )}
      {a.tokens.map((t) => {
        const d = draft[t.token] ?? { option: t.selection?.option ?? "", meaning: t.selection?.meaning ?? "", ask: t.selection?.askDoctor ?? false };
        const set = (n: Partial<typeof d>) => setDraft({ ...draft, [t.token]: { ...d, ...n } });
        const options = t.inDict ? ABBREV_DICT_OPTIONS : ABBREV_NODICT_OPTIONS;
        return (
          <div key={t.token} role="group" aria-label={`略語 ${t.token}`} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div className="chips" style={{ alignItems: "center" }}>
              <span className="badge">{t.token}</span>
              {!t.inDict && <span className="muted">辞書にない略語</span>}
              {t.selection && <span className="muted">選んだ扱い：{t.selection.option}{t.selection.meaning ? `（${t.selection.meaning}）` : ""}</span>}
              {t.doctorPending && <span className="badge">医師確認中</span>}
              {t.doctorAnswer && (
                <span className="badge">
                  医師の答え：{t.doctorAnswer.text ?? t.doctorAnswer.option}
                  {t.doctorAnswer.text && t.selection?.meaning && t.doctorAnswer.text !== t.selection.meaning ? `（事務の選択：${t.selection.meaning}）` : ""}
                </span>
              )}
            </div>
            {t.inDict && (
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                {t.candidates.map((c) => (
                  <li key={c.meaning}>
                    <label>
                      <input type="radio" name={`abbrev-${noteId}-${t.token}`} checked={d.option === "辞書の意味" && d.meaning === c.meaning} onChange={() => set({ option: "辞書の意味", meaning: c.meaning })} /> {c.meaning}
                      <span className="muted">（{c.source}{c.reliability ? `・信頼度 ${c.reliability}` : ""}）</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            <div className="chips">
              {options.filter((o) => o !== "辞書の意味").map((o) => (
                <label key={o}><input type="radio" name={`abbrev-${noteId}-${t.token}`} checked={d.option === o} onChange={() => set({ option: o, meaning: "" })} /> {o}</label>
              ))}
              {d.option === "その他" && <input aria-label="意味" placeholder="意味" maxLength={100} value={d.meaning} onChange={(e) => set({ meaning: e.target.value })} />}
              {t.inDict && (
                <label className="muted">
                  <input type="checkbox" disabled={a.mustAsk} checked={a.mustAsk || d.ask} onChange={(e) => set({ ask: e.target.checked })} /> 医師確認に回す{a.mustAsk ? "（Lv.4 までは必ず回します）" : ""}
                </label>
              )}
              <button disabled={!d.option || (d.option === "その他" && !d.meaning.trim())} onClick={() => void save(t.token, d)}>残す</button>
            </div>
          </div>
        );
      })}
      {a.credit && (
        <p className="muted" style={{ margin: 0 }}>
          出典：{a.credit.credit}（<a href={a.credit.url} target="_blank" rel="noreferrer">{a.credit.name}</a>）
        </p>
      )}
      {err && <div className="muted">{err}</div>}
    </div>
  );
}

/** 「行ったこと」の一覧（確かめる画面の一部）。rows・rxChoice は呼び出し側が持ち、確定のときに一緒に送る */
export function ActsReviewPanel(props: {
  ym: string;
  review: ActsReview;
  rows: ActRow[];
  setRows: (r: ActRow[]) => void;
  rx: RxNote[];
  rxChoice: RxChoice | null;
  setRxChoice: (c: RxChoice) => void;
  /** 「この日の院内・院外を確かめた」の印（design.md §16-4-1。値を選び直したときは押さなくても付く） */
  rxConfirmed?: boolean;
  setRxConfirmed?: (b: boolean) => void;
  /** 時刻の入力欄に使う請求とその日（design.md §16-6。カルテの画面のその日の欄） */
  claimId?: string;
  date?: string;
  /** そのカルテの id（候補の引き直しで、そのカルテの略語による止め方を使う。FR-211） */
  noteId?: number;
}) {
  const { ym, review, rows, setRows, rx, rxChoice } = props;
  const set = (i: number, r: ActRow) => setRows(rows.map((x, j) => (j === i ? r : x)));
  const askRx = review.dispensing === "inside" && rx.length > 0;
  const fold = (r: ActRow) => foldOfAct(r, r.sel, review.dispensing, askRx ? rxChoice : null);
  const groups = { show: [] as number[], hidden: [] as number[], optional: [] as number[] };
  rows.forEach((r, i) => groups[fold(r)].push(i));
  const toyaku = groups.show.filter((i) => rows[i].category === "投薬");
  const others = groups.show.filter((i) => rows[i].category !== "投薬");

  const line = (i: number, picker = true) => {
    const r = rows[i];
    return (
      <div key={i} className="notice" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <div className="chips">
          <label><input type="checkbox" checked={r.keep} onChange={(e) => set(i, { ...r, keep: e.target.checked })} /> 残す</label>
          <select value={r.category} onChange={(e) => set(i, { ...r, category: e.target.value as ActCategory, sel: null, m: { initial: null, candidates: [] } })}>
            {ACT_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
          </select>
          <input value={r.written} aria-label="書かれた名前" onChange={(e) => set(i, { ...r, written: e.target.value })} style={{ width: 200 }} />
          <input value={r.quantity ?? ""} aria-label="回数・量" placeholder="回数・量" onChange={(e) => set(i, { ...r, quantity: e.target.value })} style={{ width: 90 }} />
        </div>
        <label className="muted">カルテの「<input value={r.quote} aria-label="カルテの文字" onChange={(e) => set(i, { ...r, quote: e.target.value })} style={{ width: 260 }} />」から</label>
        {picker && r.keep && <MatchPicker item={r} table={tableKeyOfAct(r.category)} ym={ym} written={r.written} lookup={r.lookup} {...(props.noteId ? { at: { noteId: props.noteId, index: i } } : {})} onChange={(s) => set(i, { ...r, ...s })} />}
        {r.with.map((c, j) => {
          const setC = (n: ChildRow) => set(i, { ...r, with: r.with.map((x, k) => (k === j ? n : x)) });
          return (
            <div key={j} style={{ marginLeft: 20, display: "flex", flexDirection: "column", gap: 4 }}>
              <div className="chips">
                <label><input type="checkbox" checked={c.keep} onChange={(e) => setC({ ...c, keep: e.target.checked })} /> {c.kind}</label>
                <input value={c.written} aria-label="使った薬・器材の名前" onChange={(e) => setC({ ...c, written: e.target.value })} style={{ width: 200 }} />
                <input value={c.quantity ?? ""} aria-label="使った量" placeholder="量" onChange={(e) => setC({ ...c, quantity: e.target.value })} style={{ width: 90 }} />
                <span className="muted">カルテの「{c.quote}」から</span>
              </div>
              {c.keep && r.keep && <MatchPicker item={c} table={tableKeyOfChild(c.kind)} ym={ym} written={c.written} lookup={c.lookup} {...(props.noteId ? { at: { noteId: props.noteId, index: i, child: j } } : {})} onChange={(s) => setC({ ...c, ...s })} />}
            </div>
          );
        })}
      </div>
    );
  };

  const st = review.structured ?? null;
  /** 構造化データとの見分け（取り出したときの行だけ。足した行は持たない） */
  const ovOf = (i: number) => (st && i < st.acts.length ? st.acts[i] : null);
  const folded = (i: number) => ovOf(i)?.status === "folded" && rows[i].sel !== null;
  const PART_LABEL: Record<keyof StructuredReview["parts"], string> = { visits: "訪問の時刻", orders: "処方のオーダー", procedures: "注射・処置の実施", homeCare: "在宅療養の指示" };
  /** 当てられない行為の「同じ／違う／選ばない」（design.md §16-3。選ぶのは任意。初期値は出さない） */
  const pairChoice = (i: number) => {
    const r = rows[i];
    const o = ovOf(i);
    if (!o || o.status !== "unmatched" || r.sel !== null || o.pairs.length === 0) return null;
    const value = r.fold?.same === false ? "different" : (r.fold?.ref ?? "");
    return (
      <div className="notice" role="group" aria-label="電子カルテの行為と同じか">
        <div className="muted">この日の電子カルテ（構造化データ）の同じ種類の行為と同じですか（選ばなくても保存できます）</div>
        <div className="chips">
          {o.pairs.map((x) => (
            <label key={x.ref}><input type="radio" name={`pair-${i}`} checked={value === x.ref} onChange={() => set(i, { ...r, fold: { kind: "order", ref: x.ref, by: "person" } })} /> 同じ（オーダーの「{x.name}」と同じ行為）</label>
          ))}
          <label><input type="radio" name={`pair-${i}`} checked={value === "different"} onChange={() => set(i, { ...r, fold: { kind: "order", by: "person", same: false } })} /> 違う</label>
          <label><input type="radio" name={`pair-${i}`} checked={value === ""} onChange={() => set(i, { ...r, fold: undefined })} /> 選ばない</label>
        </div>
      </div>
    );
  };
  const noteOf = (i: number) => {
    const o = ovOf(i);
    return o?.status === "textOnly" && o.note ? <div className="muted">{o.note}</div> : null;
  };
  const withMarks = (i: number, el: React.ReactNode) => (
    <div key={i}>
      {el}
      {noteOf(i)}
      {pairChoice(i)}
    </div>
  );
  const foldedRows = rows.map((_, i) => i).filter(folded);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <h3>行ったこと（確かめてください）</h3>
      {st && (
        <div className="notice">
          <strong>電子カルテ（構造化データ。読むだけ・出どころ：{st.source}）</strong>
          <div className="muted">{(Object.keys(st.parts) as (keyof StructuredReview["parts"])[]).map((k) => `${PART_LABEL[k]}：${st.parts[k] === "supported" ? "受け取っている" : "受け取っていない"}`).join("／")}</div>
          {st.day.length > 0 ? (
            <ul>
              {st.day.map((x) => (
                <li key={x.ref}>{x.name}{x.quantity ? `（${x.quantity}）` : ""}{x.mapped || x.kind === "visit" ? "" : "（コードを当てられない）"}</li>
              ))}
            </ul>
          ) : (
            <div className="muted">この日の電子カルテの行為はありません</div>
          )}
        </div>
      )}
      <p className="muted">AI がカルテから読み取った、書かれた名前のままの行為です。マスターの名称と完全に一致したものは当てた状態で出ています。ほかは候補から選ぶか、名前で探してください。選ばなければ「当てられない」のまま残ります。算定できるかは、ここでは決めません。</p>
      {!review.mastersPresent && <div className="notice warn">基本マスターが入っていないため、マスターに当てられません（行ったことはそのまま残せます）。</div>}
      {review.aliasCount > 0 && <div className="notice">前に選んだものを初期値にしています：{review.aliasCount} 件</div>}
      {askRx && (
        <div className="notice">
          <div>その日の処方：{rx.map((x) => `「${x.quote}」`).join("")}</div>
          <div className="chips" role="group" aria-label="その日の院内・院外">
            {(["outside", "inside", "unknown"] as RxChoice[]).map((c) => (
              <label key={c}><input type="radio" name="rx-choice" checked={rxChoice === c} onChange={() => props.setRxChoice(c)} /> {RX_LABEL[c]}</label>
            ))}
          </div>
          {rxChoice === review.rxDefault && <div className="muted">処方の文から決めた初期値です。違えば直してください。</div>}
          {props.setRxConfirmed && review.rxMark && (
            // 印は効く日だけに出す（在医総管の月のオーダーのない処方の日、オーダーのない在医総管のない月の院内の日。サーバーが決める。C-441）。一括の操作は作らない
            <label>
              <input type="checkbox" checked={props.rxConfirmed ?? false} onChange={(e) => props.setRxConfirmed!(e.target.checked)} /> この日の院内・院外を確かめた
              {review.rxMark === "n2" ? "（処方箋を交付しない場合の加算を規則で見るのに使います）" : "（調剤料・処方料を規則で見るのに使います）"}
            </label>
          )}
        </div>
      )}
      {props.claimId && props.date && review.visitTime && <VisitTimeInput claimId={props.claimId} date={props.date} visits={review.visitTime.visits} />}
      {others.filter((i) => !folded(i)).map((i) => withMarks(i, line(i)))}
      {toyaku.length + groups.optional.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <strong>その日の投薬{askRx && rxChoice === "inside" ? "（院内）" : ""}</strong>
          {toyaku.filter((i) => !folded(i)).map((i) => withMarks(i, line(i)))}
          {groups.optional.length > 0 && (
            <details>
              <summary>名前で当たらない薬（選ぶのは任意）：{groups.optional.length} 件</summary>
              {groups.optional.map((i) => withMarks(i, line(i)))}
            </details>
          )}
        </div>
      )}
      {foldedRows.length > 0 && (
        <details>
          <summary>オーダーにもある：{foldedRows.length} 件（電子カルテの行為を正にします）</summary>
          {foldedRows.map((i) => line(i))}
        </details>
      )}
      {groups.hidden.length > 0 && (
        <details>
          <summary>見ない薬：{groups.hidden.length} 件</summary>
          {groups.hidden.map((i) => line(i, false))}
        </details>
      )}
      <div>
        <button onClick={() => setRows([...rows, { category: "診療行為", written: "", lookup: [], quote: "", keep: true, m: { initial: null, candidates: [] }, sel: null, with: [] }])}>行ったことを足す</button>
      </div>
    </div>
  );
}
