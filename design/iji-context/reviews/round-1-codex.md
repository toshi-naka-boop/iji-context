critic: codex/gpt-6.1-sol xhigh（round-1 のクロスベンダー批評。ID は X-1〜X-5 として台帳に登録）

1. **［Major／設計］状態変更後も、承認済みだった Skill をロードできる。**  
   [design.md:198](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:198)  
   同期スクリプトと状態遷移を連動させる契約がありません。同期後に知識が「要再検証」「停止」へ移っても、同期先には旧コピーが残り、F2 はそれを参照できます。FR-48 の「それ以外の状態はロードさせない」を保証するため、遷移時の同期と、読込時の最新状態確認を定義すべきです。

2. **［Major／設計］制度層が、ヒットなしを理由に停止する。**  
   [design.md:179](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:179)  
   要再検証からの `IDLE_EXPIRED` が「全層」対象です。制度層を改定で要再検証にした後、180日請求がなければ停止・廃棄提案へ進みます。これは FR-66 の「制度層の減衰は改定時だけ」に反します。要再検証中の期限判定にも層別の制約を適用し、この経路を検証対象に加える必要があります。

3. **［Major／設計］`match` では、正常通過と「同じ条件」を判定できない。**  
   [design.md:125](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:125)  
   制度層の照合に使う `ruleId` は `ClaimContext` に存在せず、違反時の `Finding` にだけ現れます。Finding を使っても、正常通過時の適用ルールを識別できません。また、区分番号等だけでは要介護度などが異なる請求を区別できず、誤った再承認・停止につながります。FR-45・47 を満たすには、正常時も含む適用判定と、知識ごとの条件表現を定義すべきです。

4. **［Major／設計］請求結果の再取込みで、再検証を誤って解除できる。**  
   [design.md:186](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:186)  
   結果を請求ID・知識版・処理済み結果IDへ結びつける契約がありません。以前の成功結果を要再検証への遷移後に再取り込みすると、記載どおりの処理では `RECHECK_PASS` となり、「次の請求」で確認していない知識まで承認済みに戻せます（FR-45）。提出時の適用記録、再検証対象となる請求の条件、重複排除を明記する必要があります。

5. **［Major／設計］投稿者による層選択が、固定された生成元を迂回する。**  
   [design.md:147](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:147)  
   F11 の提案では投稿者が層を選べますが、FR-66 は制度層を初期投入、ベテラン層をエスカレーション解決などに限定しています。自由選択を許すと、手動提案から制度層を作り、異なる減衰ルールを適用できます。既存知識への改善提案と新規生成を区別し、生成元と層の組合せを制約すべきです。


