// 権限表（spec FR-133）：どのルート（メソッドとパス）を、どのロールに許すか。1 つの表で持つ。
// app/api/**/route.ts の全ルート・全メソッドがここに載っていることを、tests/server/policy.test.ts が縛る。
// ルートを足すときは、ここに 1 行足してから、ルートで `roles: allow("POST /api/…")` と書く（docs/route-migration.md）。
// 行は、許すロールに加えて、同意が要るかを決める 2 つの申告（external・patientData）を必ず持つ（design.md §11-11。既定値はない）。
import type { User } from "./auth";
import type { Role } from "./roles";

/** 算定の仕事をする人（事務・ベテラン） */
const WORK: Role[] = ["clerk", "veteran"];
const ALL: Role[] = ["clerk", "veteran", "manager", "doctor"];

/**
 * public＝ログインなしで呼べる（ログイン・登録・ログアウト）／dev＝開発用（本番では 404。本番でなくてもログインが要る。ロールは問わない）／
 * ロールの配列＝そのロールだけ／{ roles, solo: true }＝そのロールに加えて、1 人で使っているクリニックの持ち主にも許す／
 * { roles, dev: true }＝そのロールに加えて、本番でなければ（開発では）どのロールにも許す（本番でも 404 にしない）
 */
export type Rule = "public" | "dev" | Role[] | { roles: Role[]; solo: true } | { roles: Role[]; dev: true };

/** その処理が外部のサービスに送るか：ai＝AI のサービス（Anthropic）／voice＝音声のサービス（ElevenLabs）／none＝送らない */
export type External = "ai" | "voice" | "none";
/**
 * 権限表の 1 行。external と patientData は、ルートごとに必ず書く（既定値はない。tests/server/policy.test.ts が縛る）。
 * patientData＝利用者が入れた患者の情報（カルテ・UKE・通知・患者情報・医師やベテランへの問い）を受け取る・保存する・返すか。
 * external が none でないか、patientData が真の行は、今の版の注意書きに同意していない利用者には 403（src/server/http.ts の route）
 */
export type Row = { rule: Rule; external: External; patientData: boolean };
const row = (rule: Rule, external: External, patientData: boolean): Row => ({ rule, external, patientData });

export const POLICY = {
  // ログイン・登録
  "POST /api/auth/login": row("public", "none", false),
  "POST /api/auth/register": row("public", "none", false),
  "POST /api/auth/logout": row("public", "none", false),
  // 注意書きへの同意（design.md §11-11）。本人だけ（誰の同意かはセッションで決める）
  "POST /api/consent": row(ALL, "none", false),
  "GET /api/auth/me": row(ALL, "none", false),
  // 未定のクリニックの使い方（demo／real）を一度だけ選ぶ（2026-11-22 利用者の判断）：事務長と、1 人で使っているクリニックの持ち主
  "POST /api/tenant/kind": row({ roles: ["manager"], solo: true }, "none", false),
  // 役割の切替（FR-144）：1 人で使っているクリニックの持ち主だけ。ロールでは許さない
  "POST /api/auth/role": row({ roles: [], solo: true }, "none", false),
  // 招待の発行・一覧・取り消し（FR-137）：事務長と、1 人で使っているクリニックの持ち主
  "GET /api/invites": row({ roles: ["manager"], solo: true }, "none", false),
  "POST /api/invites": row({ roles: ["manager"], solo: true }, "none", false),
  "POST /api/invites/[id]/revoke": row({ roles: ["manager"], solo: true }, "none", false),
  // 監査ログの閲覧（FR-140）
  "GET /api/audit": row(["manager"], "none", false),
  // マスターの状態（design.md §12-5）：入っている公開データと点検の準備。事務長だけ。患者の情報は返さない
  "GET /api/masters": row(["manager"], "none", false),
  // 施設の設定（FR-148）：三値の項目を、クリニックごとに残す・読む。事務長だけ。監査ログには項目の名前だけ（値は入れない）
  "GET /api/facility": row(["manager", "veteran"], "none", false),
  "POST /api/facility": row(["manager", "veteran"], "none", false),
  // 施設の申告（design.md §15-9）：読むのはどのロールも（指摘の根拠を見られるように）、残すのは事務長と責任者
  "GET /api/facility/declaration": row(ALL, "none", false),
  "POST /api/facility/declaration": row(["manager", "veteran"], "none", false),
  // 届け出た酸素の単価（design.md §19-8）：入れられる役割は施設の申告と同じ
  "GET /api/facility/oxygen-prices": row(ALL, "none", false),
  "POST /api/facility/oxygen-prices": row(["manager", "veteran"], "none", false),
  "GET /api/facility/declaration/history": row(ALL, "none", false),
  // まとめて「変わりなし」（design.md §15-2）：残すのは事務長と責任者。初期の選択を読むのも同じ
  "GET /api/facility/declaration/confirm": row(["manager", "veteran"], "none", false),
  "POST /api/facility/declaration/confirm": row(["manager", "veteran"], "none", false),
  // 注14 の計算の道具（design.md §15-13・§15-9 の権限表。round-61 C-370）：読むのはどのロールも、結果を残す・下書きを開くのは事務長と責任者（申告と同じ）。
  // 応答・記録は集計の数と出どころだけ（患者の氏名・番号・鍵を返さない）なので patientData は偽
  "GET /api/note14": row(ALL, "none", false),
  "POST /api/note14/worksheets": row(["manager", "veteran"], "none", false),
  "GET /api/note14/worksheets/[id]/draft": row(["manager", "veteran"], "none", false),

  // 医師確認（FR-134）：回答と承認は医師だけ。一覧は、送った側（事務・ベテラン）も状態を見られる
  "GET /api/doctor": row(["clerk", "veteran", "doctor"], "none", true),
  "POST /api/doctor/[id]/answer": row(["doctor"], "none", true),
  "POST /api/doctor/[id]/approve": row(["doctor"], "none", true),
  // 医師に確かめてほしい項目（医師あての情報不足）の一覧と、決められなかった答え（その他・判定不能）の記録。医師の役割だけ
  "GET /api/doctor/facts": row(["doctor"], "none", true),
  "POST /api/doctor/facts": row(["doctor"], "none", true),
  // 略語の医師への確認（FR-211）：問いの一覧と答え。医師だけ。引用（カルテの文）を返し、答えを受け取るので patientData は真
  "GET /api/doctor/abbrevs": row(["doctor"], "none", true),
  "POST /api/doctor/abbrevs": row(["doctor"], "none", true),

  // 算定・練習問題
  "POST /api/questions": row(WORK, "none", true),
  "GET /api/questions/[id]": row(WORK, "none", true),
  "POST /api/questions/[id]/ask-doctor": row(WORK, "none", true),
  "GET /api/questions/[id]/case": row(WORK, "none", true),
  "GET /api/questions/[id]/choices": row(WORK, "none", true),
  "POST /api/questions/[id]/choices": row(WORK, "none", true),
  "POST /api/questions/[id]/confirm": row(WORK, "none", true),
  "POST /api/questions/[id]/done": row(WORK, "none", true),
  "POST /api/questions/[id]/draft": row(WORK, "none", true),
  "GET /api/questions/[id]/drill": row(WORK, "none", true),
  "POST /api/questions/[id]/explain": row(WORK, "none", true),
  "POST /api/questions/[id]/local-rules": row(WORK, "none", true),
  "GET /api/cases": row(WORK, "none", true),
  "GET /api/drills": row(WORK, "none", false),
  "GET /api/visits": row(WORK, "none", true),
  "GET /api/crosscheck": row(WORK, "none", true),
  "POST /api/crosscheck": row(WORK, "none", true),
  "POST /api/mentor": row(WORK, "ai", true),
  "POST /api/proxy": row(WORK, "ai", true),
  "POST /api/results": row(WORK, "none", true),

  // カルテ・患者情報・UKE
  "POST /api/chart": row(WORK, "ai", true),
  // 訪問カルテの一覧（消す相手を選ぶため）。消せる人と同じ役割。見えるのは、事務長には全部、ほかの人には自分が書いた分（src/server/app/notes.ts の listNotes）。本文は返さない
  "GET /api/chart": row(["clerk", "veteran", "manager"], "none", true),
  "POST /api/chart/[id]": row(WORK, "none", true),
  // 事実と行ったことを、確かめた 1 回の操作で保存する（design.md §15-6）。カルテの保存と同じ
  "POST /api/chart/acts": row(WORK, "none", true),
  // どの記載にも結び付かない略語の扱い（FR-211。規則の作り直し 4）：カルテを確かめる人（事務・ベテラン）が選ぶ。語はカルテの文から拾うので patientData は真
  "GET /api/chart/abbrev-choices": row(WORK, "none", true),
  // 確定の前に、残した記載で略語の印を判定し直す（FR-211。round-99 C-651。保存しない）
  "POST /api/chart/abbrev-check": row(WORK, "none", true),
  "POST /api/chart/abbrev-choices": row(WORK, "none", true),
  // 行ったことの候補（design.md §15-7）。読むだけ。書かれた名前（カルテの語）を受け取るので、患者の情報として扱う
  "GET /api/chart/acts/candidates": row(WORK, "none", true),
  // カルテの構造化データ（design.md §16-7。段 19a）。読むだけ。今のカルテの読み出しと同じ役割で、患者の情報として扱う（実在のデータは同意のあとだけ）
  "GET /api/chart/structured": row(WORK, "none", true),
  // 当てられない行為に電子カルテの行為と「同じ／違う」をあとから付ける（design.md §16-7）。当てられない行為を選んで当てる入口（POST /api/chart/acts）と同じ
  "POST /api/chart/acts/fold": row(WORK, "none", true),
  // 処方の日の院内・院外と「確かめた」の印をあとから付け直す（design.md §16-7。C-421）。権限は POST /api/chart/acts/fold と同じ
  "POST /api/chart/acts/rx-confirm": row(WORK, "none", true),
  // 確かめたあとで印・「同じ／違う」を付け直す一覧（design.md §16-7。C-441）。権限は付け直す入口と同じ
  "GET /api/chart/acts/fixes": row(WORK, "none", true),
  // 医療事務が入れる訪問の時刻（design.md §16-6・16-7）。カルテを確かめられる人。値はログ・監査ログに出さない
  "POST /api/chart/structured/visit-time": row(WORK, "none", true),
  // 独自コードの対応表（design.md §16-7）。事務長・医療事務。返すのは接続先・欄・独自コード・表示名・件数で、患者・日は持たない
  "GET /api/code-maps": row(["clerk", "veteran", "manager"], "none", false),
  "POST /api/code-maps": row(["clerk", "veteran", "manager"], "none", false),
  // 基本マスターを名前で探す（design.md §15-7）。読むだけ。返すのは公開データの表・コード・名称だけ
  "GET /api/masters/search": row(WORK, "none", false),
  // 訪問カルテを消す（design.md §11-11）。書いた本人と事務長（本人かどうかは src/server/app/notes.ts の deleteNote が照合する）。消す操作は同意を条件にしない
  "DELETE /api/chart/[id]": row(["clerk", "veteran", "manager"], "none", false),
  // 確定したカルテの算定プレビュー（FR-101）。点数が出るので、算定の仕事をする人だけ
  "GET /api/chart/[id]/claim": row(WORK, "none", true),
  // 算定プレビューの「入力が要る」摘要欄の記載に値を入れる（FR-176）。プレビューと同じ役割。値は自由記載で患者の情報になり得る
  "POST /api/chart/[id]/comments": row(WORK, "none", true),
  // 改定の比較（design.md §11-2）：同じ記録を 2 つの版で導出して並べる。読むだけ。全ロール
  "GET /api/revision/compare": row(ALL, "none", true),
  "POST /api/chart/image": row(WORK, "ai", true),
  "POST /api/chart/soap": row(WORK, "ai", true),
  "GET /api/patients": row(WORK, "none", true),
  "GET /api/patients/[claimId]/facts": row(WORK, "none", true),
  // 患者ごとの事実。医師の役割は、医師あての項目（別表第七など）だけを残せる（項目ごとの宛先は処理の中で分ける。src/server/app/patients.ts）
  "POST /api/patients/[claimId]/facts": row([...WORK, "doctor"], "none", true),
  // 請求ごとに確かめた事実（情報不足の項目への答え）。医師あての事実は医師の役割だけが残せるので、医師にも開ける（事実ごとの宛先はハンドラの中で分ける）
  "GET /api/claims/[claimId]/facts": row([...WORK, "doctor"], "none", true),
  "POST /api/claims/[claimId]/facts": row([...WORK, "doctor"], "none", true),
  // 「この請求のこの組が返戻・査定された」（design.md §14-4）。権限は事実の入力と同じ（医療事務あての入力なので、医師の役割はハンドラが 403）
  "POST /api/claims/[claimId]/local-return": row([...WORK, "doctor"], "none", true),
  // 患者情報チェック（FR-116〜123）：加入情報と指摘の取得、保険・公費の確認入力
  "GET /api/patients/[claimId]/profile": row(WORK, "none", true),
  "POST /api/patients/[claimId]/coverages": row(WORK, "none", true),
  // 患者の在宅療養の機器と変える案（design.md §16-7。段 19e）。患者の情報を残せる人と同じ。監査ログは種類の鍵だけ
  "GET /api/patient/devices": row(WORK, "none", true),
  "POST /api/patient/devices": row(WORK, "none", true),
  "POST /api/patient/device-proposals/[id]": row(WORK, "none", true),
  // 介護保険・ほかの医療機関との調整の申告と、入所先の施設（design.md §18-2・§18-5。v37）。入れるのは医療事務・ベテラン、事務長は見るだけ
  "GET /api/patients/[claimId]/care": row([...WORK, "manager"], "none", true),
  "POST /api/patients/[claimId]/care": row(WORK, "none", true),
  "POST /api/patients/[claimId]/others": row(WORK, "none", true),
  "POST /api/patients/[claimId]/others-none": row(WORK, "none", true),
  "GET /api/care-homes": row([...WORK, "manager"], "none", false),
  // 聞き取りの画面（design.md §18-5）：確かめる患者と問いの一覧。見るのは医療事務・ベテラン・事務長
  "GET /api/uke/care-check": row([...WORK, "manager"], "none", true),
  "POST /api/care-homes": row(WORK, "none", false),
  // 一覧は、消す操作のために事務長にも見せる
  "GET /api/uke": row(["clerk", "veteran", "manager"], "none", true),
  "POST /api/uke": row(WORK, "none", true),
  // UKE のアップロード（FR-106〜109）と、見本の UKE のダウンロード
  "GET /api/uke/sample": row(WORK, "none", false),
  "POST /api/uke/upload": row(WORK, "none", true),
  // 取り込んだレセプトを、UKE に書いてあるとおりのまま点検した結果（design.md §11-11）。一覧と同じ役割
  "GET /api/uke/claims/[claimId]/check": row(["clerk", "veteran", "manager"], "none", true),
  // 取り込んだレセプトの試算（design.md §11-12）：版を選んで、その場で計算して返す。保存しない。点検と同じ役割
  "GET /api/uke/claims/[claimId]/trial": row(["clerk", "veteran", "manager"], "none", true),
  // 「この請求の点検を確かめた」（design.md §14-3・段 17g）：実在用のクリニックで F10 の処理件数に数える。点検を見られる役割と同じ（役割では分けない。C-184）
  "POST /api/uke/claims/[claimId]/reviewed": row(["clerk", "veteran", "manager"], "none", true),
  // 取り込んだ請求にカルテの文を貼る（design.md §15-9。段 18c）。カルテの保存と同じ（AI が行ったことを取り出す）
  "POST /api/uke/claims/[claimId]/notes": row(WORK, "ai", true),
  // 取り込んだファイルを消す（design.md §11-11）。事務長とベテラン。消す操作は同意を条件にしない（同意していない人も、データを消せる）
  "DELETE /api/uke/uploads/[sha256]": row(["veteran", "manager"], "none", false),

  // 査定・返戻の突き合わせ（spec FR-202 の I-1）：事務長とベテランだけ。取り込んだ明細は氏名・番号を含むので患者の情報。AI は使わない。
  // 報告は件数だけ（氏名・番号・請求 id を返さない）。消す操作は同意を条件にしない（UKE を消すのと同じ）
  "GET /api/review": row(["veteran", "manager"], "none", true),
  "POST /api/review/upload": row(["veteran", "manager"], "none", true),
  "GET /api/review/items/[id]": row(["veteran", "manager"], "none", true),
  "POST /api/review/items/[id]": row(["veteran", "manager"], "none", true),
  "POST /api/review/uploads/[sha256]/rematch": row(["veteran", "manager"], "none", true),
  "DELETE /api/review/uploads/[sha256]": row(["veteran", "manager"], "none", false),
  "GET /api/review/report": row(["veteran", "manager"], "none", false),

  // 知識：閲覧・投稿・共感は全員。検証（action=verify）はベテランだけ（ハンドラの中で分ける）。
  // 知識の閲覧には同意のゲートも置かない（CLAUDE.md 固定条件「可視性にゲートを置かない」）
  "GET /api/knowledge": row(ALL, "none", false),
  "POST /api/knowledge": row(ALL, "none", false),
  // 背反の組の院内の知識を作る（design.md §14-2）。取り込んだ請求を読んで G05 を計算し直すので、請求の事実の入力と同じ役割（医療事務あて）で、同意が要る（round-43 C-201）
  "POST /api/knowledge/pair": row(WORK, "none", true),
  // 公的文書の条件に当たるかを確かめる（design.md §11-3）：「当たる」は全員（絞るときはこの行を変える）。「当たらない」は ④ を黙らせられるので責任者だけ
  "POST /api/knowledge/[id]/official-check/applies": row(ALL, "none", false),
  "POST /api/knowledge/[id]/official-check/not-applies": row(["veteran"], "none", false),
  "GET /api/peer": row(ALL, "none", true),
  "POST /api/peer/[id]/answer": row(["veteran"], "none", true),
  // レセメン会議：回答はベテラン。議題は事務長も見られる
  "GET /api/meeting": row(["veteran", "manager"], "none", true),
  "POST /api/meeting": row(["veteran"], "none", true),
  "POST /api/meeting/answer": row(["veteran"], "none", true),
  "POST /api/notice": row(["veteran"], "ai", true),
  "POST /api/notice/register": row(["veteran"], "none", true),

  // 本人のこと・画面の共通部分（どのロールの画面でも呼ぶ）
  "GET /api/me": row(ALL, "none", false),
  "GET /api/character": row(ALL, "none", false),
  "POST /api/character": row(ALL, "none", false),
  "POST /api/clerk/name": row(ALL, "none", false),
  "GET /api/clock": row(ALL, "none", false),
  // 時計を進める：デモのクリニックの事務長（公開版でも）と、開発ではどのロールでも。進めると会議の整理と医師確認の期限がクリニック全体で動くため、事務長に絞る。
  // 実在のデータで使うクリニックでは、どのロールでも断る（ハンドラの中。src/server/app/clock.ts の advanceClock）
  "POST /api/clock": row({ roles: ["manager"], dev: true }, "none", false),
  "GET /api/master": row(ALL, "none", false),
  // 声で答えた名前の聞き取り。音声のサービスに送り、漢字が混じっていれば AI のサービスにも送る（読みをひらがなにする）。申告は 1 つなので voice と書く
  "POST /api/voice/listen": row(ALL, "voice", false),
  "POST /api/voice/speak": row(ALL, "voice", false),
  "GET /api/manager": row(["manager"], "none", false),

  // 開発用（本番では 404。本番でなくてもログインが要る）
  "GET /api/eval": row("dev", "ai", false),
  "GET /api/mentor-check": row("dev", "ai", false),
  "GET /api/sdk-check": row("dev", "ai", false),
} as const satisfies Record<string, Row>;

export type PolicyKey = keyof typeof POLICY;

/**
 * 使い方が未定のクリニックでも通す操作（ログインしている人の、選ぶ・待つための操作だけ）。ほかは src/server/http.ts の route が 409 で断る。
 * 点検などの操作は、使い方が決まるまでさせない（2026-11-22 利用者の判断）
 */
export const UNDECIDED_ALLOWED: ReadonlySet<PolicyKey> = new Set<PolicyKey>(["GET /api/auth/me", "POST /api/auth/role", "POST /api/consent", "GET /api/clock", "POST /api/tenant/kind"]);
/** ルートヘルパに渡す形（表のキーと、その行） */
export type Allowed = { key: PolicyKey } & Row;

/** 権限表の行を引く。表にないキーは型で弾かれ、実行時にも例外にする（表にないルートは動かさない） */
export function allow(key: PolicyKey): Allowed {
  const r = (POLICY as Record<string, Row>)[key];
  if (!r) throw new Error(`権限表にないルート: ${key}`);
  return { key, ...r };
}

/** この利用者に許すか。solo は「1 人で使っているクリニックの持ち主か」（src/server/auth.ts の isSolo） */
export function permits(rule: Rule, user: Pick<User, "role">, solo: () => boolean): boolean {
  if (rule === "public" || rule === "dev") return true;
  if (Array.isArray(rule)) return rule.includes(user.role);
  if ("dev" in rule) return rule.roles.includes(user.role) || process.env.NODE_ENV !== "production";
  return rule.roles.includes(user.role) || solo();
}

/** 断るときに画面に出す、許しているロールの一覧 */
export const rolesOf = (rule: Rule): Role[] => (rule === "public" || rule === "dev" ? ALL : Array.isArray(rule) ? rule : rule.roles);
