"use client";
// 確かめたあとで付け直す欄（design.md §16-4-1・16-3・16-7。C-441）：確かめて残したカルテのうち、処方の日の「確かめた」の印が効く日で印のない日と、
// 当てられない行為に同じ日の電子カルテの同じ種類の行為がある日を並べ、その日の処方の欄の値と印（POST /api/chart/acts/rx-confirm）・「同じ／違う／選ばない」（POST /api/chart/acts/fold）を付け直す。
// 病名の記載に医師が略語の答え（指すものを記入する）を返していれば、その記載に「医師の答え：…」の札を出す（FR-211。表示だけ。X-492）。
// G11 の結果の「見ていません」の案内から飛ぶ先（id="chart-fixes"）。一括の操作は作らない（1 日ずつ）。選ぶのは任意で、初期値は出さない
import { useEffect, useState } from "react";
import type { RxChoice } from "../../src/chart/acts";
import { getJson, postJson } from "../get-json";
import { DoctorAnswerBadge, RX_LABEL } from "./acts-review";

type Fix = {
  noteId: number;
  date: string;
  rx: string[];
  rxChoice: RxChoice | null;
  rxMark: "n2" | "chozai" | null;
  pairs: { index: number; written: string; pairs: { ref: string; name: string }[]; fold: { ref?: string; same?: boolean } | null }[];
  /** 病名の記載への医師の「指すものを記入する」の答え（FR-211。表示だけ） */
  doctorAnswers?: { index: number; value: string; quote: string; answers: { token: string; text: string }[] }[];
};

const md = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

export function ConfirmedFixes({ claimId, tick = 0 }: { claimId: string; tick?: number }) {
  const [list, setList] = useState<Fix[] | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    getJson<Fix[]>(`/api/chart/acts/fixes?claimId=${encodeURIComponent(claimId)}`).then(setList).catch(() => setList(null));
  }, [claimId, tick, n]);
  if (!list || list.length === 0) return <div id="chart-fixes" />;
  return (
    <section className="panel" id="chart-fixes">
      <h3>確かめたカルテの付け直し</h3>
      <p className="muted" style={{ margin: 0 }}>確かめたあとでも、その日の処方の院内・院外の印と、電子カルテの行為と同じかを付け直せます。付け直すと、次の点検から使います。</p>
      {list.map((f) => <FixDay key={f.noteId} f={f} onSaved={() => setN((x) => x + 1)} />)}
    </section>
  );
}

function FixDay({ f, onSaved }: { f: Fix; onSaved: () => void }) {
  const [choice, setChoice] = useState<RxChoice | null>(f.rxChoice);
  const [msg, setMsg] = useState("");
  const run = async (fn: () => Promise<unknown>) => {
    setMsg("");
    try {
      await fn();
      onSaved();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  return (
    <div className="notice">
      <strong>{md(f.date)} のカルテ</strong>
      {f.rxMark && (
        <div>
          <div>その日の処方：{f.rx.map((x) => `「${x}」`).join("")}</div>
          <div className="chips" role="group" aria-label="その日の院内・院外">
            {(["outside", "inside", "unknown"] as RxChoice[]).map((c) => (
              <label key={c}><input type="radio" name={`fix-rx-${f.noteId}`} checked={choice === c} onChange={() => setChoice(c)} /> {RX_LABEL[c]}</label>
            ))}
          </div>
          <button disabled={choice === null} onClick={() => run(() => postJson("/api/chart/acts/rx-confirm", { noteId: String(f.noteId), rxChoice: choice, confirmed: true }))}>
            この日の院内・院外を確かめた
          </button>
          <span className="muted">{f.rxMark === "n2" ? "（処方箋を交付しない場合の加算を規則で見るのに使います）" : "（調剤料・処方料を規則で見るのに使います）"}</span>
        </div>
      )}
      {f.pairs.map((p) => {
        const value = p.fold?.same === false ? "different" : (p.fold?.ref ?? "");
        const send = (choice: "same" | "different" | "none", ref?: string) => run(() => postJson("/api/chart/acts/fold", { noteId: String(f.noteId), index: p.index, choice, ...(ref ? { ref } : {}) }));
        return (
          <div key={p.index} role="group" aria-label="電子カルテの行為と同じか">
            <div className="muted">「{p.written}」は、この日の電子カルテ（構造化データ）の行為と同じですか（選ばなくてもかまいません）</div>
            <div className="chips">
              {p.pairs.map((x) => (
                <label key={x.ref}><input type="radio" name={`fix-pair-${f.noteId}-${p.index}`} checked={value === x.ref} onChange={() => send("same", x.ref)} /> 同じ（オーダーの「{x.name}」と同じ行為）</label>
              ))}
              <label><input type="radio" name={`fix-pair-${f.noteId}-${p.index}`} checked={value === "different"} onChange={() => send("different")} /> 違う</label>
              <label><input type="radio" name={`fix-pair-${f.noteId}-${p.index}`} checked={value === ""} onChange={() => send("none")} /> 選ばない</label>
            </div>
          </div>
        );
      })}
      {(f.doctorAnswers ?? []).map((d) => (
        <div key={`d${d.index}`}>
          病名の記載「{d.quote}」：<DoctorAnswerBadge value={d.value} answers={d.answers} />
        </div>
      ))}
      {msg && <div className="muted">{msg}</div>}
    </div>
  );
}
