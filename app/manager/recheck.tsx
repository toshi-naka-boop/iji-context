"use client";
// 確かめ直す日の知らせ（FR-190。design.md §15-2）：施設の申告のうち、確かめ直す日が近い・過ぎた・ないものを並べる。メールなどで外に送らない
import { useEffect, useState } from "react";
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
  const groups: [string, string[]][] = [
    ["確かめ直す日を過ぎた申告", d.recheck.overdue],
    [`確かめ直す日が近い申告（${d.recheckNoticeDays} 日以内）`, d.recheck.soon],
    ["確かめ直す日のない申告", d.recheck.none],
  ];
  return (
    <div className="panel">
      <h3 style={{ marginTop: 0 }}>施設の申告の確かめ直し</h3>
      {groups.every(([, keys]) => keys.length === 0) && <p className="muted">確かめ直す日が近い・過ぎた・ない申告はありません。</p>}
      {groups.map(([title, keys]) =>
        keys.length > 0 ? (
          <div key={title}>
            <h4>{title}</h4>
            <ul style={{ paddingLeft: 18 }}>
              {keys.map((k) => <li key={k}><a href={`/settings#declaration-${k}`}>{label(k)}</a></li>)}
            </ul>
          </div>
        ) : null,
      )}
    </div>
  );
}
