"use client";
// B の欄「カルテにあるが請求にない（条件つき）」（design.md §15-9。G11 の結果。src/generic/g11.ts）。取り込んだレセプトの点検・月末の点検・カルテの算定プレビューが同じ部品を使う。
// 上から：院内・院外が選ばれていない日の 1 行の案内（たたまない）→ 貼った患者だけを見ていることの 1 行（取り込んだ請求）→ 指摘（添え書きのない件が先、注意つきは後ろ）→
// 言わなかったもの（理由ごとの数。たたむ。開くと候補ごとの書かれた名前・日・理由）→ 当てられない行為（候補から選ぶ入口。たたむ。X-157）→ 見ていないもの（たたむ）。
// 指摘はどれも条件つき（控えめな見た目）。点数・金額は出さない。指摘がないことを「取り忘れなし」とは言わない
import { useState } from "react";
import { tableKeyOfAct, tableKeyOfChild, type ActMatch } from "../src/chart/acts";
import type { G11Result, G11Unmatched } from "../src/generic/g11";
import { MatchPicker } from "./chart/acts-review";
import { postJson } from "./get-json";

export type TorikawasureView = G11Result & { coverage?: string };

// 日を付けない候補（日付が診療年月だけ。X-162）は月だけを出す
const md = (date: string) => (date.length === 10 ? `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}` : `${Number(date.slice(5, 7))}月`);

export function Torikawasure({ data, chartHref }: { data: TorikawasureView | undefined; chartHref?: string }) {
  if (!data) return null;
  return (
    <section className="panel" id="torikawasure">
      <h3>カルテにあるが請求にない（条件つき）</h3>
      {data.coverage && <p className="muted" style={{ margin: 0 }}>{data.coverage}</p>}
      {"skip" in data ? (
        <p className="muted" style={{ margin: 0 }}>{data.skip}</p>
      ) : (
        <>
          {data.guide && <div className="notice">{chartHref ? <a href={chartHref}>{data.guide}</a> : data.guide}</div>}
          {data.findings.length === 0 && <p className="muted" style={{ margin: 0 }}>カルテに書かれた行為で、請求にないものは見つかりませんでした（見ていないものは下に並べたとおり）。</p>}
          {data.findings.map((f, i) => (
            <div key={i} className="notice">
              <span className="badge">{f.caution ? "注意つき" : "条件つき"}</span> {f.text}
              {f.days.map((d) => (
                <div key={d.date} className="muted">
                  {md(d.date)}{d.quote ? `：「${d.quote}」` : ""}
                  {d.notes.map((n, k) => <div key={k}>{n.text}</div>)}
                </div>
              ))}
            </div>
          ))}
          {data.hidden.length > 0 && (
            <details>
              <summary>言わなかったもの：{data.hidden.length} 件（算定できない見込み）</summary>
              <ul>
                {data.hidden.map((h, i) => (
                  <li key={i}>
                    {md(h.date)} {h.written}{h.with && h.with.length > 0 ? `（${h.with.join("・")}）` : ""}：{h.reason}（相手：{h.partner}）
                  </li>
                ))}
              </ul>
            </details>
          )}
          {data.unmatchedActs.length > 0 && (
            <details>
              <summary>当てられない行為：{data.unmatchedActs.length} 件（取り忘れは見ていません。選ぶと次の点検で見ます）</summary>
              {data.unmatchedActs.map((u, i) => <UnmatchedPick key={i} u={u} />)}
            </details>
          )}
          {data.scope.length > 0 && (
            <details>
              <summary>見ていないもの・数</summary>
              <ul>{data.scope.map((s, i) => <li key={i}>{s}</li>)}</ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}

/** 当てられない行為 1 つ：保存したカルテの行為なら、候補・探すから選んで残す（POST /api/chart/acts。選ぶのは本人。design.md §15-9）。手技で使った薬・器材は child を付ける（X-161） */
function UnmatchedPick({ u }: { u: G11Unmatched }) {
  const [item, setItem] = useState<{ m: { initial: ActMatch | null; candidates: { tbl: ActMatch["tbl"]; code: string; name: string; prior: boolean }[] }; sel: ActMatch | null }>({ m: { initial: null, candidates: [] }, sel: null });
  const [msg, setMsg] = useState("");
  const canPick = u.noteId !== undefined && u.index !== undefined;
  async function save() {
    if (!item.sel || !canPick) return;
    setMsg("");
    try {
      // 名前で当たった候補も、ここでは本人が選んだもの（by は候補）として残す
      await postJson("/api/chart/acts", { noteId: String(u.noteId), index: u.index, ...(u.child ? { child: u.child.index } : {}), match: { ...item.sel, by: item.sel.by === "name" ? "candidate" : item.sel.by } });
      setMsg("残しました。点検を開き直すと、この行為を突き合わせます");
    } catch (e) {
      setMsg((e as Error).message);
    }
  }
  return (
    <div className="notice">
      <div>{md(u.date)} {u.child ? `「${u.child.parent}」で使った${u.written}（${u.child.kind}）` : `${u.written}（${u.category}）`}</div>
      {canPick ? (
        <>
          <MatchPicker item={item} table={u.child ? tableKeyOfChild(u.child.kind) : tableKeyOfAct(u.category)} ym={u.date.slice(0, 7)} written={u.written} lookup={[]} onChange={setItem} />
          <button disabled={!item.sel} onClick={save}>選んで残す</button>
        </>
      ) : (
        <div className="muted">このカルテの行為は、ここでは選べません</div>
      )}
      {msg && <div className="muted">{msg}</div>}
    </div>
  );
}
