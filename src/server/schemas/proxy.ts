// F3 代行入力の入力
import { z } from "zod";
import { id } from "./common";

export const proxyBody = z.strictObject({ claimId: id, text: z.string().max(4000) });
