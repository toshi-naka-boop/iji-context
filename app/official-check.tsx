"use client";
// 公的情報（疑義解釈・審査の取扱いなど）との突き合わせの結果と、文書の条件に当たるかを人が確かめる操作（design.md §11-3）。
// ローカルルール欄（app/work/page.tsx）と知識の画面（app/knowledge/page.tsx）が同じ部品を使う。結果は決まった規則のもので、AI は判定しない
import { useEffect, useState } from "react";
import { permits, POLICY } from "../src/server/policy";
import type { Role } from "../src/server/roles";

type Doc = { id: string; kind: string; issuer: string; number: string; issuedOn: string; url: string; stance: string; summary: string; verdict: string };
export type OfficialMatch = {
  verdict: "整合" | "矛盾の恐れ" | "公的根拠なし" | "関連あり・未照合";
  /** まとめの結果が、人の確認で決まったものか */
  humanChecked: boolean;
  approx: boolean;
  conditionNote: string | null;
  docs: Doc[];
  /** 人が「この文書の条件には当たらない」と確かめた文書 */
  notApplying: Doc[];
  /** 知識の条件（機械が見るもの）を言葉にしたものと、知識の注記（機械は見ない） */
  matchText: string;
  ruleNote: string | null;
  /** 停止・保管の知識では確かめられない */
  canCheck: boolean;
  checks: { docId: string; key: string; condition: string; check: { applies: boolean; by: string; at: string } | null }[];
};
/** 突き合わせの結果の札の色（危ない側を目立たせる） */
const VERDICT_BADGE: Record<OfficialMatch["verdict"], string> = { 整合: "ok", 矛盾の恐れ: "warn", 公的根拠なし: "", "関連あり・未照合": "sky" };

export type CheckRights = { applies: boolean; notApplies: boolean };
/** いまの役割で、どちらのボタンを押せるか。権限表（src/server/policy.ts）の行で決める（サーバーも同じ行で確かめる） */
export function useCheckRights(): CheckRights {
  const [rights, setRights] = useState<CheckRights>({ applies: false, notApplies: false });
  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((me: { role: Role; canSwitchRole: boolean } | null) => {
        if (!me) return;
        const can = (kind: "applies" | "not-applies") => permits(POLICY[`POST /api/knowledge/[id]/official-check/${kind}`].rule, me, () => me.canSwitchRole);
        setRights({ applies: can("applies"), notApplies: can("not-applies") });
      })
      .catch(() => {});
  }, []);
  return rights;
}

/** 知識 1 件の、公的情報との突き合わせ。onChanged は、確かめた後・文書が更新されていたときに呼ぶ（読み直し） */
export function OfficialBlock({ knowledgeId, official, rights, onChanged }: { knowledgeId: string; official: OfficialMatch; rights: CheckRights; onChanged: () => void }) {
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const checkOf = (docId: string) => official.checks.find((c) => c.docId === docId);
  async function send(kind: "applies" | "not-applies", docId: string, key: string) {
    setBusy(true);
    try {
      const r = await fetch(`/api/knowledge/${encodeURIComponent(knowledgeId)}/official-check/${kind}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ docId, key }) });
      const d = await r.json().catch(() => null);
      // 409：読んだ後に文書が更新された、など。文言を出して読み直す
      setErr(r.ok ? "" : d?.error ?? "確かめた結果を残せませんでした。時間をおいて、もう一度試してください");
      if (r.ok || r.status === 409) onChanged();
    } catch {
      setErr("確かめた結果を残せませんでした。時間をおいて、もう一度試してください");
    } finally {
      setBusy(false);
    }
  }
  const row = (d: Doc) => {
    const c = checkOf(d.id);
    const who = c?.check ? `${c.check.by}・${c.check.at}` : "";
    return (
      <div key={d.id} className="muted" style={{ marginTop: 2 }}>
        ・<a href={d.url} target="_blank" rel="noreferrer">{d.kind}　{d.issuer}　{d.number}</a>（{d.issuedOn}・{d.stance}{d.verdict !== official.verdict && d.verdict !== "対象外" ? `・${d.verdict}` : ""}）{d.summary}
        {c?.check && <strong>　{c.check.applies ? `人が確かめた（${who}）` : `確かめた：この文書の条件には当たらない（${who}）`}</strong>}
        {c && official.canCheck && (rights.applies || rights.notApplies) && (
          <details style={{ marginLeft: 12 }}>
            <summary>この文書の条件に当たるかを確かめる</summary>
            <div>文書の条件：{c.condition}</div>
            <div>このルールの条件：{official.matchText}</div>
            <div>このルールの注記：{official.ruleNote ?? "なし"}</div>
            <div className="chips" style={{ alignItems: "center" }}>
              <span>このルールは、いまの条件だと〈{c.condition}〉の請求にも表示されます。そのとおりですか</span>
              {rights.applies && <button disabled={busy} onClick={() => send("applies", d.id, c.key)}>当たる</button>}
              {rights.notApplies && <button disabled={busy} onClick={() => send("not-applies", d.id, c.key)}>当たらない</button>}
            </div>
          </details>
        )}
      </div>
    );
  };
  return (
    <div style={{ marginLeft: 12 }}>
      <span className={`badge ${VERDICT_BADGE[official.verdict]}`}>公的情報：{official.verdict}{official.humanChecked ? "（人が確かめた）" : ""}</span>
      {official.approx && official.docs.length > 0 && <span className="muted">　条件の注記あり{official.conditionNote ? `（このルールの条件：${official.conditionNote}）` : ""}。当てはまるかは読み比べて確かめてください</span>}
      {err && <div className="notice warn">{err}</div>}
      {official.docs.map(row)}
      {official.notApplying.map(row)}
    </div>
  );
}
