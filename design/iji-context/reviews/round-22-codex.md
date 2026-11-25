critic: codex/gpt-6.1-sol xhigh（design-critic の原文は round-22.md）

�と、算定行だけで分かる背反が同居しています。**具体例：**カルテのない合成UKEに看取り加算と死亡診断加算が両方あっても、背反が消えて`chartRecord`だけになります。記録依存部分だけを保留する設計が必要です。

2. **high／設計：R07の追加条件が「処方ごと」という判定単位を表せない。**  
   [§11-5](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:1348)は処方ごとの判定を維持しながら、`rxLongPsychotropic: Fact<boolean>`を単一の事実として追加しています。**具体例：**同月に、長期向精神薬処方に該当する5種類の処方と、該当しない5種類の処方があり、両方に区分2を請求した場合。真なら後者の誤りを見逃し、偽なら前者を誤指摘します。処方単位の回答と算定行との対応が必要です。

3. **high／設計：「その日の理由コメント」を確認する情報が入力にない。**  
   [§11-5](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:1330)は、その日の830100086コメントの有無を判定します。しかし現在の[コメント型](/Users/toshixa/Documents/iji-context/.claude/worktrees/integration/src/engine/types.ts:101)は`{ kubun, code }`だけで、[UKE読取](/Users/toshixa/Documents/iji-context/.claude/worktrees/integration/src/uke/uke.ts:296)もコメント内容を保持しません。**具体例：**同日併算定が月に2日あり、理由を記載したのが片方だけでも、どちらの日のコメントか区別できません。実在コードへの置換だけでは成立せず、日付・内容の保持と対応づけが必要です。

4. **medium／設計：確認APIが、人の読んだ文書版を照合できない。**  
   [§11-3のAPI](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:1285)は`{ docId, applies }`だけを受け、サーバーが現在の鍵を付けます。**具体例：**利用者が文書の旧条件を読んだ後、レジストリの条件が訂正され、そのまま古い画面から`false`を送ると、未確認の新版に「対象外」の確認が付きます。[文書変更で確認を失効させる規則](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:1267)をすり抜けます。表示時の文書鍵を送らせ、現在の鍵との一致を検証する必要があります。

5. **medium／設計：K6の操作例・完了条件が、解決済みの遷移と食い違う。**  
   [§11-3の手順5](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:1293)と[完了条件#7](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:1381)は、`recheck`で「直す必要がある」と答えた後を「要再検証」としています。しかし台帳の[C-38／X-31](/Users/toshixa/Documents/iji-context/design/iji-context/ledger.md:47)では「停止」に決着し、[現実装](/Users/toshixa/Documents/iji-context/.claude/worktrees/integration/src/lifecycle/review.ts:716)も`RECHECK_FAIL`です。**具体例：**記載どおりK6を操作すると、最後は停止・廃棄提案になり、要再検証のまま表示し続ける筋書きにはなりません。既決の遷移を維持し、v23側の操作例と完了条件を直すべきです。
