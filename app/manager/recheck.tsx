"use client";
// 確かめ直す日の知らせ（FR-190。design.md §15-2）：施設の申告の行（項目といつの診療月から）ごとに、その行が効く診療月で「分からない」になるもの・
// 確かめ直す日が近いもの・確かめ直す日のないものを並べる。そこから「変わりなし」を開くと、その行を選んだ状態になる（round-52 X-150）。メールなどで外に送らない
import { useEffect, useState } from "react";
import type { RecheckNotice as Notice } from "../../src/facility/declaration";
import { NOTE14_TEXT } from "../../src/facility/note14";
import { getJson } from "../get-json";
import { itemLabel, type Declarations } from "../settings/facility";

export function RecheckNotice() {
  const [d, setD] = useState<Declarations | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    getJson<Declarations>("/api/facility/declaration").then(setD).catch((e: Error) => setErr(e.message));
  }, []);
  if (err) return <div className="notice warn">{err}</div>;
  if (!d) return null;
  const label = (key: string) => {
    const it = d.items.find((x) => x.key === key);
    return it ? itemLabel(it) : key;
  };
  const range = (n: Notice) => (n.untilMonth ? `${n.fromMonth}〜${n.untilMonth} の診療月` : `${n.fromMonth} からの診療月`);
  const text = (n: Notice) =>
    n.state === "overdue" ? `${range(n)}で分からない（確かめ直す日を過ぎた）` : n.state === "none" ? `${range(n)}：確かめ直す日がありません` : `${range(n)}：確かめ直す日 ${n.recheckOn}`;
  const groups: [string, Notice[]][] = [
    ["確かめ直す日を過ぎた申告", d.recheck.rows.filter((n) => n.state === "overdue")],
    [`確かめ直す日が近い申告（${d.recheckNoticeDays} 日以内）`, d.recheck.rows.filter((n) => n.state === "soon")],
    ["確かめ直す日のない申告", d.recheck.rows.filter((n) => n.state === "none")],
  ];
  const empty = groups.every(([, rows]) => rows.length === 0) && d.recheck.noFromMonth.length === 0;
  return (
    <div className="panel">
      <h3 style={{ marginTop: 0 }}>施設の申告の確かめ直し</h3>
      {d.note14.managerLine && <div className="notice warn">{d.note14.managerLine}</div>}
      {empty && <p className="muted">確かめ直す日が近い・過ぎた・ない申告はありません。</p>}
      {groups.map(([title, rows]) =>
        rows.length > 0 ? (
          <div key={title}>
            <h4>{title}</h4>
            <ul style={{ paddingLeft: 18 }}>
              {rows.map((n) => (
                <li key={n.id}>
                  {label(n.key)}　{text(n)}　
                  {/* 注14：道具の結果（減算になる）のまま申告が「通常」なら「変わりなし」の入口を出さず、申告の画面へ案内する（round-58 C-331・round-59 C-342。L-160） */}
                  {n.key === "note14" && d.note14.state === "block" ? <span className="notice warn">{NOTE14_TEXT.differs}</span> : <a href={`/settings?confirm=${n.id}#declaration-confirm`}>変わりなしとして確かめ直す</a>}
                  {n.key === "note14" && d.note14.state === "differs" && <span className="muted">（{NOTE14_TEXT.differs}）</span>}
                  　<a href={`/settings#declaration-${n.key}`}>申告を見る</a>
                </li>
              ))}
            </ul>
          </div>
        ) : null,
      )}
      {d.recheck.noFromMonth.length > 0 && (
        <div>
          <h4>いつの診療月からを入れてください</h4>
          <ul style={{ paddingLeft: 18 }}>
            {d.recheck.noFromMonth.map((k) => <li key={k}><a href={`/settings#declaration-${k}`}>{label(k)}</a>（その申告の「確かめ直す」で入れます）</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}
