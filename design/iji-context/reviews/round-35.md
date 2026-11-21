委譲先: claude（サブエージェント） / モデル: claude-opus-5-5

## Round 35 — 2026-11-21 — 批評（§13 v25、3 巡目）

対象：design.md §13（v25）。前提として §12・§11-5・§2-3-4、ledger の round-33・round-34 の行、sources/research/tokurei-summary.md・tokurei-group1.md、実装（.claude/worktrees/integration の src/generic/g05.ts・src/generic/index.ts・src/generic/overlap.ts・src/engine/predicates.ts の sameDayOf・src/claim/facts.ts・src/server/app/claim-facts.ts・src/engine/rules/r09.ts・r10.ts・r17.ts・src/engine/revisions/r2026-comments.ts）を読んだ。

round-34 の直しの確かめ：C-112（組ごとの確かめまで条件つき）、C-113/X-104（thenRequires.rule を撤去し checks に）、C-115（scope=day の分かれ）、C-116（answers を経路ごとに）、X-106（key に組を含める）は、本文でそれぞれ閉じている。C-114（sameDayOf の共有）・X-105（答えを書く関数の一本化）・X-107（コメントは件数で、R17 に任せる）は、直しの方向は正しいが、既存の実装と噛み合わせると下の C-117〜C-119 が残る。

### 指摘

- [C-117] 種別: 設計 / 深刻度: mid
  - 指摘: G05 が `sameDayOf` を「そのまま使う」と書いたが、`sameDayOf` の 3 つの結果と「決まらない」を例外の結果（当たる／当たらない／未決）にどう対応させるかが書かれていない。そのため、「いいえ」と答えた日に同じ問いを出し続ける。
  - 破綻シナリオ: 取り込んだ UKE で、10/12 に往診料と訪問診療料の両方がある。`sameDaySeparate` はまだ答えがない。G05 の問い（group1 #6「訪問診療のあとに急変などで往診したか」）に「往診が先」か「予定していた訪問だった」と答えると、X-105 によって `sameDayOushinAfterVisit[10/12]=false` が書かれる。`sameDayOf` は `separate===undefined` かつ `after===false` なので `{known:false, need:"sameDaySeparate"}` を返す。G05 がこれを「未決」と読むと、答え済みの同じ問いを `G05.exception_ask` でもう一度出す。そして何度答えても消えない。この例外は `after===false` だけで「当たらない」と言えるのに、完了条件の「当たらないの答え → 条件つきの exception_none（answered）」がこの組では通らない。あわせて、`GenericAbout.answers` は `(key, date) => string | null` だが、`sameDayOf` が受け取るのは `ClaimContext.facts`（日付を `YYYY-MM-DD` とする真偽の表）である。G05 は日を 1〜31 の番号で持つ。どちらの形で渡すのかも決まっていない。
  - 提案: 対応を表で書く。`same`→当たらない／`after`→当たる／`not_after`→当たらない／`known:false` のうち `need:"sameDayOushinAfterVisit"`→未決（G05 の問いを出す）／`need:"sameDaySeparate"`→当たらない（急変後の往診ではないことは決まっている。実施の回数は R10 が聞く）。G05 に渡す入力は「日ごとの `sameDayOf` の結果」の形にし、日付の変換をどこで行うかも書く。完了条件に「往診が先と答え、sameDaySeparate が未回答の日 → 問いが消えて exception_none（answered）」を足す。

- [C-118] 種別: 設計 / 深刻度: mid
  - 指摘: X-105 の「その日の `sameDayOushinAfterVisit` を消す」「`haihan:*` を消す」は、今の `claim_facts` では書いたとおりに実現できない。`claim_facts` は追記だけの表で、`(claim_id, key, date)` ごとに `MAX(id)` の行を最新とし、`value` は NOT NULL である。
  - 破綻シナリオ: 医療事務が 10/12 について「いいえ」(id=1)、「はい」(id=2)、「その他」の順に答える。「消す」を最新の行の DELETE で実装すると id=2 が消え、`MAX(id)` が id=1 に戻る。その結果、利用者が取り消したはずの「いいえ」が R10 と G05 の両方で生き返る（R10 は `oushin_not_after_visit`、G05 は exception_none）。key と date が同じ行を全部 DELETE すると今度は経過が消え、「どちらも監査ログに残す」と食い違う。空文字などの番兵の値を書く実装にすると、`applyClaimFacts` が `f.value as boolean` で真偽の表に入れてしまい、空文字が偽と同じ扱いになる。
  - 提案: 「消す」を「不明を表す行を追記する」と定める（例：value に決めた番兵を書き、`applyClaimFacts` はその日の値を表から外す。読み出しの `MAX(id)` はそのまま）。`haihan:*` の取り消しも同じ形にする。完了条件に「はい→その他の順に答えると、R10 も G05 も不明に戻り、前の答えは戻らない」を足す。

- [C-119] 種別: 設計 / 深刻度: mid
  - 指摘: `G05.exception_needs_comment` を「R17 が見ている組は R17 に任せる（§12-2 の重なりの規則）」と書いたが、今の重なりの規則ではこの組は止まらない。
  - 破綻シナリオ: overlap.ts で手書きのルールが受け持つ組（covers）として登録されるのは、R17 の場合 `when==="always"` の記載の、区分 1 つの組だけである。往診の理由（T162-reason、830100086）は `when: "sameDayVisitAndOushin"` なので covers に入らない。加えて、G05 の指摘の kind は「背反」で、コードは 2 つ（区分の組が 2 つ）なので、`c.kind === g.kind` も `sets.has(setKey(...))` も成り立たない。10/12 に往診料と訪問診療料があり、急変後と答え、830100086 がない UKE では、R17 の `comment_missing` と G05 の `exception_needs_comment` が同じ記載もれを 2 回言う。逆に G05 の中で R17 の判定を見て止めようとしても、evaluateGeneric は手書きの結果を知らない（overlap.ts 冒頭）。
  - 提案: どちらかに決めて書く。(i) G05 には `comments` に R17 の記載の id（`T162-reason`）を書けるようにし、overlap で「G05 の exception_needs_comment は、その id の R17 の判定（指摘・判定済み）があれば止める」という専用の規則を足す。(ii) R17 が持つ記載は `thenRequires.comments` に書かない（EM §2-12 の行では「R17 の T162-reason」と参照だけ残す）。(ii) のほうが小さい。

- [C-120] 種別: 設計 / 深刻度: low
  - 指摘: `scope: "day"` の問いを「背反の行の `b` 側のコードの算定日ごと」に問うとしたが、G05 は組ごとに「コードの小さいほうをコード①」とする行を選ぶので、`b` 側がどちらになるかは意味ではなくコードの大小で決まる。
  - 破綻シナリオ: 同一月の表の組で、片方が月 1 回の管理料（10/1 だけ）、もう片方が処置（10/5・10/20）で、医療型短期入所中かは処置の日ごとに問う必要がある場合を考える。管理料のコードのほうが大きいと `b`=管理料になり、10/1 だけを問う。10/1 に「当たる」と答えると、10/20 は短期入所が終わっていたかもしれないのに、月全体が「当たる」となって背反が消える。
  - 提案: 問う日の側を、行の向きではなく `HaihanPattern` の側（`a` か `b` か）か `Ask.daysOf: CodeSel` で指定し、表と裏のどちらの向きの行でも同じ側の日を使う、と書く。完了条件の「表と裏のどちらの向き」に、scope=day の問う日が同じであることを含める。

- [C-121] 種別: 設計 / 深刻度: low
  - 指摘: `checks` の「在宅での死亡」を「レセプトでも手書きのルールでも確かめきれない」としたが、請求ごとの事実 `deathPlace`（`CLAIM_FACT_KEYS`、医師あて）はすでにあり、comments.ts と derive.ts（D12）が読んでいる。
  - 破綻シナリオ: K5 で `deathPlace=在宅以外` と確定している請求でも、G05 は「在宅での死亡を確かめてください」という `exception_needs_check` を出し続ける。実際には例外 2 に当たらず、背反である（exception_none であるべき）のに、条件つきの「併せて算定できます」側の文になる。`在宅` と確定していても、同じ確かめを毎月求め続ける。
  - 提案: `checks` は前の月にまたがる C001 の算定だけにし、看取りの場所は `answers` で `deathPlace` を読む `pre`（在宅以外 → 当たらない、不明 → 未決）にする。`ReceiptCond` を広げずに済むよう、kind=fact の `ask.factKey: "deathPlace"`（既存の事実の共有。L-74 の「意味が同じもの」に当たる）として書く。

### 賛成の根拠（直しで正しくなった点）
- C-113 の直し（thenRequires.rule を撤去）は、R09 の `terminalVisitsOk` が看取りの場所と前の月を見ていないことと噛み合っている。手書きのルールに任せると黙って通る、という最も危うい前提を、要件を挙げる形で避けている。
- X-106 の key `haihan:<HX>:<コード①>:<コード②>`（コードは小さい順）は、claim_facts の `(claim_id, key, date)` の最新値の読み出しとそのまま合い、同じ日の 2 つの組を分けられる。
- 13-4 の照合 `certain.has(messageKey) || certain.has(messageKey#hp)` は、今の CERTAIN に `G05.exception_none` の素の key がないので、組を足さない限り確定にならない。既存の `G05.same_unit` の言い切りにも影響しない。
