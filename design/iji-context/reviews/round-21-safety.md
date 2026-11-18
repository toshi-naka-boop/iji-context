委譲先: claude（Claude Code サブエージェント）／モデル: claude-opus-5-5

## Round 21 — 2026-11-18 — 反証(安全性)

対象: feat/integration（21070b0）、worktree `.claude/worktrees/integration`。静的読解が中心。実測は fetch.ts の IPv6 判定だけ（tsx）。

### 指摘

- [S-1] 種別: 設計 / 深刻度: mid
  - 指摘: `POST /api/clock` が全ロール（ALL）に開いていて、ベテランだけに許している会議の整理（`POST /api/meeting`）を、任意の時刻で回せてしまう。
  - 該当: `src/server/policy.ts:96`（`"POST /api/clock": ALL`）と `:85`（`"POST /api/meeting": ["veteran"]`）、`src/server/app/clock.ts:23-30`
  - 破綻シナリオ: 医師ロール（または事務・事務長）が `POST /api/clock {"now":"<次の会議の曜日>T09:00:00+09:00"}` を送る。`advanceClock` の中で `dueMeeting(last, to, …)` が真になり、`meetingReview(deps, to)` が走る。これは `runMeeting` と同じ処理で、知識の状態が動き（④の要再検証など）、議題が作られ、`reviews` に記録される。`to` には `isoTime` の形しか課していないので、過去にも遠い未来にも動かせる。`tickQueries` も同じ時刻で走るので、医師確認の期限・保留がクリニック全体でまとめて進む。権限表が会議の実行をベテランに絞っていても、時計の経路では効かない。
  - 提案: 権限表の `POST /api/clock` を、会議を回せるロール（ベテラン）と solo の持ち主に絞るか、`advanceClock` から会議の整理を外して `POST /api/meeting` だけで回す。あわせて時刻を「いまより後」かつ上限つきにする。spec FR-70（時計は全員で共有）と FR-133 の表のどちらを採るかが決まっていないなら、ユーザーへの確認に回す。

- [S-2] 種別: 設計 / 深刻度: mid
  - 指摘: LLM の回数制限が利用者ごとしかなく、クリニック全体・サービス全体の上限がない。登録の制限は接続元 IP ごとなので、開放登録のときは IPv6 のアドレスを替えるだけで回避でき、API の予算を使い切れる。
  - 該当: `src/server/http.ts:184`（キーは `${tenantId}:${userId}`）、`src/server/rate-limit.ts:43-50`、`app/api/auth/register/route.ts:11-17`（`perIp` は 1 時間 20 回）、`src/server/rate-limit.ts:60-64`（IPv6 アドレスをそのままキーにしている）、`docs/deploy-gcp.md:3`（審査員が各自登録する前提）
  - 破綻シナリオ: `RESEMEN_OPEN_SIGNUP=1` で公開する。攻撃者は /64 の中で送信元アドレスを替えながら `POST /api/auth/register` を繰り返す。`X-Real-IP` が毎回違うので、`perIp` には引っかからない。作ったアカウントごとに `llm` の perDay 300 回が使え、`/api/mentor`・`/api/chart`・`/api/notice` を呼べる。1 時間に数百アカウント × 300 回の LLM 呼び出しで、$500 のクレジットが 1 日もたたずに尽きる。招待制でも、事務長は招待を何枚でも作れるので、同じクリニックに利用者を増やせば上限は人数に比例して増える（こちらは内部の者による濫用）。
  - 提案: `rate_daily` と同じ仕組みで、サービス全体（auth.db）の 1 日の上限と、クリニックごとの上限を足す。登録の制限は、IPv6 を /64 に丸めたキーで数える。

- [S-3] 種別: 実装 / 深刻度: mid
  - 指摘: `Throttle.blocked()` は、ヒットのないキーにも空の配列を `set` する。消すのは `clear()` だけなので、ログインの試みのたびに `id:<任意の文字列>` の項目が Map に残り続け、メモリを際限なく食う。
  - 該当: `src/server/auth.ts:51-55`（`this.hits.set(key, xs)` を必ず実行する）、`app/api/auth/login/route.ts:14-16`（`keys.some(blocked)` は `id:` を先に見る）
  - 破綻シナリオ: 攻撃者は Origin を付けずに（curl で）、`POST /api/auth/login {"login":"<毎回違う 64 文字>","password":"x"}` を投げ続ける。5 回失敗すると IP 側が塞がれて 429 になるが、その判定より先に `failures.blocked("id:<新しい文字列>")` が走り、項目が 1 つ増える。429 の経路は scrypt を通らないので 1 回の処理は軽く、秒間数千件を送れる。項目 1 件はおよそ 150〜200 B なので、1,000 万件で 2 GB 近くになり、プロセスが OOM で落ちる。テナントの DB は無事だが、全利用者が使えなくなる。register の `perIp` も同じ形で、IPv6 を替えれば同じことが起きる。
  - 提案: `blocked()` で、窓の中のヒットがなくなったキーは `delete` する。あわせて Map の大きさに上限を置き、古いものから捨てる。ログイン ID の形（`/^[A-Za-z0-9_.-]{3,32}$/`）を、Throttle を引く前に確かめる。

- [S-4] 種別: 実装 / 深刻度: low
  - 指摘: ログイン ID がないときは scrypt を 2 回、あるときは 1 回だけ回すので、応答時間の差でログイン ID が存在するかを見分けられる。
  - 該当: `src/server/auth.ts:166-173`（`verifyPassword(password, hashPassword("dummy-password"))` は、hashPassword で 1 回、verify でもう 1 回）
  - 破綻シナリオ: 候補の ID ごとにログインを試して応答時間を測る。N=16384 の scrypt 1 回分（数十 ms）の差が出て、存在する ID は速く返る。IP ごとの制限（10 分に 5 回）は IPv6 を替えれば回避できる（S-2 と同じ）。招待制で、登録の経路から ID の有無が漏れないようにしてある（招待の検査が `insertUser` の重複検査より先）のに、ログインの経路で漏れる。
  - 提案: ダミーのハッシュはモジュールの読み込み時に 1 回だけ作り、ないときも `verifyPassword` 1 回だけにする。

### 反論なしとした観点（要約）
- Origin の検証と CSRF（`proxy.ts`・`origin.ts`）：Origin が `"null"` のときは URL として読めず false になる。Host との比較はブラウザからは偽れない。Origin も Sec-Fetch-Site もないリクエストは cookie 持ちのブラウザ外クライアントだけで、cookie は SameSite=Lax。
- tenant 越え：`tenantPaths` は `^t[0-9a-f]{12}$` だけを通す。tenant は AsyncLocalStorage で、セッションから決めた利用者だけで選ぶ。ロールは毎回 DB から読み直す。メンターの道具は Skill と MCP だけで、ファイルを読む道具はない。問題（questions）は全ルートで本人のものかを確かめている。加入情報の確認入力は、coverageId がその患者のものかを `coveragesOf(patientId)` で確かめている。
- UKE：アップロードは本文の読み込み前に上限を見ている（content-length と、実際に読んだ量の両方）。`parseUke` の例外の文は定型文と行番号だけ。保存するのは見本と同じ内容のバイト列だけで、ファイル名は内容のハッシュ。sample の name は正規表現と一覧の両方で絞り、content-disposition には一覧の名前を使う。case-files は表を引くだけ。
- コネクタ（`fetch.ts`）：どの API ルートからも呼ばれていない（`connectorOf`・`enabledConnectors` の呼び出し元は 0 件）。IPv4 を埋め込んだ IPv6 の 16 進表記（`::ffff:7f00:1`・`::ffff:a9fe:a9fe`）は、Node 26 の BlockList が IPv4 として判定するのを tsx で確かめた（true）。`::ffff:0:a9fe:a9fe`（SIIT）・`::7f00:1`（IPv4 互換）・`2002::/16`（6to4）は通るが、許可リストの完全一致が前提で、既定の経路では届かないので指摘にしない。
- 公的文書のリンク：`officialDocSchema` の `url` は `^https://` に限っている。画面のリンク（`app/meeting`・`app/work`）はレジストリから来た値だけで、利用者の入力は届かない。`dangerouslySetInnerHTML` は使っていない。
- 監査ログ：target は検証済みの id・列挙値・時刻だけで、`cleanTarget` で制御文字を除き、長さも切っている。本文が入る経路はない。
- `chart/[id]/claim` の choices：`claimChoices` で値は文字列 40 字までに絞っている。`derive.ts` は、選択肢の id と一致したときだけ採る。プレビューにカルテの本文は載らない。
