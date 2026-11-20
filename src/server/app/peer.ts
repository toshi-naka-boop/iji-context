// F6 メンター同士：ベテランのメンター → ベテラン本人。解決した問いは知識候補（FR-14・FR-15）
import { escalationCandidate } from "../../mentor/peer";
import type { Clock } from "./clock";
import type { AppContext } from "./context";
import { badRequest, conflict, notFound } from "../errors";

export function createPeer(ctx: AppContext, clock: Clock) {
  const { sqlite, store } = ctx;
  const { now } = clock;

  /** claim_id は、その問いが出た相談の請求（取り込んだファイルを消すとき、その請求の問いも消す。画面には返さない） */
  type PeerRow = { id: string; from_clerk: string; question: string; status: "回答待ち" | "解決"; answer: string | null; answered_by: string | null; knowledge_id: string | null; created_at: string; answered_at: string | null };
  const COLUMNS = "id, from_clerk, question, status, answer, answered_by, knowledge_id, created_at, answered_at";
  const peerList = (): PeerRow[] => sqlite.prepare(`SELECT ${COLUMNS} FROM peer_questions ORDER BY created_at, id`).all() as PeerRow[];
  /** 画面に返す一覧。誰が聞いたか（from_clerk）は、ベテランのロールと、その問いを出した本人にだけ返す。ほかの人には問いと回答だけ */
  const peerListFor = (viewer: { clerkId: string; role: string }): (Omit<PeerRow, "from_clerk"> & { from_clerk?: string })[] =>
    peerList().map(({ from_clerk, ...rest }) => (viewer.role === "veteran" || from_clerk === viewer.clerkId ? { ...rest, from_clerk } : rest));
  /** 番号は、いまある番号の最大の次（件数から振ると、行が消えたときに既存の id とぶつかる）。保存は INSERT だけなので、ぶつかっても上書きはしない */
  function newPeerId(): string {
    const n = (sqlite.prepare("SELECT COALESCE(MAX(CAST(SUBSTR(id, 2) AS INTEGER)), 0) AS n FROM peer_questions WHERE id GLOB 'P[0-9]*'").get() as { n: number }).n;
    return `P${String(n + 1).padStart(4, "0")}`;
  }
  /** ベテランのメンターが答えた問いを記録し、知識候補にする */
  function peerResolvedByMentor(fromClerk: string, question: string, answer: string, claimId?: string) {
    const id = newPeerId();
    const k = escalationCandidate(store, { id, question, answer, answeredBy: "veteran_mentor" }, now());
    sqlite.prepare(`INSERT INTO peer_questions (${COLUMNS}, claim_id) VALUES (?, ?, ?, '解決', ?, 'veteran_mentor', ?, ?, ?, ?)`).run(id, fromClerk, question, answer, k.id, now(), now(), claimId ?? null);
    return { id, knowledgeId: k.id };
  }
  /** ベテラン本人に届ける（ベテランのメンター経由） */
  function peerToHuman(fromClerk: string, question: string, claimId?: string) {
    const id = newPeerId();
    sqlite.prepare("INSERT INTO peer_questions (id, from_clerk, question, status, created_at, claim_id) VALUES (?, ?, ?, '回答待ち', ?, ?)").run(id, fromClerk, question, now(), claimId ?? null);
    return { queued: id };
  }
  /** ベテラン本人の回答。知識候補（未検証）を作る */
  function peerAnswerByHuman(id: string, answer: string) {
    const row = peerList().find((r) => r.id === id);
    if (!row) throw notFound(`問いがない: ${id}`);
    if (row.status !== "回答待ち") throw conflict(`回答済み: ${id}`);
    if (!answer.trim()) throw badRequest("回答が空");
    const k = escalationCandidate(store, { id, question: row.question, answer, answeredBy: "veteran" }, now());
    sqlite.prepare("UPDATE peer_questions SET status = '解決', answer = ?, answered_by = 'veteran', knowledge_id = ?, answered_at = ? WHERE id = ?").run(answer, k.id, now(), id);
    return { id, knowledgeId: k.id };
  }

  return { peerList, peerListFor, peerResolvedByMentor, peerToHuman, peerAnswerByHuman };
}

export type Peer = ReturnType<typeof createPeer>;
