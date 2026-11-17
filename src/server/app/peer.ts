// F6 メンター同士：ベテランのメンター → ベテラン本人。解決した問いは知識候補（FR-14・FR-15）
import { escalationCandidate } from "../../mentor/peer";
import type { Clock } from "./clock";
import type { AppContext } from "./context";

export function createPeer(ctx: AppContext, clock: Clock) {
  const { sqlite, store } = ctx;
  const { now } = clock;

  type PeerRow = { id: string; from_clerk: string; question: string; status: "回答待ち" | "解決"; answer: string | null; answered_by: string | null; knowledge_id: string | null; created_at: string; answered_at: string | null };
  const peerList = (): PeerRow[] => sqlite.prepare("SELECT * FROM peer_questions ORDER BY created_at, id").all() as PeerRow[];
  function newPeerId(): string {
    const n = (sqlite.prepare("SELECT COUNT(*) AS n FROM peer_questions").get() as { n: number }).n;
    return `P${String(n + 1).padStart(4, "0")}`;
  }
  /** ベテランのメンターが答えた問いを記録し、知識候補にする */
  function peerResolvedByMentor(fromClerk: string, question: string, answer: string) {
    const id = newPeerId();
    const k = escalationCandidate(store, { id, question, answer, answeredBy: "veteran_mentor" }, now());
    sqlite.prepare("INSERT INTO peer_questions VALUES (?, ?, ?, '解決', ?, 'veteran_mentor', ?, ?, ?)").run(id, fromClerk, question, answer, k.id, now(), now());
    return { id, knowledgeId: k.id };
  }
  /** ベテラン本人に届ける（ベテランのメンター経由） */
  function peerToHuman(fromClerk: string, question: string) {
    const id = newPeerId();
    sqlite.prepare("INSERT INTO peer_questions (id, from_clerk, question, status, created_at) VALUES (?, ?, ?, '回答待ち', ?)").run(id, fromClerk, question, now());
    return { queued: id };
  }
  /** ベテラン本人の回答。知識候補（未検証）を作る */
  function peerAnswerByHuman(id: string, answer: string) {
    const row = peerList().find((r) => r.id === id);
    if (!row) throw new Error(`問いがない: ${id}`);
    if (row.status !== "回答待ち") throw new Error(`回答済み: ${id}`);
    if (!answer.trim()) throw new Error("回答が空");
    const k = escalationCandidate(store, { id, question: row.question, answer, answeredBy: "veteran" }, now());
    sqlite.prepare("UPDATE peer_questions SET status = '解決', answer = ?, answered_by = 'veteran', knowledge_id = ?, answered_at = ? WHERE id = ?").run(answer, k.id, now(), id);
    return { id, knowledgeId: k.id };
  }

  return { peerList, peerResolvedByMentor, peerToHuman, peerAnswerByHuman };
}

export type Peer = ReturnType<typeof createPeer>;
