"use client";
// 取り込んだレセプトの点検の画面のメンター（採点 r2 医療事務課長 P1）：算定画面と同じメンター（POST /api/mentor）に、指摘の理由を聞く。
// 新しい AI の使い方は足さない：はじめて聞くときに、この請求の問題を算定画面と同じ入口（POST /api/questions。通常モード）で 1 つ作り、その問題について話す。
// メンターは答えを言わず理由を示す（算定画面と同じ指示。src/mentor/prompt.ts）。メンターが見る判定は、問題の明細（UKE の行）を手書きのルールで判定したものに、
// この画面に出ている指摘（摘要欄の R17・データで動く点検・患者情報チェックを含む）を添えたもの（screen: "uke"。採点 r3 医療事務課長 #2）。画面の指摘をメンターが打ち消さない。
// 話せるのは算定の仕事をする人（事務・ベテラン）だけ。キャラを選んでいなければ、算定画面へ案内する
import { useEffect, useState } from "react";
import type { MentorOutput } from "../../src/mentor/output";
import { faceFor, faceImage, type Face } from "../../src/mentor/face";
import type { MentorChoice } from "../mentor-picker";
import { getJson } from "../get-json";

type Bubble = { from: "mentor" | "me"; text: string; face?: Face };

async function post<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? "エラー");
  return d as T;
}

/** doctorMissing は、医師に確かめる情報不足があるか（メンターに渡す場面を「カルテ不足」にする） */
export function UkeMentor({ claimId, doctorMissing }: { claimId: string; doctorMissing: boolean }) {
  const [role, setRole] = useState<string | null>(null);
  const [choice, setChoice] = useState<MentorChoice | null>(null);
  const [questionId, setQuestionId] = useState<string | null>(null);
  const [chat, setChat] = useState<Bubble[]>([]);
  const [ask, setAsk] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    getJson<{ role: string }>("/api/auth/me").then((me) => setRole(me.role)).catch(() => setRole(null));
    getJson<MentorChoice>("/api/character").then(setChoice).catch(() => setChoice(null));
  }, []);
  // 請求が替わったら、問題と会話を持ち越さない
  useEffect(() => {
    setQuestionId(null);
    setChat([]);
  }, [claimId]);
  if (role !== "clerk" && role !== "veteran") return null;
  const me = choice?.current ?? null;
  const name = me?.name ?? "メンター";
  if (choice && !choice.chosen) return <div className="notice"><a href="/work">算定画面でメンターを選ぶ</a>と、ここでも指摘の理由を聞けます。</div>;

  async function send(message: string) {
    setErr("");
    setBusy(true);
    setChat((c) => [...c, { from: "me", text: message }]);
    try {
      const id = questionId ?? (await post<{ id: string }>("/api/questions", { claimId, mode: "通常" })).id;
      setQuestionId(id);
      const situation = doctorMissing ? "カルテ不足" : "通常";
      const r = await post<{ output: MentorOutput }>("/api/mentor", { questionId: id, message, situation, skipCrosscheck: true, screen: "uke" });
      setChat((c) => [...c, { from: "mentor", text: r.output.body, face: faceFor(situation, r.output.topic) }]);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const last = [...chat].reverse().find((b) => b.from === "mentor");
  return (
    <section className="notice" aria-label="メンター" style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
      {me?.image && <img src={faceImage(me.image, last?.face ?? "通常")} alt="" style={{ width: 72, height: 96, objectFit: "contain", objectPosition: "bottom", flex: "none" }} />}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
        <strong>{name}に聞く</strong>
        <div className="muted">指摘の理由や、どこを見ればよいかを聞けます。{name}は答えを言わず、理由と見る場所を示します（算定画面と同じメンターです。{name}は、この画面に出ている指摘を見て答えます）。</div>
        {chat.map((b, i) => (
          <div key={i} style={{ whiteSpace: "pre-wrap" }}><span className="muted">{b.from === "me" ? "あなた" : name}：</span>{b.text}</div>
        ))}
        {busy && <div className="muted">{name}が目を通しています…</div>}
        {err && <div className="notice warn">{err}</div>}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input value={ask} onChange={(e) => setAsk(e.target.value)} style={{ flex: 1, minWidth: 200 }} placeholder={`${name}に聞く（空なら「この指摘の理由を教えてください」）`} onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing && !busy) { void send(ask.trim() || "この指摘の理由を教えてください。"); setAsk(""); } }} />
          <button disabled={busy} onClick={() => { void send(ask.trim() || "この指摘の理由を教えてください。"); setAsk(""); }}>聞く</button>
        </div>
      </div>
    </section>
  );
}
