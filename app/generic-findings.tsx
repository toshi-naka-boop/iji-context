"use client";
// データで動く点検（G01〜。design.md §12-5）の指摘と、点検の範囲。取り込んだレセプトの点検・月末の点検・カルテの算定プレビューが同じ部品を使う。
// 条件つきの指摘は控えめな見た目（注意の色にしない）。「指摘なし」は、動いた点検についてだけ言う。動かさなかった点検は、理由つきで必ず出す
import type { GenericView } from "../src/generic/view";

/** その理由で動かさなかった点検を「G01（コード）」の形で並べる */
const names = (list: { check: string; kind: string }[]) => list.map((c) => `${c.check}（${c.kind}）`).join("、");

/** scope が full なら、点検の範囲を項目ごとに出す。line なら 1 行にまとめる。skippedLines は、コードに直せないので掛けなかった行の数 */
export function GenericFindings({ generic, scope, skippedLines = 0 }: { generic: GenericView; scope: "full" | "line"; skippedLines?: number }) {
  const noData = generic.notRun.filter((n) => n.reason === "noMasters" || n.reason === "noSnapshot");
  const notReady = generic.notRun.filter((n) => n.reason === "notReady");
  const notBuilt = generic.notRun.filter((n) => n.reason === "notBuilt");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {generic.findings.map((f, i) => (
        <div key={i} className={`notice ${f.certainty === "確定" ? "warn" : ""}`}>
          <span className={`badge ${f.certainty === "確定" ? "warn" : ""}`}>{f.certainty}</span> <span className="badge">{f.kind}</span> {f.text}
          {f.codes.some((c) => c.name) && <div className="muted">対象の行：{f.codes.map((c) => (c.name ? `${c.code} ${c.name}` : c.code)).join("、")}</div>}
          <div className="muted">{f.check}・出どころ：{f.source.data}（{f.source.ref}）</div>
        </div>
      ))}
      {scope === "full" ? (
        <ul className="muted" style={{ margin: 0, paddingLeft: 20 }}>
          {generic.ran.length > 0 && <li>動いた点検：{names(generic.ran)}{generic.findings.length === 0 ? "。指摘はありません" : ""}</li>}
          {noData.map((n) => <li key={n.check}>データがなくて動かなかった点検：{n.check}（{n.kind}）。{n.text}</li>)}
          {notReady.map((n) => <li key={n.check}>準備ができていない点検：{n.check}（{n.kind}）。{n.text}</li>)}
          {notBuilt.length > 0 && <li>まだ入っていない点検：{names(notBuilt)}</li>}
        </ul>
      ) : (
        <p className="muted" style={{ margin: 0 }}>
          データで動く点検：
          {generic.ran.length > 0 ? `${names(generic.ran)}をしました${generic.findings.length === 0 ? "（指摘はありません）" : ""}。` : ""}
          {[...noData, ...notReady].map((n) => `${n.check}（${n.kind}）は、${n.text}。`).join("")}
          {skippedLines > 0 ? `コードに直せない ${skippedLines} 行には掛けていません。` : ""}
          {notBuilt.length > 0 ? `${names(notBuilt)}は、まだ入っていません。` : ""}
        </p>
      )}
    </div>
  );
}
