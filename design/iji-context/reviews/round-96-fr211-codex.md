critic: codex/gpt-6.1-sol xhigh（round-96 FR-211 の反証。対象 git diff 70116aa..feat/fr211）

1. **X-490｜重大｜実装・安全性：LLM の言い換えで医師確認を迂回できる**  
   [abbrev.ts:86](/Users/toshixa/Documents/iji-context/.claude/worktrees/fr211/src/chart/abbrev.ts:86)  
   印は `written`／`value` だけで決まります。原文 `ECG12` を `written: "心電図"`、原文 `AF` を `value: "心房細動"` と展開し、quote に原文を残すと検証を通過します。印も問いも付かず、lookup が残り、名称完全一致なら自動選択にも進めます。原文との照合が必要です。

2. **X-491｜重大｜実装・正しさ：「違う」を選ぶと略語確認と B の件数が消える**  
   [acts.ts:45](/Users/toshixa/Documents/iji-context/.claude/worktrees/fr211/src/chart/acts.ts:45)  
   `!a.fold` が、「たたまない」を意味する `fold.same: false` まで除外します。未対応略語の行為で構造化データとは「違う」と選ぶだけで、親・子とも医師への問いと B の確認件数から消えます。`same: false` は確認対象に残す必要があります。

3. **X-492｜中｜実装・正しさ：病名に対する医師の記入回答を表示できない**  
   [doctor-abbrevs.ts:113](/Users/toshixa/Documents/iji-context/.claude/worktrees/fr211/src/server/app/doctor-abbrevs.ts:113)  
   病名への記入回答は保存後に質問一覧から消えますが、その答えを画面へ返す経路がありません。`writtenIn` の利用も行為・子だけです。計画 §5 の「医師の答え：…」が未実装で、事務が確認結果を参照できません。

4. **X-493｜中｜実装・正しさ：501 記載以上のまとめ質問に回答できない**  
   [doctor.ts:23](/Users/toshixa/Documents/iji-context/.claude/worktrees/fr211/src/server/schemas/doctor.ts:23)  
   GET は同月・同語を無制限にまとめ、画面は全引用の refs を送りますが、POST は最大500件です。501件で Zod が拒否することを再現しました。「記載によって違う」も含め、画面からの全回答が400になります。

純関数とメモリ内DBで再現を確認しました。マイグレーション23→24と、共有回答の参照削除・孤立回答の削除は通過しました。


