critic: codex（xhigh）／再反証 2 巡目

実行モデル：`gpt-6.1-sol`（推論設定 `xhigh`。セッションメタデータで確認）。

1. **X-160｜中｜実装｜X-156の修正漏れ：別の親処置で使った薬の量が混ざる。**  
   [g11.ts:537](/Users/toshixa/Documents/iji-context/.claude/worktrees/practical-ab/src/generic/g11.ts:537) はカルテ量を親区分ごとに集計する一方、[426行](/Users/toshixa/Documents/iji-context/.claude/worktrees/practical-ab/src/generic/g11.ts:426) の比較先は全親を合算した請求量。同日に「熱傷処置＋薬10g」「創傷処置＋同じ薬10g」がカルテ・請求とも一致していても、それぞれを請求総量20と比較し、誤った `quantity_more` が2件出た。[設計2413行](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:2413) の親区分ごとの比較に反する。

2. **X-161｜中｜実装｜X-157の修正漏れ：`with` の未対応薬・器材を補正できない。**  
   新しい未対応一覧への登録は親の `match` がない場合だけで、[g11.ts:519](/Users/toshixa/Documents/iji-context/.claude/worktrees/practical-ab/src/generic/g11.ts:519) は未対応の子を除外する。親処置は対応済み・請求済み、使用薬だけ未対応という入力で、`unmatchedActs: []`・未対応件数0・指摘0を再現した。[notes.ts:229](/Users/toshixa/Documents/iji-context/.claude/worktrees/practical-ab/src/server/app/notes.ts:229) の新APIも親だけを対象とし、対応済みなら409になるため、子を選ぶ経路がない。[設計2361行](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:2361) の未対応行為の表示要求が残る。

3. **X-162｜中｜実装｜X-158の修正で混入：算定日不明の検査を「1日」と扱う。**  
   [g11.ts:594](/Users/toshixa/Documents/iji-context/.claude/worktrees/practical-ab/src/generic/g11.ts:594) は請求の算定日が不明なら `day: 1` とし、[610行](/Users/toshixa/Documents/iji-context/.claude/worktrees/practical-ab/src/generic/g11.ts:610) 以降で日付つき判断料候補にする。日付のないPTの請求と、20日の別処置だけのカルテから、「請求（1日）に『ＰＴ』があり…」、候補日 `2026-10-01` が出た。根拠にない日が表示と掛け直しに使われる。[設計2298行](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:2298) は日不明を月単位で扱うとしている。

3件ともインメモリDBで再現確認。ファイル変更なし。


