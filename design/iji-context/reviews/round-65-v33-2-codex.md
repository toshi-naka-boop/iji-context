critic: codex/gpt-6.1-sol xhigh（v33 の批評 2 巡目。ID は呼び出し側が X-240〜X-244 を振った：1→X-240、2→X-241、3→X-242、4→X-243、5→X-244）

1. **高／設計：材料加算の重複対策が、前月に算定した別コードには効きません。**  
   [§16-4-7](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:2936)の過去分照合は、まだ「同じコード」です。10月に11月分のボンベ2を算定済みでも、11月の機器が濃縮装置なら一致せず、11月分を再び勧めます。C-401の修正を、前月分にも「対象月＋`DEVICE_UNITS`」で適用する必要があります。対象月の重複は禁止されています。[留意事項 p315](https://www.mhlw.go.jp/content/12400000/001757385.pdf#page=315)

2. **高／設計：注2の過去処方チェックが、文章だけにある長期処方を見落とします。**  
   [§16-4-5(d)](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:2909)は過去のオーダーだけを読み、(e)の文章との照合は当月だけです。例えば10月25日の「院外処方60日分」が確認済み文章にだけあり、11月は院内オーダーだけなら、11月の注2を誤って候補にします。過去月にも文章との照合を掛け、期間を確定できなければ「見ていません」にする必要があります。[留意事項 C002(13)](https://www.mhlw.go.jp/content/12400000/001757385.pdf#page=258)

3. **中／設計：注2で要求する「本人が院内を選んだ」を、既存の欄では記録できません。**  
   新しい[(e)](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:2907)は本人の選択を必須にしましたが、[現実装](/Users/toshixa/Documents/iji-context/.claude/worktrees/integration/src/server/app/notes.ts:207)は、選択値が初期値と同じなら常に`rule`を保存します。初期値「院内」を本人が選び直しても解消しません。「確かめた」の印はL-199(b)の場合だけでなく、L-206にも必要です。

4. **中／設計：独自コードの対応表が、薬と処置で同じ番号を使う接続先を表現できません。**  
   [対応表の主キー](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:3024)は接続先・system・独自コードだけです。薬と処置がそれぞれ`local:001`を返すと、片方の対応が他方を上書きします。[適用規則](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:2852)にも入力欄ごとの表の検査がありません。接続先のコード体系を識別する名前空間と、対応先の許可表を定義する必要があります。

5. **中／設計：評価データの指紋が、AIに渡すカルテ本文を固定していません。**  
   [§16-9の固定対象](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:3036)は除外一覧・gate行・正解`acts`で、本文のS/O/A/P・処方欄を含みません。[評価処理](/Users/toshixa/Documents/iji-context/.claude/worktrees/integration/eval/run-eval.ts:108)が読む本文だけを取り出しやすく書き換えても、指紋は変わらず合格率を上げられます。参照先の入力本文も固定対象に含める必要があります。


