"use client";
// 算定画面（F7：1 件＝1 問。ヒント → 確定 → 判定 → 解説）。判定はエンジン、メンターはヒントと解説だけ
import { useEffect, useMemo, useState } from "react";
import type { ClaimContext, ClaimLine, EngineResult, Finding } from "../../src/engine/types";
import type { MentorOutput, Situation } from "../../src/mentor/output";
import type { Question } from "../../src/practice/practice";
import { findingText } from "../../src/messages";
import { TopBar } from "../nav";

type Master = { kubun: string; name: string; points: number | null }[];
type Status = { level: number; count: number; streak: number };
type Bubble = { from: "mentor" | "me"; text: string; expression?: string };
type Cross = { mismatches: { ruleId: string; disease: string; draft: { question: string }; query: { id: string; status: string } | null }[]; confirmed: string[] };

const CLERK = "new1";

/** レセプトを開いたときにメンターへ渡す合図（本人には見せない） */
const OPENING = "（本人がこのレセプトを開いた。最初のひと声をかけてください。レベルに合わせて、見るとよい場所を一つ示すか、声かけだけにするかを決める）";

async function api<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error ?? "エラー");
  return d as T;
}

export default function Work() {
  const [cases, setCases] = useState<ClaimContext[]>([]);
  const [master, setMaster] = useState<Master>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [q, setQ] = useState<Question | null>(null);
  const [lines, setLines] = useState<ClaimLine[]>([]);
  const [careLevel, setCareLevel] = useState<string>("");
  const [chat, setChat] = useState<Bubble[]>([]);
  const [ask, setAsk] = useState("");
  const [showLog, setShowLog] = useState(false);
  /** 医師に聞きたいと言われたときに、照合の不一致から本人に選んでもらう選択肢（メンターは質問を書かない） */
  const [choices, setChoices] = useState<{ ruleId: string; about: string }[]>([]);
  const [pendingAsk, setPendingAsk] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [cross, setCross] = useState<Cross | null>(null);
  const [proxy, setProxy] = useState("");
  const [proxyMsg, setProxyMsg] = useState("");
  async function sendProxy() {
    if (!q) return;
    setBusy(true);
    try {
      const r = await api<{ scribed: { text: string; missing: { field: string; target: string }[] }; clerkTasks: { field: string }[] }>("/api/proxy", { claimId: q.claimId, text: proxy });
      setProxyMsg(`医師確認に回しました：${r.scribed.text}${r.clerkTasks.length ? `\n医療事務で確かめること：${r.clerkTasks.map((t) => t.field).join("、")}` : ""}`);
      setProxy("");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const loadCross = (claimId: string) => api<Cross>(`/api/crosscheck?claimId=${claimId}`).then(setCross).catch(() => setCross(null));

  useEffect(() => {
    api<ClaimContext[]>("/api/cases").then(setCases).catch((e) => setErr(e.message));
    api<Master>("/api/master").then(setMaster).catch(() => {});
    refreshStatus();
  }, []);
  const refreshStatus = () => api<Status>(`/api/me?clerkId=${CLERK}`).then(setStatus).catch(() => {});

  const ctx = useMemo(() => cases.find((c) => c.claimId === q?.claimId) ?? null, [cases, q]);
  const nameOf = (k: string) => master.find((m) => m.kubun === k)?.name ?? k;
  const pointsOf = (k: string) => master.find((m) => m.kubun === k)?.points ?? null;
  const facts = careLevel === "" ? undefined : { careLevel: { known: true as const, value: Number(careLevel) } };
  const careUnknown = ctx ? !ctx.facts.careLevel.known : false;

  async function begin(claimId: string) {
    setErr("");
    const nq = await api<Question>("/api/questions", { clerkId: CLERK, claimId });
    setQ(nq);
    setLines(cases.find((c) => c.claimId === claimId)!.lines.map((l) => ({ ...l, dates: [...l.dates] })));
    setCareLevel("");
    setChat([]);
    loadCross(claimId);
    // メンターから先に声をかける（聞かれるのを待たない）。下書きの記録は作らない（防いだ額に数えない）
    void mentor(OPENING, "通常", nq.id, true);
  }

  /** 照合の不一致を本人が選んだ：決まった質問で医師確認を送る */
  async function chooseCross(ruleId: string, about: string) {
    setChoices([]);
    setChat((c) => [...c, { from: "me", text: `「${about}」のことを医師に聞く` }]);
    await sendQuery(ruleId);
    setChat((c) => [...c, { from: "mentor", text: "決まった質問で医師に確認を送りました。回答が来たら一緒に見ましょう。", expression: "通常" }]);
  }
  /** それ以外：この 1 回は照合の不一致を渡さず、メンターが質問を作る */
  async function chooseOther() {
    setChoices([]);
    setChat((c) => [...c, { from: "me", text: "照合のこととは別のことを聞きたい" }]);
    await mentor(pendingAsk, "カルテ不足", q?.id, true, true);
  }

  async function sendQuery(ruleId: string) {
    if (!q) return;
    try {
      await api("/api/crosscheck", { claimId: q.claimId, ruleId });
    } catch (e) {
      setErr((e as Error).message);
    }
    loadCross(q.claimId);
  }

  /** silent=true はメンターから話しかける場面（本人の発言として画面に出さない） */
  async function mentor(message: string, situation: Situation, questionId = q?.id, silent = false, skipCrosscheck = false) {
    if (!questionId) return;
    setBusy(true);
    setChoices([]);
    if (!silent) setChat((c) => [...c, { from: "me", text: message }]);
    try {
      const r = await api<{ output: MentorOutput; choices: { ruleId: string; about: string }[] }>("/api/mentor", { clerkId: CLERK, questionId, message, situation, skipCrosscheck });
      setChat((c) => [...c, { from: "mentor", text: r.output.body, expression: r.output.expression }]);
      if (r.choices?.length) {
        setChoices(r.choices);
        setPendingAsk(message);
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** ヒント：下書きをエンジンにかけてから、メンターに聞く（指摘そのものは画面に出さない） */
  async function hint(message: string) {
    if (!q) return;
    const d = await api<{ question: Question; result: EngineResult }>(`/api/questions/${q.id}/draft`, { lines, facts });
    setQ(d.question);
    const doctor = d.result.findings.some((f) => f.missing?.target === "doctor");
    await mentor(message, doctor ? "カルテ不足" : "通常");
  }

  async function doConfirm() {
    if (!q) return;
    setErr("");
    try {
      const cq = await api<Question>(`/api/questions/${q.id}/confirm`, { lines, facts });
      setQ(cq);
      // 確定したら、聞かれる前に解説を始める
      await explanation(cq);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function explanation(cur = q) {
    if (!cur) return;
    const nq = await api<Question>(`/api/questions/${cur.id}/explain`, {});
    setQ(nq);
    await mentor("（本人が確定した。判定の理由を短く解説してください）", nq.correct ? "正方向" : "新人の誤り", nq.id, true);
  }

  async function next() {
    if (!q) return;
    await api<Question>(`/api/questions/${q.id}/done`, {});
    setQ(null);
    refreshStatus();
  }

  const findings: Finding[] = q?.confirmed?.result.findings ?? [];
  const total = lines.reduce((s, l) => s + (pointsOf(l.kubun) ?? 0) * l.count, 0);
  const lastMentorBubble = [...chat].reverse().find((b) => b.from === "mentor");
  const lastExpression = lastMentorBubble?.expression ?? "通常";
  const lastMentor = lastMentorBubble?.text ?? null;

  return (
    <main className="shell">
      <TopBar right={status && <span className="level">Lv.{status.level}・{status.count} 件・連続 {status.streak}</span>} />
      {err && <div className="notice warn">{err}</div>}
      {!q && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>今日のレセプト</h2>
          <div className="chips">
            {cases.map((c) => (
              <button key={c.claimId} onClick={() => begin(c.claimId)}>
                {c.claimId.split("-")[0]}（{c.facts.mainDisease.known ? c.facts.mainDisease.value : "主病不明"}）
              </button>
            ))}
          </div>
        </div>
      )}
      {q && ctx && (
        <div className={`work${showLog ? " with-log" : ""}`}>
          <section className="panel">
            <h2 style={{ marginTop: 0 }}>
              {q.claimId}　<span className="muted">{ctx.payer}・{ctx.facts.insurance.known ? ctx.facts.insurance.value : ""}・{q.phase}</span>
            </h2>
            <table>
              <thead>
                <tr><th>区分</th><th>回数</th><th>日（3 月）</th><th>点数</th><th /></tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i}>
                    <td>
                      <select value={l.kubun} disabled={q.phase !== "ヒント"} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, kubun: e.target.value } : x)))}>
                        {master.map((m) => <option key={m.kubun} value={m.kubun}>{m.name}</option>)}
                      </select>
                    </td>
                    <td>{l.count}</td>
                    <td>
                      <input
                        value={l.dates.map((d) => Number(d.slice(8))).join(",")}
                        disabled={q.phase !== "ヒント"}
                        style={{ width: 120 }}
                        onChange={(e) => {
                          const dates = e.target.value.split(",").map((s) => s.trim()).filter(Boolean).map((d) => `2025-03-${d.padStart(2, "0")}`);
                          setLines(lines.map((x, j) => (j === i ? { ...x, dates, count: dates.length } : x)));
                        }}
                      />
                    </td>
                    <td>{pointsOf(l.kubun) ?? "未収載"}</td>
                    <td>{q.phase === "ヒント" && <button onClick={() => setLines(lines.filter((_, j) => j !== i))}>外す</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {q.phase === "ヒント" && (
              <p>
                <button onClick={() => setLines([...lines, { kubun: master[0]?.kubun ?? "C001_1I", count: 1, dates: ["2025-03-10"] }])}>行を足す</button>
                <span className="muted">　合計 {total.toLocaleString()} 点（{nameOf(lines[0]?.kubun ?? "")} ほか）</span>
              </p>
            )}
            {careUnknown && (
              <p>
                要介護度（介護保険証で確認）：
                <select value={careLevel} disabled={q.phase !== "ヒント"} onChange={(e) => setCareLevel(e.target.value)}>
                  <option value="">未入力</option>
                  {[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n === 0 ? "要支援・非該当" : `要介護${n}`}</option>)}
                </select>
              </p>
            )}
            {cross && (cross.mismatches.length > 0 || cross.confirmed.length > 0) && (
              <div>
                <h3>確認してほしい点（カルテとの照合）</h3>
                {cross.mismatches.map((m) => (
                  <div key={m.ruleId} className="notice warn">
                    傷病名「{m.disease}」と処方が合っていません。{m.draft.question}
                    <div style={{ marginTop: 6 }}>
                      {m.query ? (
                        <span>医師確認を送りました（{m.query.status}）。<button onClick={() => loadCross(q.claimId)}>状態を見る</button></span>
                      ) : (
                        <button onClick={() => sendQuery(m.ruleId)}>医師確認を送る</button>
                      )}
                    </div>
                  </div>
                ))}
                {cross.confirmed.map((n) => <div key={n} className="notice ok">医師の回答と承認で、傷病名「{n}」が確定しました</div>)}
              </div>
            )}
            <details style={{ margin: "12px 0" }}>
              <summary>代行入力（医師確認つき）</summary>
              <p className="muted">下書きを整えて医師確認に回します。足りない項目は推定せず、確認として出します。</p>
              <textarea rows={3} style={{ width: "100%" }} value={proxy} onChange={(e) => setProxy(e.target.value)} placeholder="例：AF 継続、DOAC 継続" />
              <button disabled={busy || !proxy.trim()} onClick={sendProxy}>整えて医師確認に回す</button>
              {proxyMsg && <div className="notice ok" style={{ whiteSpace: "pre-wrap" }}>{proxyMsg}</div>}
            </details>
            {q.phase === "ヒント" && <button className="primary" onClick={doConfirm}>確定する</button>}
            {q.confirmed && (
              <div>
                <h3>ユスティの判定</h3>
                {q.correct ? <div className="notice ok">確認してほしい点はありません</div> : null}
                {findings.map((f, i) => (
                  <div key={i} className={`notice ${f.kind === "情報不足" ? "ok" : "warn"}`}>
                    {findingText(f)}<br />
                    <span className="muted">{f.ruleId}・{f.kind}・根拠：{f.reference}</span>
                  </div>
                ))}
                {q.phase === "判定" && <button className="primary" onClick={() => explanation()} disabled={busy}>解説を聞く</button>}
                {q.phase === "解説" && <button className="primary" onClick={next}>次のレセプトへ</button>}
              </div>
            )}
          </section>
          {/* 吹き出しの欄（画面の下）：左にキャラ、右に最新のひと言と入力欄。会話の履歴は右の窓で開く */}
          <div className="dock" role="region" aria-label="メンター">
            <div className="portrait" aria-label={`メンターの表情：${lastExpression}`}>
              <div className="portrait-figure">メンター</div>
              <div className="muted">{lastExpression}</div>
            </div>
            <div className="dialog">
              <div className="dialog-line">
                {busy ? <span className="muted">メンターが目を通しています…</span> : (lastMentor ?? "今日もよろしく。気になるところがあったら声をかけてね。")}
              </div>
              {choices.length > 0 && (
                <div className="dialog-actions" role="group" aria-label="医師に聞くことを選ぶ">
                  {choices.map((c) => (
                    <button key={c.ruleId} className="primary" disabled={busy} onClick={() => chooseCross(c.ruleId, c.about)}>
                      照合：{c.about}
                    </button>
                  ))}
                  <button disabled={busy} onClick={chooseOther}>それ以外のこと</button>
                </div>
              )}
              <div className="dialog-actions">
                {q.phase === "ヒント" && (
                  <>
                    <input value={ask} onChange={(e) => setAsk(e.target.value)} placeholder="メンターに聞く（空なら「ヒントをください」）" onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing && !busy) { hint(ask.trim() || "ヒントをください。"); setAsk(""); } }} />
                    <button disabled={busy} onClick={() => { hint(ask.trim() || "ヒントをください。"); setAsk(""); }}>聞く</button>
                  </>
                )}
                <button onClick={() => setShowLog(!showLog)} aria-expanded={showLog}>会話の履歴（{chat.length}）</button>
              </div>
            </div>
          </div>
          {showLog && (
            <aside className="log" aria-label="このレセプトの会話の履歴">
              <div className="log-head">
                <strong>このレセプトの会話</strong>
                <button onClick={() => setShowLog(false)} aria-label="履歴を閉じる">閉じる</button>
              </div>
              {chat.length === 0 && <div className="muted">まだ会話はありません。</div>}
              {chat.map((b, i) => (
                <div key={i} className={`log-item from-${b.from}`}>
                  <div className="muted">{b.from === "me" ? "あなた" : `メンター・${b.expression ?? "通常"}`}</div>
                  <div className="bubble">{b.text}</div>
                </div>
              ))}
            </aside>
          )}
        </div>
      )}
    </main>
  );
}
