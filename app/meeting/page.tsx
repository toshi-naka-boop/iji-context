"use client";
// レセメン会議の議題（F5・design.md §4-4）。責任者の回答で知識を更新する。点数・金額は出さない
import { useEffect, useState } from "react";
import type { DigestEntry } from "../../src/lifecycle/review";
import type { Notice, ResolvedItem } from "../../src/notice/notice";
import { CHOOSABLE } from "../../src/notice/problems";
import { eventText, fillLocal, LOCAL_PAIR_TEXT, payerLabel } from "../../src/messages";
import { Notice as NoticeText } from "../consent";
import { TopBar } from "../nav";

/** 会議室の絵（public/characters/ にあればそれを使い、なければ全員の絵を並べる。2026-11-08） */
const MEETING_IMAGE: string | null = "/characters/meeting.jpg"; // assets/characters/meeting/meeting-2.png（Codex で生成。2026-11-08 ユーザーが案 2 を選んだ）
const MEMBERS: [string, string][] = [["suit", "ハル"], ["makki", "マッキー"], ["black-hair", "ナツ"], ["bob", "ユキ"]];

/** 全員が会議している様子。ハルが前に立って説明する */
function MeetingRoom() {
  return (
    <section className="meeting-room" aria-label="レセメン会議の様子">
      {MEETING_IMAGE ? (
        <img className="meeting-art" src={MEETING_IMAGE} alt="ハルがホログラムのパネルでみんなに説明している" />
      ) : (
        <div className="meeting-members">
          {MEMBERS.map(([img, name]) => (
            <figure key={img}>
              <img src={`/characters/${img}-select.png`} alt={name} />
              <figcaption>{name}</figcaption>
            </figure>
          ))}
          <figure className="rule">
            <img src="/characters/yusti.png" alt="ユスティ" />
            <figcaption>ユスティ</figcaption>
          </figure>
        </div>
      )}
      <div className="meeting-caption">
        <div className="hud-tag">WEEKLY · 毎週土曜</div>
        <h1>レセメン会議</h1>
        <div className="page-guide-say">
          <span className="page-guide-name">ハル</span>
          <p>査定・返戻の通知をもとに、みんなでルールを見直します。長く使われていないルールも、ここで確かめ直しに回します。</p>
        </div>
      </div>
    </section>
  );
}

const KIND: Record<string, string> = { miss: "外れの確認", recheck: "確かめ直し", ignored: "新人が外した理由", disposal: "廃棄提案" };

/** 承認済みでないあいだに出た改定の差（承認し直す議題に並べる。design.md §14-4 v28） */
const diffLines = (r: Record<string, unknown>): string[] => Object.entries((r.revisionDiffs as Record<string, string[]> | undefined) ?? {}).map(([d, c]) => fillLocal(LOCAL_PAIR_TEXT.revisionDiff, { changes: c.join("／"), date: d.slice(0, 10) }));

function reasonText(e: DigestEntry): string {
  const r = e.reason as Record<string, unknown>;
  if (e.kind === "miss") {
    const misses = (r.misses as { submissionId: string; kubun: string[] }[]).map((m) => `${m.submissionId}（${m.kubun.join("・") || "区分なし"}）`).join("、");
    const same = (r.sameApplied as { claimId: string; result: string }[]).map((s) => `${s.claimId}：${s.result}`).join("、");
    return `査定・返戻：${misses}\n同じ知識を適用したほかの請求：${same || "なし"}`;
  }
  if (e.kind === "recheck") {
    // 背反の組の知識（design.md §14-4）：返戻の請求と組・改定で差が出た項目
    const extra = [r.claimId ? `請求 ${String(r.claimId)}` : "", Array.isArray(r.changes) ? `差が出た項目：${(r.changes as string[]).join("／")}` : "", ...diffLines(r)].filter((x) => x !== "");
    return `きっかけ：${eventText(String(r.event), r.trigger ? String(r.trigger) : undefined)}${extra.length > 0 ? `\n${extra.join("\n")}` : ""}`;
  }
  if (e.kind === "ignored") return `外した区分：${(r.removedKubun as string[]).join("・")}`;
  return [`きっかけ：${eventText(String(r.event))}`, ...diffLines(r)].join("\n");
}

/** 議題の理由に載った公的文書（このルールと矛盾の恐れがあるもの。要旨とリンクだけ）。決めるのは責任者で、自動では停止しない */
function OfficialDocs({ e }: { e: DigestEntry }) {
  if (e.reason.kind !== "recheck" && e.reason.kind !== "disposal") return null;
  const { official, conditionNote } = e.reason;
  if (!official || official.length === 0) return null;
  return (
    <div className="notice warn">
      <strong>公的情報：矛盾の恐れ</strong>　<span className="muted">次の文書と向きが逆です。読み比べて、今も正しいかを決めてください</span>
      {conditionNote && <div className="muted">条件の注記あり（このルールの条件：{conditionNote}）</div>}
      {official.map((d) => (
        <div key={d.id}>
          ・<a href={d.url} target="_blank" rel="noreferrer">{d.kind}　{d.issuer}　{d.number}</a>（{d.issuedOn}・{d.stance}{d.seen ? "・前の会議で確認済み" : ""}）{d.summary}
        </div>
      ))}
    </div>
  );
}

type Read = { fileName: string; notice: Notice; items: ResolvedItem[] };
/** 残っている問題（区分を選んだ項目は、区分の問題を除く。選べるかの判定はサーバーがもう一度する） */
const rest = (it: ResolvedItem, chosen: string | undefined) => (chosen ? it.problems.filter((p) => !CHOOSABLE.includes(p)) : it.problems);

/** 査定・返戻の通知（PDF）を読む。Claude は書かれていることを取り出すだけで、知識の候補にするのは本人が確かめてから */
function NoticeReader({ onRegistered }: { onRegistered: () => void }) {
  const [read, setRead] = useState<Read | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [reexam, setReexam] = useState<Record<number, boolean>>({});
  const [done, setDone] = useState<Record<number, string>>({});
  /** 項目名から区分が決まらなかった項目で、本人が選んだ区分 */
  const [chosen, setChosen] = useState<Record<number, string>>({});
  // 見本（作り物の K6 の通知）は、デモのクリニックにだけ出す
  const [demo, setDemo] = useState(false);
  useEffect(() => {
    fetch("/api/clock").then((r) => (r.ok ? r.json() : null)).then((d) => setDemo(d?.kind === "demo")).catch(() => {});
  }, []);

  async function send(payload: unknown) {
    setBusy(true);
    setMsg("");
    setDone({});
    setChosen({});
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
    const r = await fetch("/api/notice/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ notice: read.notice, index, reexamFiled: !!reexam[index], fileName: read.fileName, ...(chosen[index] ? { kubun: chosen[index] } : {}) }) });
    const d = await r.json();
    setDone({ ...done, [index]: r.ok ? `知識の候補にしました（${d.status}）` : d.error });
    if (r.ok) onRegistered();
  }

  return (
    <div className="panel" style={{ marginBottom: 20 }}>
      <h3 style={{ marginTop: 0 }}>査定・返戻の通知を読む</h3>
      <p className="muted">通知に書かれていることを取り出し、確かめた項目だけを知識の候補にします。</p>
      <NoticeText />
      <p>
        {demo && <><button onClick={() => send({ sample: true })} disabled={busy}>サンプル（K6・前の月の査定）を読む</button>{" "}</>}
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
                <td>
                  {it.itemName} → {it.kubun ?? (chosen[i] ? `${chosen[i]}（選んだ区分）` : "？")}
                  {it.choices.length > 0 && (
                    <div>
                      <select style={{ maxWidth: 220 }} value={chosen[i] ?? ""} onChange={(e) => setChosen({ ...chosen, [i]: e.target.value })} disabled={!!done[i]}>
                        <option value="">区分を選ぶ</option>
                        {it.choices.map((c) => <option key={c.kubun} value={c.kubun}>{c.name}（{c.kubun}）</option>)}
                      </select>
                    </div>
                  )}
                </td>
                <td>{it.outcome}</td>
                <td>{it.reason}</td>
                <td>{rest(it, chosen[i]).length === 0 ? `${it.prefecture}・${payerLabel(it.payer)}` : <span className="warn">{rest(it, chosen[i]).join(" / ")}</span>}</td>
                <td>
                  {it.outcome === "査定" && (
                    <label className="muted"><input type="checkbox" checked={!!reexam[i]} onChange={(e) => setReexam({ ...reexam, [i]: e.target.checked })} /> 再審査を申し出る</label>
                  )}
                  <br />
                  <button disabled={rest(it, chosen[i]).length > 0 || !!done[i]} onClick={() => register(i)}>確かめた。知識の候補にする</button>
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
  /** 背反の組の知識を「直す必要がある」と答えるときの、修正版の扱いと条件の文（design.md §14-1。項目ごと。既定は今の値） */
  const [fix, setFix] = useState<Record<string, { polarity: "allow" | "avoid"; conditionNote: string }>>({});
  const [msg, setMsg] = useState("");
  const load = () => fetch("/api/meeting").then((r) => r.json()).then((d) => setItems(d.items ?? []));
  useEffect(() => { load(); }, []);

  async function answer(e: DigestEntry, answer: number) {
    const itemId = e.itemId;
    const cur = e.pair ? (fix[itemId] ?? e.pair) : null;
    const f = cur && answer === 2 && e.kind !== "disposal" ? { polarity: cur.polarity, conditionNote: cur.conditionNote } : null;
    const r = await fetch("/api/meeting/answer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ itemId, answer, freeText: free[itemId] || undefined, ...(f ?? {}) }) });
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
      <MeetingRoom />
      <NoticeReader onRegistered={load} />
      <div className="board-head">
        <h2>今週の議題</h2>
        <span className="num" style={{ fontSize: 18, color: "var(--muted)" }}>{items.length} 件</span>
        <button onClick={run}>今すぐ整理を回す</button>
        <span className="muted">{msg}</span>
      </div>
      {items.length === 0 && <div className="panel muted">今週の議題はありません。「今すぐ整理を回す」を押すと、長く使われていないルールなどが議題に上がります。</div>}
      <div className="card-list">
      {items.map((e) => (
        <article key={e.itemId} className="card">
          <div className="card-band" style={{ background: e.kind === "disposal" ? "var(--warn-mark)" : "var(--accent)" }} />
          <div className="card-body">
          <div className="chips" style={{ alignItems: "center" }}><span className="badge blue">{KIND[e.kind]}</span><span className="muted">{e.knowledgeId}{e.waitingRecheck ? "・確かめ直しの回答がこの回答を待っています" : ""}</span></div>
          <p><strong>{e.summary}</strong></p>
          <div className="bubble">{reasonText(e)}</div>
          <OfficialDocs e={e} />
          {e.pair && e.kind !== "disposal" && (
            <div className="muted" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span>「直す必要がある」と答えるときの、修正版の扱いと条件（{LOCAL_PAIR_TEXT.createNote}）</span>
              <select value={(fix[e.itemId] ?? e.pair).polarity} onChange={(ev) => setFix({ ...fix, [e.itemId]: { conditionNote: (fix[e.itemId] ?? e.pair!).conditionNote, polarity: ev.target.value as "allow" | "avoid" } })}>
                <option value="allow">{LOCAL_PAIR_TEXT.allowLabel}</option>
                <option value="avoid">{LOCAL_PAIR_TEXT.avoidLabel}</option>
              </select>
              <input maxLength={200} value={(fix[e.itemId] ?? e.pair).conditionNote} onChange={(ev) => setFix({ ...fix, [e.itemId]: { polarity: (fix[e.itemId] ?? e.pair!).polarity, conditionNote: ev.target.value } })} style={{ width: "100%" }} />
            </div>
          )}
          <p>
            <input placeholder="自由記述（足りない条件など）" value={free[e.itemId] ?? ""} onChange={(ev) => setFree({ ...free, [e.itemId]: ev.target.value })} style={{ width: "100%" }} />
          </p>
          <div className="chips">
            {e.choices.map((c) => <button key={c.no} onClick={() => answer(e, c.no)}>{c.label}</button>)}
          </div>
          </div>
        </article>
      ))}
      </div>
    </main>
  );
}
