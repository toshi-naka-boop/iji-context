critic: codex/gpt-6.1-sol xhigh（途中で「model at capacity」が 5 回出たが、最後まで答えた）

1. **X-350｜重大度：高｜種別：設計 — 管理料の判定が `partial` で誤る。**  
   [§18-3](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:3285) は全種類を `soundWhenPartial` に許可していますが、改訂後の「全訪問日が短期入所期間内」は、見えない行に依存します。例えば利用期間10/20〜24、訪問日10/6・22では管理料を未判定にするのに、10/6の単位が対象外に落ちると「全日が期間内」となり、算定不可の指摘が新しく出ます。この分岐は `partial` で止める必要があります。

2. **X-351｜重大度：高｜種別：設計 — 利用前30日の算定を前月だけで探している。**  
   [§18-3②](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:3292) の検索では、10/20利用開始に対する10/5の自宅訪問を拾えません。前月請求に該当算定がなければ、条件を満たす患者を「利用前算定なし」と誤判定します。[EMの条件](/Users/toshixa/Documents/iji-context/sources/em-v37-draft.md:67) に合わせ、開始日前30日の実日付で、当月を含む必要月を検索すべきです。

3. **X-352｜重大度：高｜種別：設計 — 短期入所先の配置医師を除外できない。**  
   [EM R8-250・256](/Users/toshixa/Documents/iji-context/sources/em-v37-draft.md:67) は配置医師を除外しますが、設計②の判定条件には配置医師の値がありません。さらに [shortStayの入力](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:3269) に利用先施設IDがなく、自宅から短期入所した患者では施設設定にも結び付けられません。前後の30日条件を満たす配置医師の請求を見逃します。利用先との関連と、配置医師の禁止・不明時の未判定処理が必要です。

4. **X-353｜重大度：高｜種別：設計 — 退院日から宿泊を始める例外の入力経路がない。**  
   [§18-3②](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:3293) は利用前算定を不要とする例外を採りますが、介護申告・`CareFacts`・聞き取り画面に退院日がありません。出来事も読まない宣言なので、既存の退院イベントを使う設計にもなっていません。[EM R8-248](/Users/toshixa/Documents/iji-context/sources/em-v37-draft.md:65) が求める例外判定と「退院日当日は除外」の両方を実行できません。取得元と、不明時の扱いを定める必要があります。

5. **X-354｜重大度：中｜種別：設計 — 「ほかの機関はない」が過去月へ遡って効く。**  
   [§18-2](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:3275) は確認日＋6か月という上限だけを定め、適用開始月を持ちません。11/24に確認した「11月は他院なし」が10月にも効き、未申告の10月についてR21と「見ていません」の表示を消し得ます。確認日とは別に、どの診療月について確認した事実かを保存すべきです。
