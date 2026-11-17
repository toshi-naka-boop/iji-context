// 医師確認の入力。回答者・承認者の名前は受け取らない（セッションの本人から決める。FR-134）
import { z } from "zod";

/** 医師確認の id（src/query/doctor-query.ts の createQuery が作る形。記録のファイル名になるので、形を固定する） */
export const doctorQueryParams = z.strictObject({ id: z.string().regex(/^q-[0-9a-f]{12}$/) });
export const answerBody = z.strictObject({ option: z.string().min(1).max(100), freeText: z.string().max(500).optional() });
