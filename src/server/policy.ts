// 権限表（spec FR-133）：どのルート（メソッドとパス）を、どのロールに許すか。1 つの表で持つ。
// app/api/**/route.ts の全ルート・全メソッドがここに載っていることを、tests/server/policy.test.ts が縛る。
// ルートを足すときは、ここに 1 行足してから、ルートで `roles: allow("POST /api/…")` と書く（docs/route-migration.md）。
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

export const POLICY = {
  // ログイン・登録
  "POST /api/auth/login": "public",
  "POST /api/auth/register": "public",
  "POST /api/auth/logout": "public",
  "GET /api/auth/me": ALL,
  // 役割の切替（FR-144）：1 人で使っているクリニックの持ち主だけ。ロールでは許さない
  "POST /api/auth/role": { roles: [], solo: true },
  // 招待の発行・一覧・取り消し（FR-137）：事務長と、1 人で使っているクリニックの持ち主
  "GET /api/invites": { roles: ["manager"], solo: true },
  "POST /api/invites": { roles: ["manager"], solo: true },
  "POST /api/invites/[id]/revoke": { roles: ["manager"], solo: true },
  // 監査ログの閲覧（FR-140）
  "GET /api/audit": ["manager"],

  // 医師確認（FR-134）：回答と承認は医師だけ。一覧は、送った側（事務・ベテラン）も状態を見られる
  "GET /api/doctor": ["clerk", "veteran", "doctor"],
  "POST /api/doctor/[id]/answer": ["doctor"],
  "POST /api/doctor/[id]/approve": ["doctor"],

  // 算定・練習問題
  "POST /api/questions": WORK,
  "GET /api/questions/[id]": WORK,
  "POST /api/questions/[id]/ask-doctor": WORK,
  "GET /api/questions/[id]/case": WORK,
  "GET /api/questions/[id]/choices": WORK,
  "POST /api/questions/[id]/choices": WORK,
  "POST /api/questions/[id]/confirm": WORK,
  "POST /api/questions/[id]/done": WORK,
  "POST /api/questions/[id]/draft": WORK,
  "GET /api/questions/[id]/drill": WORK,
  "POST /api/questions/[id]/explain": WORK,
  "POST /api/questions/[id]/local-rules": WORK,
  "GET /api/cases": WORK,
  "GET /api/drills": WORK,
  "GET /api/visits": WORK,
  "GET /api/crosscheck": WORK,
  "POST /api/crosscheck": WORK,
  "POST /api/mentor": WORK,
  "POST /api/proxy": WORK,
  "POST /api/results": WORK,

  // カルテ・患者情報・UKE
  "POST /api/chart": WORK,
  "POST /api/chart/[id]": WORK,
  // 確定したカルテの算定プレビュー（FR-101）。点数が出るので、算定の仕事をする人だけ
  "GET /api/chart/[id]/claim": WORK,
  "POST /api/chart/image": WORK,
  "POST /api/chart/soap": WORK,
  "GET /api/patients": WORK,
  "GET /api/patients/[claimId]/facts": WORK,
  "POST /api/patients/[claimId]/facts": WORK,
  // 患者情報チェック（FR-116〜123）：加入情報と指摘の取得、保険・公費の確認入力
  "GET /api/patients/[claimId]/profile": WORK,
  "POST /api/patients/[claimId]/coverages": WORK,
  "GET /api/uke": WORK,
  "POST /api/uke": WORK,
  // UKE のアップロード（FR-106〜109）と、見本の UKE のダウンロード
  "GET /api/uke/sample": WORK,
  "POST /api/uke/upload": WORK,

  // 知識：閲覧・投稿・共感は全員。検証（action=verify）はベテランだけ（ハンドラの中で分ける）
  "GET /api/knowledge": ALL,
  "POST /api/knowledge": ALL,
  "GET /api/peer": ALL,
  "POST /api/peer/[id]/answer": ["veteran"],
  // レセメン会議：回答はベテラン。議題は事務長も見られる
  "GET /api/meeting": ["veteran", "manager"],
  "POST /api/meeting": ["veteran"],
  "POST /api/meeting/answer": ["veteran"],
  "POST /api/notice": ["veteran"],
  "POST /api/notice/register": ["veteran"],

  // 本人のこと・画面の共通部分（どのロールの画面でも呼ぶ）
  "GET /api/me": ALL,
  "GET /api/character": ALL,
  "POST /api/character": ALL,
  "POST /api/clerk/name": ALL,
  "GET /api/clock": ALL,
  // 時計を進めるのは開発用（本番では 404）。進めると会議の整理と医師確認の期限がクリニック全体で動くため、利用者の操作にしない
  "POST /api/clock": "dev",
  "GET /api/master": ALL,
  "POST /api/voice/listen": ALL,
  "POST /api/voice/speak": ALL,
  "GET /api/manager": ["manager"],

  // 開発用（本番では 404。本番でなくてもログインが要る）
  "GET /api/eval": "dev",
  "GET /api/mentor-check": "dev",
  "GET /api/sdk-check": "dev",
} as const satisfies Record<string, Rule>;

export type PolicyKey = keyof typeof POLICY;
/** ルートヘルパに渡す形（表のキーと、その行） */
export type Allowed = { key: PolicyKey; rule: Rule };

/** 権限表の行を引く。表にないキーは型で弾かれ、実行時にも例外にする（表にないルートは動かさない） */
export function allow(key: PolicyKey): Allowed {
  const rule = (POLICY as Record<string, Rule>)[key];
  if (!rule) throw new Error(`権限表にないルート: ${key}`);
  return { key, rule };
}

/** この利用者に許すか。solo は「1 人で使っているクリニックの持ち主か」（src/server/auth.ts の isSolo） */
export function permits(rule: Rule, user: Pick<User, "role">, solo: () => boolean): boolean {
  if (rule === "public" || rule === "dev") return true;
  if (Array.isArray(rule)) return rule.includes(user.role);
  return rule.roles.includes(user.role) || solo();
}

/** 断るときに画面に出す、許しているロールの一覧 */
export const rolesOf = (rule: Rule): Role[] => (rule === "public" || rule === "dev" ? ALL : Array.isArray(rule) ? rule : rule.roles);
