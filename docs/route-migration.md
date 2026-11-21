# 新しい API ルートを足すときの手順

API ルート（`app/api/**/route.ts`）は、共通ルートヘルパ `route()`（`src/server/http.ts`）で書く。
`route()` が、ログイン → params の検証 → ロール → 注意書きへの同意 → 回数制限 → query・本文の検証 → 処理 → 監査ログ、の順に面倒を見る。

## 1. 権限表に 1 行足す

`src/server/policy.ts` の `POLICY` に「メソッド パス」の行を足す（例 `"POST /api/knowledge": row(ALL, "none", false)`）。

`row(許す相手, external, patientData)` の 3 つは省けない：
- `external`：その処理が外部のサービスに送るか（`"ai"`・`"voice"`・`"none"`）
- `patientData`：利用者が入れた患者の情報を受け取る・保存する・返すか
- どちらかに当たる行は、今の版の注意書きに同意していない利用者には 403（`route()` が確かめる）。迷ったら掛ける側に倒す
- 外部へ送る処理は `src/llm/outbound.ts`（AI）と `src/voice/`（音声）の関数だけを使い、ハンドラが受け取った `user` をそのまま渡す（`docs/security.md`）

許す相手の書き方：

- ロールの配列：そのロールだけ／`{ roles, solo: true }`：1 人で使っているクリニックの持ち主にも許す
- `"public"`：ログインなし（ログイン・登録だけ）／`"dev"`：開発用（本番では 404。本番でなくてもログインが要る。ロールは問わない）
- 1 つのルートの中で操作ごとにロールが違うとき（知識の検証など）は、行は広いほうにして、処理の中で `forbidden()` を投げる

行を足さずにルートだけ足すと `tests/server/policy.test.ts` が落ちる（全ルート・全メソッドが表に載っていること、`allow()` のキーが自分のパスと合っていることを確かめている）。

## 2. スキーマを書く

置き場所は `src/server/schemas/<領域>.ts`（knowledge・meeting・peer・clerk など）。名前は `<対象>Body`・`<対象>Params`・`<対象>Query`。

- オブジェクトは `z.strictObject`（知らない項目は 400）。文字列は長さの上限、配列は件数の上限を必ず付ける
- id は形を固定する（`common.ts` の `id`。ファイル名やディレクトリ名になる id は、作る側のコードの形に合わせた正規表現にする）
- `action` で分かれる本文は `z.discriminatedUnion("action", […])` で、操作ごとに形を固定する
- 本人の id、承認者・回答者の名前は受け取らない。`user`・`clerkId`（セッションの本人）から決める
- 細かい業務の規則と文言（名前に使える文字など）は業務処理に置き、スキーマは型と上限だけにする

## 3. ルートを書く

```ts
import { route } from "../../../src/server/http";
import { getApp } from "../../../src/server/instance";
import { allow } from "../../../src/server/policy";
import { meetingAnswerBody } from "../../../src/server/schemas/meeting";

export const POST = route({ roles: allow("POST /api/meeting/answer"), body: meetingAnswerBody, audit: { target: ({ body }) => body.itemId } }, ({ body }) =>
  getApp().answerAgenda(body.itemId, body.answer, body.freeText),
);
```

- 処理に渡るのは `{ body, params, query, user, viewer, clerkId, form, ip, req }`。返した値は JSON になる（`Response` はそのまま返る）
- スキーマを渡さなかった本文・query は読まれない。`[id]` のあるパスは `params` のスキーマを必ず渡す
- 本文の上限は既定で `config/limits.json` の `jsonBytes`。大きい本文（base64 の PDF など）は `maxBytes`、multipart は `form: { maxBytes }`
- 処理は薄くして、中身は `src/server/app/` に置く

## 4. エラーの使い分け（`src/server/errors.ts`）

利用者に文言を見せてよい誤りだけ `UserError` で投げる。それ以外の例外は 500 と定型文になり、詳細はサーバーログにだけ出る。

| 関数 | ステータス | 使うとき |
|---|---|---|
| `badRequest(msg)` | 400 | 入力の中身の誤り（空の回答、PDF ではない） |
| `forbidden(msg)` | 403 | ロールが足りない |
| `notFound(msg)` | 404 | 対象がない（ほかの人のものも「ない」として扱う） |
| `conflict(msg)` | 409 | いまの状態ではできない（回答済みへの回答、検証済みの知識の検証） |

業務処理の奥（`src/lifecycle/` など）が素の `Error` を投げる場合、その文言は画面に出ない。利用者が起こせる誤りなら、`UserError` に変えるか、手前（`src/server/app/`）で確かめて同じ文言で投げる。プログラムの誤り（起きてはならない状態）は `Error` のままにする。

## 5. 回数制限

LLM を呼ぶルートは `limit: "llm"`、音声は `limit: "voice"`。利用者ごとの 1 分あたりと 1 日の上限で、値は `config/limits.json`。
失敗した呼び出しも 1 回と数える。LLM を呼ばないルートには付けない。

## 6. 監査ログ

GET 以外は `route()` が 1 行残す（誰が・どの操作を・どの対象に・結果）。操作の名前は権限表のキー、対象は既定で params の `id`。

- 入れてよいもの：対象の id（知識の id・議題の項目の id・問題の id・キャラの id）、ロール名のような決まった値
- 入れてはいけないもの：本文（カルテ・回答・提案・却下の理由・メンターへの発言）、氏名、ファイル名、秘密の値
- 対象が本文にあるときは `audit: { target: ({ body }) => body.itemId }`。ロールで断ったとき・検証で落ちたときは本文を読んでいないので、対象は空になる
- `audit: false` にするのは、別の場所に記録するルート（ログインなど）と、何も書き換えない読み取り相当の POST（当てはまるローカルルール）だけ

## 7. テストを書く

`tests/server/authz.test.ts`・`tests/server/routes-knowledge.test.ts` と同じ形で、ルートの `GET`/`POST` を `Request` で直接呼ぶ。

- `RESEMEN_DATA` を一時ディレクトリにしてから `src/server/instance` を import する。利用者は `getAuth().register()`、cookie は `createSession()` で作る
- ロールは `/api/auth/role` で切り替える（1 人で使っているクリニックの持ち主は切り替えられる）
- 確かめること：未ログインは 401／スキーマ違反は 400 と `fields`（項目名）／許していないロールは 403／パスの区切りを含む id は 400／
  記録される本人がセッションの利用者であること／監査ログに 1 行残り、本文が入っていないこと
- LLM・音声は実際に呼ばない（呼ぶ前に断られる入力で確かめるか、業務処理の関数を直接試す）
- 最後に `npm run typecheck` と `npx vitest run tests/server` を通す
