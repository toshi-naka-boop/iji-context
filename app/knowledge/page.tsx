"use client";
import { LocalRuleHistoryMock } from "./history-mock";
// 知識の画面：ベテランへの質問（F6）、検証キュー（F5）、改善の提案と共感（F11）
import { useEffect, useState } from "react";
import { TopBar } from "../nav";

type K = { id: string; layer: string; status: string; summary: string; empathy: number; body?: string; hits?: number; misses?: number };
type Peer = { id: string; question: string; status: string; answer: string | null; answered_by: string | null; knowledge_id: string | null };

async function post(url: string, body: unknown) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error);
  return d;
}

export default function Knowledge() {
  const [queue, setQueue] = useState<K[]>([]);
  const [all, setAll] = useState<K[]>([]);
  const [peer, setPeer] = useState<Peer[]>([]);
  const [ans, setAns] = useState<Record<string, string>>({});
  const [prop, setProp] = useState({ summary: "", body: "" });
  const [err, setErr] = useState("");
  const load = () => {
    fetch("/api/knowledge?view=queue").then((r) => r.json()).then(setQueue);
    fetch("/api/knowledge").then((r) => r.json()).then(setAll);
    fetch("/api/peer").then((r) => r.json()).then(setPeer);
  };
  useEffect(load, []);
  const run = (p: Promise<unknown>) => p.then(() => { setErr(""); load(); }).catch((e) => setErr(e.message));

  const count = (s: string) => all.filter((k) => k.status === s).length;

  return (
    <main className="shell">
      <TopBar />
      {err && <div className="notice warn">{err}</div>}
      <h2>知識</h2>
      <p className="muted">
        承認済み {count("承認済み")}・未検証 {count("未検証")}・確かめ直し待ち {count("要再検証")}・停止 {count("停止")}・保管 {count("保管")}
      </p>

      <section className="panel" style={{ marginBottom: 12 }}>
        <h3 style={{ marginTop: 0 }}>医事責任者への質問</h3>
        {peer.length === 0 && <p className="muted">届いている質問はありません。</p>}
        {peer.map((p) => (
          <div key={p.id} style={{ marginBottom: 8 }}>
            <div><strong>{p.question}</strong> <span className="muted">{p.status}{p.answered_by === "veteran_mentor" ? "（医事責任者のメンターが回答）" : ""}</span></div>
            {p.status === "回答待ち" ? (
              <div className="chips">
                <input style={{ flex: 1, minWidth: 240 }} value={ans[p.id] ?? ""} onChange={(e) => setAns({ ...ans, [p.id]: e.target.value })} placeholder="医事責任者の回答" />
                <button className="primary" onClick={() => run(post(`/api/peer/${p.id}/answer`, { answer: ans[p.id] ?? "" }))}>回答する</button>
              </div>
            ) : (
              <div className="bubble">{p.answer}</div>
            )}
          </div>
        ))}
      </section>

      <section className="panel" style={{ marginBottom: 12 }}>
        <h3 style={{ marginTop: 0 }}>検証キュー（共感の多い順）</h3>
        {queue.length === 0 && <p className="muted">未検証の知識はありません。</p>}
        {queue.map((k) => (
          <div key={k.id} style={{ marginBottom: 10 }}>
            <div><strong>{k.summary}</strong> <span className="muted">{k.layer === "ベテラン" ? "医事責任者" : k.layer}・共感 {k.empathy}</span></div>
            <div className="bubble" style={{ margin: "4px 0" }}>{k.body}</div>
            <div className="chips">
              <button onClick={() => run(post("/api/knowledge", { action: "empathy", id: k.id }))}>共感する</button>
              <button className="primary" onClick={() => run(post("/api/knowledge", { action: "verify", id: k.id, approve: true }))}>承認する（医事責任者）</button>
              <button onClick={() => run(post("/api/knowledge", { action: "verify", id: k.id, approve: false }))}>却下する（医事責任者）</button>
            </div>
          </div>
        ))}
      </section>

      <section className="panel">
        <h3 style={{ marginTop: 0 }}>改善を提案する</h3>
        <p><input style={{ width: "100%" }} placeholder="要約（1 行）" value={prop.summary} onChange={(e) => setProp({ ...prop, summary: e.target.value })} /></p>
        <p><textarea style={{ width: "100%" }} rows={3} placeholder="内容" value={prop.body} onChange={(e) => setProp({ ...prop, body: e.target.value })} /></p>
        <button className="primary" onClick={() => run(post("/api/knowledge", { action: "propose", ...prop }).then(() => setProp({ summary: "", body: "" })))}>提案する</button>
        <p className="muted">提案は院内の知識の候補になり、すぐ全員に見えます（未検証）。院内の知識は新人への助言には使いません。</p>
      </section>
      <LocalRuleHistoryMock />
    </main>
  );
}
