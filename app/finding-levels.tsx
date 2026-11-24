// 指摘の 4 段階の短い説明（README「指摘の読み方」と同じ中身）。点検の画面の上に、閉じた折りたたみで置く
export function FindingLevels() {
  return (
    <details className="notice" style={{ margin: "0 0 12px" }}>
      <summary>指摘の 4 つの段階（確定・条件つき・情報不足・見ていません）</summary>
      <table className="emr-table" style={{ marginTop: 8 }}>
        <thead>
          <tr><th>段階</th><th>意味</th><th>医療事務がすること</th></tr>
        </thead>
        <tbody>
          <tr><td>確定</td><td>レセプトの行と確かめた事実だけで、決まりに合わないと言い切れる</td><td>請求を直す。直せない理由があれば、メンターかベテランに相談する</td></tr>
          <tr><td>条件つき</td><td>前提（「申告のとおりなら」など）が付く</td><td>前提が当たっているかを確かめてから、直すかを決める。査定されると決まったわけではない</td></tr>
          <tr><td>情報不足</td><td>判定に要る事実が分からない</td><td>事実を確かめて入れる。カルテに書かれていなければ医師確認を送る。本人の間違いではない</td></tr>
          <tr><td>見ていません</td><td>その点検を動かしていない（マスターがない、聞き取りの答えがない など）</td><td>足りないものを入れれば見られる。「問題なし」とは読まない</td></tr>
        </tbody>
      </table>
      <p className="muted" style={{ margin: "8px 0 0" }}>「指摘はありません」は、動いた点検についてだけ言います。</p>
    </details>
  );
}
