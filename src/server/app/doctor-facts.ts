// 医師に確かめてほしい項目（医師あての情報不足）の一覧と、決められなかった答え（その他・判定不能）の記録。
// 一覧は、いまある請求（同梱の症例と、取り込んだレセプト）を決まった規則で判定し、宛先の表（src/engine/index.ts の targetOfNeed）が医師とした情報不足を集めたもの。何も推し量らない。
// 決まった答え（はい・いいえ、看取りの場所、主病）は、事実の入口（請求ごと：src/server/app/claim-facts.ts、患者ごと：src/server/app/patients.ts）に医師の役割で残す。
// 「その他」「判定不能」は事実にしない（不明のまま）。答えたことと、その他の自由記述だけを、ここに残す。
// 医師確認の決まり（CLAUDE.md）：問いと選択肢は点数・金額に触れない。選択肢に必ず「その他」「判定不能」を含める。患者の氏名は返さない（医師確認の画面と同じく、請求の番号だけ）
import { DEATH_PLACES, inputKindOf, isClaimFactKey } from "../../claim/facts";
import type { Finding } from "../../engine/types";
import { FACT_LABEL } from "../../messages";
import { PATIENT_FACT_KEYS } from "../../patient/facts";
import { MONEY, OTHER, UNDETERMINABLE } from "../../query/doctor-query";
import type { Chart } from "../../uke/crosscheck";
import { MASK } from "./doctor-abbrevs";
import { badRequest, notFound } from "../errors";
import type { Cases } from "./cases";
import type { Clerks } from "./clerks";
import type { Clock } from "./clock";
import type { AppContext } from "./context";

export const MAX_DOCTOR_FREE_TEXT = 200;
/** 主病（文字で答える項目）の、記入を選ぶ選択肢 */
export const WRITE_IN = "主病を記入する";

/**
 * scope：答えを残す先（patient＝患者ごとの事実、claim＝請求ごとの事実）。input：答えの形。
 * options は画面に同じ大きさで並べる選択肢（必ず「その他」「判定不能」を含む）。note は、前に決められなかったときの答え。
 * evidence は、カルテの記載の引用（医師確認の 7 要件の ①臨床指標。採点 r2 医療事務課長 P1）：その日の問いはその日の記載（なければその月の全部）、
 * 月の問いはその月の記載を、同じ文どうしは日をまとめて並べる。点数・金額の語は伏せる。カルテの記録がない請求は空で、noRecord が真
 */
export type DoctorFactItem = {
  claimId: string;
  yearMonth: string;
  field: string;
  date: string | null;
  scope: "patient" | "claim";
  input: "boolean" | "deathPlace" | "text";
  question: string;
  options: string[];
  note: { option: string; freeText: string | null; at: string } | null;
  evidence: { source: string; text: string }[];
  noRecord: boolean;
};

const dayLabel = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
/** 点数・金額の語（MONEY の正規表現そのもの）を伏せる（略語の問いの引用と同じ。src/server/app/doctor-abbrevs.ts の quoteOf） */
const masked = (text: string) => text.replace(new RegExp(MONEY.source, "g"), MASK);

/** 引用に使うカルテ（照合用のカルテに、貼って確かめたカルテの O を足せる形） */
export type EvidenceChart = { entries: { date: string; s: string; o?: string; a: string; p: string }[]; prescriptions: Chart["prescriptions"] };

/** カルテの記載の引用。chart がない・記載がないときは null（カルテの記録がない請求） */
export function evidenceOf(chart: EvidenceChart | null, date: string | null): DoctorFactItem["evidence"] | null {
  if (!chart || chart.entries.length === 0) return null;
  const onDay = date ? chart.entries.filter((e) => e.date === date) : [];
  const entries = onDay.length > 0 ? onDay : chart.entries;
  const groups = new Map<string, string[]>();
  for (const e of entries) {
    const text = [["S", e.s], ["O", e.o ?? ""], ["A", e.a], ["P", e.p]].filter(([, v]) => v.trim() !== "").map(([k, v]) => `${k}: ${v.trim()}`).join(" / ");
    if (text === "") continue;
    groups.set(text, [...(groups.get(text) ?? []), e.date]);
  }
  const out = [...groups].map(([text, dates]) => ({ source: `カルテ ${dates.map(dayLabel).join("・")}`, text: masked(text) }));
  const rx = [...new Set(chart.prescriptions.filter((p) => onDay.length === 0 || p.date === date).map((p) => p.category))];
  if (rx.length > 0) out.push({ source: "処方", text: masked(rx.join("、")) });
  return out.length > 0 ? out : null;
}

const isPatientKey = (field: string) => (PATIENT_FACT_KEYS as readonly string[]).includes(field);

/** chartOf は、引用に使うカルテ（合成カルテと、取り込んだ請求に貼って確かめたカルテ。src/server/app.ts が渡す） */
export function createDoctorFacts(ctx: AppContext, clock: Clock, clerks: Clerks, casesOf: Cases, chartOf: (claimId: string) => EvidenceChart | null = () => null) {
  const { sqlite } = ctx;

  type NoteRow = { option: string; free_text: string | null; answered_at: string };
  const noteOf = (claimId: string, key: string, date: string | null): DoctorFactItem["note"] => {
    const r = sqlite.prepare("SELECT option, free_text, answered_at FROM doctor_fact_notes WHERE claim_id = ? AND key = ? AND date = ? ORDER BY id DESC LIMIT 1").get(claimId, key, date ?? "") as NoteRow | undefined;
    return r ? { option: r.option, freeText: r.free_text, at: r.answered_at } : null;
  };

  function itemOf(claimId: string, yearMonth: string, f: Finding): DoctorFactItem | null {
    const m = f.missing;
    if (f.kind !== "情報不足" || !m || m.target !== "doctor") return null;
    const scope = isPatientKey(m.field) ? "patient" : isClaimFactKey(m.field) ? "claim" : null;
    if (!scope) return null;
    const input = isClaimFactKey(m.field) ? inputKindOf(m.field) : "boolean";
    const date = m.date ?? null;
    const day = date ? `（${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日）` : "";
    const label = (FACT_LABEL as Record<string, string>)[m.field] ?? m.field;
    const clinical = input === "boolean" ? ["はい", "いいえ"] : input === "deathPlace" ? [...DEATH_PLACES] : [WRITE_IN];
    const evidence = evidenceOf(chartOf(claimId), date);
    return { claimId, yearMonth, field: m.field, date, scope, input, question: `${label}${day}`, options: [...clinical, OTHER, UNDETERMINABLE], note: noteOf(claimId, m.field, date), evidence: evidence ?? [], noRecord: evidence === null };
  }

  /** 確かめてほしい項目の一覧。同じ請求・同じ項目・同じ日は 1 件（いくつものルールが同じことを聞いても、聞くのは 1 回） */
  function doctorFacts(): DoctorFactItem[] {
    const out = new Map<string, DoctorFactItem>();
    for (const c of casesOf.cases()) {
      for (const f of casesOf.judge(c).findings) {
        const item = itemOf(c.claimId, c.yearMonth, f);
        if (item) out.set(`${item.claimId}|${item.field}|${item.date ?? ""}`, item);
      }
    }
    return [...out.values()];
  }

  /**
   * 決められなかった答えを残す（「その他」は自由記述つき、「判定不能」は自由記述なし）。事実は不明のまま。
   * 残せるのは、いま一覧に出ている項目だけ。返すのは、残したあとの一覧
   */
  function noteDoctorFact(clerkId: string, input: { claimId: string; key: string; date: string | null; option: string; freeText?: string }): DoctorFactItem[] {
    clerks.clerk(clerkId);
    if (!doctorFacts().some((i) => i.claimId === input.claimId && i.field === input.key && i.date === input.date)) throw notFound("確かめてほしい項目にありません");
    const text = input.freeText?.trim() ?? "";
    if (input.option === OTHER && text === "") throw badRequest("「その他」は、具体的に書いてください", ["freeText"]);
    if (input.option === UNDETERMINABLE && text !== "") throw badRequest("「判定不能」に、記述は付けません", ["freeText"]);
    sqlite
      .prepare("INSERT INTO doctor_fact_notes (claim_id, key, date, option, free_text, answered_by, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(input.claimId, input.key, input.date ?? "", input.option, input.option === OTHER ? text : null, clerkId, clock.now());
    return doctorFacts();
  }

  return { doctorFacts, noteDoctorFact };
}
