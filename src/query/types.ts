// 医師確認（F1）と ask_missing（spec FR-30〜37、EM 19-2）の型

/** 臨床指標の引用（①）。カルテ・検査・処方のどこから取ったか */
export type ClinicalIndicator = { source: string; text: string };

export type QueryStatus = "未回答" | "回答済み" | "承認済み" | "保留";

export type DoctorQuery = {
  id: string;
  claimId: string;
  /** 何が足りないか（例: "SY:心房細動の病型"） */
  field: string;
  /** なぜ聞くか（医療事務向けの記録。医師への質問文には出さない） */
  why: string;
  question: string;
  indicators: ClinicalIndicator[];
  /** 選択肢。必ず「その他」「判定不能」を含む（③） */
  options: string[];
  /** 質問を作ったのはメンター（AI）か医療事務か。どちらも同じ基準で検証する（⑤） */
  createdBy: "mentor" | "clerk";
  createdAt: string;
  status: QueryStatus;
  answer: { option: string; freeText: string | null; answeredBy: string; at: string } | null;
  /** 医師の承認（確認ボタン）。承認者名と日時（FR-33） */
  approval: { approver: string; at: string } | null;
  /** 翌営業日のリマインド（⑦） */
  remindedAt: string | null;
  /** 3 営業日で保留（算定しない） */
  heldAt: string | null;
};

/** 医師の回答と承認で確定した傷病名（FR-32） */
export type ConfirmedDisease = { claimId: string; queryId: string; name: string; approver: string; at: string };

/** 医療事務への確認（F3）。宛先が医療事務のときの ask_missing */
export type ClerkTask = { id: string; claimId: string; field: string; why: string; createdAt: string };
