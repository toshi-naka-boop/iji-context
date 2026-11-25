// 事務長レポートの入力（GET /api/manager）。month は確定した月（"YYYY-MM"）。省けば全期間の累計
import { z } from "zod";

export const managerQuery = z.strictObject({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() });
