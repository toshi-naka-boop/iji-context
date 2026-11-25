critic: codex（モデルは ~/.codex/config.toml の設定）xhigh。対象 feat/integration、レンズ：正しさ

重大度順に5件です。すべて再現確認済みで、ファイルは編集していません。

1. **設計・高：同じ1診療を2回の訪問として数える。** [src/engine/predicates.ts:128](/Users/toshixa/Documents/iji-context/.claude/worktrees/integration/src/engine/predicates.ts:128)  
   入力：10/21に`visit`と`oushin`、`sameDaySeparate["2026-10-21"]=false`、他の訪問なし、10/22在宅死亡。往診・ターミナル加算を選択すると、実施は1回なのに2回要件を満たし、**4,500点を導出して検証も通る**。
2. **実装・高：同日の選択が前日往診の制限を飛ばす。** [src/engine/derive.ts:181](/Users/toshixa/Documents/iji-context/.claude/worktrees/integration/src/engine/derive.ts:181)  
   入力：10/13往診、10/14に訪問＋往診、14日は`sameDaySeparate=false`で訪問を選択、`contactDocProvided=false`。早期returnにより翌日制限を調べず訪問診療料を立てる。保留なしになる一方、検証では`R10.visit_day_after_oushin`が出る。
3. **実装・高：同一区分の複数行を先頭行だけで検査する。** [src/engine/rules/util.ts:5](/Users/toshixa/Documents/iji-context/.claude/worktrees/integration/src/engine/rules/util.ts:5)、[r11.ts:23](/Users/toshixa/Documents/iji-context/.claude/worktrees/integration/src/engine/rules/r11.ts:23)  
   入力：`D026_3`を10/14・10/28に各`count:1`の別行で算定。月1回の判断料を**250点請求しても指摘なし**。UKE経由でも再現する。同じ関数を使うR08・R15にも後続行の検査漏れがある。
4. **設計・中：UKEの請求点数を捨て、不整合を見逃す。** [src/uke/uke.ts:273](/Users/toshixa/Documents/iji-context/.claude/worktrees/integration/src/uke/uke.ts:273)  
   入力：同梱の支払基金UKEでBNPのSI第6列を`130→9999`、HO第6列を`274→1`、GOは274のままにする。読み込みに成功し、再出力すると130・274に戻る。元ファイルの点数不整合を検出できない。
5. **実装・中：処方ごとの種類数を月全体で判定する。** [src/engine/predicates.ts:120](/Users/toshixa/Documents/iji-context/.claude/worktrees/integration/src/engine/predicates.ts:120)、[derive.ts:309](/Users/toshixa/Documents/iji-context/.claude/worktrees/integration/src/engine/derive.ts:309)  
   入力：管理料なし、10/1に内服5種類、10/20に7種類。両方を`F400_2`にして64点となり、設計D10どおりの60＋32＝92点から**28点過少算定**。正しい2区分を入力するとR07が誤り扱いする。
tokens used
128,786
