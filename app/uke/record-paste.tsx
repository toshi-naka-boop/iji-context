"use client";
// 取り込んだレセプトにカルテの文を貼る（design.md §15-8・§15-9。段 18c）：日付ごとに貼る → AI が行ったことを取り出す → 本人が確かめて保存する（POST /api/chart/acts）。
// 訪問・往診の出来事は作らない。確かめたあとは、点検をやり直すと B の欄（取り忘れ）がこのカルテで動く。同意・外部送信の注意書きは、今のカルテの保存と同じ
import { useState } from "react";
import type { ChartAct, RxChoice, RxNote } from "../../src/chart/acts";
import { ActsReviewPanel, actsToSave, rowsOf, type ActRow, type ActsReview } from "../chart/acts-review";
import { Notice } from "../consent";
import { postJson } from "../get-json";

type Pasted = { id: number; date: string; acts: ChartAct[]; rx: RxNote[]; actsDropped: unknown[]; review: ActsReview };

export function RecordPaste({ claimId, yearMonth, onSaved }: { claimId: string; yearMonth: string; onSaved: () => void }) {
  const [date, setDate] = useState(`${yearMonth}-01`);
  const [text, setText] = useState("");
  const [rxText, setRxText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [ex, setEx] = useState<Pasted | null>(null);
  const [rows, setRows] = useState<ActRow[]>([]);
  const [rxChoice, setRxChoice] = useState<RxChoice | null>(null);

  async function paste() {
    setErr("");
    setMsg("");
    setBusy(true);
    try {
      const r = await postJson<Pasted>(`/api/uke/claims/${encodeURIComponent(claimId)}/notes`, { date, note: { s: "", o: text, a: "", p: "", rx: rxText } });
      setEx(r);
      setRows(rowsOf(r.acts, r.review));
      setRxChoice(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!ex) return;
    setErr("");
    try {
      await postJson("/api/chart/acts", { noteId: String(ex.id), facts: [], acts: actsToSave(rows), rx: ex.rx, rxChoice });
      setMsg(`${ex.date} のカルテを確かめて残しました。`);
      setEx(null);
      setText("");
      setRxText("");
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  return (
    <details>
      <summary>この請求にカルテを貼る（日付ごと）</summary>
      <Notice />
      {err && <div className="notice warn">{err}</div>}
      {msg && <div className="notice ok">{msg}</div>}
      {!ex ? (
        <div>
          <label>
            日付 <input type="date" value={date} min={`${yearMonth}-01`} max={`${yearMonth}-31`} onChange={(e) => setDate(e.target.value)} />
          </label>
          <div>
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} style={{ width: "100%" }} placeholder="その日のカルテの文" aria-label="その日のカルテの文" />
          </div>
          <div>
            <textarea value={rxText} onChange={(e) => setRxText(e.target.value)} rows={2} style={{ width: "100%" }} placeholder="処方の記載（あれば）" aria-label="処方の記載" />
          </div>
          <button className="primary" disabled={busy || text.trim() === ""} onClick={paste}>
            貼って、行ったことを読み取る
          </button>
        </div>
      ) : (
        <div>
          <ActsReviewPanel ym={yearMonth} review={ex.review} rows={rows} setRows={setRows} rx={ex.rx} rxChoice={rxChoice} setRxChoice={setRxChoice} />
          {ex.actsDropped.length > 0 && <div className="notice warn">カルテに書かれていない言葉から取ったものなど {ex.actsDropped.length} 件は、使わずに捨てました。</div>}
          <button className="primary" onClick={save}>これで確かめる（{ex.date}）</button>
        </div>
      )}
    </details>
  );
}
