critic: codex/gpt-6.1-sol xhigh（批評 round-4、v6 の変更箇所。2026-11-04）

codex
解決済みの方針自体は再評価せず、v6 の追加処理に絞った5件です。

1. **高／設計：知識が別の状態へ進んだ後、結果を訂正できない**  
   対象：[§4-4 手順3](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:281)、§4-2、§7 #3・#5。  
   **破綻シナリオ：**承認済みの知識に通過結果で `HIT` を付け、その後 idle により要再検証→停止へ進む。遅れて査定結果が届くと、状態を戻さず `RESULT_REVISED` → `COUNTER_EXAMPLE` を出すことになるが、停止からの `COUNTER_EXAMPLE` は遷移表で例外になる。元の適用記録のガードを使えば、訂正そのものが拒否される。「現在の状態を保ちながら数だけ訂正する」経路が必要。

2. **高／設計：過去全件との重複排除が、正当な再訂正を捨てる**  
   対象：[§4-4 手順1](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:277)、§7 #5。  
   **破綻シナリオ：**異なる `resultId` で、同じ提出・同じ kind に「通過→査定→通過」という訂正が届く。最後の通過は最初の通過と `contentHash` が一致するため捨てられ、査定の反映が残る。「後の結果を正とする」方針と矛盾する。過去に存在した内容と、現在反映中の内容を区別する必要がある。

3. **中／設計：取り消した HIT の日時が残り、idle を不当に延長する**  
   対象：[§4-2 RESULT_REVISED](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:225)、§7 #3・#5。  
   **破綻シナリオ：**他の `HIT`／`USED` がない知識に、179日目の通過で `last_hit_at` を更新し、180日目の訂正でその HIT を取り消す。戻す対象がカウンタだけなので、撤回済みの日時が残り、知識はさらに約180日間 idle を免れる。有効な他の利用実績を保ちつつ、日時も訂正する規定が必要。

4. **中／設計：問い合わせ回答の再送で、反例と候補が二重生成される**  
   対象：[§4-4 回答の反映](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:307)、§7 #11。  
   **破綻シナリオ：**承認済み知識への回答2を反映した後、通信再試行で同じ回答を再受信する。`COUNTER_EXAMPLE` は承認済みの自己遷移なので、状態・`status_since`・`rev` のガードは再び通り、misses と候補が重複する。`answeredAt` はあるが、回答済み判定と反映を一度に限定する規定・再送テストがない。

5. **低／設計：適用条件が変わっただけでも「項目を外した」と判定する**  
   対象：[§4-4 ignored の判定](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:270)、§7 #5・#11。  
   **破綻シナリオ：**`careLevelMin: 3` の allow 知識が評価途中では当たり、要介護度を3から2へ訂正すると外れる。算定行を一切外していなくても `ignored` となり、`removedKubun[]` が空の問い合わせが発生する。既存条件による正しい適用除外を、取り忘れや条件不足として扱ってしまう。実際の項目除外と、他の条件の変化を分ける必要がある。


