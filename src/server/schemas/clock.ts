// 時計（デモ）の入力
import { z } from "zod";
import { isoTime } from "./common";

export const clockBody = z.strictObject({ now: isoTime });
