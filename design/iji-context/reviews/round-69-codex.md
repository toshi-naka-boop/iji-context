critic: codex/gpt-6.1-sol xhigh（v33・v34 の実装全体の反証。9d1d04c..a26003a。ID は呼び出し側が X-280〜X-284 を番号順に振った）

1. **high／種別：欠損処理** — [src/generic/g11.ts:1034](/Users/toshixa/Documents/iji-context/.claude/worktrees/practical-ab/src/generic/g11.ts:1034)  
   在医総管あり・注2なし、過去12か月のオーダーは対応済み0件、当月14日のカルテ確認済み。正常な院内オーダーに、同日の `{ref:null,place:"院外",refills:0,drugs:[…]}` を加えると、[read.ts:62](/Users/toshixa/Documents/iji-context/.claude/worktrees/practical-ab/src/structured/read.ts:62) が院外行を捨てます。残した `gaps` を判定が見ないため、「院外0件」として**注2・300点の候補が出て、「見ていません」も出ません**。過去月の欠損行でも同じ経路があります。

2. **high／種別：規則の迂回** — [src/generic/g11.ts:628](/Users/toshixa/Documents/iji-context/.claude/worktrees/practical-ab/src/generic/g11.ts:628)  
   患者の機器が未確認でも、`procedures.items` に `act.code={system:"rece",value:"114006210"}`（酸素濃縮装置加算）を入れると、`source:"structured"` の行為は材料加算の折り畳みから除外され、**通常の `G11.missing` が注意なしで出ます**。同じ応答では「機器を確かめていないので見ていません」と表示されます。§16-5 の機器確認を通らず算定候補に進めます。

3. **mid／種別：評価条件の固定漏れ** — [eval/gate.ts:41](/Users/toshixa/Documents/iji-context/.claude/worktrees/practical-ab/eval/gate.ts:41)  
   全gateを1回実行した後、`config/models.json` の `chartExtract.model` または `effort` を変更して全gateを再実行できます。抽出は変更後の設定を読みますが、設定ファイルと `src/mentor/models.ts` は指紋の対象外です。両回が95%以上なら、**異なる抽出条件を「同じ条件の最初の2回」として合格にします**。

4. **mid／種別：入力検査** — [src/structured/read.ts:45](/Users/toshixa/Documents/iji-context/.claude/worktrees/practical-ab/src/structured/read.ts:45)  
   接続先の訪問が `{kind:"訪問診療",start:"10:99",end:"12:40"}`、同日に訪問診療料ありの場合、存在しない時刻を欠けとして扱いません。[g11.ts:579](/Users/toshixa/Documents/iji-context/.claude/worktrees/practical-ab/src/generic/g11.ts:579) が差を61分と計算し、**患家診療時間加算114001470・数量61が注意なしで出ます**。手入力API側の時刻検査では、この接続先経路は塞がりません。

5. **mid／種別：実装・設計不整合** — [src/generic/g11.ts:464](/Users/toshixa/Documents/iji-context/.claude/worktrees/practical-ab/src/generic/g11.ts:464)  
   `acts:[]`、構造化データなし、患者機器は確認済みで `rows:[{kind:"C158",fromMonth:当月,…}]`、請求に材料加算なし、という入力でも「確かめたカルテの行ったことがない」で早期終了します。追加した `about.devices` を終了条件が考慮せず、**確認済み機器だけで決まる材料加算を判定しません**。v34 §16-4-1 の直しが、この入力では効いていません。
