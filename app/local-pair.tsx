"use client";
// 背反の組の院内の知識（design.md §14-2〜§14-4）の入力：作る入口（対象の G05 の指摘の下）・「この請求も条件に当たる」のボタン。取り込んだレセプトの点検の画面だけが出す
import { useState } from "react";
import { CLAIM_FACT_SOURCES } from "../src/claim/facts";
import { LOCAL_PAIR_BASES, LOCAL_PAIR_TEXT } from "../src/messages";

type Pair = { a: string; b: string; tani: number };

/** 「この組の扱いを院内の知識として残す」：扱い（polarity）・根拠・条件の文。作ると未検証で、承認はベテラン */
export function LocalPairCreate(props: { claimId: string; pair: Pair; onSaved: () => void }) {
  const [polarity, setPolarity] = useState<"allow" | "avoid">("allow");
  const [basis, setBasis] = useState<string>(LOCAL_PAIR_BASES[0]);
  const [condition, setCondition] = useState("");
  const [msg, setMsg] = useState("");
  // allow と「返戻・査定された」の組は作れない（サーバーも断る）
  const bases = LOCAL_PAIR_BASES.filter((b) => polarity === "avoid" || b !== "返戻・査定された");
  async function save() {
    setMsg("");
    const r = await fetch("/api/knowledge/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ claimId: props.claimId, ...props.pair, polarity, basis: bases.includes(basis as (typeof bases)[number]) ? basis : bases[0], condition }) });
    const d = await r.json().catch(() => null);
    if (!r.ok) return setMsg(d?.error ?? "エラー");
    setCondition("");
    setMsg(`残しました（${d?.id ?? ""}。未検証）`);
    props.onSaved();
  }
  return (
    <details style={{ marginTop: 6 }}>
      <summary>{LOCAL_PAIR_TEXT.create}</summary>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 4 }}>
        <div className="muted">{LOCAL_PAIR_TEXT.createNote}</div>
        <label>
          扱い{" "}
          <select value={polarity} onChange={(e) => setPolarity(e.target.value as "allow" | "avoid")}>
            <option value="allow">{LOCAL_PAIR_TEXT.allowLabel}</option>
            <option value="avoid">{LOCAL_PAIR_TEXT.avoidLabel}</option>
          </select>
        </label>
        <label>
          根拠{" "}
          <select value={bases.includes(basis as (typeof bases)[number]) ? basis : bases[0]} onChange={(e) => setBasis(e.target.value)}>
            {bases.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </label>
        <textarea rows={2} maxLength={180} placeholder="条件（どんなときに当たるか）" value={condition} onChange={(e) => setCondition(e.target.value)} />
        <span><button disabled={condition.trim() === ""} onClick={() => void save()}>残す</button> {msg && <span className="muted">{msg}</span>}</span>
      </div>
    </details>
  );
}

const dayText = (date: string | null) => (date ? `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日：` : "");

/**
 * 「この請求も条件に当たる」（Lv.5 以上・承認済みの allow。design.md §14-3）：押すと、その請求のその組（その日）は算定できる扱いになり、G05 は出ない。
 * 書くのは請求ごとの事実の入口（POST /api/claims/[claimId]/facts）。照らすのはサーバー
 */
export function LocalPress(props: { claimId: string; press: { key: string; date: string | null }[]; onSaved: () => void }) {
  const [source, setSource] = useState<string>(CLAIM_FACT_SOURCES[0]);
  const [err, setErr] = useState("");
  async function press(p: { key: string; date: string | null }) {
    setErr("");
    const r = await fetch(`/api/claims/${encodeURIComponent(props.claimId)}/facts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fact: { key: p.key, date: p.date, value: true, source } }) });
    const d = await r.json().catch(() => null);
    if (!r.ok) return setErr(d?.error ?? "エラー");
    props.onSaved();
  }
  if (props.press.length === 0) return null;
  return (
    <div style={{ marginTop: 4, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
      <select aria-label="確かめ方" value={source} onChange={(e) => setSource(e.target.value)}>
        {CLAIM_FACT_SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
      {props.press.map((p) => (
        <button key={`${p.key}|${p.date ?? ""}`} onClick={() => void press(p)}>
          {dayText(p.date)}{p.date ? LOCAL_PAIR_TEXT.pressDay : LOCAL_PAIR_TEXT.press}
        </button>
      ))}
      {err && <span className="notice warn">{err}</span>}
    </div>
  );
}

/** 「この請求のこの組が返戻・査定された」（design.md §14-4）：その組の承認済みの allow の院内の知識を要再検証にし、この請求で押した事実を取り消す */
export function LocalReturn(props: { claimId: string; pair: { a: string; b: string; tani: number; ids: string[] }; onSaved: () => void }) {
  const [msg, setMsg] = useState("");
  async function send() {
    setMsg("");
    const { ids: _ids, ...pair } = props.pair;
    const r = await fetch(`/api/claims/${encodeURIComponent(props.claimId)}/local-return`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(pair) });
    const d = await r.json().catch(() => null);
    if (!r.ok) return setMsg(d?.error ?? "エラー");
    props.onSaved();
  }
  return (
    <div className="notice" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div>院内の知識 {props.pair.ids.join("・")}（コード {props.pair.a} と {props.pair.b}）</div>
      <div className="muted">{LOCAL_PAIR_TEXT.returnedNote}</div>
      <span><button onClick={() => void send()}>{LOCAL_PAIR_TEXT.returned}</button> {msg && <span className="notice warn">{msg}</span>}</span>
    </div>
  );
}
