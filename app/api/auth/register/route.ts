// API Route：利用者の登録（招待制。spec FR-137）。招待コードがあれば、招待のクリニックとロールで登録する。
// 招待なしの登録（新しい 1 人クリニックを作る）は、環境変数 RESEMEN_OPEN_SIGNUP=1 で明示したときだけ。登録したらそのままログインする。
// 新しいクリニックを作るときは、種類（デモで試す／実在のデータで使う）を必ず選ぶ（選ばなければ断る。後から変えない）。招待で入るときは選ばない（招待したクリニックの種類になる）
import { openSignup, Throttle } from "../../../../src/server/auth";
import { UserError, badRequest, forbidden } from "../../../../src/server/errors";
import { route, sessionCookie } from "../../../../src/server/http";
import { getAuth } from "../../../../src/server/instance";
import { allow } from "../../../../src/server/policy";
import { registerBody } from "../../../../src/server/schemas/auth";

/** 同じ接続元からの登録の試みを 1 時間に 20 回までにする（機械的な大量登録と、招待コードの当て推量を遅らせる） */
const perIp = new Throttle(20, 3_600_000);

// 監査は auth.db の auth_events に残す（登録、招待の使用）
export const POST = route({ roles: allow("POST /api/auth/register"), body: registerBody, audit: false }, ({ body: b, ip }) => {
  const auth = getAuth();
  if (perIp.blocked(ip)) throw new UserError(429, "しばらくしてからもう一度試してください");
  perIp.hit(ip);
  const code = b.inviteCode?.trim();
  try {
    if (!code && !openSignup()) throw forbidden("登録には招待コードが必要です");
    if (code && b.kind) throw badRequest("招待コードで登録するときは、クリニックの種類を選びません（招待したクリニックの種類になります）", ["kind"]);
    if (!code && !b.kind) throw badRequest("「デモで試す」か「実在のデータで使う」かを選んでください", ["kind"]);
    const user = code ? auth.registerWithInvite(b.login, b.name, b.password, code) : auth.register(b.login, b.name, b.password, b.kind);
    auth.recordEvent({ event: "register", result: "ok", userId: user.id, tenantId: user.tenantId, ip });
    if (code) auth.recordEvent({ event: "invite.use", result: "ok", userId: user.id, tenantId: user.tenantId, ip });
    const s = auth.createSession(user.id);
    return Response.json({ user: { login: user.login, name: user.name }, kind: auth.tenantKind(user.tenantId) }, { headers: { "set-cookie": sessionCookie(s.token, s.expires) } });
  } catch (e) {
    if (e instanceof UserError) auth.recordEvent({ event: code ? "invite.use" : "register", result: e.status === 403 ? "denied" : "rejected", ip });
    throw e;
  }
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
