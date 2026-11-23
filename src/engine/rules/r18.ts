// R18 施設の種別（design.md §15-4）：施設の種別で分かれる区分（管理料・在宅ターミナルケア加算・緊急往診加算）の行の種別と、申告の種別を比べる。
// 在宅療養移行加算は在支診以外（種別 3）に限る。ベースアップ評価料(Ⅰ) の通常／注5 の側も見る（施設の申告から決まる区分の次元なので同じ担当。X-133）。
// 区分（回数・重症）・族・対象患者・回数の要件は見ない（R01・R02・R16・R10・R09 の担当。§0-12）。行と申告だけで決まる（出来事は読まない）
import { gradeSlots, isNote14Band, kanriOf, reducedOf } from "../predicates";
import type { KubunDef, RevisionConsts } from "../revisions/types";
import type { ClaimContext, FacilityGrade, Finding, NeedKey, Rule } from "../types";
import { finding, has, present } from "./util";

/** 連携型（(2)ア・(2)イ）の申告の選択肢。令和8年5月以前に届け出た連携型の経過措置は EM で未確認（EM §7-2 U-1。docs M-8） */
const RENKEI_CHOICES = ["renkei_a_beds", "renkei_a_nobeds", "renkei_i"];

/** points は版の点数表（直し先の区分の名前を文に添えるのに使う。点数は見ない） */
export function makeR18(c: RevisionConsts, points: Record<string, KubunDef>): Rule {
  const slots = gradeSlots(c);
  const GRADED = slots.map((s) => s.kubun);
  const IKOU3 = c.ikouGrade3 ?? [];
  const NOTE5 = Object.entries(c.baseUp.note5 ?? {});
  const BASEUP = NOTE5.flatMap(([normal, note5]) => [normal, note5]);
  // 注14（段 17h）：10 人以上の人数の区分の管理料（通常の行と、note14Pairs の減の行）
  const TEN = c.kanri.rows.filter((r) => isNote14Band(c, r.kubun)).map((r) => r.kubun);
  const ALL = [...new Set([...GRADED, ...IKOU3, ...BASEUP, ...TEN])];
  /** 同じ鍵（slot）で、申告の種別の区分 */
  const fixOf = (kubun: string, grade: FacilityGrade) => {
    const slot = slots.find((s) => s.kubun === kubun)!.slot;
    return slots.find((s) => s.slot === slot && s.grade === grade)?.kubun;
  };
  /** 連携型の申告なら、指摘の文に経過措置の断りを添える */
  const noteOf = (ctx: ClaimContext): Record<string, string> => (ctx.facility.gradeChoice && RENKEI_CHOICES.includes(ctx.facility.gradeChoice) ? { note: "（令和8年5月以前に届け出た連携型の経過措置は未確認）" } : {});
  return {
    id: "R18",
    kubun: ALL,
    reference: "C002・C002-2・C001 注6・C000 注1（施設の種別ごとの区分）・C002 注9・O001 注5、特掲通知 第9",
    recordFindings: [],
    // どれも、その行と施設の申告だけで決まる（ほかの行の有無に依らない。§11-11・§12-4）
    soundWhenPartial: ["use_grade", "iko_grade3_only", "use_baseup_note5", "use_baseup_normal", "use_note14_reduced"],
    // 読むのは kubun の区分だけ
    reads() {
      return this.kubun;
    },
    appliesTo: (ctx) => present(ctx, ALL).length > 0,
    // 分からない申告は、判定ごとに check が情報不足で返す（種別が分からなくても、ベースアップ評価料の側は見る）
    needs: () => [],
    check(ctx) {
      const out: Finding[] = [];
      const note = noteOf(ctx);
      const ask = (field: NeedKey, lineRefs: string[]): Finding => ({ ruleId: this.id, kind: "情報不足", lineRefs, missing: { target: "clerk", field }, messageKey: `${this.id}.missing_fact`, reference: this.reference });
      const say = (kind: Finding["kind"], lineRefs: string[], key: string, fix?: string): Finding => ({ ...finding(this, kind, lineRefs, key), params: { ...note, ...(fix ? { fix, fixName: points[fix]?.name ?? fix } : {}) } });
      const graded = present(ctx, [...GRADED, ...IKOU3]);
      const grade = ctx.facility.grade;
      if (graded.length && !grade.known) out.push(ask("facility.grade", graded));
      else if (grade.known) {
        for (const k of present(ctx, GRADED)) {
          const s = slots.find((x) => x.kubun === k)!;
          if (s.grade !== grade.value) out.push(say("区分誤り", [k], "use_grade", fixOf(k, grade.value)));
        }
        const iko = present(ctx, IKOU3);
        if (iko.length && grade.value !== "3") out.push(say("要件不足", iko, "iko_grade3_only"));
      }
      const baseUp = present(ctx, BASEUP);
      if (baseUp.length) {
        const b = ctx.facility.baseUp;
        if (!b.known) out.push(ask("facility.baseUp", baseUp));
        // なし のときは R18 は言わない（届出の有無は G10 の担当）
        else if (b.value !== "なし")
          for (const [normal, note5] of NOTE5) {
            if (b.value === "注5" && has(ctx, normal)) out.push(say("区分誤り", [normal], "use_baseup_note5", note5));
            if (b.value === "通常" && has(ctx, note5)) out.push(say("区分誤り", [note5], "use_baseup_normal", normal));
          }
      }
      // 注14 の通常の行と減の行（段 17h。design.md §15-4）：申告 note14 で見る。人数（R19）・区分（R01・R02）・族（R16）・注8 の次元は見ない
      const ten = present(ctx, TEN);
      if (ten.length) {
        const n = ctx.facility.note14;
        if (!n.known) out.push(ask("facility.note14", ten));
        else {
          const conflict: string[] = [];
          for (const k of ten) {
            const reduced = kanriOf(c, k)!.note14 !== undefined;
            if (n.value === "減算" && !reduced) {
              // 点数の低い側へ直すので区分誤り。在支診以外では減の行が 2 つ（注14 だけ・注8 と重ねた行）で、どちらかは注8 に当たるかで決まる（X-171。L-151）
              const reds = reducedOf(c, k);
              if (reds.length === 1) out.push(say("区分誤り", [k], "use_note14_reduced", reds[0]));
              else out.push({ ...finding(this, "区分誤り", [k], "use_note14_reduced"), params: { ...note, ...note14Either(reds, points) } });
            }
            // 申告だけを根拠に点数の高い区分（通常の行）へ直さない（L-126 の 3 つ目。L-130）
            if (n.value === "通常" && reduced) conflict.push(k);
          }
          if (conflict.length) out.push({ ruleId: this.id, kind: "情報不足", lineRefs: conflict, missing: { target: "clerk", field: "facility.note14" }, messageKey: `${this.id}.note14_conflict`, reference: this.reference });
        }
      }
      return out;
    },
  };
}

/** 減の行が 1 つに決まらないときの名指し（「〔注14 だけの減の行〕」又は「〔注8 と重ねた減の行〕」（注8 の減算に当たるかで決まります。注8 は見ていません）。round-57 X-171・L-151） */
export const NOTE8_EITHER = "（注8 の減算に当たるかで決まります。注8 は見ていません）";
export function note14Either(reds: string[], points: Record<string, KubunDef>): { fixName: string; note8: string; fixes: string } {
  return { fixName: reds.map((k) => points[k]?.name ?? k).join("」又は「"), note8: NOTE8_EITHER, fixes: reds.join(",") };
}
