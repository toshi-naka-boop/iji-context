// API Route（薄い入口。処理は src/server/app/local-pairs.ts）：背反の組の院内の知識を、取り込んだレセプトの点検の G05 の指摘から作る（design.md §14-2）。
// 取り込んだ請求を読んで G05 を計算し直すので、権限は請求ごとの事実の入力と同じ（事務・ベテラン。医師の役割は作れない）で、注意書きへの同意が要る（round-43 C-201）。
// 監査ログの対象は請求 id と組だけ（要約・本文・条件の文は入れない）
import { route } from "../../../../src/server/http";
import { getApp } from "../../../../src/server/instance";
import { allow } from "../../../../src/server/policy";
import { pairBody } from "../../../../src/server/schemas/knowledge";

export const POST = route({ roles: allow("POST /api/knowledge/pair"), body: pairBody, audit: { target: ({ body }) => `${body.claimId} ${body.a}:${body.b}:${body.tani}` } }, ({ body }) => getApp().createPair(body));

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
