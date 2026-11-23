"use client";
import { LocalRuleHistoryMock } from "./history-mock";
// 知識の画面：ベテランへの質問（F6）、検証キュー（F5）、改善の提案と共感（F11）
import { useEffect, useState } from "react";
import { TopBar } from "../nav";
import { PageGuide } from "../page-guide";
import { getJson } from "../get-json";
import { OfficialBlock, useCheckRights, type OfficialMatch } from "../official-check";
import { fillLocal, LOCAL_PAIR_TEXT } from "../../src/messages";

const STATUS_COLOR: Record<string, string> = { 承認済み: "var(--accent)", 未検証: "var(--sky)", 要再検証: "var(--warn-mark)", 停止: "#5a4632", 保管: "var(--muted)" };

type K = { id: string; layer: string; status: string; summary: string; empathy: number; body?: string; hits?: number; misses?: number; official?: OfficialMatch | null; sample?: boolean; match?: { codePair?: { a: string; b: string; tani: number } }; polarity?: string; conditionNote?: string | null; pair?: { a: string; b: string; tani: number; table: string; conditionNote: string; polarity: string; emDecided: boolean }; revisionDiffs?: Record<string, string[]> };
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
  const checkRights = useCheckRights();
  const load = () => {
    const fail = (e: Error) => setErr(e.message);
    getJson<K[]>("/api/knowledge?view=queue").then(setQueue).catch(fail);
    getJson<K[]>("/api/knowledge").then(setAll).catch(fail);
    getJson<Peer[]>("/api/peer").then(setPeer).catch(fail);
  };
  useEffect(load, []);
  const run = (p: Promise<unknown>) => p.then(() => { setErr(""); load(); }).catch((e) => setErr(e.message));

  // 作り物（同梱の合成データから生まれた知識。実在のデータで使うクリニックでは使わない）は、数えずに別の欄に出す
  const count = (s: string) => all.filter((k) => k.status === s && !k.sample).length;
  const samples = all.filter((k) => k.sample);

  return (
    <main className="shell">
      <TopBar />
      <PageGuide who="bob" title="知識">
        院内や地域で育ったルールの置き場所です。未検証のものは、医事責任者が確かめると承認済みになります。使われなくなったものは、確かめ直しを経てしまわれます。
      </PageGuide>
      {err && <div className="notice warn">{err}</div>}
      <div className="stats">
        {([["承認済み", "承認済み"], ["未検証", "未検証"], ["要再検証", "確かめ直し待ち"], ["停止", "停止"], ["保管", "保管"]] as const).map(([s, label]) => (
          <div key={s} className="stat" style={{ ["--stat-color" as string]: STATUS_COLOR[s] }}><div className="label">{label}</div><span className="value">{count(s)}</span><span className="unit">件</span></div>
        ))}
      </div>

      <section className="panel" style={{ marginBottom: 16 }}>
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

      <div className="board-head"><h2>検証キュー（共感の多い順）</h2><span className="num" style={{ fontSize: 18, color: "var(--muted)" }}>{queue.length} 件</span></div>
      {queue.length === 0 && <div className="panel muted">未検証の知識はありません。</div>}
      <div className="card-list" style={{ marginBottom: 20 }}>
        {queue.map((k) => (
          <article key={k.id} className="card">
            <div className="card-band" style={{ background: STATUS_COLOR[k.status] ?? "var(--sky)" }} />
            <div className="card-body">
            <div className="chips" style={{ alignItems: "center" }}><span className="badge sky">{k.layer === "ベテラン" ? "医事責任者" : k.layer}</span><span className="badge">共感 {k.empathy}</span><strong>{k.summary}</strong></div>
            {/* 背反の組の知識：承認すると実際に使われる扱いと条件（meta の値。round-43 codex #3） */}
            {/* 承認済みでないあいだに出た改定の差（承認の前に見せる。design.md §14-4 v28） */}
            {Object.entries(k.revisionDiffs ?? {}).map(([d, c]) => <div key={d} className="notice warn">{fillLocal(LOCAL_PAIR_TEXT.revisionDiff, { changes: c.join("／"), date: d.slice(0, 10) })}</div>)}
            {k.match?.codePair && <div className="notice">{fillLocal(LOCAL_PAIR_TEXT.usedAs, { label: k.polarity === "allow" ? LOCAL_PAIR_TEXT.allowLabel : LOCAL_PAIR_TEXT.avoidLabel, note: k.conditionNote ?? "" })}</div>}
            <div className="bubble" style={{ margin: "10px 0" }}>{k.body}</div>
            <div className="chips">
              <button onClick={() => run(post("/api/knowledge", { action: "empathy", id: k.id }))}>共感する</button>
              <button className="primary" onClick={() => run(post("/api/knowledge", { action: "verify", id: k.id, approve: true, ...(k.revisionDiffs ? { revisionSeen: Object.keys(k.revisionDiffs) } : {}) }))}>承認する（医事責任者）</button>
              <button onClick={() => run(post("/api/knowledge", { action: "verify", id: k.id, approve: false }))}>却下する（医事責任者）</button>
            </div>
            </div>
          </article>
        ))}
      </div>

      {/* ローカルルール（地域・医事責任者の判断・院内）と公的情報。どの状態のものも、状態を付けて出す（隠さない） */}
      <section className="panel" style={{ marginBottom: 20 }}>
        <h3 style={{ marginTop: 0 }}>ローカルルールと公的情報</h3>
        <p className="muted">公的な文書（疑義解釈・審査の取扱いなど）との突き合わせです。文書に条件があるときは、このルールがその条件の請求にも当たるかを人が確かめます。確かめた結果は、次のレセメン会議の議題に使われます。</p>
        {all.filter((k) => k.official).length === 0 && <p className="muted">ローカルルールはまだありません。</p>}
        {all.filter((k) => k.official).map((k) => (
          <div key={k.id} style={{ marginTop: 8 }}>
            <span className={`badge ${k.status === "要再検証" || k.status === "停止" ? "warn" : ""}`} style={{ marginRight: 4 }}>{k.status === "要再検証" ? "要再検証（確かめ直し待ち）" : k.status}</span>
            {k.layer === "地域" ? "地域ルール" : k.layer === "ベテラン" ? "医事責任者の判断" : "院内ルール"}：{k.summary.replace("（中身は伏せています）", "")}
            {/* 背反の組の院内の知識（design.md §14）：条件の文と、EM の例外の組が入った組か */}
            {k.pair && <div className="muted">{fillLocal(LOCAL_PAIR_TEXT.usedAs, { label: k.pair.polarity === "allow" ? LOCAL_PAIR_TEXT.allowLabel : LOCAL_PAIR_TEXT.avoidLabel, note: k.pair.conditionNote })}{k.pair.emDecided ? `　${LOCAL_PAIR_TEXT.emDecided}` : ""}</div>}
            <OfficialBlock knowledgeId={k.id} official={k.official!} rights={checkRights} onChanged={load} />
          </div>
        ))}
      </section>

      {samples.length > 0 && (
        <section className="panel" style={{ marginBottom: 20 }}>
          <h3 style={{ marginTop: 0 }}>作り物（このクリニックでは使いません）</h3>
          <p className="muted">デモのときに入った、同梱の合成データから生まれた知識です。消さずに残していますが、ローカルルールの欄・メンター・レセメン会議・提出結果の集計には使いません。状態はデモのときのままです。</p>
          {samples.map((k) => (
            <div key={k.id} style={{ marginTop: 8 }}>
              <span className="badge" style={{ marginRight: 4 }}>作り物（このクリニックでは使いません）</span>
              <span className="muted" style={{ marginRight: 4 }}>{k.status}</span>
              {k.layer === "地域" ? "地域ルール" : k.layer === "ベテラン" ? "医事責任者の判断" : "院内ルール"}：{k.summary.replace("（中身は伏せています）", "")}
            </div>
          ))}
        </section>
      )}
      <section className="panel" style={{ marginBottom: 20 }}>
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
