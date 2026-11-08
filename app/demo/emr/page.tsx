// 架空の電子カルテ（デモ用。2026-11-08 ユーザー判断）：この画面を撮った画像を、カルテの画面で取り込む流れを見せるためだけに置く。
// メニューには出さない。特定の製品に似せない。中身は合成データ（K4）で、症例表（EM 5-1）とカルテの合成データにあることだけを載せる
import PATIENTS from "../../../fixtures/uke/patients.json";
import CASE from "../../../fixtures/cases/K4.json";
import CHART from "../../../fixtures/charts/K4.json";
import SAMPLES from "../../../fixtures/charts/samples.json";

const ID = "K4-2025-03";
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`;

export default function DemoEmr() {
  const pt = (PATIENTS.patients as unknown as Record<string, { name: string; sex: number; birth: string; diseases: { name: string; start: string; main: boolean }[] }>)[ID];
  const age = CASE.facts.age.known ? CASE.facts.age.value : null;
  const ins = CASE.facts.insurance.known ? CASE.facts.insurance.value : "";
  const ratio = CASE.facts.burdenRatio.known ? `${Math.round(Number(CASE.facts.burdenRatio.value) * 10)}割` : "";
  const today = "2025-03-25";
  const past = CHART.entries.filter((e) => e.date < today);
  const record = SAMPLES[ID].complete.split("。").filter(Boolean).map((x) => `${x}。`);
  return (
    <main className="emr">
      <div className="emr-banner">架空の電子カルテ（デモ用）・合成データ</div>
      <header className="emr-head">
        <div>
          <div className="emr-name">{pt.name.replace("　", " ")}</div>
          <div className="emr-meta">{pt.sex === 1 ? "男性" : "女性"}　{age} 歳　{ins}（{ratio}）　{CASE.prefecture}</div>
        </div>
        <div className="emr-visit">
          <span>{md(today)} 訪問診療</span>
          <strong>診察中</strong>
        </div>
      </header>
      <div className="emr-grid">
        <aside className="emr-box">
          <h2>受診歴</h2>
          {past.map((e) => (
            <div key={e.date} className="emr-past">
              <div className="emr-past-date">{md(e.date)} 訪問診療</div>
              <div>S：{e.s}</div>
              <div>A：{e.a}</div>
              <div>P：{e.p}</div>
            </div>
          ))}
        </aside>
        <section style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="emr-box">
            <h2>病名</h2>
            <table className="emr-table">
              <thead><tr><th>病名</th><th>開始日</th><th>主病</th></tr></thead>
              <tbody>
                {pt.diseases.map((d) => (
                  <tr key={d.name}><td>{d.main ? "（主）" : ""}{d.name}</td><td>{`${d.start.slice(0, 4)}/${d.start.slice(4, 6)}/${d.start.slice(6)}`}</td><td>{d.main ? "○" : ""}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="emr-box" style={{ flex: 1 }}>
            <h2>診療記録　<span className="emr-sub">{md(today)}</span></h2>
            <div className="emr-record">{record.map((l) => <div key={l}>{l}</div>)}</div>
          </div>
        </section>
        <aside className="emr-box">
          <h2>処方（院外）</h2>
          {CHART.prescriptions.map((r) => (
            <div key={r.date + r.category} className="emr-rx">
              <div>{r.category}</div>
              <div className="emr-sub">継続</div>
            </div>
          ))}
        </aside>
      </div>
    </main>
  );
}
