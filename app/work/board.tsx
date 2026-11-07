"use client";
// 算定画面の一覧（2026-11-08 ユーザー判断で案 C+「クエストボード」）：訪問は月のタイムライン、練習問題は患者の色のカード。
// 見た目だけを受け持ち、開く処理は呼ぶ側（page.tsx）の begin に任せる。データは合成データ・架空コード
import { useEffect, useState } from "react";
import type { ClaimContext } from "../../src/engine/types";

type Visit = { claimId: string; date: string; type: "visit" | "oushin"; mainDisease: string | null; lines: unknown[]; written: boolean };
export type BoardDrill = { id: string; no: number; claimId: string; situation: string[]; cleared?: boolean };

/** 患者ごとの色（明るさも変えて、色だけに頼らず見分けられるようにする） */
const COLORS: Record<string, { bg: string; ink: string }> = {
  K1: { bg: "#0e5cc6", ink: "#ffffff" },
  K2: { bg: "#c7a46a", ink: "#0b0e12" },
  K3: { bg: "#5a4632", ink: "#ffffff" },
  K4: { bg: "#7ec1ff", ink: "#0b0e12" },
  K5: { bg: "#0b0e12", ink: "#ffffff" },
  K6: { bg: "#aab2bd", ink: "#0b0e12" },
};
const colorOf = (claimId: string) => COLORS[claimId.split("-")[0]] ?? { bg: "#aab2bd", ink: "#0b0e12" };
const kOf = (claimId: string) => claimId.split("-")[0];

const Stethoscope = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 3v6a4 4 0 0 0 8 0V3" /><path d="M10 13v3a5 5 0 0 0 10 0v-2" /><circle cx="20" cy="12" r="2" />
  </svg>
);

export function Board(props: {
  visits: Visit[];
  cases: ClaimContext[];
  drills: { fix: BoardDrill[]; doctor: BoardDrill[] };
  onVisit: (v: Visit) => void;
  onDrill: (d: BoardDrill) => void;
}) {
  const { visits, cases, drills } = props;
  const [today, setToday] = useState("");
  useEffect(() => {
    fetch("/api/clock").then((r) => (r.ok ? r.json() : null)).then((d) => d && setToday(String(d.now).slice(0, 10))).catch(() => {});
  }, []);
  const disease = (claimId: string) => {
    const c = cases.find((x) => x.claimId === claimId);
    return c?.facts.mainDisease.known ? String(c.facts.mainDisease.value) : "";
  };
  // 訪問の月（合成データは 1 か月分）。日ごとに並べる
  const month = visits[0]?.date.slice(0, 7) ?? today.slice(0, 7);
  const lastDay = month ? new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate() : 31;
  const days = Array.from({ length: lastDay }, (_, i) => {
    const date = `${month}-${String(i + 1).padStart(2, "0")}`;
    return { n: i + 1, date, today: date === today, visits: visits.filter((v) => v.date === date) };
  });
  const patients = [...new Set(visits.map((v) => v.claimId))].sort();
  const fixDone = drills.fix.filter((d) => d.cleared).length;
  const docDone = drills.doctor.filter((d) => d.cleared).length;
  // 次にやる練習：まだ正解していない最初の 1 問
  const next = drills.fix.find((d) => !d.cleared)?.id;

  return (
    <>
      <div className="board-head">
        <h2>訪問記録デモ</h2>
        <span className="muted">訪問のデモデータです。点を押すと、その日の訪問を開きます。</span>
        <div className="legend" aria-label="患者の色">
          {patients.map((id) => (
            <span key={id}><span className="swatch" style={{ background: colorOf(id).bg }} />{kOf(id)} {disease(id)}</span>
          ))}
        </div>
      </div>
      <div className="timeline">
        <div className="timeline-days">
          {days.map((d) => (
            <div key={d.n} className={`timeline-col${d.today ? " today" : ""}`}>
              {d.visits.map((v) => (
                <button
                  key={v.claimId + v.type}
                  className={`timeline-dot${v.type === "oushin" ? " oushin" : ""}`}
                  style={{ background: colorOf(v.claimId).bg }}
                  title={`${Number(v.date.slice(5, 7))}/${d.n} ${kOf(v.claimId)} ${v.mainDisease ?? ""}・${v.type === "oushin" ? "往診" : "訪問診療"}・${v.lines.length} 行${v.written ? "・書いたカルテ" : ""}`}
                  aria-label={`${Number(v.date.slice(5, 7))}月${d.n}日 ${kOf(v.claimId)} ${v.mainDisease ?? ""} ${v.type === "oushin" ? "往診" : "訪問診療"}`}
                  onClick={() => props.onVisit(v)}
                />
              ))}
            </div>
          ))}
        </div>
        <div className="timeline-days">
          {days.map((d) => <span key={d.n} className={`timeline-n${d.today ? " today" : ""}`}>{d.n}</span>)}
        </div>
        <div className="muted">● 訪問診療　■ 往診　／　色の帯は今日（デモの日付）</div>
      </div>

      <div className="board-head">
        <h2>練習問題</h2>
        <span className="num" style={{ fontSize: 18, color: "var(--muted)" }}>{fixDone} / {drills.fix.length} CLEAR</span>
        <div className="board-progress" role="img" aria-label={`${drills.fix.length} 問中 ${fixDone} 問`}>
          <div style={{ width: `${drills.fix.length ? (fixDone / drills.fix.length) * 100 : 0}%` }} />
        </div>
        <span className="muted">はじめての方へ：<a href="/guide">練習問題の手引き</a></span>
      </div>
      <div className="cards">
        {drills.fix.map((d) => {
          const c = colorOf(d.claimId);
          const state = d.cleared ? "クリア" : d.id === next ? "NEXT" : "未挑戦";
          return (
            <button key={d.id} className={`qcard${d.cleared ? " cleared" : d.id === next ? " next" : ""}`} onClick={() => props.onDrill(d)} aria-label={`練習 ${d.no}（${kOf(d.claimId)}・${disease(d.claimId)}）${state}`}>
              <div className="qcard-band" style={{ background: c.bg }} />
              <div className="qcard-body">
                <div className="qcard-top">
                  <span className="qcard-no">{String(d.no).padStart(2, "0")}</span>
                  <span className="qcard-chip" style={{ background: c.bg, color: c.ink }}>{kOf(d.claimId)}</span>
                </div>
                <strong style={{ fontSize: 13 }}>練習 {d.no}</strong>
                <span style={{ fontSize: 12, opacity: 0.8 }}>{disease(d.claimId)}</span>
                <span className="qcard-state">{state}</span>
              </div>
            </button>
          );
        })}
      </div>

      <div className="board-head">
        <h2>医師確認用練習</h2>
        <span className="num" style={{ fontSize: 16, color: "var(--muted)" }}>{docDone} / {drills.doctor.length}</span>
      </div>
      <div className="dcards">
        {drills.doctor.map((d) => (
          <button key={d.id} className={`dcard${d.cleared ? " cleared" : ""}`} onClick={() => props.onDrill(d)}>
            <span className="dcard-icon"><Stethoscope /></span>
            <span style={{ display: "flex", flexDirection: "column" }}>
              <strong style={{ fontSize: 14 }}>医師確認 {d.no}</strong>
              <span className="muted" style={{ fontSize: 12 }}>{kOf(d.claimId)}・{disease(d.claimId)}</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: "var(--accent)" }}>{d.cleared ? "クリア" : "医師に聞いてから確定"}</span>
            </span>
          </button>
        ))}
      </div>
    </>
  );
}
