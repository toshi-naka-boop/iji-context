// 医師確認の画面の文言（spec FR-211。plan-fr211.md「医師確認の画面の文言」）：文は config の 1 か所で持ち、医師確認の一覧の上の別の欄に出す。
// 個々の問いの文には入れず、validateQuery（7 要件）は今のまま通る。辞書で意味が複数ある略語の問いには、問いの下に事実だけを添える
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import DOCTOR_ABBREV from "../../config/doctor-abbrev.json";
import { AbbrevQuestionBody, DoctorAbbrevNotice } from "../../app/doctor/abbrev-requests";
import { BANNED_WORDS } from "../../scripts/check-banned-words";
import { ABBREV_OPTIONS, abbrevQuestion, abbrevQueryErrors } from "../../src/server/app/doctor-abbrevs";
import { claimId, day, YM } from "../helpers/period";

const NOTICE = "健全な経営は健全なカルテから（多数解釈のできる略語などは控えましょう）";

describe("医師確認の画面の文言", () => {
  it("config に計画の文がそのまま 1 か所にあり、禁止語を含まない", () => {
    expect(DOCTOR_ABBREV.notice).toBe(NOTICE);
    expect(DOCTOR_ABBREV.multiMeaning).toBe("この略語は辞書で複数の意味があります");
    for (const w of BANNED_WORDS) expect(JSON.stringify(DOCTOR_ABBREV)).not.toContain(w);
  });
  it("文は一覧の上の別の欄に出る（医師確認の画面で、確かめてほしい項目より前）", () => {
    expect(renderToString(createElement(DoctorAbbrevNotice))).toContain(NOTICE);
    const page = readFileSync(path.join(__dirname, "..", "..", "app", "doctor", "page.tsx"), "utf8");
    expect(page.indexOf("<DoctorAbbrevNotice />")).toBeGreaterThan(0);
    expect(page.indexOf("<DoctorAbbrevNotice />")).toBeLessThan(page.indexOf("<FactRequests />"));
  });
  it("問いの文には入らず、7 要件の検査は今のまま通る。意味が複数ある略語は問いの下に事実だけを添え、どの意味かは示さない", () => {
    const q = { yearMonth: YM, token: "AF", question: abbrevQuestion("AF"), options: [...ABBREV_OPTIONS], quotes: [{ ref: "1:text:0000000000000000", claimId: claimId("K4"), date: day(5), quote: "AF。", masked: false }] };
    expect(q.question).toBe("この記載の『AF』は何を指しますか");
    expect(q.question).not.toContain(DOCTOR_ABBREV.notice);
    expect(abbrevQueryErrors(q)).toEqual([]);
    const withNote = renderToString(createElement(AbbrevQuestionBody, { q: { question: q.question, multiMeaning: true } }));
    expect(withNote).toContain(q.question);
    expect(withNote).toContain(DOCTOR_ABBREV.multiMeaning);
    expect(withNote).not.toContain("心房細動");
    expect(renderToString(createElement(AbbrevQuestionBody, { q: { question: q.question, multiMeaning: false } }))).not.toContain(DOCTOR_ABBREV.multiMeaning);
  });
});
