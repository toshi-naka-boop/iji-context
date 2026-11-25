critic: codex/gpt-6.1-sol xhigh（round-101 辞書方式の反証。対象 git diff 7e41adb..feat/fr211）

2件。実メソッドとメモリDBで再現確認しました。

1. **X-510｜Major｜実装：意味を確かめていないカルテでも lookup が復帰する**  
   [notes.ts:206](/Users/toshixa/Documents/iji-context/.claude/worktrees/fr211/src/server/app/notes.ts:206) は、現在の辞書への登録と「選択行があること」だけで停止を解除します。  
   カルテAの未知語NPPVを「算定に関係なし」にする → 別カルテBへの医師回答でNPPVが辞書に追加されると、Aも意味未選択・医師確認なしのまま lookup と自動選択が復帰します。また、辞書語に「判定不能」を選んだ場合も復帰します。「すべての意味を選び終えたら」という条件を満たさず、LLMの推測が候補へ戻ります。

2. **X-511｜Major｜実装：医師の訂正が事務へ届かず、誤った意味の表示が残る**  
   [notes.ts:158](/Users/toshixa/Documents/iji-context/.claude/worktrees/fr211/src/server/app/notes.ts:158) は、事務の選択と確認中かどうかだけを返し、医師の回答を返しません。  
   AMIで事務が「心筋梗塞」を選び、医師が「心臓破裂」と回答しても、事務画面は「心筋梗塞」のまま確認中の札だけ消えます。訂正先が既存の辞書候補なので、[doctor-abbrevs.ts:231](/Users/toshixa/Documents/iji-context/.claude/worktrees/fr211/src/server/app/doctor-abbrevs.ts:231) の辞書追記もありません。必須の医師確認を通しても、訂正内容を事務が受け取れません。
