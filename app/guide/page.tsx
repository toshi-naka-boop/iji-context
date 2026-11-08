// 練習問題の手引き（spec FR-77）：医療事務や医師でない人が、練習問題に取り組むための読みもの。
// ルールの文は、知識に入れている制度層の要約（scripts/seed-knowledge.ts の RULE_TEXT）をそのまま使い、作り足さない
import { RULE_TEXT } from "../../scripts/seed-knowledge";
import { TopBar } from "../nav";
import { PageGuide } from "../page-guide";

/** 練習の流れ（文は前の手引きのまま、カードに分けた） */
const STEPS: [string, string][] = [
  ["明細を直す問題", "新人が入れたつもりの明細に、よくある間違いが 1 つ入っています。表の行を外したり、区分を選び直したりして直し、「確定する」を押します。"],
  ["医師に確認する問題", "カルテに書かれていない事実があり、そのままでは決められません。推測で埋めずに「医師確認を送る」を押し、「医師確認」の画面で医師の役として回答・承認してから、問題に戻って確定します。"],
  ["迷ったらメンターに", "下のメンターに「ヒントをください」と聞いてください。メンターは答えそのものは言わず、どこを見ればよいかを示します。"],
  ["判定と解説", "確定すると、ユスティが判定し、メンターが理由を解説します。"],
];

const TERMS: [string, string][] = [
  ["訪問診療", "計画を立てて、決まった日に患者さんの家へ行く診療。"],
  ["往診", "患者さんや家族に呼ばれて、その都度行く診療。訪問診療とは算定が分かれる。"],
  ["在医総管", "在宅時医学総合管理料。家で療養する患者さんを月ごとに管理する料金で、月の訪問回数と患者さんの状態で区分が変わる。"],
  ["別表第七・別表第八の二", "決まりで定められた、病気や状態の一覧。当たるかどうかで、訪問できる回数や在医総管の区分が変わる。当たるかは医師の判断で、カルテに書かれている必要がある。"],
  ["ユスティ", "レセメンのルールエンジン。決まった規則だけで、算定が正しいかを判定する。AI ではない。"],
  ["情報不足", "判定に要る事実（要介護度、別表に当たるか など）が分からず、ユスティが正否を決められない状態。本人の間違いではない。"],
  ["医師確認", "カルテに書かれていないことを医師に聞く仕組み。点数や金額には触れず、選択肢に必ず「その他」「判定不能」を入れる。"],
];

export default function Guide() {
  return (
    <main className="shell">
      <TopBar />
      <PageGuide who="makki" title="練習問題の手引き">
        医療事務や医師でなくても練習問題に取り組めるように、流れと用語をまとめました。合成データ・架空コードのデモです。迷ったら、算定画面で私たちに聞いてください。
      </PageGuide>

      <div className="board-head"><h2>練習の流れ</h2></div>
      <div className="cards" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 14 }}>
        {STEPS.map(([title, text], i) => (
          <article key={title} className="card">
            <div className="card-band" />
            <div className="card-body">
              <div className="qcard-no">{String(i + 1).padStart(2, "0")}</div>
              <strong>{title}</strong>
              <p style={{ margin: "6px 0 0", fontSize: 14 }}>{text}</p>
            </div>
          </article>
        ))}
      </div>

      <div className="board-head"><h2>用語</h2></div>
      <div className="cards" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 14 }}>
        {TERMS.map(([t, d]) => (
          <article key={t} className="card"><div className="card-body"><strong style={{ color: "var(--accent)" }}>{t}</strong><p style={{ margin: "6px 0 0", fontSize: 14 }}>{d}</p></div></article>
        ))}
      </div>

      <div className="panel" style={{ marginTop: 20 }}>
        <h3 style={{ marginTop: 0 }}>ローカルルール</h3>
        <p>
          ユスティが見るのは全国共通の決まりです。それとは別に、審査の結果（査定・返戻）や、ベテランの判断、院内の取り決めから育つ「ローカルルール」があります。算定画面では、明細に当てはまるローカルルールを、ユスティの判定とは別の欄に出します。
        </p>
        <ul>
          <li>はじめから、東京都の支払基金で BNP が査定された例（合成の増減点連絡書）から作った地域ルールが 1 つ入っています。「UKE 取り込み」で支払基金の UKE を取り込み、K6 を開くと反応します（同じ BNP でも国保連の K1 には当てはまりません）。</li>
          <li>ローカルルールは「未検証」から始まり、ベテランが確かめると「承認済み」になって、メンターが助言に使うようになります。使われなくなると「要再検証」「停止」と進み、最後はしまわれます（「知識」の画面で見られます）。</li>
          <li>院内のルールも、何年分も積み上がった状態で入っています（中身は伏せ、何の区分に関するものかだけを出しています）。算定画面で K1 などを開くと、どの院内ルールが引っかかったか、どれが何年も使われていないかが分かります。「レセメン会議」を開くと、長く使われていないものが見直しに回ります。院内のルールは、メンターの助言には使いません。</li>
        </ul>

      </div>
      <div className="panel" style={{ marginTop: 20 }}>
        <h3 className="with-avatar" style={{ marginTop: 0 }}><img className="yusti-avatar" src="/characters/yusti-face.png" alt="" />ユスティが見ているルール</h3>
        <p className="muted">2024 年度の診療報酬改定後の決まりを、ユスティが判定に使う形に要約したものです。練習問題の間違いは、このどれかに関わります。</p>
        <table>
          <tbody>
            {Object.entries(RULE_TEXT).map(([id, text]) => (
              <tr key={id}>
                <td style={{ whiteSpace: "nowrap", verticalAlign: "top" }}>{id}</td>
                <td>{text}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <p><a href="/work">算定画面へ戻る</a></p>
      </div>
    </main>
  );
}
