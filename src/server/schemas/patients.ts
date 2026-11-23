// 患者ごとに確かめた情報の入力。確かめた人は受け取らない（セッションの本人から決める）
import { z } from "zod";
import { CLAIM_FACT_KEYS, CLAIM_FACT_SOURCES, MAX_MAIN_DISEASE } from "../../claim/facts";
import { BUILDING_BANDS } from "../../engine/types";
import { FACT_SOURCES, PATIENT_FACT_KEYS, RESIDENCES } from "../../patient/facts";
import { COVERAGE_SOURCES } from "../../patient/profile";
import { claimId, date } from "./cases";

export const claimParams = z.strictObject({ claimId });

/** 形だけをここで確かめる。項目ごとの決まり（要介護度は 0〜5 と有効期間の終わりの日、障害支援区分は 0〜6、居住の場所は 2 つから、ほかは期限なし）は src/patient/facts.ts の validatePatientFact が確かめて文言を返す */
export const factBody = z.strictObject({
  fact: z.strictObject({
    key: z.enum(PATIENT_FACT_KEYS),
    // 人数の区分は「いつの診療月から」つき（design.md §15-4。月の途中の変化の欄は持たない。V-4）
    value: z.union([z.number().int().min(0).max(6), z.boolean(), z.enum(RESIDENCES), z.strictObject({ band: z.enum(BUILDING_BANDS), fromMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) })]),
    source: z.enum(FACT_SOURCES),
    validUntil: date.nullable(),
  }),
});

/**
 * 請求ごとに確かめた事実の入力。形だけをここで確かめる。事実ごとの決まり（日付ごとの事実は診療年月の日付、値の型）は src/claim/facts.ts の validateClaimFact が確かめて文言を返す。
 * 確かめた人は受け取らない（セッションの本人から決める）。背反の特例条件の例外の問いの答え（haihan:<HX-nn>:<コード①>:<コード②>。design.md §13-3）も同じ入口で受け取る（値は選択肢の文字列）
 */
export const claimFactBody = z.strictObject({
  fact: z.strictObject({
    key: z.union([
      z.enum(CLAIM_FACT_KEYS),
      z.string().regex(/^haihan:HX-\d{2}:\d{9}:\d{9}$/).transform((k) => k as `haihan:${string}`),
      // 院内の知識で「この請求も条件に当たる」と押した事実（design.md §14-3）
      z.string().regex(/^local:(local|veteran)\/[a-z0-9-]{1,60}@[0-9a-f]{12}:\d{9}:\d{9}$/).transform((k) => k as `local:${string}`),
    ]),
    date: date.nullable(),
    value: z.union([z.boolean(), z.string().max(MAX_MAIN_DISEASE)]),
    source: z.enum(CLAIM_FACT_SOURCES),
  }),
});

/**
 * 保険・公費の加入情報の確認入力。確かめた根拠（何を見て確かめたか）は選択。番号・負担割合は、直すときだけ送る。
 * 有効期間の終わりの null は「期限の定めなし」。桁数・検証番号は断らずに受け取り、患者情報チェック（P01）が指摘として返す
 */
export const coverageBody = z.strictObject({
  coverage: z.strictObject({
    coverageId: z.string().regex(/^C[0-9]{1,12}$/),
    source: z.enum(COVERAGE_SOURCES),
    payerNumber: z.string().regex(/^[0-9]{1,12}$/).optional(),
    memberNo: z.string().regex(/^[0-9]{1,12}$/).optional(),
    burdenRatio: z.number().min(0).max(1).optional(),
    validFrom: date.nullable(),
    validUntil: date.nullable(),
  }),
});

// 患者の在宅療養の機器（design.md §16-5・16-7。段 19e）。種類は DEVICE_KINDS のキーか none（形だけ。所属は src/server/app/devices.ts が確かめて文言を返す）
const yearMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const c150 = z.strictObject({ band: z.string().regex(/^C150_[1-7]$/), patientClass: z.enum(["イ", "ロ"]) });
/** GET /api/patient/devices */
export const devicesQuery = z.strictObject({ claimId });
/** POST /api/patient/devices：機器の行を追記する */
export const deviceBody = z.strictObject({ claimId, kind: z.string().min(1).max(20), fromMonth: yearMonth, endMonth: yearMonth.nullable().optional(), c150: c150.optional() });
/** POST /api/patient/device-proposals/[id]：変える案に答える（C150 の案は c150 がないと 400。種類の決まらない案は kind を選ぶ） */
export const proposalParams = z.strictObject({ id: z.coerce.number().int().positive() });
export const proposalBody = z.strictObject({ claimId, action: z.enum(["accept", "reject"]), kind: z.string().min(1).max(20).optional(), fromMonth: yearMonth.optional(), endMonth: yearMonth.nullable().optional(), c150: c150.optional() });
