// 院内ルールの育ち方を git log で見せるイメージ（FR-49 の仮表示）。中身は例で、実際の知識の履歴ではない。
// 流れは spec FR-45・FR-46（院内層は「使われない期間」だけが再検証のきっかけ）に合わせた。ルールの中身は創作しないため伏せ字にしている
// 日付は基準月（config/demo.json）からの相対で作る（年月を直書きしない）
import { dateFrom } from "../../src/demo/period";

const APPROVED = dateFrom(0, 9);
const STOPPED = dateFrom(7, 18);
const LOG = [
  { sha: "7c41e2a", date: dateFrom(7, 24), msg: `保管：廃棄提案を医事責任者が承認（廃止理由：使われなくなった）。適用期間 ${APPROVED}〜${STOPPED} を残す` },
  { sha: "e09b5d1", date: STOPPED, msg: "停止：再検証の期間にも使われず、廃棄提案を出した（可否は人が決める）" },
  { sha: "3fa8c07", date: dateFrom(7, 3), msg: "要再検証：最後に使われてから 180 日" },
  { sha: "b62d9e4", date: dateFrom(1, 4), msg: "適用：請求で使われた（ヒット 2）" },
  { sha: "51ce0af", date: dateFrom(0, 14), msg: "適用：請求で使われた（ヒット 1）" },
  { sha: "a90f3b8", date: APPROVED, msg: "承認済み：医事責任者が検証した" },
  { sha: "0d27c6e", date: dateFrom(0, 7), msg: "候補（未検証）：提案から作成。すぐ全員に見える" },
];

export function LocalRuleHistoryMock() {
  return (
    <section className="panel">
      <h3 style={{ marginTop: 0 }}>院内ルールの履歴（git log のイメージ・仮）</h3>
      <p className="muted">知識はファイルとして git で残るので、ひとつのルールが生まれてから使われなくなり、しまわれるまでを、あとから追えます。下は表示のイメージで、ルールの中身は伏せた例です。</p>
      <pre className="terminal" aria-label="院内ルールの履歴の例">
        {"$ git log --oneline -- knowledge/local/（例）院内ルール\n\n"}
        {LOG.map((l) => `${l.sha}  ${l.date}  ${l.msg}`).join("\n")}
      </pre>
    </section>
  );
}
