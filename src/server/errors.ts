// 利用者に起因する誤り（入力の誤り・権限なし・見つからない・業務上の拒否）。この文言だけを画面に返す。
// これ以外の例外は、共通のルートヘルパ（src/server/http.ts の route）が 500 と定型文にして、詳細はサーバーログに出す
export class UserError extends Error {
  /** HTTP ステータス（400 入力の誤り・401 未ログイン・403 権限なし・404 見つからない・409 いまの状態ではできない・413・415・429） */
  readonly status: number;
  /** 検証で落ちた項目名（あれば） */
  readonly fields?: string[];
  constructor(status: number, message: string, fields?: string[]) {
    super(message);
    this.name = "UserError";
    this.status = status;
    this.fields = fields;
  }
}

/** 注意書きへの同意を求めるときの定型の文言 */
export const CONSENT_MESSAGE = "この操作の前に、注意書きへの同意が必要です";
/**
 * 今の版の注意書きに同意していない利用者の操作（design.md §11-11）。共通のルートヘルパは 403 と、画面が同意を出すための印（consent: "required"）を返す。
 * ルートの申告で止めるとき（src/server/http.ts）と、外部へ送る直前に止めるとき（src/llm/outbound.ts）の両方が使う
 */
export class ConsentRequired extends UserError {
  constructor() {
    super(403, CONSENT_MESSAGE);
  }
}

export const badRequest = (message: string, fields?: string[]) => new UserError(400, message, fields);
export const forbidden = (message: string) => new UserError(403, message);
export const notFound = (message: string) => new UserError(404, message);
/** いまの状態ではできない操作（回答済みの質問にもう一度回答する、など） */
export const conflict = (message: string) => new UserError(409, message);
