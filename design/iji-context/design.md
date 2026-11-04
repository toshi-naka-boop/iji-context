# iji-context 設計書 — ルールエンジンと知識ライフサイクル（F5）

版: v4（2026-11-04。v3 にユーザーの C-10 判断と取り忘れ検出の範囲の明確化を反映。v3 の内訳：批評 1 巡目の C-1〜C-5・X-1〜X-5 と、2 巡目の C-6〜C-9・X-6〜X-10 を反映。2 巡目の反映分は批評を受けていない）
要求入力: design/iji-context/spec.md（FR-01〜04, FR-38〜51, FR-64〜66）
対象外: UKE パーサ（F4）、メンター（F2/F6）、UI、医師確認（F1/F3）。これらは impl-plan.md で扱い、本設計とは §6 の境界でつなぐ

## 0. 設計の要点

1. **ルールエンジンは「渡された算定行を検証し、合計する」純関数**とする。算定行を自分で生成しない
2. **事実は三値（ある／ない／不明）で持つ**。「不明」のときだけ「情報不足」を返す（C-4）
3. **知識（Skill）は「説明文（SKILL.md）＋決定的な適用条件（meta.json の `match`）＋向き（`polarity`）」で構成する**。提出を確定した版ごとに「どの知識が適用されたか」を記録し、提出結果はその版の記録に結びつけて取り込む（C-3、X-3、X-4、C-6、C-7、X-6）
4. **状態遷移は表駆動の純関数 1 つ**（`transition`）に閉じる。表にない遷移は例外にする。時刻は引数で受け取る
5. **知識の正はファイル（`knowledge/`）、適用記録と取り込み済み結果は SQLite**。状態が変わるたびに同期スクリプトを走らせ、さらに読み出し側でも状態を確かめる（X-1）

## 1. ディレクトリ構成

```
src/
├── engine/
│   ├── types.ts            # ClaimContext, Fact, ClaimLine, Finding, EngineResult
│   ├── points-2024.ts      # 区分番号→点数（出典は §2-4）
│   ├── codes-fictional.ts  # 区分番号→架空9桁コード
│   ├── rules/              # r01.ts … r14.ts。各ルールは appliesTo と check を持つ
│   └── index.ts            # evaluate(ctx): EngineResult
├── lifecycle/
│   ├── types.ts            # KnowledgeMeta, KnowledgeStatus, LifecycleEvent
│   ├── layers.ts           # 層×生成元×トリガーの対応表（FR-66、定数）
│   ├── machine.ts          # transition(meta, event, now)
│   ├── triggers.ts         # evaluateTriggers(metas, now, calendar)
│   ├── calendar.ts         # 改定日・改選日
│   ├── match.ts            # matches(meta, ctx, applied): boolean
│   ├── applications.ts     # 適用記録と提出結果の取り込み（SQLite）
│   ├── queue.ts            # 検証キュー（FR-65）
│   └── store.ts            # knowledge/ の読み書き（原子的書き込み＋同期の呼び出し）
scripts/sync-skills.ts      # 承認済みだけを .claude/skills/ へ（FR-48）
config/{facility.json, calendar.json}
fixtures/{cases/K1.json … K6.json, rules/r01-*.json …}
knowledge/<layerSlug>/<slug>/{SKILL.md, meta.json}
tests/{engine,lifecycle,scripts}/*.test.ts
```

- `layerSlug` は英字に固定する：制度＝`system`、地域＝`regional`、ベテランの判断＝`veteran`、院内＝`local`（C-5）。`slug` は英小文字・数字・ハイフンのみ
- 依存は `typescript`・`tsx`・`vitest`（§9）。SQLite のドライバと Drizzle は impl-plan.md の承認に含める

## 2. ルールエンジン

### 2-1. 入力 `ClaimContext`

UKE そのものではなく、正規化済みの 1 患者 1 か月分を受け取る（UKE→ClaimContext の変換は F4 の担当）。

| フィールド | 中身 |
|---|---|
| `claimId` | 請求を一意に識別する ID（適用記録と提出結果の結びつけに使う） |
| `yearMonth` | `"2025-03"` 固定（それ以外は例外） |
| `facility` | config/facility.json（在支診・強化型以外・病床なし・東京都、届出の有無） |
| `payer` / `prefecture` | 審査支払機関（支払基金／国保連）と都道府県 |
| `facts` | 判定に使う事実。各値は `Fact<T> = { known: true; value: T } \| { known: false }`（C-4） |
| `events` | 日付付きの出来事：訪問診療（同一建物の患者数つき）、往診（種別）、検査、処方箋交付（内服種類数・日数）、死亡、退院、在医総管の算定開始月 |
| `lines` | 算定行：`{ kubun, count, dates[] }` |

- `facts` の主な項目：年齢、保険種別、負担割合、要介護度、別表第七・第八の二の該当、主病、在宅酸素の有無、看取りの場所。**合成症例 K1〜K6 はすべて `known: true` で埋める**
- `events` は「記録された出来事の一覧」で、載っていない出来事は「なかった」とみなす。出来事の有無そのものが不明なときは、対応する `facts` の項目（例：`facts.visitsComplete`）を `known: false` にする

### 2-2. 出力

```ts
type Finding = {
  ruleId: string;            // "R01"…"R14"
  kind: "不一致" | "背反" | "取り忘れ" | "区分誤り" | "要件不足" | "情報不足";
  lineRefs: string[];
  missing?: { target: "doctor" | "clerk"; field: string };   // kind=情報不足のとき
  messageKey: string;        // メンターが言語化するためのキー（文言はエンジンが持たない）
  reference: string;         // 告示・留意事項の該当
};
type EngineResult = {
  claimId: string;
  total: number | null;      // 点数未収載の行があれば null
  byLine: { kubun: string; points: number | null }[];
  findings: Finding[];
  applied: string[];         // appliesTo が真だったルール ID（違反の有無によらない。X-3）
};
```

- 合計は渡された `lines` をそのまま点数表で足す。指摘があっても合計は変えない（FR-11）
- 各ルールは `appliesTo(ctx): boolean`、`check(ctx): Finding[]`、対象区分の定数 `kubun: string[]` を持つ（`kubun` は §4-4 の反例判定に使う: C-6）。`appliesTo` が判定に必要な `facts` を `known: false` で受け取ったときは、`check` を呼ばずに `情報不足` を 1 件返す
- 文言は持たず `messageKey` だけを返す（FR-11）

### 2-3. ルール一覧（13 テストケースと 1 対 1、＋R14）

ルール本文は report-A 項目21「新人が間違えやすいポイント」に従う（EM §5 で採用済み）。

| ID | 内容 | kind |
|---|---|---|
| R01 | 在医総管の区分は同月の C001 算定回数で決まる。C001 なしの在医総管は不可 | 区分誤り |
| R02 | 在宅酸素中（別表第八の二）は重症区分 4,585。3,685 は過少。重症区分に包括的支援加算 150 は付けない | 区分誤り／背反 |
| R03 | 包括的支援加算は要介護 3 以上かつ重症区分以外。満たさないのに立てていれば要件不足、満たすのに立てていなければ取り忘れ | 要件不足／取り忘れ |
| R04 | 在宅療養指導管理料は主たる 1 つのみ。材料加算は各々可 | 背反 |
| R05 | 在医総管算定月に包括される項目を別に立てない。院外処方なら注2（+300）不可。処方箋料（F400）は包括されない（EM #7-6） | 背反 |
| R06 | 特定疾患処方管理加算は主病が対象疾患のとき（糖尿病・高血圧は 2024年6月から不可） | 要件不足 |
| R07 | 処方箋料は内服 7 種類以上で 32 点。68 点を使わない | 区分誤り |
| R08 | ベースアップ評価料(Ⅰ) 訪問診療時は 28 点。往診のみの日は再診時等 2 点 | 区分誤り |
| R09 | 死亡診断加算 200 と看取り加算 3,000 は併算定不可。ターミナルケア加算は死亡日前 14 日以内に 2 回以上の訪問 | 背反／要件不足 |
| R10 | 緊急往診加算は対象患者限定。訪問診療と同日の往診は原則不可、往診翌日の訪問診療は在支診以外不可 | 要件不足 |
| R11 | 検査判断料は月 1 回。BNP は生化学(Ⅱ)。外来迅速検体検査加算は訪問診療では立てない | 背反／区分誤り |
| R12 | 在宅医療DX情報活用加算は医療情報取得加算・医療DX推進体制整備加算と同月併算定不可 | 背反 |
| R13 | 週 3 回超の訪問診療は例外疾病（別表第七）か急性増悪のときだけ | 要件不足 |
| R14 | 在宅移行早期加算の取り忘れ（K2 の S2 用） | 取り忘れ |

- R14 の算定条件（算定開始から何か月以内か等）は EM に収載されていない。実装前に留意事項通知の本文で確認し、EM に行を足してからコードにする（L-1）。**R14 が未確定でも K2 の合計（§7 #2）は成立する**（合計は渡された行の和で、R14 は指摘を足すだけのため）
- **取り忘れは、事実（`facts`・`events`）だけで要件が決まる加算を検出する。届出に依存する加算（ベースアップ評価料・DX 加算・在宅医療情報連携加算）は検出しない**（P-1）。v4 で検出するのは R03（包括的支援加算 150）と R14（在宅移行早期加算 100）で、K2 の「加算の取り忘れ」（F4 の中核）はこの 2 つで出る
- 事実だけで判定できる加算のうち、頻回訪問加算・ターミナルケア加算・特定疾患処方管理加算の「付け忘れ」は、13 テストケースに含まれないためルールを持たない（L-6）

### 2-4. 点数表（C-1）

`points-2024.ts` の出典は 2 つに限る：

1. report-A 項目21 の点数セット表
2. EM §5／§5-1 に点数付きで載っている項目（在宅移行早期加算 100、包括的支援加算 150、頻回訪問加算 800／300、ターミナルケア加算 4,500、看取り加算 3,000、往診料 720 など）

区分は 3 種類に分ける：

| 種類 | 扱い |
|---|---|
| 点数あり | 上記 2 つの出典に点数がある区分 |
| 点数未収載 | 違反フィクスチャに必要だが EM に点数がない区分（特定疾患療養管理料、医療情報取得加算、医療DX推進体制整備加算、外来迅速検体検査加算、C002 注2）。`points: null` を返し、`total` は null になる |
| 未知 | どちらにもない区分。`evaluate` は例外を投げる（黙って 0 点にしない） |

点数未収載の区分に点数を付けるときは、先に EM に行を足す。

## 3. 知識の形式（FR-39）

`knowledge/<layerSlug>/<slug>/meta.json`：

```ts
type KnowledgeMeta = {
  id: string;                  // "<layerSlug>/<slug>"
  layer: "制度" | "地域" | "ベテラン" | "院内";
  status: "未検証" | "承認済み" | "contested" | "要再検証" | "停止" | "保管";   // FR-64 の6つで閉じる
  summary: string;             // 1 行の説明（SKILL.md の description に使う）
  rev: string;                 // SKILL.md 本文と match の内容ハッシュ先頭12桁。本文か match を変えると変わる（X-9）
  polarity: "avoid" | "allow"; // avoid＝「この条件だと返戻・査定される」、allow＝「この条件なら通る／こう算定する」（C-6）
  matchApprox: boolean;        // match が条件を表しきれていないとき true（X-7）
  conditionNote: string | null;// match で表せない条件の文章（matchApprox のとき必須）
  source_event: { type: SourceType; ref: string; at: string };
  relates_to: string | null;   // 提案（F11）が対象とする既存知識の id
  valid_from: string;
  review_by: string | null;
  hits: number;
  misses: number;
  last_hit_at: string | null;
  status_since: string;        // 現在の状態に入った日
  retired_reason: string | null;
  empathy: number;             // 共感数（FR-65）
  match: Match;
  history: { at: string; from: string; to: string; event: string; actor: "veteran" | "clerk" | "system" }[];
};
type Match = {
  ruleId?: string;             // 制度層：エンジンの applied に含まれれば適用（X-3）
  kubunAll?: string[];         // 地域・ベテラン・院内：これらの区分がすべて lines にある
  payer?: "支払基金" | "国保連";
  prefecture?: string;
  facts?: Partial<{ careLevelMin: number; insurance: string; table8_2: boolean; table7: boolean }>;
};
```

- `match` は宣言的な条件だけで、自由な式は書けない。`facts` の条件は、対応する事実が `known: false` なら「適用せず」とする
- 層ごとの `match` の必須項目（`store` が書き込み時に検証。C-8）：

| 層 | 必須 | polarity の既定 |
|---|---|---|
| 制度 | `ruleId` | allow |
| 地域 | `kubunAll`・`payer`・`prefecture`（改選日を一意に決めるため） | 返戻・査定由来は avoid、再審査（復活）由来は allow |
| ベテラン | なし（`kubunAll` は任意） | allow |
| 院内 | なし（`kubunAll` は任意） | 返戻由来は avoid、それ以外は allow |

- 条件が `match` で表しきれない知識（訪問回数・日付の関係・処方の種類数など）も、元の層の候補として作る。このとき `matchApprox: true` とし、表せない部分を `conditionNote` に書く（X-7。v2 の「院内メモに留める」は廃止）
- `matchApprox: true` の知識と、`match` に `kubunAll` も `ruleId` もない知識には、提出結果から自動でイベントを出さない。状態を動かすのは、メンターの引用（`USED`）とベテランの操作だけ（§4-4）
- `actor` は役割名だけを記録し、個人名を残さない（FR-50）

## 4. 状態遷移

### 4-1. 生成元と層の対応（`layers.ts`、FR-66・X-5）

| 生成元 `source_event.type` | 作れる層 | 初期状態 |
|---|---|---|
| 初期投入 | 制度 | 承認済み |
| 返戻 | 地域、院内 | 未検証（FR-42） |
| 査定（再審査申出中） | 地域 | contested |
| 査定（申出なし） | 地域 | 未検証 |
| 再審査（復活） | 地域（「この項目は認められた」） | 承認済み（FR-43） |
| エスカレーション | ベテラン | 未検証（FR-15） |
| 提案（F11）、手動 | 院内 | 未検証 |

- 表にない組み合わせ（例：提案から制度層）は `store` が拒否する
- F11 の提案が既存知識の改善の場合は、院内層の新しい候補として作り `relates_to` に対象を入れる。対象の知識は直接書き換えない

### 4-2. 遷移表（`machine.ts`）

| 現在 | イベント | 次 | 付随 |
|---|---|---|---|
| 未検証 | `VERIFY_APPROVE`（veteran） | 承認済み | |
| 未検証 | `VERIFY_REJECT`（veteran） | 保管 | retired_reason 必須 |
| 未検証 | `EMPATHY` | 未検証 | empathy を加算 |
| 未検証 | `REEXAM_FILED` | contested | 査定由来の知識だけ（X-8） |
| 承認済み | `REEXAM_FILED` | contested | 査定由来の知識だけ（X-8） |
| contested | `REEXAM_RESULT{原審どおり}` | 承認済み | |
| contested | `REEXAM_RESULT{復活}` | 保管 | 地域層の承認済み知識を 1 件生成（effect） |
| 承認済み | `TRIGGER{revision\|reappointment\|idle}` | 要再検証 | 層に効かないトリガーは例外 |
| 承認済み | `HIT` | 承認済み | hits を加算、last_hit_at を更新 |
| 承認済み | `COUNTER_EXAMPLE` | 承認済み | misses を加算 |
| 承認済み | `USED` | 承認済み | last_hit_at を更新（C-6、C-8） |
| 要再検証 | `RECHECK_PASS{claim\|veteran}` | 承認済み | |
| 要再検証 | `COUNTER_EXAMPLE` | 停止 | misses を加算、廃棄提案を出す |
| 要再検証 | `IDLE_EXPIRED` | 停止 | 廃棄提案を出す（X-10）。層に③が効かない場合は例外（X-2） |
| 要再検証 | `USED` | 要再検証 | last_hit_at を更新（再承認はしない） |
| 停止 | `DISPOSAL_APPROVE`（veteran） | 保管 | retired_reason 必須 |
| 停止 | `DISPOSAL_REJECT`（veteran） | 承認済み | |

- 上記にない組み合わせは例外にする。保管は終端
- 状態が変わる遷移では、必ず `status_since = now` に更新する
- `VERIFY_REJECT` は FR に明記がない。未検証の候補をベテランが誤りと判断したときの出口として追加した（L-2）
- `REEXAM_FILED`（→contested）は、FR-43「再審査申出中は contested」を、査定を取り込んだ後に申し出た場合にも満たすために追加した（L-5）
- `USED` は状態を変えない自己遷移で、U-H の遷移を増やさない
- 承認済みでの `COUNTER_EXAMPLE` は状態を変えず misses を数えるだけにする

### 4-3. トリガー判定（`triggers.ts`）

`evaluateTriggers(metas, now, calendar)` は、発火すべきイベントの一覧を返すだけで、書き込みはしない。**1 つの知識について、1 回の判定で返すイベントは最大 1 件**とし、優先順位は ①改定 → ②改選 → ③idle とする（C-2）。

| トリガー | 発火条件 | 対象 |
|---|---|---|
| ① 改定 | `now` 以前の直近の改定日（偶数年 6/1）が `status_since` より後 | 制度層の承認済み |
| ② 改選 | `now` 以前の直近の改選日が `status_since` より後。支払基金は奇数年 6/1、国保連は `calendar.json` の都道府県別日付。**未設定（null）なら発火しない** | 地域層の承認済み |
| ③ idle（承認済み） | `max(last_hit_at, status_since)` から 180 日以上（C-2） | FR-66 で③が効く層の承認済み |
| ③ idle（要再検証） | `max(last_hit_at, status_since)` から 180 日以上 → `IDLE_EXPIRED` | FR-66 で③が効く層の要再検証のみ（制度層は対象外: X-2） |

- 層×トリガーの対応は `layers.ts` の定数表だけを参照する
- 起点に `status_since` を含めるので、ベテランの再確認や廃棄却下で承認済みに戻った知識は、戻った日から数え直しになる（C-2）
- 制度層の要再検証から出る道は、`RECHECK_PASS` と `COUNTER_EXAMPLE` だけになる

### 4-4. 適用記録と提出結果（`applications.ts`、C-3・X-3・X-4・C-6・C-7・X-6・X-9）

**記録するのは「提出を確定した版」だけ**にする。評価は何度でもしてよいが、記録は提出確定のときに 1 回だけ書く（C-7、X-6）。

SQLite に 3 つの表を持つ：

| 表 | 列 | 書くとき |
|---|---|---|
| `submissions` | submissionId（一意）, claimId, linesHash, submittedAt, superseded | 本人が提出を確定したとき。同じ claimId の以前の版は `superseded=true` にする |
| `applications` | submissionId, knowledgeId, rev, status, statusSince, role（`final`／`avoided`） | 提出確定のとき。承認済み・要再検証の知識を対象に、確定版の lines で `matches` が真なら `final`。その請求の評価途中で一度でも真になり、確定版では偽なら `avoided`（本人が助言どおりに直した） |
| `claim_results` | resultId（一意）, submissionId, outcome（通過／返戻／査定）, kubun[], importedAt | 提出結果を取り込んだとき |

提出結果の取り込み（`importResult`）：

1. `resultId` が取り込み済みなら何もしない（重複排除）
2. `submissionId` が `superseded` なら、その結果からイベントを出さない（X-6）
3. その `submissionId` の適用記録を引き、知識の**現在の状態・`status_since`・`rev` がすべて記録時と同じ**ものだけを対象にする。違えば捨てる（X-4、X-9）
4. `matchApprox` の知識と、`kubunAll` も `ruleId` もない知識は対象外（§3）
5. 次の表でイベントに変換する（C-6）。「関係あり」＝結果の `kubun[]` が知識の `match.kubunAll`（制度層は該当ルールの `kubun`）と重なる

| role | polarity | outcome | 承認済みのとき | 要再検証のとき |
|---|---|---|---|---|
| final | allow | 通過 | `HIT` | `RECHECK_PASS{claim}` |
| final | allow | 返戻・査定（関係あり） | `COUNTER_EXAMPLE` | `COUNTER_EXAMPLE` |
| final | avoid | 返戻・査定（関係あり） | `HIT`（予告どおり落ちた） | `RECHECK_PASS{claim}` |
| final | avoid | 通過 | `COUNTER_EXAMPLE`（落ちなかった） | `COUNTER_EXAMPLE` |
| avoided | どちらでも | どれでも | `USED` | `USED` |

6. 返戻・査定は、別途 §4-1 の生成元として新しい候補も作る

- avoid の知識は、助言どおりに直されると確定版では当たらない。`avoided` の `USED` で last_hit_at を更新するので、使われ続けている限り 180 日ヒットなしで消えない（C-6）
- メンターが回答で知識を引用したときも `USED` を出す（ベテラン層など、提出結果と結びつかない知識の生存確認。C-8）
- デモでは提出結果を JSON ファイルで取り込む（審査支払機関とはつながない）

### 4-5. 検証キュー（FR-65）

未検証の知識を `empathy` 降順、同数なら `source_event.at` 昇順に並べる。閾値による自動承認はしない。

## 5. 同期（FR-48、X-1・C-5）

`scripts/sync-skills.ts`（`store` からも関数として呼ぶ）：

1. `knowledge/` を走査し、`status === "承認済み"` かつ `layer !== "院内"` のものを選ぶ（FR-12）
2. `.claude/skills/iji-*` を全削除してから、`.claude/skills/iji-<layerSlug>-<slug>/SKILL.md` に書き出す。先頭に frontmatter（`name: iji-<layerSlug>-<slug>`、`description: <summary>`）を生成して付ける
3. 出力は入力だけで決まる（時刻や走査順に依存しない）

古いコピーを残さないために、2 か所で守る（X-1）：

- **書き込み側**：`store` は状態が変わる遷移を書き込んだ直後に、必ず同期を実行する
- **読み出し側**：メンターの `query_skills` は、返す前に `knowledge/` の meta.json を読み、承認済みでないものと院内層のものを除く（C-9）
- **長く続くセッション**（C-9）：同期のたびに `.claude/skills/.iji-generation` に世代番号を書く。メンターのホスト（F2）は 1 問の開始ごとに世代番号を比べ、変わっていればセッションを作り直す（キャラ・レベル・呼び名だけを引き継ぐ）。これは F2 への要求で、impl-plan.md に載せる

## 6. 他機能との境界

| 相手 | 渡すもの | 受け取るもの |
|---|---|---|
| F4（UKE パーサ） | — | `ClaimContext`（`facts` は合成データから `known: true` で埋める） |
| F2 メンター | `EngineResult`、`query_skills` の結果 | — |
| F1/F3 | `Finding.missing` | 回答で更新された `facts` |
| F9 防いだ額 | `Finding` と修正前後の `lines` | — |
| F2 メンター（引用） | — | 回答で引用した知識 id（`USED` を出す） |
| 提出結果の取り込み | — | 結果 JSON（`resultId`, `submissionId`, outcome, kubun[]）、再審査申出（`REEXAM_FILED` の対象 id） |

## 7. 検証可能な完了条件

すべて呼び出し側がリポジトリ直下で実行して確かめる。

| # | コマンド | 合格条件 |
|---|---|---|
| 1 | `npx vitest run tests/engine/rules` | R01〜R13 それぞれ「違反あり」「違反なし」の 2 本が通る。違反フィクスチャは点数未収載の区分を含んでよい（`total` は null） |
| 2 | `npx vitest run tests/engine/totals.test.ts` | `evaluate(K1).total === 14819`、`evaluate(K2).total === 6193`。K1 の findings が空。K1 の `facts` を 1 項目 `known: false` にすると、その項目を使うルールの `情報不足` が出る。K2 から包括的支援加算と在宅移行早期加算の行を外すと、R03・R14 の `取り忘れ` が 1 件ずつ出る（R14 は L-1 の確認後） |
| 3 | `npx vitest run tests/lifecycle/machine.test.ts` | §4-2 の全行が通る。6 状態 × 全イベントの残りの組み合わせはすべて例外になる。`IDLE_EXPIRED` と `COUNTER_EXAMPLE` による停止で、どちらも廃棄提案が出る |
| 4 | `npx vitest run tests/lifecycle/triggers.test.ts` | FR-66 にない層×トリガーで発火しない。制度層の要再検証は 180 日経っても `IDLE_EXPIRED` にならない。改選と idle が同時に該当しても 1 件だけ返る。`DISPOSAL_REJECT` 直後の知識は即座に再発火しない。国保連の改選日が null なら②は発火しない。2025-06-01 で K6（支払基金）の地域知識が要再検証になる |
| 5 | `npx vitest run tests/lifecycle/applications.test.ts` | §4-4 の変換表の全行が通る。同じ resultId を 2 回取り込んでも hits は 1 回分。superseded の版の結果ではイベントが出ない。要再検証に入る前の記録、または rev が変わった後の記録では承認済みに戻らない。入った後の請求の「通過」（allow）で戻る。avoid の知識を助言どおり直した請求で `USED` が出る |
| 6 | `npx vitest run tests/lifecycle/layers.test.ts` | 提案から制度層・ベテラン層を作ろうとすると拒否される。地域層は payer と prefecture がないと拒否される。`matchApprox` の知識は conditionNote がないと拒否される |
| 7 | `npx vitest run tests/lifecycle/queue.test.ts` | empathy で並び順だけが変わり、状態は変わらない |
| 8 | `npx vitest run tests/scripts/sync.test.ts` | 一時ディレクトリで同期を 2 回実行し、2 回の出力が完全に一致する。承認済みかつ院内以外だけが入り、各 SKILL.md に name と description がある。承認済みの知識を要再検証に遷移させると、同期先から消える |
| 9 | `npx tsc --noEmit` | 型エラーなし |

## 8. 前提・既知の論点

- **P-1（データの癖）**：K1（14,819 点）はベースアップ評価料・DX 加算・連携加算を含み（report-A の前提）、K2（6,193 点）は含まない（report-B の前提）。同じ架空クリニックなのに届出の前提が違う。届出依存の加算の付け忘れを検出しないことで、両方の合計を成立させる
- **C-11（ユーザーに確認中）**：EM #7-6 で処方箋料は在医総管の月でも別算定できると決まった。一方 K2（6,193 点）は report-B の「処方箋料も別加算しない」に基づき、院外処方があるのに F400 を含まない。処方箋料の付け忘れはエンジンが検出しないので合計は成立するが、K2 の「正解」に算定漏れが残る
- **L-1**：R14 の条件は EM 未収載。実装前に一次資料で確認する
- **L-2**：`VERIFY_REJECT`（未検証→保管）を追加した
- **L-3**：東京都国保連の改選日が未設定のため、K1〜K5 の地域知識はトリガー②で落ちない
- **L-4**：`match` の表現力は §3 で固定した。表現できない知識は `matchApprox` 付きで元の層に置き、提出結果からは自動で動かさない
- **L-5**：`REEXAM_FILED`（未検証・承認済み→contested）を追加した
- **C-10（解決）**：在医総管の月でも処方箋料は別算定できる（report-A に合わせる。EM #7-6）。R05 は F400 を包括に含めない
- **L-6**：事実だけで判定できる加算のうち、R03・R14 以外の付け忘れ検出は持たない
- 時刻はすべて引数の `now` で受け取る。デモは時計を 2025-03 → 2025-06-01 に進めて K6 の降格を見せる
- Skill の frontmatter の規則（name の文字種など）は実装時に Claude Code のドキュメントで確認する

## 9. 承認が要る依存追加

| パッケージ | 用途 | 代替 | ライセンス |
|---|---|---|---|
| typescript | 型検査 | なし（TypeScript 固定） | Apache-2.0 |
| tsx | スクリプト実行 | `node --experimental-strip-types`（実験機能のため不採用） | MIT |
| vitest | テスト | `node:test`（TS の変換を別に用意する必要がある） | MIT |
