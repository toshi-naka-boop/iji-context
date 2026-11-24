"use client";
// 聞き取りの画面（design.md §18-5。v37 21d）：取り込んだ UKE の月末の点検の前に、介護保険・ほかの医療機関との調整で使う申告を確かめる。
// 1 患者 1 枚、その患者の行で要る問いだけ（要介護・要支援の認定／住まいの種別／今月の短期入所／ほかの機関）。どの問いにも「分からない」を置き、出どころと確かめた日は必須。
// 答えの月は開いた UKE の診療年月（C-513）。入れるのは医療事務・ベテラン、事務長は見るだけ。答えたあとは一覧を取り直す（点検は開くたびに計算する）
import { useEffect, useState } from "react";
import { CARE_HOME_KINDS, CARE_SOURCES, KANRI_SIDES, OTHER_ACTIVITIES, OTHER_KINDS, RESIDENCE_TYPES, SHORT_STAY_KINDS, TRI } from "../../../src/engine/care";
import { TopBar } from "../../nav";
import { SignIn, useClerk } from "../../clerk";
import { PageGuide } from "../../page-guide";
import { getJson, postJson } from "../../get-json";
import { CareCertForm } from "../../care-cert-input";

type Ask = "careCert" | "residenceType" | "shortStay" | "others";
type Target = { claimId: string; yearMonth: string; patient: string; asks: Ask[]; notDone: boolean };
type Home = { homeId: string; name: string; kind: string; placedPhysician: string; mitoriFacility: string; recheckOn: string };
type Check = { month: string | null; months: { month: string; targets: number; notDone: number }[]; targets: Target[]; notDoneCount: number; homes: Home[] };
type CareView = { care: Record<string, { value: Record<string, unknown>; checkedOn: string; source: string } | undefined>; legacyResidence: string | null; others: { name: string; kind: string; kanriSide: string }[]; none: { forMonth: string } | null };

const ASK_LABEL: Record<Ask, string> = { careCert: "要介護・要支援の認定", residenceType: "住まいの種別", shortStay: "今月の短期入所・宿泊", others: "ほかの医療機関・訪問看護ステーション" };
/** 確かめた日の初期値：そのクリニックの今日（デモの時計。GET /api/clock。design.md §18-12 の 7）。読み込むまで空 */
let clinicToday = "";
const today = () => clinicToday;

/** 確かめた日と出どころ（どの問いにも要る） */
function Basis(props: { value: { checkedOn: string; source: string }; onChange: (v: { checkedOn: string; source: string }) => void }) {
  return (
    <span style={{ display: "inline-flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
      <label>確かめた日 <input type="date" value={props.value.checkedOn} onChange={(e) => props.onChange({ ...props.value, checkedOn: e.target.value })} /></label>
      <select aria-label="出どころ" value={props.value.source} onChange={(e) => props.onChange({ ...props.value, source: e.target.value })}>
        <option value="">出どころを選ぶ</option>
        {CARE_SOURCES.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
    </span>
  );
}
const basisOk = (b: { checkedOn: string; source: string }) => b.checkedOn !== "" && b.source !== "";

/** 入所先の施設を足す（名前・種別・配置医師か・看取り介護加算の施設基準・確かめた日・確かめ直す日） */
function HomeForm(props: { onSaved: (homes: Home[]) => void }) {
  const [v, setV] = useState({ name: "", kind: "", placedPhysician: "分からない", mitoriFacility: "分からない", recheckOn: "" });
  const [b, setB] = useState({ checkedOn: today(), source: "" });
  const [err, setErr] = useState("");
  async function save() {
    setErr("");
    try {
      const d = await postJson<{ homes: Home[] }>("/api/care-homes", { ...v, ...b });
      props.onSaved(d.homes);
      setV({ name: "", kind: "", placedPhysician: "分からない", mitoriFacility: "分からない", recheckOn: "" });
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  return (
    <div className="notice" style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
      <strong>入所先の施設を足す</strong>
      <input aria-label="施設の名前" placeholder="施設の名前" maxLength={60} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
      <select aria-label="施設の種別" value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value })}>
        <option value="">種別を選ぶ</option>
        {CARE_HOME_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
      </select>
      <label>当院の医師がその施設の配置医師か <select value={v.placedPhysician} onChange={(e) => setV({ ...v, placedPhysician: e.target.value })}>{TRI.map((t) => <option key={t}>{t}</option>)}</select></label>
      <label>看取り介護加算の施設基準に合うか <select value={v.mitoriFacility} onChange={(e) => setV({ ...v, mitoriFacility: e.target.value })}>{TRI.map((t) => <option key={t}>{t}</option>)}</select></label>
      <label>確かめ直す日 <input type="date" value={v.recheckOn} onChange={(e) => setV({ ...v, recheckOn: e.target.value })} /></label>
      <Basis value={b} onChange={setB} />
      <button disabled={v.name.trim() === "" || v.kind === "" || v.recheckOn === "" || !basisOk(b)} onClick={() => void save()}>施設を残す</button>
      {err && <span className="notice warn">{err}</span>}
    </div>
  );
}

/** 住まいの種別（施設なら入所先の施設を選ぶか足す）と、月の途中で変わったか */
function ResidenceForm(props: { claimId: string; homes: Home[]; onHomes: (h: Home[]) => void; onSaved: () => void }) {
  const [type, setType] = useState("");
  const [homeId, setHomeId] = useState("");
  const [mid, setMid] = useState(false);
  const [b, setB] = useState({ checkedOn: today(), source: "" });
  const [err, setErr] = useState("");
  const facility = type !== "" && type !== "自宅" && type !== "分からない";
  async function save() {
    setErr("");
    try {
      await postJson(`/api/patients/${encodeURIComponent(props.claimId)}/care`, { item: "residenceType", value: { type, ...(facility && homeId ? { careHomeId: homeId } : {}), ...(mid ? { changedMidMonth: true } : {}) }, ...b });
      props.onSaved();
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        <select aria-label="住まいの種別" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">選ぶ</option>
          {RESIDENCE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        {facility && (
          <select aria-label="入所先の施設" value={homeId} onChange={(e) => setHomeId(e.target.value)}>
            <option value="">入所先の施設（任意）</option>
            {props.homes.map((h) => <option key={h.homeId} value={h.homeId}>{h.name}（{h.kind}）</option>)}
          </select>
        )}
        <label><input type="checkbox" checked={mid} onChange={(e) => setMid(e.target.checked)} /> この月の途中で変わった</label>
        <Basis value={b} onChange={setB} />
        <button disabled={type === "" || !basisOk(b)} onClick={() => void save()}>残す</button>
        {err && <span className="notice warn">{err}</span>}
      </span>
      {facility && <HomeForm onSaved={props.onHomes} />}
    </div>
  );
}

type Use = { kind: string; start: string; end: string; careHomeId: string; fromDischarge: string };
const emptyUse = (): Use => ({ kind: "", start: "", end: "", careHomeId: "", fromDischarge: "分からない" });

/** 今月の短期入所・宿泊（使った・使っていないと確かめた・分からない。使ったときは利用を 1 つずつ） */
function ShortStayForm(props: { claimId: string; homes: Home[]; onSaved: () => void }) {
  const [status, setStatus] = useState("");
  const [uses, setUses] = useState<Use[]>([emptyUse()]);
  const [b, setB] = useState({ checkedOn: today(), source: "" });
  const [err, setErr] = useState("");
  const set = (i: number, u: Partial<Use>) => setUses(uses.map((x, j) => (j === i ? { ...x, ...u } : x)));
  async function save() {
    setErr("");
    const value = status === "使った" ? { status, uses: uses.map((u) => ({ kind: u.kind, start: u.start || null, end: u.end || null, careHomeId: u.careHomeId || null, fromDischarge: u.fromDischarge })) } : { status };
    try {
      await postJson(`/api/patients/${encodeURIComponent(props.claimId)}/care`, { item: "shortStay", value, ...b });
      props.onSaved();
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        <select aria-label="今月の短期入所" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">選ぶ</option>
          <option value="使った">使った</option>
          <option value="使っていない">使っていないと確かめた</option>
          <option value="分からない">分からない</option>
        </select>
        <Basis value={b} onChange={setB} />
        <button disabled={status === "" || !basisOk(b) || (status === "使った" && uses.some((u) => u.kind === ""))} onClick={() => void save()}>残す</button>
        {err && <span className="notice warn">{err}</span>}
      </span>
      {status === "使った" && uses.map((u, i) => (
        <span key={i} style={{ display: "inline-flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          <select aria-label="短期入所の種類" value={u.kind} onChange={(e) => set(i, { kind: e.target.value })}>
            <option value="">種類を選ぶ</option>
            {SHORT_STAY_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <label>開始日 <input type="date" value={u.start} onChange={(e) => set(i, { start: e.target.value })} /></label>
          <label>終了日 <input type="date" value={u.end} onChange={(e) => set(i, { end: e.target.value })} /></label>
          <select aria-label="利用先の施設" value={u.careHomeId} onChange={(e) => set(i, { careHomeId: e.target.value })}>
            <option value="">利用先の施設（任意）</option>
            {props.homes.map((h) => <option key={h.homeId} value={h.homeId}>{h.name}（{h.kind}）</option>)}
          </select>
          <label>退院日から利用を始めたか <select value={u.fromDischarge} onChange={(e) => set(i, { fromDischarge: e.target.value })}>{TRI.map((t) => <option key={t}>{t}</option>)}</select></label>
        </span>
      ))}
      {status === "使った" && <span><button onClick={() => setUses([...uses, emptyUse()])}>同じ月の利用をもう 1 つ足す</button> <span className="muted">開始日・終了日は任意です（月をまたぐ利用は、開始日を前の月の日で入れます）。</span></span>}
    </div>
  );
}

/** ほかの機関：ある → 行を足す／ないと確かめた／分からない */
function OthersForm(props: { claimId: string; onSaved: () => void }) {
  const [mode, setMode] = useState("");
  const [v, setV] = useState({ name: "", kind: "", specialRelation: "分からない", kanriSide: "分からない", referredOn: "" });
  const [acts, setActs] = useState<Record<string, string>>(Object.fromEntries(OTHER_ACTIVITIES.map((a) => [a, "分からない"])));
  const [b, setB] = useState({ checkedOn: today(), source: "" });
  const [err, setErr] = useState("");
  async function save() {
    setErr("");
    try {
      if (mode === "none") await postJson(`/api/patients/${encodeURIComponent(props.claimId)}/others-none`, b);
      else await postJson(`/api/patients/${encodeURIComponent(props.claimId)}/others`, { name: v.name, kind: v.kind, specialRelation: v.specialRelation, kanriSide: v.kanriSide, activities: acts, referredOn: v.referredOn || null, ...b });
      props.onSaved();
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        <select aria-label="ほかの機関" value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="">選ぶ</option>
          <option value="add">ある（行を足す）</option>
          <option value="none">ないと確かめた</option>
          <option value="unknown">分からない</option>
        </select>
        {mode !== "unknown" && mode !== "" && <Basis value={b} onChange={setB} />}
        {mode !== "unknown" && mode !== "" && <button disabled={!basisOk(b) || (mode === "add" && (v.name.trim() === "" || v.kind === ""))} onClick={() => void save()}>残す</button>}
        {mode === "unknown" && <span className="muted">残すものはありません。この月のほかの機関との調整は「見ていません」のままです。</span>}
        {err && <span className="notice warn">{err}</span>}
      </span>
      {mode === "add" && (
        <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          <input aria-label="機関の名前" placeholder="機関の名前" maxLength={60} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} />
          <select aria-label="機関の種別" value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value })}>
            <option value="">種別を選ぶ</option>
            {OTHER_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <label>特別の関係 <select value={v.specialRelation} onChange={(e) => setV({ ...v, specialRelation: e.target.value })}>{TRI.map((t) => <option key={t}>{t}</option>)}</select></label>
          <label>在医総管を取る側 <select value={v.kanriSide} onChange={(e) => setV({ ...v, kanriSide: e.target.value })}>{KANRI_SIDES.map((t) => <option key={t}>{t}</option>)}</select></label>
          {OTHER_ACTIVITIES.map((a) => (
            <label key={a}>{a} <select value={acts[a]} onChange={(e) => setActs({ ...acts, [a]: e.target.value })}>{TRI.map((t) => <option key={t} value={t}>{t === "はい" ? "している" : t === "いいえ" ? "していない" : t}</option>)}</select></label>
          ))}
          <label>求めた日 <input type="date" value={v.referredOn} onChange={(e) => setV({ ...v, referredOn: e.target.value })} /></label>
        </span>
      )}
    </div>
  );
}

function Card(props: { t: Target; homes: Home[]; onHomes: (h: Home[]) => void; editable: boolean; onSaved: () => void; picked: boolean; onPick: (v: boolean) => void }) {
  const { t } = props;
  const [view, setView] = useState<CareView | null>(null);
  useEffect(() => {
    getJson<CareView>(`/api/patients/${encodeURIComponent(t.claimId)}/care`).then(setView).catch(() => setView(null));
  }, [t.claimId]);
  const now = (k: string) => {
    const r = view?.care[k];
    return r ? `${JSON.stringify(r.value).replace(/[{}"]/g, "")}（${r.checkedOn} ${r.source}）` : "申告なし";
  };
  return (
    <article className="card">
      <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{t.patient}（{t.claimId}）</h2>
          <a href={`/uke/${encodeURIComponent(t.claimId)}`}>このレセプトの点検を開く →</a>
        </div>
        {t.notDone && <div className="notice warn">いまは点検の範囲に「見ていません」があります。</div>}
        <div className="muted">今の申告：住まいの種別 {now("residenceType")}／今月の短期入所 {now("shortStay")}{view?.legacyResidence ? `／古い入力（居住の場所：${view.legacyResidence}）` : ""}／ほかの機関 {view ? (view.others.length > 0 ? `${view.others.length} 件` : view.none ? "ないと確かめた" : "申告なし") : ""}</div>
        {t.asks.map((a) => (
          <div key={a} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <strong>{ASK_LABEL[a]}</strong>
            {!props.editable ? <span className="muted">医療事務・ベテランが答えます。</span>
              : a === "careCert" ? <CareCertForm claimId={t.claimId} onSaved={props.onSaved} />
              : a === "residenceType" ? <ResidenceForm claimId={t.claimId} homes={props.homes} onHomes={props.onHomes} onSaved={props.onSaved} />
              : a === "shortStay" ? <><ShortStayForm claimId={t.claimId} homes={props.homes} onSaved={props.onSaved} /><label className="muted"><input type="checkbox" checked={props.picked} onChange={(e) => props.onPick(e.target.checked)} /> 下の「まとめて、使っていないと確かめた」に入れる</label></>
              : <OthersForm claimId={t.claimId} onSaved={props.onSaved} />}
          </div>
        ))}
      </div>
    </article>
  );
}

export default function CareCheck() {
  const { clerk: user, ready } = useClerk();
  const [data, setData] = useState<Check | null>(null);
  const [month, setMonth] = useState<string | null>(null);
  const [homes, setHomes] = useState<Home[]>([]);
  const [editable, setEditable] = useState(false);
  const [err, setErr] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState({ checkedOn: today(), source: "" });
  const [tick, setTick] = useState(0);
  const [clockReady, setClockReady] = useState(false);
  useEffect(() => {
    if (!user) return;
    getJson<{ now: string }>("/api/clock")
      .then((c) => {
        clinicToday = c.now.slice(0, 10);
        setBulk((b) => ({ ...b, checkedOn: clinicToday }));
      })
      .catch(() => {})
      .finally(() => setClockReady(true));
    getJson<{ role: string }>("/api/auth/me").then((me) => setEditable(me.role === "clerk" || me.role === "veteran")).catch(() => {});
  }, [user]);
  useEffect(() => {
    if (!user) return;
    const q = new URLSearchParams(window.location.search);
    const m = month ?? q.get("month");
    const url = m ? `/api/uke/care-check?month=${encodeURIComponent(m)}` : "/api/uke/care-check";
    getJson<Check>(url)
      .then((d) => {
        if (!m && d.months.length > 0) return setMonth(d.months[0].month);
        setData(d);
        setHomes(d.homes);
        if (m && month === null) setMonth(m);
      })
      .catch((e: Error) => setErr(e.message));
  }, [user, month, tick]);
  const reload = () => setTick((t) => t + 1);
  async function bulkNone() {
    setErr("");
    try {
      for (const id of picked) await postJson(`/api/patients/${encodeURIComponent(id)}/care`, { item: "shortStay", value: { status: "使っていない" }, ...bulk });
      setPicked(new Set());
      reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  if (!ready) return <main className="shell"><TopBar /></main>;
  if (!user) return <main className="shell"><TopBar /><SignIn /></main>;
  return (
    <main className="shell">
      <TopBar />
      <PageGuide who="yusti" title="点検の前に確かめること" tag="RULE ENGINE">
        介護保険・ほかの医療機関との調整の点検に使う申告を、患者ごとに確かめて残します。答えは開いた UKE の診療年月の分として残り、点検は決まった規則で計算し直します。
      </PageGuide>
      {err && <div className="notice warn">{err}</div>}
      <p><a href="/uke">UKE 取り込みへ戻る</a></p>
      {data && clockReady && (
        <>
          <div className="chips" style={{ margin: "0 0 12px" }}>
            {data.months.map((m) => (
              <button key={m.month} className={m.month === month ? "primary" : ""} onClick={() => setMonth(m.month)}>{m.month}：確かめる {m.targets} 人・見ていない {m.notDone} 人</button>
            ))}
          </div>
          {data.targets.length === 0 && <p className="muted">この月に確かめることはありません。</p>}
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {data.targets.map((t) => (
              <Card key={`${t.claimId}-${tick}`} t={t} homes={homes} onHomes={setHomes} editable={editable} onSaved={reload} picked={picked.has(t.claimId)} onPick={(v) => { const n = new Set(picked); if (v) n.add(t.claimId); else n.delete(t.claimId); setPicked(n); }} />
            ))}
          </div>
          {editable && data.targets.some((t) => t.asks.includes("shortStay")) && (
            <section className="card" style={{ marginTop: 16 }}>
              <div className="card-body" style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                <strong>まとめて、この月は短期入所・宿泊を使っていないと確かめた（{picked.size} 人）</strong>
                <Basis value={bulk} onChange={setBulk} />
                <button disabled={picked.size === 0 || !basisOk(bulk)} onClick={() => void bulkNone()}>まとめて残す</button>
                <span className="muted">1 人ずつ、同じ確かめた日と出どころで残ります。</span>
              </div>
            </section>
          )}
        </>
      )}
    </main>
  );
}
