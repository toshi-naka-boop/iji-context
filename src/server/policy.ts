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
 * ロールの配列＝そのロールだけ／{ roles, solo: true }＝そのロールに加えて、1 人で使っているクリニックの持ち主にも許す
 */
export type Rule = "public" | "dev" | Role[] | { roles: Role[]; solo: true };

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
  // 役割の切替（FR-144）：1 人で使っているクリニックの持ち主だけ。ロールでは許さない
  "POST /api/auth/role": row({ roles: [], solo: true }, "none", false),
  // 招待の発行・一覧・取り消し（FR-137）：事務長と、1 人で使っているクリニックの持ち主
  "GET /api/invites": row({ roles: ["manager"], solo: true }, "none", false),
  "POST /api/invites": row({ roles: ["manager"], solo: true }, "none", false),
  "POST /api/invites/[id]/revoke": row({ roles: ["manager"], solo: true }, "none", false),
  // 監査ログの閲覧（FR-140）
  "GET /api/audit": row(["manager"], "none", false),

  // 医師確認（FR-134）：回答と承認は医師だけ。一覧は、送った側（事務・ベテラン）も状態を見られる
  "GET /api/doctor": row(["clerk", "veteran", "doctor"], "none", true),
  "POST /api/doctor/[id]/answer": row(["doctor"], "none", true),
  "POST /api/doctor/[id]/approve": row(["doctor"], "none", true),

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
  "POST /api/chart/[id]": row(WORK, "none", true),
  // 確定したカルテの算定プレビュー（FR-101）。点数が出るので、算定の仕事をする人だけ
  "GET /api/chart/[id]/claim": row(WORK, "none", true),
  // 改定の比較（design.md §11-2）：同じ記録を 2 つの版で導出して並べる。読むだけ。全ロール
  "GET /api/revision/compare": row(ALL, "none", true),
  "POST /api/chart/image": row(WORK, "ai", true),
  "POST /api/chart/soap": row(WORK, "ai", true),
  "GET /api/patients": row(WORK, "none", true),
  "GET /api/patients/[claimId]/facts": row(WORK, "none", true),
  "POST /api/patients/[claimId]/facts": row(WORK, "none", true),
  // 請求ごとに確かめた事実（情報不足の項目への答え）。医師あての事実は医師の役割だけが残せるので、医師にも開ける（事実ごとの宛先はハンドラの中で分ける）
  "GET /api/claims/[claimId]/facts": row([...WORK, "doctor"], "none", true),
  "POST /api/claims/[claimId]/facts": row([...WORK, "doctor"], "none", true),
  // 患者情報チェック（FR-116〜123）：加入情報と指摘の取得、保険・公費の確認入力
  "GET /api/patients/[claimId]/profile": row(WORK, "none", true),
  "POST /api/patients/[claimId]/coverages": row(WORK, "none", true),
  // 一覧は、消す操作のために事務長にも見せる
  "GET /api/uke": row(["clerk", "veteran", "manager"], "none", true),
  "POST /api/uke": row(WORK, "none", true),
  // UKE のアップロード（FR-106〜109）と、見本の UKE のダウンロード
  "GET /api/uke/sample": row(WORK, "none", false),
  "POST /api/uke/upload": row(WORK, "none", true),
  // 取り込んだレセプトを、UKE に書いてあるとおりのまま点検した結果（design.md §11-11）。一覧と同じ役割
  "GET /api/uke/claims/[claimId]/check": row(["clerk", "veteran", "manager"], "none", true),
  // 取り込んだファイルを消す（design.md §11-11）。事務長とベテラン。消す操作は同意を条件にしない（同意していない人も、データを消せる）
  "DELETE /api/uke/uploads/[sha256]": row(["veteran", "manager"], "none", false),

  // 知識：閲覧・投稿・共感は全員。検証（action=verify）はベテランだけ（ハンドラの中で分ける）。
  // 知識の閲覧には同意のゲートも置かない（CLAUDE.md 固定条件「可視性にゲートを置かない」）
  "GET /api/knowledge": row(ALL, "none", false),
  "POST /api/knowledge": row(ALL, "none", false),
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
  // 時計を進めるのは開発用（本番では 404）。進めると会議の整理と医師確認の期限がクリニック全体で動くため、利用者の操作にしない
  "POST /api/clock": row("dev", "none", false),
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
  return rule.roles.includes(user.role) || solo();
}

/** 断るときに画面に出す、許しているロールの一覧 */
export const rolesOf = (rule: Rule): Role[] => (rule === "public" || rule === "dev" ? ALL : Array.isArray(rule) ? rule : rule.roles);
