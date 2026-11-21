"use client";
// データで動く点検（G01〜。design.md §12-5）の指摘と、点検の範囲。取り込んだレセプトの点検・月末の点検・カルテの算定プレビューが同じ部品を使う。
// 条件つきの指摘は控えめな見た目（注意の色にしない）。「指摘なし」は、動いた点検についてだけ言う。動かさなかった点検は、理由つきで必ず出す。
// 包括（G04）は、同じ行（含まれる側）について親が複数あれば 1 つにまとめる。手書きのルールとの重なりで出さなかった指摘は、数を出す（消えたことが分かるように）
// 適応・併用（G09）は、ほかの点検よりさらに控えめに出す：別の見出しの下にまとめ、既定で折りたたむ。見出しの下に、公開元の但し書きの趣旨と、見られないもの（院外処方の薬、表にない薬・診療行為の数）
import { groupSameChild } from "../src/generic/overlap";
import type { GenericView } from "../src/generic/view";
import { GENERIC_SCOPE_NOTE } from "../src/messages";

/** その理由で動かさなかった点検を「G01（コード）」の形で並べる */
const names = (list: { check: string; kind: string }[]) => list.map((c) => `${c.check}（${c.kind}）`).join("、");
const rowText = (c: { code: string; name: string | null }) => (c.name ? `${c.code} ${c.name}` : c.code);

/** scope が full なら、点検の範囲を項目ごとに出す。line なら 1 行にまとめる。skippedLines は、コードに直せないので掛けなかった行の数 */
export function GenericFindings({ generic, scope, skippedLines = 0 }: { generic: GenericView & { overlap?: { duplicate: number; judged: number } }; scope: "full" | "line"; skippedLines?: number }) {
  const noData = generic.notRun.filter((n) => n.reason === "noMasters" || n.reason === "noSnapshot");
  const notReady = generic.notRun.filter((n) => n.reason === "notReady");
  const notBuilt = generic.notRun.filter((n) => n.reason === "notBuilt");
  const { duplicate = 0, judged = 0 } = generic.overlap ?? {};
  const hidden = [judged > 0 ? `手書きのルールが判定済み ${judged} 件` : "", duplicate > 0 ? `ユスティの指摘と同じ内容 ${duplicate} 件` : ""].filter((x) => x !== "").join("、");
  const notes = generic.ran.flatMap((r) => (GENERIC_SCOPE_NOTE[r.check] ? [{ ...r, text: GENERIC_SCOPE_NOTE[r.check] }] : []));
  // 検算（G02）の数：再計算できた単位・合った単位と、検算の対象外の単位（理由ごと）。対象外は「合っている」ではない
  const recalc = generic.scope?.recalc;
  const recalcText = recalc ? `点数の検算：点数の書いてある ${recalc.units} 単位のうち、再計算できたのは ${recalc.checked} 単位（UKE の点数と合った ${recalc.matched} 単位）。検算の対象外は ${recalc.units - recalc.checked} 単位${recalc.excluded.length > 0 ? `（${recalc.excluded.map((e) => `${e.text}：${e.count}`).join("／")}）` : ""}` : "";
  const notDone = generic.scope?.notDone ?? [];
  const g09 = generic.findings.filter((f) => f.check === "G09");
  const g09Notes = generic.scope?.g09 ?? [];
  // 傷病名を持たない行（月末の点検・算定プレビュー）には掛けていない：見出しは出さず、掛けていないことだけを点検の範囲に出す
  const g09Open = g09.length > 0 || g09Notes.length > 1;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {groupSameChild(generic.findings.filter((f) => f.check !== "G09")).map(([f, ...more], i) => (
        <div key={i} className={`notice ${f.certainty === "確定" ? "warn" : ""}`}>
          <span className={`badge ${f.certainty === "確定" ? "warn" : ""}`}>{f.certainty}</span> <span className="badge">{f.kind}</span> {f.text}
          {f.codes.some((c) => c.name) && <div className="muted">対象の行：{f.codes.map(rowText).join("、")}</div>}
          <div className="muted">{f.check}・出どころ：{f.source.data}（{f.source.ref}）</div>
          {more.length > 0 && (
            <div className="muted">
              同じ行は、ほかに {more.length} 個の行為にも含まれる項目として載っています：
              {more.map((m, n) => <div key={n}>{rowText(m.codes[0])}（出どころ：{m.source.ref}）</div>)}
            </div>
          )}
        </div>
      ))}
      {g09Open && (
        <details className="muted">
          <summary>審査支払機関のコンピュータチェックの対象（適応・併用）：{g09.length} 件</summary>
          <ul style={{ margin: "4px 0", paddingLeft: 20 }}>
            {g09Notes.map((t, i) => <li key={i}>{t}</li>)}
          </ul>
          {g09.map((f, i) => (
            <div key={i} style={{ margin: "6px 0" }}>
              <span className="badge">{f.certainty}</span> {f.text}
              <div>{f.check}・出どころ：{f.source.data}（{f.source.ref}）</div>
            </div>
          ))}
        </details>
      )}
      {scope === "full" ? (
        <ul className="muted" style={{ margin: 0, paddingLeft: 20 }}>
          {generic.ran.length > 0 && <li>動いた点検：{names(generic.ran)}{generic.findings.length === 0 ? "。指摘はありません" : ""}</li>}
          {hidden !== "" && <li>出していない指摘：{hidden}</li>}
          {notes.map((n) => <li key={n.check}>{n.check}（{n.kind}）が点検していないこと：{n.text}</li>)}
          {noData.map((n) => <li key={n.check}>データがなくて動かなかった点検：{n.check}（{n.kind}）。{n.text}</li>)}
          {notReady.map((n) => <li key={n.check}>準備ができていない点検：{n.check}（{n.kind}）。{n.text}</li>)}
          {notBuilt.length > 0 && <li>まだ入っていない点検：{names(notBuilt)}</li>}
          {recalc && <li>{recalcText}</li>}
          {notDone.map((t, i) => <li key={i}>{t}</li>)}
          {!g09Open && g09Notes.map((t, i) => <li key={`g09-${i}`}>{t}</li>)}
        </ul>
      ) : (
        <p className="muted" style={{ margin: 0 }}>
          データで動く点検：
          {generic.ran.length > 0 ? `${names(generic.ran)}をしました${generic.findings.length === 0 ? "（指摘はありません）" : ""}。` : ""}
          {hidden !== "" ? `出していない指摘：${hidden}。` : ""}
          {[...noData, ...notReady].map((n) => `${n.check}（${n.kind}）は、${n.text}。`).join("")}
          {skippedLines > 0 ? `コードに直せない ${skippedLines} 行には掛けていません。` : ""}
          {notBuilt.length > 0 ? `${names(notBuilt)}は、まだ入っていません。` : ""}
          {recalc ? `${recalcText}。` : ""}
          {notDone.map((t) => `${t}。`).join("")}
          {!g09Open ? g09Notes.map((t) => `${t}。`).join("") : ""}
        </p>
      )}
    </div>
  );
}
