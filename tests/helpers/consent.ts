// ルートのテストで登録する利用者は、登録と同時に今の版の注意書きに同意したことにする（同意していない利用者の扱いは tests/server/consent.test.ts が確かめる）
import NOTICE from "../../config/notice.json";
import type { Auth, User } from "../../src/server/auth";

/** この auth で登録する利用者（招待での登録を含む）を、登録の直後に同意済みにする */
export function autoConsent(auth: Auth): void {
  const { register, registerWithInvite } = auth;
  const accept = (u: User): User => {
    auth.acceptNotice(u.id, NOTICE.version);
    return u;
  };
  auth.register = (...a) => accept(register(...a));
  auth.registerWithInvite = (...a) => accept(registerWithInvite(...a));
}
