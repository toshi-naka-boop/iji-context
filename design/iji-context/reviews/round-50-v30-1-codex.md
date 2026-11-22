codex: gpt-6.1-sol（reasoning effort xhigh）。codex exec --sandbox read-only。v30 §15 の 1 巡目（round-50）

1. **［設計／high］過去月の訂正が、登録済みの将来変更を上書きする。**  
   [§15-2](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:2094) は、有効月より登録順（`MAX(id)`）を優先しています。  
   **破綻シナリオ：** 注16 を「9月から満たす」→「12月から満たさない」と登録後、10月分の訂正として「10月から満たす」を追記すると、12月にも最後の行が選ばれます。予定した変更が効かず、R01 が誤った管理料区分を案内します。  
   **修正方向：** 対象月以前で最大の `from_month` を選び、同月内だけ最新 `id` を使う。期限比較の後続行も有効月順で決める必要があります。

2. **［設計／high］単独評価で除外した候補が、別の取り忘れを補えば成立しても復帰しない。**  
   [2段の掛け直し](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:2347) は、1段目で落ちた候補を再評価しません。  
   **破綻シナリオ：** カルテには月2回の訪問診療と在医総管2ロがあるが、UKE は訪問診療料1回だけで、2回目と管理料が抜けている。管理料だけを足すと R01 `use_once` で除外され、2段目で訪問診療料を補っても、成立する管理料の取り忘れが消えたままになります。  
   **修正方向：** 成立条件を補う候補を含めて再評価してから除外する必要があります。既存の M-2 への対応で生じる別の穴です。

3. **［設計／medium］数量比較が、算定回数と時間などの量を混同する。**  
   [数量比較の規則](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:2340) は「回」を許す一方、請求側を一律に「数量データ×回数」としています。  
   **破綻シナリオ：** [EM の患家診療時間加算](/Users/toshixa/Documents/iji-context/design/iji-context/sources/evidence-master-iji-context.md:1580) は数量70分・算定1回です。カルテで同加算「1回」を確認すると、正しい請求を70と比較し、`G11.quantity_more` が出ます。  
   **修正方向：** 「回」は当日の算定回数、時間などは同じ単位の数量として分けて比較する必要があります。

4. **［設計／medium］子の薬・器材の数量を比較するとしながら、入力の型に数量がない。**  
   [`ChartAct.with`](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:2265) には `quantity` がなく、[§15-8](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:2341) の子の量比較へ渡せません。  
   **破綻シナリオ：** K8 の熱傷処置で、カルテには[ゲーベンクリーム20g](/Users/toshixa/Documents/iji-context/design/iji-context/sources/evidence-master-iji-context.md:578)、請求には同じ薬が10gある。コードは存在するため取り忘れにはならず、子の数量も保持できないため不足を検出できません。  
   **修正方向：** 子にも数量を保持し、取り出し・本人確認・保存・比較まで通す契約と受け入れ条件が必要です。
