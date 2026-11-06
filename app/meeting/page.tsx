"use client";
// レセメン会議の議題（F5・design.md §4-4）。責任者の回答で知識を更新する。点数・金額は出さない
import { useEffect, useState } from "react";
import type { DigestEntry } from "../../src/lifecycle/review";
import type { Notice, ResolvedItem } from "../../src/notice/notice";
import { TopBar } from "../nav";

const KIND: Record<string, string> = { miss: "外れの確認", recheck: "確かめ直し", ignored: "新人が外した理由", disposal: "廃棄提案" };

function reasonText(e: DigestEntry): string {
  const r = e.reason as Record<string, unknown>;
  if (e.kind === "miss") {
    const misses = (r.misses as { submissionId: string; kubun: string[] }[]).map((m) => `${m.submissionId}（${m.kubun.join("・") || "区分なし"}）`).join("、");
    const same = (r.sameApplied as { claimId: string; result: string }[]).map((s) => `${s.claimId}：${s.result}`).join("、");
    return `査定・返戻：${misses}\n同じ知識を適用したほかの請求：${same || "なし"}`;
  }
  if (e.kind === "recheck") return `きっかけ：${String(r.event)}${r.trigger ? `（${String(r.trigger)}）` : ""}`;
  if (e.kind === "ignored") return `外した区分：${(r.removedKubun as string[]).join("・")}`;
  return `きっかけ：${String(r.event)}`;
}

type Read = { fileName: string; notice: Notice; items: ResolvedItem[] };

/** 査定・返戻の通知（PDF）を読む。Claude は書かれていることを取り出すだけで、知識の候補にするのは本人が確かめてから */
function NoticeReader({ onRegistered }: { onRegistered: () => void }) {
  const [read, setRead] = useState<Read | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [reexam, setReexam] = useState<Record<number, boolean>>({});
  const [done, setDone] = useState<Record<number, string>>({});

  async function send(payload: unknown) {
    setBusy(true);
    setMsg("");
    setDone({});
    try {
      const r = await fetch("/api/notice", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setRead(d);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function upload(file: File) {
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = "";
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    await send({ pdfBase64: btoa(bin), fileName: file.name });
  }
  async function register(index: number) {
    if (!read) return;
    const r = await fetch("/api/notice/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ notice: read.notice, index, reexamFiled: !!reexam[index], fileName: read.fileName }) });
    const d = await r.json();
    setDone({ ...done, [index]: r.ok ? `知識の候補にしました（${d.status}）` : d.error });
    if (r.ok) onRegistered();
  }

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <h3>査定・返戻の通知を読む</h3>
      <p className="muted">Claude が PDF から書かれていることを取り出し、患者・区分・審査支払機関への対応づけは決まった規則で行います。知識の候補にするのは、確かめてボタンを押した項目だけです。</p>
      <p>
        <button onClick={() => send({ sample: true })} disabled={busy}>サンプル（K6・2 月分の査定）を読む</button>{" "}
        <input type="file" accept="application/pdf" disabled={busy} onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
      </p>
      {busy && <div className="muted">通知を読んでいます…</div>}
      {msg && <div className="notice warn">{msg}</div>}
      {read && (
        <table>
          <thead>
            <tr><th>診療年月</th><th>患者</th><th>項目 → 区分</th><th>結果</th><th>理由（通知のまま）</th><th>対応づけ</th><th></th></tr>
          </thead>
          <tbody>
            {read.items.map((it, i) => (
              <tr key={i}>
                <td>{it.yearMonth}</td>
                <td>{it.patientName}<br /><span className="muted">{it.claimId ?? "見つからない"}</span></td>
                <td>{it.itemName} → {it.kubun ?? "？"}</td>
                <td>{it.outcome}</td>
                <td>{it.reason}</td>
                <td>{it.problems.length === 0 ? `${it.prefecture}・${it.payer}` : <span className="warn">{it.problems.join(" / ")}</span>}</td>
                <td>
                  {it.outcome === "査定" && (
                    <label className="muted"><input type="checkbox" checked={!!reexam[i]} onChange={(e) => setReexam({ ...reexam, [i]: e.target.checked })} /> 再審査を申し出る</label>
                  )}
                  <br />
                  <button disabled={it.problems.length > 0 || !!done[i]} onClick={() => register(i)}>確かめた。知識の候補にする</button>
                  {done[i] && <div className="muted">{done[i]}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function Meeting() {
  const [items, setItems] = useState<DigestEntry[]>([]);
  const [free, setFree] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState("");
  const load = () => fetch("/api/meeting").then((r) => r.json()).then((d) => setItems(d.items ?? []));
  useEffect(() => { load(); }, []);

  async function answer(itemId: string, answer: number) {
    const r = await fetch("/api/meeting/answer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ itemId, answer, freeText: free[itemId] || undefined }) });
    const d = await r.json();
    setMsg(r.ok ? `反映：${d.status}` : d.error);
    load();
  }
  async function run() {
    await fetch("/api/meeting", { method: "POST" });
    load();
  }

  return (
    <main className="shell">
      <TopBar />
      <h2>レセメン会議（毎週土曜）</h2>
      <NoticeReader onRegistered={load} />
      <p><button onClick={run}>今すぐ整理を回す</button> <span className="muted">{msg}</span></p>
      {items.length === 0 && <div className="panel muted">今週の議題はありません。</div>}
      {items.map((e) => (
        <div key={e.itemId} className="panel" style={{ marginBottom: 12 }}>
          <div className="muted">{KIND[e.kind]}・{e.knowledgeId}{e.waitingRecheck ? "・確かめ直しの回答がこの回答を待っています" : ""}</div>
          <p><strong>{e.summary}</strong></p>
          <div className="bubble">{reasonText(e)}</div>
          <p>
            <input placeholder="自由記述（足りない条件など）" value={free[e.itemId] ?? ""} onChange={(ev) => setFree({ ...free, [e.itemId]: ev.target.value })} style={{ width: "100%" }} />
          </p>
          <div className="chips">
            {e.choices.map((c) => <button key={c.no} onClick={() => answer(e.itemId, c.no)}>{c.label}</button>)}
          </div>
        </div>
      ))}
    </main>
  );
}
