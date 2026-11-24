"use client";
// マスターの状態（design.md §12-5）：事務長にだけ、設定の画面が出す欄。入っている公開データ・更新日・件数・取り込んだ日時と、点検の準備。
// データはアプリに同梱していない。入れるのは、サーバーを動かす人がコマンドで行う（docs/masters.md）
import { useEffect, useState } from "react";

type Status = {
  present: boolean;
  sources: { dataset: string; snapshot: string; table: string; file: string; rows: number; importedAt: string; verified: string | null; newer: boolean }[];
  checks: { check: string; ready: boolean; reason: string }[];
  rejected: { dataset: string; snapshot: string; file: string; reason: string }[];
  licenses?: { dataset: string; title: string; name: string; url: string; credit: string }[];
};

/** データ名・表の名前の表示（config/masters.json の title と同じ言い方） */
const TABLE_LABELS: Record<string, string> = {
  shinryo: "医科診療行為マスター", iyakuhin: "医薬品マスター", tokutei: "特定器材マスター", shobyo: "傷病名マスター", shushokugo: "修飾語マスター", comment: "コメントマスター",
  hojo: "電子点数表（補助マスター）", houkatsu: "電子点数表（包括）", haihan: "電子点数表（背反）", kaisu: "電子点数表（算定回数）",
  comment_kanren: "コメント関連テーブル", cm_tekio: "チェックマスタ（医薬品の適応）", cm_si_shobyo: "チェックマスタ（診療行為の適応）", cm_heiyo_kinki: "チェックマスタ（併用禁忌）", manbyo: "万病辞書 MANBYO（略語の意味の候補）",
};
const CHECK_LABELS: Record<string, string> = { G01: "コード", G02: "点数の検算", G03: "行の属性", G04: "包括", G05: "背反", G06: "算定回数", G07: "必須コメント", G08: "傷病名の要件", G09: "適応・併用", G10: "施設基準", G11: "取り忘れ" };

const day = (s: string) => `${s.slice(0, 4)}/${s.slice(4, 6)}/${s.slice(6, 8)}`;
const when = (iso: string) => new Date(iso).toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

export function Masters() {
  const [status, setStatus] = useState<Status | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    fetch("/api/masters")
      .then(async (r) => (r.ok ? setStatus(await r.json()) : setErr("マスターの状態を読めませんでした")))
      .catch(() => setErr("通信できませんでした。もう一度試してください"));
  }, []);
  const howTo = (
    <p className="muted">
      入れる手順（サーバーを動かす人が行います）：<code>npm run masters:fetch</code> で落とすものの一覧を確かめ、<code>npm run masters:fetch -- --yes</code> で落とし、<code>npm run masters:build</code> で取り込みます。くわしくは docs/masters.md。
    </p>
  );
  return (
    <div className="panel">
      <h3 style={{ marginTop: 0 }}>マスターの状態</h3>
      <p className="muted">全部の行の点検に使う、公開のデータ（基本マスター・電子点数表・コメント関連テーブル・チェックマスタ）です。アプリには同梱していません。</p>
      {err && <div className="notice warn">{err}</div>}
      {status && !status.present && (
        <>
          <div className="notice warn">入っていません。データで動く点検は、どれも動きません（手書きのルールの点検は、今までどおり動きます）。</div>
          {howTo}
        </>
      )}
      {status?.present && (
        <>
          {status.sources.some((s) => s.newer) && <div className="notice warn">読み方を確かめた版より新しいデータが入っています。形式と、原文で確かめた事実（錨）の検査は通っています。</div>}
          <table>
            <thead>
              <tr><th>データ</th><th>更新日</th><th>件数</th><th>取り込んだ日時</th><th>読み方を確かめた版</th></tr>
            </thead>
            <tbody>
              {status.sources.map((s) => (
                <tr key={`${s.table}-${s.snapshot}-${s.file}`}>
                  <td>{TABLE_LABELS[s.table] ?? s.table}</td>
                  <td>{day(s.snapshot)}{s.newer ? "（確かめた版より新しい）" : ""}</td>
                  <td style={{ textAlign: "right" }}>{s.rows.toLocaleString("ja-JP")}</td>
                  <td>{when(s.importedAt)}</td>
                  <td>{s.verified ? day(s.verified) : "なし"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {(status.licenses ?? []).map((l) => (
            <p key={l.dataset} className="muted">
              出典：{l.credit}（<a href={l.url} target="_blank" rel="noreferrer">{l.name}</a>）
            </p>
          ))}
          {status.rejected.length > 0 && (
            <div className="notice warn">
              形式が合わず、取り込まなかったファイルがあります：
              <ul>{status.rejected.map((r) => <li key={`${r.dataset}-${r.snapshot}-${r.file}`}>{r.dataset}／{r.snapshot}／{r.file}：{r.reason}</li>)}</ul>
            </div>
          )}
          <h4>点検の準備</h4>
          <p className="muted">要るデータがそろい、読み方を原文で確かめてある点検だけが動きます。</p>
          <ul>
            {status.checks.map((c) => (
              <li key={c.check}>{c.check} {CHECK_LABELS[c.check] ?? ""}：{c.ready ? `準備できています${c.reason ? `（${c.reason}）` : ""}` : `動かしません（${c.reason}）`}</li>
            ))}
          </ul>
          {howTo}
        </>
      )}
    </div>
  );
}
