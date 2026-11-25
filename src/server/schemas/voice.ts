// 音声（読み上げ）の入力。読み上げるのは決まった台詞だけ
import { z } from "zod";
import { id } from "./common";

export const VOICE_LINES = ["intro", "askName", "greeting", "greetingNoName"] as const;
export const speakBody = z.strictObject({ characterId: id, line: z.enum(VOICE_LINES), name: z.string().max(40).optional() });
