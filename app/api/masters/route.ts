// API Route：マスターの状態（design.md §12-5）。事務長だけ。入っている公開データ・更新日・件数・取り込んだ日時と、点検の準備。
// 返すのは公開データの名前と数だけ（患者の情報は入らない）。masters.db がなければ present: false
import { mastersStatus } from "../../../src/masters/db";
import { route } from "../../../src/server/http";
import { allow } from "../../../src/server/policy";

export const GET = route({ roles: allow("GET /api/masters") }, () => mastersStatus());

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
