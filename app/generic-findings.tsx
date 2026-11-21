"use client";
// データで動く点検（G01〜。design.md §12-5）の指摘と、点検の範囲。取り込んだレセプトの点検・月末の点検・カルテの算定プレビューが同じ部品を使う。
// 条件つきの指摘は控えめな見た目（注意の色にしない）。「指摘なし」は、動いた点検についてだけ言う。動かさなかった点検は、理由つきで必ず出す。
// 包括（G04）は、同じ行（含まれる側）について親が複数あれば 1 つにまとめる。手書きのルールとの重なりで出さなかった指摘は、数を出す（消えたことが分かるように）
// 適応・併用（G09）は、ほかの点検よりさらに控えめに出す：別の見出しの下にまとめ、既定で折りたたむ。見出しの下に、公開元の但し書きの趣旨と、見られないもの（院外処方の薬、表にない薬・診療行為の数）を、1 行の見出しの閉じた折りたたみで出す。
// 取り込んだレセプトの点検（full）は、上から要約（動いた点検の数・指摘の数・何も出ないことは問題がない意味ではないこと）→ 指摘 → 点検していないこと・断り（閉じた折りたたみ）の順
// 背反の特例条件の例外の問い（G05.exception_ask。design.md §13-3）は、answer（請求 id と、答えを残したあとに読み直す関数）を渡した画面（取り込んだレセプトの点検）でだけ、指摘の下に選択肢を出す
import { AskInput } from "./fact-input";
import { groupSameChild } from "../src/generic/overlap";
import type { GenericView } from "../src/generic/view";
import { FINDING_LIMIT } from "../src/generic/types";

/** 指摘がないときの文。言えるのは動いた点検の、点検した範囲についてだけ（していないことは点検の範囲に並べる。round-32 O-19） */
const NONE = "動いた点検の、点検した範囲では指摘はありません（点検していないことは、ここに並べたとおり）";

/** その理由で動かさなかった点検を「G01（コード）」の形で並べる */
const names = (list: { check: string; kind: string }[]) => list.map((c) => `${c.check}（${c.kind}）`).join("、");
const rowText = (c: { code: string; name: string | null }) => (c.name ? `${c.code} ${c.name}` : c.code);

/**
 * scope が full なら、上から 1〜2 行の要約 → 指摘 → 点検の範囲（点検していないこと・断り。既定で閉じた折りたたみ）の順に出す。line なら 1 行にまとめる。
 * skippedLines は、コードに直せないので掛けなかった行の数。rowHref は、対象の行からページ内の行へのリンク先（あれば）。
 * full のときだけ：notes は、呼び出し側の断り（折りたたみの中に足す）、laterSheets は、診療年月より後の版で代えているデータの名前（要約に一言添える）
 */
export function GenericFindings({ generic, scope, skippedLines = 0, rowHref, notes = [], laterSheets = [], answer }: { generic: GenericView & { overlap?: { duplicate: number; judged: number } }; scope: "full" | "line"; skippedLines?: number; rowHref?: (code: string) => string | undefined; notes?: string[]; laterSheets?: string[]; answer?: { claimId: string; onSaved: () => void } }) {
  const rowLink = (c: { code: string; name: string | null }) => {
    const href = rowHref?.(c.code);
    return href ? <a href={href}>{rowText(c)}</a> : rowText(c);
  };
  const noData = generic.notRun.filter((n) => n.reason === "noMasters" || n.reason === "noSnapshot");
  const notReady = generic.notRun.filter((n) => n.reason === "notReady");
  const notBuilt = generic.notRun.filter((n) => n.reason === "notBuilt");
  const { duplicate = 0, judged = 0 } = generic.overlap ?? {};
  const hidden = [judged > 0 ? `手書きのルールが判定済み ${judged} 件` : "", duplicate > 0 ? `ユスティの指摘と同じ内容 ${duplicate} 件` : ""].filter((x) => x !== "").join("、");
  // 検算（G02）の数：再計算できた単位・合った単位と、検算の対象外の単位（理由ごと）。対象外は「合っている」ではない
  const recalc = generic.scope?.recalc;
  const recalcText = recalc ? `点数の検算：点数の書いてある ${recalc.units} 単位のうち、再計算できたのは ${recalc.checked} 単位（UKE の点数と合った ${recalc.matched} 単位）。検算の対象外は ${recalc.units - recalc.checked} 単位${recalc.excluded.length > 0 ? `（${recalc.excluded.map((e) => `${e.text}：${e.count}`).join("／")}）` : ""}` : "";
  const notDone = generic.scope?.notDone ?? [];
  const g09 = generic.findings.filter((f) => f.check === "G09");
  const g09Notes = generic.scope?.g09 ?? [];
  // 傷病名を持たない行（月末の点検・算定プレビュー）には掛けていない：見出しは出さず、掛けていないことだけを点検の範囲に出す
  const g09Open = g09.length > 0 || g09Notes.length > 1;
  // full の点検の範囲（折りたたみの中身）。中身は削らず、見出しの件数に数える
  const scopeItems = [
    ...notes,
    ...(generic.ran.length > 0 ? [`動いた点検：${names(generic.ran)}${generic.findings.length === 0 ? `。${NONE}` : ""}`] : []),
    ...(hidden !== "" ? [`出していない指摘：${hidden}`] : []),
    ...noData.map((n) => `データがなくて動かなかった点検：${n.check}（${n.kind}）。${n.text}`),
    ...notReady.map((n) => `準備ができていない点検：${n.check}（${n.kind}）。${n.text}`),
    ...(notBuilt.length > 0 ? [`まだ入っていない点検：${names(notBuilt)}`] : []),
    ...(recalc ? [recalcText] : []),
    ...notDone,
    ...(!g09Open ? g09Notes : []),
  ];
  const conditional = generic.findings.filter((f) => f.certainty === "条件つき").length;
  const certain = generic.findings.length - conditional;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {scope === "full" && (
        <p style={{ margin: 0 }}>
          {generic.ran.length > 0 ? `${generic.ran.length} つの点検が動きました。${certain > 0 ? `確定の指摘 ${certain} 件、` : ""}条件つきの指摘 ${conditional} 件。` : "データで動く点検は、どれも動いていません。"}
          {laterSheets.length > 0 ? `データの一部（${laterSheets.join("、")}）は、診療年月より後の版で代えています。` : ""}
          <span className="muted">何も出ないことは、問題がないという意味ではありません（点検していないことは、下の折りたたみに並べています）。</span>
        </p>
      )}
      {groupSameChild(generic.findings.filter((f) => f.check !== "G09")).map(([f, ...more], i) => (
        <div key={i} className={`notice ${f.certainty === "確定" ? "warn" : ""}`}>
          <span className={`badge ${f.certainty === "確定" ? "warn" : ""}`}>{f.certainty}</span> <span className="badge">{f.kind}</span> {f.text}
          {f.codes.some((c) => c.name) && <div className="muted">対象の行：{f.codes.map((c, n) => <span key={n}>{n > 0 && "、"}{rowLink(c)}</span>)}</div>}
          <div className="muted">{f.check}・出どころ：{f.source.data}（{f.source.ref}）</div>
          {answer && (f.asks ?? []).map((a, n) => <AskInput key={n} claimId={answer.claimId} ask={a} onSaved={answer.onSaved} />)}
          {more.length > 0 && (
            <div className="muted">
              同じ行は、ほかに {more.length} 個の行為にも含まれる項目として載っています：
              {more.map((m, n) => <div key={n}>{rowText(m.codes[0])}（出どころ：{m.source.ref}）</div>)}
            </div>
          )}
        </div>
      ))}
      {(generic.omitted ?? []).map((o) => (
        <div key={`omitted-${o.check}`} className="muted">
          {o.check}（{o.kind}）：ほか {o.count} 件（1 回の点検で出す指摘は、点検ごとに {FINDING_LIMIT} 件までです）
        </div>
      ))}
      {g09Open && (
        <details className="muted">
          {/* 作ったのは適応と併用だけ。折りたたんだままでも、量と日数を見ていないことが分かるように見出しに添える（round-32 O-18） */}
          <summary>審査支払機関のコンピュータチェックの対象（適応・併用）：{g09.length} 件。投与量・投与日数は点検していません</summary>
          {/* 但し書きは 1 行の見出しにして、中身は閉じた折りたたみに入れる（中身は削らない） */}
          {g09Notes.length > 0 && (
            <details style={{ margin: "4px 0" }}>
              <summary>公開元の但し書きと、この点検で見ていないもの（{g09Notes.length} 項目）</summary>
              <ul style={{ margin: "4px 0", paddingLeft: 20 }}>
                {g09Notes.map((t, i) => <li key={i}>{t}</li>)}
              </ul>
            </details>
          )}
          {g09.map((f, i) => (
            <div key={i} style={{ margin: "6px 0" }}>
              <span className="badge">{f.certainty}</span> {f.text}
              <div>{f.check}・出どころ：{f.source.data}（{f.source.ref}）</div>
            </div>
          ))}
        </details>
      )}
      {scope === "full" ? (
        <details className="muted">
          <summary>点検していないこと・断り（{scopeItems.length} 項目）</summary>
          <ul style={{ margin: "4px 0", paddingLeft: 20 }}>
            {scopeItems.map((t, i) => <li key={i}>{t}</li>)}
          </ul>
        </details>
      ) : (
        <p className="muted" style={{ margin: 0 }}>
          データで動く点検：
          {generic.ran.length > 0 ? `${names(generic.ran)}をしました${generic.findings.length === 0 ? `。${NONE}` : ""}。` : ""}
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
