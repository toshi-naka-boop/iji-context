"use client";
// 訪問カルテの一覧と「消す」（design.md §11-11。DELETE /api/chart/[id]）。カルテを書く画面（その患者の、自分が書いた分）と、事務長の画面（クリニックの全部）で使う。
// 一覧に出るのは、日付・種類・書いた人・確定済みかだけ。カルテの本文は出さない。見えるのは消せる分だけ（サーバーが絞る）
import { useEffect, useState } from "react";
import { getJson } from "../get-json";

type Note = { id: number; claimId: string; date: string; kind: string; writer: string; mine: boolean; confirmed: boolean };

/** claimId を渡すと、その請求のカルテだけを出す。tick が変わると読み直す。onDeleted は、消したカルテの id を受け取る */
export function NoteList(props: { claimId?: string; tick?: string; onDeleted?: (id: number) => void }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [err, setErr] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    getJson<Note[]>("/api/chart").then(setNotes).catch((e: Error) => setErr(e.message));
  }, [props.tick, reload]);

  async function remove(n: Note) {
    if (!window.confirm(`${n.date} の${n.kind}のカルテを消します。カルテの本文と、そこから確かめた事実が消え、元に戻せません。このカルテをもとに作った医師確認の記録と、AI のサービスに送った内容は、ここからは消えません。よろしいですか`)) return;
    setErr("");
    const r = await fetch(`/api/chart/${n.id}`, { method: "DELETE" });
    const d = await r.json().catch(() => null);
    if (!r.ok) return setErr(d?.error ?? "消せませんでした");
    setReload((x) => x + 1);
    props.onDeleted?.(n.id);
  }

  const shown = props.claimId === undefined ? notes : notes.filter((n) => n.claimId === props.claimId);
  return (
    <section aria-label="訪問カルテの一覧" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <h3 style={{ margin: 0 }}>{props.claimId === undefined ? "訪問カルテ（消す操作）" : "この患者に書いた訪問カルテ"}</h3>
      {err && <div className="notice warn">{err}</div>}
      {shown.length === 0 ? <p className="muted" style={{ margin: 0 }}>{props.claimId === undefined ? "カルテを書く画面から入れた訪問カルテは、ありません。" : "まだありません。"}</p> : (
        <table className="emr-table">
          <thead>
            <tr>{props.claimId === undefined && <th>請求</th>}<th>日付</th><th>種類</th><th>書いた人</th><th>状態</th><th></th></tr>
          </thead>
          <tbody>
            {shown.map((n) => (
              <tr key={n.id}>
                {props.claimId === undefined && <td>{n.claimId}</td>}
                <td>{n.date}</td>
                <td>{n.kind}</td>
                <td>{n.writer}{n.mine ? "（自分）" : ""}</td>
                <td>{n.confirmed ? "確定済み" : "保存のみ（未確定）"}</td>
                <td><button onClick={() => void remove(n)}>消す</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
