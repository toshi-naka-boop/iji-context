"use client";
// カルテの「行ったこと」を確かめる（design.md §15-6・15-7・15-9。FR-192・FR-193）：足す・直す・消す・候補から選ぶ。
// 候補はどれも診療年月の基本マスターに実在するコードだけ。名前の完全一致が 1 つのときだけ当てた状態で出し、ほかは本人が選ぶ（選ばなければ「当てられない」のまま残る）。
// 前に選んだものは選んだ状態の初期値で出す（L-95）。請求は見ない（C-233）。保存は、事実と同じ 1 回の確かめ（呼び出し側の「確定する」）
import { useState } from "react";
import { ACT_CATEGORIES, foldOfAct, tableKeyOfAct, tableKeyOfChild, type ActCategory, type ActChild, type ActMatch, type ChartAct, type RxChoice, type RxNote, type TableKey } from "../../src/chart/acts";
import type { Candidate, ItemMatch } from "../../src/chart/match";
import { getJson } from "../get-json";

export type ActsReview = { dispensing: RxChoice; rxDefault: RxChoice; aliasCount: number; mastersPresent: boolean; matches: { act: ItemMatch; with: ItemMatch[] }[] };
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
    .map(({ keep: _k, m: _m, sel, with: w, ...a }) => {
      const kids = w.filter((c) => c.keep).map(({ keep: _ck, m: _cm, sel: cs, ...c }) => ({ ...c, quantity: c.quantity || undefined, match: cs }));
      return { ...a, quantity: a.quantity || undefined, match: sel, ...(kids.length ? { with: kids } : {}) };
    });
}

const RX_LABEL: Record<RxChoice, string> = { outside: "院外処方箋", inside: "院内", unknown: "分からない" };
const key = (c: Pick<Candidate, "tbl" | "code">) => `${c.tbl}|${c.code}`;

/** 1 行の当て方（当てた・選ぶ・当てられない）と、名前で探す入口 */
function MatchPicker(props: { item: Sel; table: TableKey; ym: string; written: string; lookup: string[]; onChange: (s: Sel) => void }) {
  const { item, onChange } = props;
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Candidate[]>([]);
  const [err, setErr] = useState("");
  const options = [...item.m.candidates, ...found.filter((f) => !item.m.candidates.some((c) => key(c) === key(f)))];
  if (item.sel && !options.some((c) => key(c) === key(item.sel!))) options.unshift({ tbl: item.sel.tbl, code: item.sel.code, name: item.sel.name, prior: item.sel.by === "alias" });
  async function reload() {
    setErr("");
    try {
      const m = await getJson<ItemMatch>(`/api/chart/acts/candidates?${new URLSearchParams({ table: props.table, ym: props.ym, written: props.written, lookup: props.lookup.join("|") })}`);
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

/** 「行ったこと」の一覧（確かめる画面の一部）。rows・rxChoice は呼び出し側が持ち、確定のときに一緒に送る */
export function ActsReviewPanel(props: { ym: string; review: ActsReview; rows: ActRow[]; setRows: (r: ActRow[]) => void; rx: RxNote[]; rxChoice: RxChoice | null; setRxChoice: (c: RxChoice) => void }) {
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
        {picker && r.keep && <MatchPicker item={r} table={tableKeyOfAct(r.category)} ym={ym} written={r.written} lookup={r.lookup} onChange={(s) => set(i, { ...r, ...s })} />}
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
              {c.keep && r.keep && <MatchPicker item={c} table={tableKeyOfChild(c.kind)} ym={ym} written={c.written} lookup={c.lookup} onChange={(s) => setC({ ...c, ...s })} />}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <h3>行ったこと（確かめてください）</h3>
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
        </div>
      )}
      {others.map((i) => line(i))}
      {toyaku.length + groups.optional.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <strong>その日の投薬{askRx && rxChoice === "inside" ? "（院内）" : ""}</strong>
          {toyaku.map((i) => line(i))}
          {groups.optional.length > 0 && (
            <details>
              <summary>名前で当たらない薬（選ぶのは任意）：{groups.optional.length} 件</summary>
              {groups.optional.map((i) => line(i))}
            </details>
          )}
        </div>
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
