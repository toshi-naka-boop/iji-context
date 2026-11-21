"use client";
// 背反の組の院内の知識（design.md §14-2〜§14-4）の入力：作る入口（対象の G05 の指摘の下）。取り込んだレセプトの点検の画面だけが出す
import { useState } from "react";
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
    const r = await fetch("/api/knowledge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "pair", claimId: props.claimId, ...props.pair, polarity, basis: bases.includes(basis as (typeof bases)[number]) ? basis : bases[0], condition }) });
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
