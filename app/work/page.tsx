"use client";
// 算定画面（F7：1 件＝1 問。ヒント → 確定 → 判定 → 解説）。判定はエンジン、メンターはヒントと解説だけ
import { useEffect, useMemo, useState } from "react";
import type { ClaimContext, ClaimLine, EngineResult, Finding } from "../../src/engine/types";
import type { MentorOutput, Situation } from "../../src/mentor/output";
import type { Character } from "../../src/mentor/prompt";
import { PREFERENCES, TYPES16, type Style } from "../../src/mentor/style";
import { faceFor, faceImage, selectImage, type Face } from "../../src/mentor/face";
import type { Question } from "../../src/practice/practice";
import { findingText } from "../../src/messages";
import { TopBar } from "../nav";
import { SignIn, useClerk } from "../clerk";
import { PatientPanel } from "./patient-panel";

type Master = { kubun: string; name: string; points: number | null }[];
type Status = { level: number; count: number; streak: number };
/** 防いだ額（本人向け。FR-57：既定は出さず、本人が開いたときだけ。金額は推定） */
type Prevented = { visible: false } | { visible: true; summary: { label: string; 取りこぼし: { count: number; yen: number }; 差し戻し: { count: number; yen: number }; 医師記載起因: { count: number; yen: number } } };
/** face は立ち絵の表情（場面で決める）。expression はメンターが選んだ表情で、記録として残すだけ */
type Bubble = { from: "mentor" | "me"; text: string; expression?: string; face?: Face };
/** 選択モードの問題（正誤はサーバーでユスティが決める。画面は正解を持たない） */
type ChoiceItem = { lineIndex: number; group: string; options: string[] };
type ChoiceState = { item: ChoiceItem; wrong: string[]; reason: string; state: "未回答" | "正解" | "判定不能" };
/** 訪問の記録（レセコンに入れる前。FR-68）：その日のカルテと、その日までの実施 */
type Visit = { claimId: string; date: string; type: "visit" | "oushin"; mainDisease: string | null; chart: { s: string; a: string; p: string } | null; lines: ClaimLine[]; outlook: string; written: boolean };
/** 練習問題（よくある間違いを入れた明細。FR-75）。答えのルールは一覧に出ない */
type Drill = { id: string; no: number; claimId: string; situation: string[] };
/** 本人が選んだメンターと、選べるキャラ（FR-19） */
type MentorChoice = { chosen: boolean; current: Character; characters: Character[]; style: Style };
type Cross = { mismatches: { ruleId: string; disease: string; draft: { question: string }; query: { id: string; status: string } | null }[]; confirmed: string[] };


/** レセプトを開いたときにメンターへ渡す合図（本人には見せない） */
const OPENING = "（本人がこのレセプトを開いた。最初のひと声をかけてください。レベルに合わせて、見るとよい場所を一つ示すか、声かけだけにするかを決める）";

async function api<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error ?? "エラー");
  return d as T;
}

export default function Work() {
  // 利用者（審査員などがそれぞれ自分の利用者で使う）
  const { clerk: user, ready } = useClerk();
  const CLERK = user?.id ?? "";
  const [prevented, setPrevented] = useState<Prevented | null>(null);
  const [showPrevented, setShowPrevented] = useState(false);
  /** 取り込んだ UKE に入っているレセプト（月末の点検の対象） */
  const [ukeClaims, setUkeClaims] = useState<string[] | null>(null);
  const [cases, setCases] = useState<ClaimContext[]>([]);
  const [master, setMaster] = useState<Master>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [q, setQ] = useState<Question | null>(null);
  const [lines, setLines] = useState<ClaimLine[]>([]);
  const [chat, setChat] = useState<Bubble[]>([]);
  const [ask, setAsk] = useState("");
  const [showLog, setShowLog] = useState(false);
  /** 医師に聞きたいと言われたときに、照合の不一致から本人に選んでもらう選択肢（メンターは質問を書かない） */
  const [choices, setChoices] = useState<{ ruleId: string; about: string }[]>([]);
  const [pendingAsk, setPendingAsk] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [cross, setCross] = useState<Cross | null>(null);
  const [proxy, setProxy] = useState("");
  const [proxyMsg, setProxyMsg] = useState("");
  /** 選択モード（急いでいるとき）：区分を選ぶ箇所を、正解と間違えやすい区分の選択肢で答える */
  const [choiceMode, setChoiceMode] = useState(false);
  const [quiz, setQuiz] = useState<ChoiceState[]>([]);
  const [mentorChoice, setMentorChoice] = useState<MentorChoice | null>(null);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [drills, setDrills] = useState<Drill[]>([]);
  /** 問題の始まりの請求（訪問の時点・練習問題では、月末の UKE とちがう） */
  const [qCase, setQCase] = useState<ClaimContext | null>(null);
  /** カルテを書いた直後（/work?visit=claimId|date）は、その訪問の記録を開く（FR-69） */
  const [pendingVisit, setPendingVisit] = useState<string | null>(null);
  useEffect(() => {
    const v = new URLSearchParams(window.location.search).get("visit");
    if (v) setPendingVisit(v);
  }, []);
  const loadVisits = () => api<Visit[]>(`/api/visits?clerkId=${CLERK}`).then(setVisits).catch(() => setVisits([]));
  /** メンターを選び直している途中 */
  const [picking, setPicking] = useState(false);
  /** 伝え方のタイプ（FR-20。本人の申告、任意）。変えるとメンターとの会話は新しく始まる */
  async function pickStyle(style: Style) {
    setErr("");
    try {
      setMentorChoice(await api<MentorChoice>("/api/character", { clerkId: CLERK, style }));
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  async function pickMentor(characterId: string) {
    setErr("");
    try {
      const m = await api<MentorChoice>("/api/character", { clerkId: CLERK, characterId });
      const changed = mentorChoice?.chosen && mentorChoice.current.id !== characterId;
      setMentorChoice(m);
      setPicking(false);
      // レセプトを開いている途中で替えたら、新しいメンターから声をかける（会話はセッションごと新しくなる）
      if (changed && q) {
        setChat([]);
        void mentor(OPENING, "通常", q.id, true);
      }
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  async function sendProxy() {
    if (!q) return;
    setBusy(true);
    try {
      const r = await api<{ scribed: { text: string; missing: { field: string; target: string }[] }; clerkTasks: { field: string }[] }>("/api/proxy", { claimId: q.claimId, text: proxy });
      setProxyMsg(`医師確認に回しました：${r.scribed.text}${r.clerkTasks.length ? `\n医療事務で確かめること：${r.clerkTasks.map((t) => t.field).join("、")}` : ""}`);
      setProxy("");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const loadCross = (claimId: string, asOf?: string) => api<Cross>(`/api/crosscheck?claimId=${claimId}&clerkId=${CLERK}${asOf ? `&asOf=${asOf}` : ""}`).then(setCross).catch(() => setCross(null));

  useEffect(() => {
    if (!CLERK) return;
    api<ClaimContext[]>("/api/cases").then(setCases).catch((e) => setErr(e.message));
    api<Master>("/api/master").then(setMaster).catch(() => {});
    loadVisits();
    api<Drill[]>("/api/drills").then(setDrills).catch(() => setDrills([]));
    api<MentorChoice>(`/api/character?clerkId=${CLERK}`).then(setMentorChoice).catch((e) => setErr(e.message));
    api<{ imported: boolean; receipts: { claimId: string }[] }[]>(`/api/uke?clerkId=${CLERK}`)
      .then((us) => setUkeClaims(us.filter((u) => u.imported).flatMap((u) => u.receipts.map((r) => r.claimId))))
      .catch(() => setUkeClaims([]));
    refreshStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [CLERK]);
  const refreshStatus = () => api<Status>(`/api/me?clerkId=${CLERK}`).then(setStatus).catch(() => {});
  /** 防いだ額は本人が開いたときだけ取りにいく（FR-57） */
  async function togglePrevented() {
    const next = !showPrevented;
    setShowPrevented(next);
    if (next) setPrevented(await api<{ prevented: Prevented }>(`/api/me?clerkId=${CLERK}&optIn=1`).then((d) => d.prevented).catch(() => null));
  }

  const ctx = useMemo(() => qCase ?? cases.find((c) => c.claimId === q?.claimId) ?? null, [qCase, cases, q]);
  const nameOf = (k: string) => master.find((m) => m.kubun === k)?.name ?? k;
  const pointsOf = (k: string) => master.find((m) => m.kubun === k)?.points ?? null;

  /** visit があれば訪問の時点（レセコンに入れる前）の問題。なければ月末の UKE の問題 */
  async function begin(claimId: string, visit?: Visit, drill?: Drill) {
    setErr("");
    const plain = !visit && !drill;
    const nq = await api<Question>("/api/questions", { claimId, mode: plain && choiceMode ? "選択" : "通常", asOf: visit?.date, drill: drill?.id });
    const start = await api<ClaimContext>(`/api/questions/${nq.id}/case`);
    setQCase(start);
    setQ(nq);
    setQuiz([]);
    if (plain && choiceMode) {
      const items = await api<ChoiceItem[]>(`/api/questions/${nq.id}/choices`);
      setQuiz(items.map((item) => ({ item, wrong: [], reason: "", state: "未回答" })));
    }
    setLines(start.lines.map((l) => ({ ...l, dates: [...l.dates] })));
    setChat([]);
    loadCross(claimId, visit?.date);
    // メンターから先に声をかける（聞かれるのを待たない）。下書きの記録は作らない（防いだ額に数えない）
    void mentor(OPENING, "通常", nq.id, true);
  }

  /** 照合の不一致を本人が選んだ：決まった質問で医師確認を送る */
  async function chooseCross(ruleId: string, about: string) {
    setChoices([]);
    setChat((c) => [...c, { from: "me", text: `「${about}」のことを医師に聞く` }]);
    await sendQuery(ruleId);
    setChat((c) => [...c, { from: "mentor", text: "決まった質問で医師に確認を送りました。回答が来たら一緒に見ましょう。", expression: "通常" }]);
  }
  /** それ以外：この 1 回は照合の不一致を渡さず、メンターが質問を作る */
  async function chooseOther() {
    setChoices([]);
    setChat((c) => [...c, { from: "me", text: "照合のこととは別のことを聞きたい" }]);
    await mentor(pendingAsk, "カルテ不足", q?.id, true, true);
  }

  /** 選択モードで 1 つ選ぶ。正誤はユスティ。間違いならその指摘を理由として見せ、もう一度選べる */
  async function choose(lineIndex: number, option: string) {
    if (!q) return;
    try {
      const r = await api<{ correct: boolean; findings: Finding[] }>(`/api/questions/${q.id}/choices`, { lineIndex, option });
      setQuiz((qs) =>
        qs.map((x) => {
          if (x.item.lineIndex !== lineIndex) return x;
          if (option === "判定不能") return { ...x, state: "判定不能", reason: "区分を表から自分で選ぶか、メンターに聞いてみましょう。" };
          if (r.correct) return { ...x, state: "正解", reason: "" };
          return { ...x, wrong: [...x.wrong, option], reason: r.findings.map(findingText).join(" ") || "ユスティの判定では合いません。" };
        }),
      );
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  /** 選択モードで、まだ答えていない行（区分を「？」で隠す） */
  const hidden = (i: number) => quiz.some((x) => x.item.lineIndex === i && x.state === "未回答");

  async function sendQuery(ruleId: string) {
    if (!q) return;
    try {
      await api("/api/crosscheck", { claimId: q.claimId, ruleId, asOf: q.asOf, clerkId: CLERK });
    } catch (e) {
      setErr((e as Error).message);
    }
    loadCross(q.claimId, q.asOf);
  }

  /** silent=true はメンターから話しかける場面（本人の発言として画面に出さない） */
  async function mentor(message: string, situation: Situation, questionId = q?.id, silent = false, skipCrosscheck = false) {
    if (!questionId) return;
    setBusy(true);
    setChoices([]);
    if (!silent) setChat((c) => [...c, { from: "me", text: message }]);
    try {
      const r = await api<{ output: MentorOutput; choices: { ruleId: string; about: string }[] }>("/api/mentor", { clerkId: CLERK, questionId, message, situation, skipCrosscheck });
      setChat((c) => [...c, { from: "mentor", text: r.output.body, expression: r.output.expression, face: faceFor(situation, r.output.topic) }]);
      if (r.choices?.length) {
        setChoices(r.choices);
        setPendingAsk(message);
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** ヒント：下書きをエンジンにかけてから、メンターに聞く（指摘そのものは画面に出さない） */
  async function hint(message: string) {
    if (!q) return;
    const d = await api<{ question: Question; result: EngineResult }>(`/api/questions/${q.id}/draft`, { lines });
    setQ(d.question);
    const doctor = d.result.findings.some((f) => f.missing?.target === "doctor");
    await mentor(message, doctor ? "カルテ不足" : "通常");
  }

  async function doConfirm() {
    if (!q) return;
    setErr("");
    try {
      const cq = await api<Question>(`/api/questions/${q.id}/confirm`, { lines });
      setQ(cq);
      // 確定したら、聞かれる前に解説を始める
      await explanation(cq);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function explanation(cur = q) {
    if (!cur) return;
    const nq = await api<Question>(`/api/questions/${cur.id}/explain`, {});
    setQ(nq);
    await mentor("（本人が確定した。判定の理由を短く解説してください）", nq.correct ? "正方向" : "新人の誤り", nq.id, true);
  }

  async function next() {
    if (!q) return;
    await api<Question>(`/api/questions/${q.id}/done`, {});
    setQ(null);
    setQCase(null);
    refreshStatus();
    loadVisits();
  }

  const findings: Finding[] = q?.confirmed?.result.findings ?? [];
  const total = lines.reduce((s, l) => s + (pointsOf(l.kubun) ?? 0) * l.count, 0);
  const lastMentorBubble = [...chat].reverse().find((b) => b.from === "mentor");
  const lastFace: Face = lastMentorBubble?.face ?? "通常";
  const lastMentor = lastMentorBubble?.text ?? null;
  const me = mentorChoice?.current ?? null;
  const mentorName = me?.name ?? "メンター";
  useEffect(() => {
    if (!pendingVisit || q || !mentorChoice?.chosen || cases.length === 0) return;
    const [claimId, date] = pendingVisit.split("|");
    const v = visits.find((x) => x.claimId === claimId && x.date === date);
    if (!v) return;
    setPendingVisit(null);
    window.history.replaceState(null, "", "/work");
    void begin(claimId, v);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingVisit, visits, mentorChoice, cases, q]);
  const visitOf = q?.asOf ? visits.find((v) => v.claimId === q.claimId && v.date === q.asOf) ?? null : null;
  const showChooser = mentorChoice !== null && (!mentorChoice.chosen || picking);

  if (!ready) return <main className="shell"><TopBar /></main>;
  if (!user) return <main className="shell"><TopBar /><SignIn /></main>;

  return (
    <main className="shell">
      <TopBar right={status && <span className="level">Lv.{status.level}・{status.count} 件・連続 {status.streak}</span>} />
      {err && <div className="notice warn">{err}</div>}
      {showChooser && mentorChoice && (
        <div className="panel">
          <h2 style={{ marginTop: 0 }}>{mentorChoice.chosen ? "メンターを変える" : "一緒に働くメンターを選んでください"}</h2>
          <p className="muted">あとから変えられます。変えると、メンターとの会話は新しく始まります。</p>
          <div className="chooser">
            {mentorChoice.characters.map((c) => (
              <button key={c.id} className={`chooser-card${mentorChoice.chosen && c.id === mentorChoice.current.id ? " current" : ""}`} onClick={() => pickMentor(c.id)}>
                {c.image && <img src={selectImage(c.image)} alt="" />}
                <strong>{c.name}</strong>
                <span className="muted">{c.tone}</span>
                {c.examples?.opening && <span className="bubble">{c.examples.opening}</span>}
              </button>
            ))}
          </div>
          {mentorChoice.chosen && <p><button onClick={() => setPicking(false)}>変えずに戻る</button></p>}
        </div>
      )}
      {!q && mentorChoice?.chosen && !picking && (
        <div className="panel">
          <p className="muted">
            メンター：{mentorName}　<button onClick={() => setPicking(true)}>メンターを変える</button>
          </p>
          <p className="muted">
            <button onClick={togglePrevented} aria-expanded={showPrevented}>{showPrevented ? "防いだ額を閉じる" : "防いだ額を見る"}</button>　既定では出しません。開いたときだけ表示します
          </p>
          {showPrevented && prevented?.visible && (
            <div className="notice ok">
              <div>取りこぼしを防いだ（算定漏れ）：{prevented.summary.取りこぼし.count} 件・{prevented.summary.取りこぼし.yen.toLocaleString()} 円</div>
              <div>差し戻しを防いだ（返戻・査定のおそれ）：{prevented.summary.差し戻し.count} 件・{prevented.summary.差し戻し.yen.toLocaleString()} 円</div>
              <div>うち医師の記載が原因で、医師確認で解決：{prevented.summary.医師記載起因.count} 件・{prevented.summary.医師記載起因.yen.toLocaleString()} 円</div>
              <div className="muted">{prevented.summary.label}。提出前に指摘され、提出までに直した項目だけを数えています（点数×10 円）</div>
            </div>
          )}
          <p className="muted">
            話し方の好み（任意）：
            <select value={mentorChoice.style?.preference ?? ""} onChange={(e) => pickStyle({ ...mentorChoice.style, preference: (e.target.value || undefined) as Style["preference"] })}>
              <option value="">指定しない</option>
              {PREFERENCES.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
            　16 タイプ（任意・自己申告）：
            <select value={mentorChoice.style?.type16 ?? ""} onChange={(e) => pickStyle({ ...mentorChoice.style, type16: (e.target.value || undefined) as Style["type16"] })}>
              <option value="">指定しない</option>
              {TYPES16.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </p>
          <h2>訪問の記録（レセコンに入れる前）</h2>
          <p className="muted">訪問のあった日に、その日のカルテとその日までの実施を見直します（デモデータとして、どの日の訪問でも開けます）。在医総管の区分など月末に決まるものは、見込みだけ出します。件数・レベルには数えません。</p>
          <div className="chips">
            {visits.map((v) => (
              <button key={v.claimId + v.date} onClick={() => begin(v.claimId, v)}>
                {Number(v.date.slice(5, 7))}/{Number(v.date.slice(8))} {v.claimId.split("-")[0]}（{v.mainDisease ?? "主病不明"}・{v.type === "oushin" ? "往診" : "訪問診療"}{v.written ? "・書いたカルテ" : ""}）{v.lines.length} 行
              </button>
            ))}
          </div>
          <h2>練習問題（よくある間違いを入れた明細）</h2>
          <p className="muted">新人が入れたつもりの明細に、よくある間違いが 1 つ入っています。見直して直し、確定してください。間違いは報告書にある実例（13 項目）から取っています。件数・レベルには数え、防いだ額には数えません。</p>
          <div className="chips">
            {drills.map((d) => {
              const c = cases.find((x) => x.claimId === d.claimId);
              return (
                <button key={d.id} onClick={() => begin(d.claimId, undefined, d)}>
                  練習 {d.no}（{d.claimId.split("-")[0]}・{c?.facts.mainDisease.known ? c.facts.mainDisease.value : ""}）
                </button>
              );
            })}
          </div>
          <h2>月末の点検（UKE・提出前）</h2>
          <p>
            <label>
              <input type="checkbox" checked={choiceMode} onChange={(e) => setChoiceMode(e.target.checked)} /> 選択モード（急いでいるとき。区分を選択肢から選ぶ。レベルの上がり方は小さめ）
            </label>
          </p>
          {ukeClaims !== null && ukeClaims.length === 0 && (
            <p className="muted">まだ UKE を取り込んでいません。<a href="/uke">UKE を取り込む</a>と、ここに並びます。</p>
          )}
          <div className="chips">
            {cases.filter((c) => ukeClaims?.includes(c.claimId)).map((c) => (
              <button key={c.claimId} onClick={() => begin(c.claimId)}>
                {c.claimId.split("-")[0]}（{c.facts.mainDisease.known ? c.facts.mainDisease.value : "主病不明"}）
              </button>
            ))}
          </div>
        </div>
      )}
      {q && ctx && (
        <div className={`work${showLog ? " with-log" : ""}`}>
          <section className="panel">
            <h2 style={{ marginTop: 0 }}>
              {q.claimId}　<span className="muted">{ctx.payer}・{ctx.facts.insurance.known ? ctx.facts.insurance.value : ""}・{q.phase}{q.mode === "選択" ? "・選択モード" : ""}{q.asOf ? `・${Number(q.asOf.slice(8))} 日の訪問（レセコンに入れる前）` : ""}</span>
            </h2>
            {q.drill && (
              <div className="notice">
                <strong>練習問題</strong>　よくある間違いが 1 つ入っています。
                {(drills.find((d) => d.id === q.drill)?.situation ?? []).map((x) => <div key={x}>状況：{x}</div>)}
              </div>
            )}
            {visitOf && (
              <div className="notice">
                <strong>カルテ（{visitOf.date}）</strong>
                {visitOf.chart ? <div>S：{visitOf.chart.s}　A：{visitOf.chart.a}　P：{visitOf.chart.p}</div> : <div className="muted">この日のカルテはありません</div>}
                <div className="muted">見込み：{visitOf.outlook}</div>
              </div>
            )}
            {q.mode === "選択" && q.phase === "ヒント" && (
              <div className="quiz">
                {quiz.length === 0 && <div className="notice ok">このレセプトには選択式で出せる箇所がありません。いつもどおり表を見直してください。</div>}
                {quiz.map((x) => (
                  <div key={x.item.lineIndex} className={`notice ${x.state === "正解" ? "ok" : x.wrong.length ? "warn" : ""}`}>
                    <strong>{x.item.group}は？</strong>（{x.item.lineIndex + 1} 行目）
                    {x.state === "未回答" ? (
                      <div className="dialog-actions" role="group" aria-label={`${x.item.group}を選ぶ`}>
                        {x.item.options.map((o) => (
                          <button key={o} disabled={x.wrong.includes(o)} onClick={() => choose(x.item.lineIndex, o)}>
                            {o === "なし" || o === "判定不能" ? o : nameOf(o)}
                          </button>
                        ))}
                      </div>
                    ) : (
                      <span>　{x.state === "正解" ? "正解です" : "判定不能"}</span>
                    )}
                    {x.reason && <div className="muted">{x.reason}</div>}
                  </div>
                ))}
              </div>
            )}
            <table>
              <thead>
                <tr><th>区分</th><th>回数</th><th>日（3 月）</th><th>点数</th><th /></tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i}>
                    <td>
                      {hidden(i) ? <span aria-label="選択式で答える区分">？（上で選ぶ）</span> : <select value={l.kubun} disabled={q.phase !== "ヒント"} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, kubun: e.target.value } : x)))}>
                        {master.map((m) => <option key={m.kubun} value={m.kubun}>{m.name}</option>)}
                      </select>}
                    </td>
                    <td>{l.count}</td>
                    <td>
                      <input
                        value={l.dates.map((d) => Number(d.slice(8))).join(",")}
                        disabled={q.phase !== "ヒント"}
                        style={{ width: 120 }}
                        onChange={(e) => {
                          const dates = e.target.value.split(",").map((s) => s.trim()).filter(Boolean).map((d) => `2025-03-${d.padStart(2, "0")}`);
                          setLines(lines.map((x, j) => (j === i ? { ...x, dates, count: dates.length } : x)));
                        }}
                      />
                    </td>
                    <td>{hidden(i) ? "？" : pointsOf(l.kubun) ?? "未収載"}</td>
                    <td>{q.phase === "ヒント" && quiz.length === 0 && <button onClick={() => setLines(lines.filter((_, j) => j !== i))}>外す</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {q.phase === "ヒント" && (
              <p>
                <button onClick={() => setLines([...lines, { kubun: master[0]?.kubun ?? "C001_1I", count: 1, dates: ["2025-03-10"] }])}>行を足す</button>
                <span className="muted">　合計 {quiz.some((x) => x.state === "未回答") ? "？" : total.toLocaleString()} 点（{nameOf(lines[0]?.kubun ?? "")} ほか）</span>
              </p>
            )}
            <PatientPanel
              claimId={q.claimId}
              clerkId={CLERK}
              facts={ctx.facts}
              editable={q.phase === "ヒント" && q.mode !== "選択" && !q.drill}
              onSaved={() => {
                api<ClaimContext[]>("/api/cases").then(setCases).catch(() => {});
                // 問題の始まりの請求にも、確かめた患者情報を反映する
                api<ClaimContext>(`/api/questions/${q.id}/case`).then(setQCase).catch(() => {});
              }}
            />
            {cross && (cross.mismatches.length > 0 || cross.confirmed.length > 0) && (
              <div>
                <h3>確認してほしい点（カルテとの照合）</h3>
                {cross.mismatches.map((m) => (
                  <div key={m.ruleId} className="notice warn">
                    傷病名「{m.disease}」と処方が合っていません。{m.draft.question}
                    <div style={{ marginTop: 6 }}>
                      {m.query ? (
                        <span>医師確認を送りました（{m.query.status}）。<button onClick={() => loadCross(q.claimId, q.asOf)}>状態を見る</button></span>
                      ) : (
                        <button onClick={() => sendQuery(m.ruleId)}>医師確認を送る</button>
                      )}
                    </div>
                  </div>
                ))}
                {cross.confirmed.map((n) => <div key={n} className="notice ok">医師の回答と承認で、傷病名「{n}」が確定しました</div>)}
              </div>
            )}
            <details style={{ margin: "12px 0" }}>
              <summary>代行入力（医師確認つき）</summary>
              <p className="muted">下書きを整えて医師確認に回します。足りない項目は推定せず、確認として出します。</p>
              <textarea rows={3} style={{ width: "100%" }} value={proxy} onChange={(e) => setProxy(e.target.value)} placeholder="例：AF 継続、DOAC 継続" />
              <button disabled={busy || !proxy.trim()} onClick={sendProxy}>整えて医師確認に回す</button>
              {proxyMsg && <div className="notice ok" style={{ whiteSpace: "pre-wrap" }}>{proxyMsg}</div>}
            </details>
            {q.phase === "ヒント" && (
              <button className="primary" onClick={doConfirm} disabled={quiz.some((x) => x.state === "未回答")}>
                確定する
              </button>
            )}
            {q.confirmed && (
              <div>
                <h3>ユスティの判定</h3>
                {q.correct ? <div className="notice ok">確認してほしい点はありません</div> : null}
                {findings.map((f, i) => (
                  <div key={i} className={`notice ${f.kind === "情報不足" ? "ok" : "warn"}`}>
                    {findingText(f)}<br />
                    <span className="muted">{f.ruleId}・{f.kind}・根拠：{f.reference}</span>
                  </div>
                ))}
                {q.phase === "判定" && <button className="primary" onClick={() => explanation()} disabled={busy}>解説を聞く</button>}
                {q.phase === "解説" && <button className="primary" onClick={next}>次のレセプトへ</button>}
              </div>
            )}
          </section>
          {/* 吹き出しの欄（画面の下）：左にキャラ、右に最新のひと言と入力欄。会話の履歴は右の窓で開く */}
          <div className="dock" role="region" aria-label="メンター">
            <div className="portrait" aria-label={`${mentorName}の表情：${lastFace}`}>
              <div className="portrait-figure">{me?.image ? <img src={faceImage(me.image, lastFace)} alt="" /> : mentorName}</div>
              <div><strong>{mentorName}</strong> <span className="muted">{lastFace}</span></div>
            </div>
            <div className="dialog">
              <div className="dialog-line">
                {busy ? <span className="muted">{mentorName}が目を通しています…</span> : (lastMentor ?? me?.examples?.opening ?? "今日もよろしく。気になるところがあったら声をかけてね。")}
              </div>
              {choices.length > 0 && (
                <div className="dialog-actions" role="group" aria-label="医師に聞くことを選ぶ">
                  {choices.map((c) => (
                    <button key={c.ruleId} className="primary" disabled={busy} onClick={() => chooseCross(c.ruleId, c.about)}>
                      照合：{c.about}
                    </button>
                  ))}
                  <button disabled={busy} onClick={chooseOther}>それ以外のこと</button>
                </div>
              )}
              <div className="dialog-actions">
                {q.phase === "ヒント" && (
                  <>
                    <input value={ask} onChange={(e) => setAsk(e.target.value)} placeholder={`${mentorName}に聞く（空なら「ヒントをください」）`} onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing && !busy) { hint(ask.trim() || "ヒントをください。"); setAsk(""); } }} />
                    <button disabled={busy} onClick={() => { hint(ask.trim() || "ヒントをください。"); setAsk(""); }}>聞く</button>
                  </>
                )}
                <button onClick={() => setShowLog(!showLog)} aria-expanded={showLog}>会話の履歴（{chat.length}）</button>
                <button disabled={busy} onClick={() => setPicking(true)}>メンターを変える</button>
              </div>
            </div>
          </div>
          {showLog && (
            <aside className="log" aria-label="このレセプトの会話の履歴">
              <div className="log-head">
                <strong>このレセプトの会話</strong>
                <button onClick={() => setShowLog(false)} aria-label="履歴を閉じる">閉じる</button>
              </div>
              {chat.length === 0 && <div className="muted">まだ会話はありません。</div>}
              {chat.map((b, i) => (
                <div key={i} className={`log-item from-${b.from}`}>
                  <div className="muted">{b.from === "me" ? "あなた" : `${mentorName}・${b.face ?? "通常"}`}</div>
                  <div className="bubble">{b.text}</div>
                </div>
              ))}
            </aside>
          )}
        </div>
      )}
    </main>
  );
}
