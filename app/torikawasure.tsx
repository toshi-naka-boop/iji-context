"use client";
// B の欄「カルテにあるが請求にない（条件つき）」（design.md §15-9。G11 の結果。src/generic/g11.ts）。取り込んだレセプトの点検・月末の点検・カルテの算定プレビューが同じ部品を使う。
// 上から：院内・院外が選ばれていない日の 1 行の案内（たたまない）→ 貼った患者だけを見ていることの 1 行（取り込んだ請求）→ 指摘（添え書きのない件が先、注意つきは後ろ）→
// 言わなかったもの（理由ごとの数。たたむ。開くと候補ごとの書かれた名前・日・理由）→ 見ていないもの・当てられない行為（たたむ）。
// 指摘はどれも条件つき（控えめな見た目）。点数・金額は出さない。指摘がないことを「取り忘れなし」とは言わない
import type { G11Result } from "../src/generic/g11";

export type TorikawasureView = G11Result & { coverage?: string };

const md = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

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
                  {md(d.date)}：「{d.quote}」
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
