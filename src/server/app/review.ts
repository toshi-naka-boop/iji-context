// 査定・返戻の突き合わせ（spec FR-202 の I-1。design/iji-context/plan-i1.md）：増減点連絡書・返戻内訳書の CSV を取り込み、提出した UKE の請求と行に決まった規則で当て、
// 当てた請求を今の点検で点検し直した指摘を並べ、人が結果（同じ論点／別の論点／指摘なし）と指摘しなかった理由を選ぶ。件数の報告を作る。
// AI は一切使わない（判定も分類も人が選ぶ）。原本の CSV は保存せず、読んだ明細だけを DB に持つ。氏名・番号はログ・監査ログに出さない。
// 消すのは取り込んだ CSV の単位（FR-168 と同じ。deleteUpload）。UKE を消したときは、その請求に当てた分を外す（src/server/app/erase.ts）
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolveRevision } from "../../engine/revisions";
import { findingText, patientFindingText } from "../../messages";
import { codeFingerprint } from "../../review/fingerprint";
import { KIND_LABEL, readReviewCsv, ReviewError, type ReviewFileName, type ReviewKind, type ReviewRow } from "../../review/format";
import { claimLevel, matchClaim, matchLine, norm, type LineUnit, type ReceiptKey } from "../../review/match";
import { AUTO_EXCLUSIONS, HUMAN_EXCLUSIONS, LINE_OTHERS, MISS_REASONS, RESULTS, type Certainty, type ReviewResult } from "../../review/reasons";
import { reportOf, type ReportItem } from "../../review/report";
import { badRequest, conflict, notFound } from "../errors";
import type { AppContext } from "./context";
import type { Uke } from "./uke";
import type { UkeCheck } from "./uke-check";

type UploadRow = { sha256: string; kind: ReviewKind; paper: number; payer: string; clinic_code: string; processed_month: string; header_month: string | null; fingerprint: string; uploaded_by: string; uploaded_at: string };
type ItemRow = { id: number; upload_sha256: string; seq: number; data: string; claim_id: string | null; claim_by: string | null; claim_note: string | null; line_code: string | null; line_by: string | null; confirmed_by: string | null; confirmed_at: string | null; excluded: string | null; excluded_by: string | null };
type JudgmentRow = { id: number; item_id: number; fingerprint: string; revision_id: string | null; result: ReviewResult; reason: string | null; finding: string | null; judged_by: string; judged_at: string };

/** 指摘 1 件（当てた請求を今の点検で点検し直したもの）。key は判定で選ぶときの印（点検し直すたびに同じ並びで振る） */
export type ReviewFinding = { key: string; system: "ユスティ" | "データで動く点検" | "患者情報チェック"; id: string; certainty: Certainty; text: string; related: boolean };

/** 判定で選べる値 */
export type JudgeInput = { result: ReviewResult; reason?: string; finding?: string };

const fileOf = (u: UploadRow): ReviewFileName => ({ kind: u.kind, paper: u.paper === 1, payer: u.payer as ReviewFileName["payer"], prefectureCode: "", clinicCode: u.clinic_code, processedMonth: u.processed_month });
const rowOf = (it: ItemRow): ReviewRow => JSON.parse(it.data) as ReviewRow;

export function createReview(ctx: AppContext, uke: Uke, check: UkeCheck["ukeCheck"]) {
  const { sqlite, paths, kind } = ctx;
  const now = () => new Date().toISOString();
  const fingerprint = () => codeFingerprint(paths.root);

  const uploads = (): UploadRow[] => sqlite.prepare("SELECT * FROM review_uploads ORDER BY uploaded_at, sha256").all() as UploadRow[];
  const uploadOf = (sha256: string): UploadRow | undefined => sqlite.prepare("SELECT * FROM review_uploads WHERE sha256 = ?").get(sha256) as UploadRow | undefined;
  const itemsOf = (sha256?: string): ItemRow[] =>
    (sha256 === undefined ? sqlite.prepare("SELECT i.* FROM review_items i JOIN review_uploads u ON u.sha256 = i.upload_sha256 ORDER BY u.uploaded_at, u.sha256, i.seq").all() : sqlite.prepare("SELECT * FROM review_items WHERE upload_sha256 = ? ORDER BY seq").all(sha256)) as ItemRow[];
  function itemOf(id: number): { it: ItemRow; up: UploadRow } {
    const it = sqlite.prepare("SELECT * FROM review_items WHERE id = ?").get(id) as ItemRow | undefined;
    const up = it && uploadOf(it.upload_sha256);
    if (!it || !up) throw notFound("取り込んだ明細が見つかりません（消してあるかもしれません）");
    return { it, up };
  }
  const judgmentsOf = (itemId: number): JudgmentRow[] => sqlite.prepare("SELECT * FROM review_judgments WHERE item_id = ? ORDER BY id").all(itemId) as JudgmentRow[];
  const keyMap = () => new Map(uke.receiptKeys().map((k) => [k.claimId, k]));

  /** 当てた請求の算定単位と、行の名称の候補（マスターの名称か版の表の名称と、単位の先頭のコードには版の表の区分の名称も）。点検できない請求は null */
  function unitsOf(claimId: string): LineUnit[] | null {
    const r = check(claimId);
    if (!("rows" in r) || !r.rows) return null;
    const rev = resolveRevision(r.yearMonth);
    const units = uke.receiptOf(claimId).claim().units;
    let shikibetsu = "";
    return r.rows.map((row, i) => {
      // 省略された診療識別は、前の単位から引き継ぐ
      shikibetsu = units[i]?.shikibetsu || shikibetsu;
      return {
        unit: row.unit,
        shikibetsu,
        codes: row.items.map((item, n) => ({ code: item.code, names: [...(item.name ? [item.name] : []), ...(n === 0 ? row.kubun.map((k) => rev.points[k]?.name ?? "") : [])] })),
      };
    });
  }

  /** 対象外か、人が決めていないことがあるか（報告と一覧の状態） */
  function stateOf(it: ItemRow, up: UploadRow, keys: Map<string, ReceiptKey>): { excluded: string | null; pending: "unmatched" | "unconfirmed" | null } {
    if (it.excluded) return { excluded: it.excluded, pending: null };
    if (up.paper === 1) return { excluded: AUTO_EXCLUSIONS[0], pending: null };
    const k = it.claim_id ? keys.get(it.claim_id) : undefined;
    if (!k) return it.claim_by === "none" ? { excluded: AUTO_EXCLUSIONS[3], pending: null } : { excluded: null, pending: "unmatched" };
    if (k.noRevision) return { excluded: AUTO_EXCLUSIONS[1], pending: null };
    if (!k.checkable) return { excluded: AUTO_EXCLUSIONS[2], pending: null };
    return { excluded: null, pending: it.confirmed_at ? null : "unconfirmed" };
  }

  /** 当て方を変えたら、確かめた印と、その明細の判定を外す（別の請求・行についての判定を残さない） */
  function resetItem(id: number): void {
    sqlite.prepare("UPDATE review_items SET confirmed_by = NULL, confirmed_at = NULL WHERE id = ?").run(id);
    sqlite.prepare("DELETE FROM review_judgments WHERE item_id = ?").run(id);
  }

  /** 請求を決めたあと、行を当てる（請求単位の明細は行に当てない） */
  function setClaim(it: ItemRow, up: UploadRow, claimId: string, by: "auto" | "human", lines: Map<string, LineUnit[] | null>): void {
    const row = rowOf(it);
    let line: { code: string | null; by: string | null } = { code: null, by: null };
    if (claimLevel(up.kind, row)) line = { code: null, by: "claim" };
    else {
      if (!lines.has(claimId)) lines.set(claimId, unitsOf(claimId));
      const units = lines.get(claimId);
      const m = units ? matchLine(up.kind, row, units) : null;
      if (m?.scope === "code") line = { code: m.code, by: "auto" };
    }
    sqlite.prepare("UPDATE review_items SET claim_id = ?, claim_by = ?, claim_note = NULL, line_code = ?, line_by = ? WHERE id = ?").run(claimId, by, line.code, line.by, it.id);
  }

  /** 自動で当てる（取り込んだときと、当て直すとき）。人が決めた・確かめた明細は変えない */
  function autoMatch(up: UploadRow): void {
    const keys = uke.receiptKeys();
    const lines = new Map<string, LineUnit[] | null>();
    for (const it of itemsOf(up.sha256)) {
      if (it.confirmed_at || it.claim_by === "human" || it.claim_by === "none") continue;
      const m = matchClaim(fileOf(up), up.header_month, rowOf(it), keys);
      if ("reason" in m) sqlite.prepare("UPDATE review_items SET claim_id = NULL, claim_by = NULL, claim_note = ?, line_code = NULL, line_by = NULL WHERE id = ?").run(m.reason, it.id);
      else setClaim(it, up, m.claimId, "auto", lines);
    }
  }

  /** 同梱の合成の記録（fixtures/review/*.csv）の内容のハッシュ。実在のデータで使うクリニックでは、同じ内容の取り込みを断る（UKE の見本と同じ扱い） */
  const bundledHashes = (): Set<string> => {
    const dir = path.join(paths.root, "fixtures", "review");
    return new Set(existsSync(dir) ? readdirSync(dir).filter((f) => /\.csv$/i.test(f)).map((f) => createHash("sha256").update(readFileSync(path.join(dir, f))).digest("hex")) : []);
  };

  /** 一覧：取り込んだ CSV と明細。状態は、対象外・当てられない（選ぶ）・確かめる・判定する・判定済み（今の指紋での判定があるもの） */
  function reviewList() {
    const keys = keyMap();
    const fp = fingerprint();
    const ups = uploads();
    const byUpload = new Map(ups.map((u) => [u.sha256, u]));
    return {
      fingerprint: fp,
      uploads: ups.map((u) => ({ sha256: u.sha256, kind: u.kind, label: KIND_LABEL[u.kind], paper: u.paper === 1, payer: u.payer, processedMonth: u.processed_month, fingerprint: u.fingerprint, items: (sqlite.prepare("SELECT COUNT(*) AS n FROM review_items WHERE upload_sha256 = ?").get(u.sha256) as { n: number }).n })),
      items: itemsOf().map((it) => {
        const up = byUpload.get(it.upload_sha256)!;
        const row = rowOf(it);
        const st = stateOf(it, up, keys);
        const last = judgmentsOf(it.id).filter((j) => j.fingerprint === fp).at(-1) ?? null;
        const k = it.claim_id ? keys.get(it.claim_id) : undefined;
        return {
          id: it.id,
          upload: it.upload_sha256,
          kind: up.kind,
          receiptNo: row.receiptNo,
          uketsuke: row.uketsuke,
          name: row.name,
          kasho: [row.kasho1, row.kasho2].filter((x) => x !== "").join(" "),
          points: row.points,
          amount: row.amount,
          jiyu: row.jiyu,
          jiyuText: row.jiyuText,
          seikyu: row.seikyu,
          satei: row.satei,
          claimId: it.claim_id,
          claimPatient: k?.name ?? null,
          claimNote: it.claim_note,
          line: it.line_by === "claim" ? "請求単位" : it.line_code,
          confirmed: it.confirmed_at !== null,
          excluded: st.excluded,
          state: st.excluded ? "excluded" : st.pending ?? (last ? "judged" : "unjudged"),
          judgment: last ? { result: last.result, reason: last.reason } : null,
        };
      }),
    };
  }

  /** CSV を取り込む。読めないファイル・同じファイルの取り込み直しは断る。指紋は、明細を見る前（ここ）で固定する */
  function importReview(clerkId: string, fileName: string, buf: Buffer) {
    let csv: ReturnType<typeof readReviewCsv>;
    try {
      csv = readReviewCsv(fileName, buf);
    } catch (e) {
      if (e instanceof ReviewError) throw badRequest(`この CSV は取り込めません（${e.message}）`);
      throw e;
    }
    const sha256 = createHash("sha256").update(buf).digest("hex");
    if (kind !== "demo" && bundledHashes().has(sha256)) throw badRequest("この CSV は取り込めません（同梱の合成の記録と同じ内容です。実在のデータで使うクリニックには取り込めません）");
    if (uploadOf(sha256)) throw conflict("同じファイルをすでに取り込んでいます。取り込み直すときは、取り込み済みのファイルを消してからにしてください");
    sqlite
      .transaction(() => {
        const f = csv.file;
        sqlite.prepare("INSERT INTO review_uploads (sha256, kind, paper, payer, clinic_code, processed_month, header_month, fingerprint, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(sha256, f.kind, f.paper ? 1 : 0, f.payer, f.clinicCode, f.processedMonth, csv.headerMonth, fingerprint(), clerkId, now());
        const ins = sqlite.prepare("INSERT INTO review_items (upload_sha256, seq, data) VALUES (?, ?, ?)");
        csv.rows.forEach((r, i) => ins.run(sha256, i + 1, JSON.stringify(r)));
        autoMatch(uploadOf(sha256)!);
      })
      .immediate();
    return reviewList();
  }

  /** 当て直す（あとから UKE を取り込んだとき）。人が決めた・確かめた明細は変えない */
  function rematchReview(sha256: string) {
    const up = uploadOf(sha256);
    if (!up) throw notFound("取り込んだファイルが見つかりません（消してあるかもしれません）");
    sqlite.transaction(() => autoMatch(up)).immediate();
    return reviewList();
  }

  /** 当てた請求を今の点検で点検し直した指摘（ユスティ・データで動く点検・患者情報チェック）。related は、当てた行（請求単位なら請求）に関わる指摘か */
  function findingsOf(claimId: string, lineCode: string | null, lineBy: string | null): { revisionId: string | null; findings: ReviewFinding[] } {
    const r = check(claimId);
    if (!("rows" in r) || !r.rows) return { revisionId: null, findings: [] };
    const claimWide = lineBy === "claim" || lineCode === null || (LINE_OTHERS as readonly string[]).includes(lineCode);
    const kubun = new Set(r.rows.filter((row) => row.items.some((i) => i.code === lineCode)).flatMap((row) => row.kubun));
    const hand = r.findings.map((f, i): ReviewFinding => ({ key: `R:${i}`, system: "ユスティ", id: f.ruleId, certainty: f.params?.g11First ? "条件つき" : "確定", text: findingText(f), related: claimWide || f.lineRefs.some((k) => kubun.has(k)) }));
    const generic = (r.generic?.findings ?? []).map((f, i): ReviewFinding => ({ key: `G:${i}`, system: "データで動く点検", id: f.check, certainty: f.certainty, text: f.text, related: claimWide || f.codes.some((c) => c.code === lineCode) }));
    const patient = r.patientFindings.filter((f) => f.kind !== "情報不足").map((f, i): ReviewFinding => ({ key: `P:${i}`, system: "患者情報チェック", id: f.checkId, certainty: "患者情報", text: patientFindingText(f), related: true }));
    return { revisionId: r.revisionId, findings: [...hand, ...generic, ...patient] };
  }

  /** 明細 1 件の詳しい内容：選べる請求、選べる行、指摘、判定の記録 */
  function reviewItem(id: number) {
    const { it, up } = itemOf(id);
    const row = rowOf(it);
    const keys = uke.receiptKeys();
    const st = stateOf(it, up, new Map(keys.map((k) => [k.claimId, k])));
    // 選べる請求：審査支払機関と医療機関コードが同じもの。氏名の合うものを先に（増減点連絡書は請求月の同じものも先に）
    const score = (k: ReceiptKey) => (norm(k.name) === norm(row.name) ? 2 : 0) + (up.kind === "zogen" && k.billingMonth === up.processed_month ? 1 : 0);
    const claims = keys
      .filter((k) => k.payer === up.payer && k.clinicCode === up.clinic_code)
      .sort((a, b) => score(b) - score(a))
      .slice(0, 100)
      .map((k) => ({ claimId: k.claimId, patient: k.name, yearMonth: k.yearMonth, billingMonth: k.billingMonth, receiptNo: k.receiptNo, patientNo: k.patientNo, nameMatch: norm(k.name) === norm(row.name), insurerMatch: row.insurers.some((n) => k.insurers.includes(n.trim())), checkable: k.checkable }));
    const level = claimLevel(up.kind, row);
    const units = it.claim_id && !level ? unitsOf(it.claim_id) : null;
    const hits = units ? (() => { const m = matchLine(up.kind, row, units); return m.scope === "choose" ? m.hits : m.scope === "code" ? [m.code] : []; })() : [];
    const seen = new Set<string>();
    const lines = (units ?? []).flatMap((u) => u.codes.filter((c) => !seen.has(c.code) && seen.add(c.code)).map((c) => ({ code: c.code, name: c.names[0] ?? null, unit: u.unit, shikibetsu: u.shikibetsu, hit: hits.includes(c.code) })));
    const found = it.claim_id && st.excluded === null ? findingsOf(it.claim_id, it.line_code, it.line_by) : { revisionId: null, findings: [] };
    return {
      id: it.id,
      kind: up.kind,
      label: KIND_LABEL[up.kind],
      payer: up.payer,
      processedMonth: up.processed_month,
      row,
      claimId: it.claim_id,
      claimBy: it.claim_by,
      claimNote: it.claim_note,
      claimLevel: level,
      line: it.line_code,
      lineBy: it.line_by,
      confirmed: it.confirmed_at !== null,
      excluded: st.excluded,
      humanExcluded: it.excluded,
      pending: st.pending,
      claims,
      lines,
      lineOthers: LINE_OTHERS,
      revisionId: found.revisionId,
      findings: found.findings,
      fingerprint: fingerprint(),
      fixedFingerprint: up.fingerprint,
      judgments: judgmentsOf(it.id).map((j) => ({ fingerprint: j.fingerprint, revisionId: j.revision_id, result: j.result, reason: j.reason, finding: j.finding ? (JSON.parse(j.finding) as Omit<ReviewFinding, "key" | "related">) : null, at: j.judged_at })),
      choices: { results: RESULTS, reasons: MISS_REASONS, exclusions: HUMAN_EXCLUSIONS },
    };
  }

  /** 請求を選ぶ（null は「当てられない」） */
  function pickClaim(id: number, claimId: string | null) {
    const { it, up } = itemOf(id);
    sqlite
      .transaction(() => {
        resetItem(id);
        if (claimId === null) sqlite.prepare("UPDATE review_items SET claim_id = NULL, claim_by = 'none', line_code = NULL, line_by = NULL WHERE id = ?").run(id);
        else {
          if (!keyMap().has(claimId)) throw badRequest("選べる請求ではありません", ["claimId"]);
          setClaim(it, up, claimId, "human", new Map());
        }
      })
      .immediate();
    return reviewItem(id);
  }

  /** 行を選ぶ（請求の行のコードか、「その他」「判定不能」） */
  function pickLine(id: number, line: string) {
    const { it, up } = itemOf(id);
    if (!it.claim_id) throw badRequest("先に請求を選んでください");
    if (claimLevel(up.kind, rowOf(it))) throw badRequest("請求単位の明細です（行は選びません）");
    const ok = (LINE_OTHERS as readonly string[]).includes(line) || (unitsOf(it.claim_id) ?? []).some((u) => u.codes.some((c) => c.code === line));
    if (!ok) throw badRequest("選べる行ではありません", ["line"]);
    sqlite
      .transaction(() => {
        resetItem(id);
        sqlite.prepare("UPDATE review_items SET line_code = ?, line_by = 'human' WHERE id = ?").run(line, id);
      })
      .immediate();
    return reviewItem(id);
  }

  /** 当て方を確かめる（自動で当てた分も、人が 1 回確かめる） */
  function confirmMatch(id: number, clerkId: string) {
    const { it } = itemOf(id);
    if (!it.claim_id) throw badRequest("請求を選んでから確かめてください");
    if (it.line_by !== "claim" && it.line_code === null) throw badRequest("行を選んでから確かめてください");
    sqlite.prepare("UPDATE review_items SET confirmed_by = ?, confirmed_at = ? WHERE id = ?").run(clerkId, now(), id);
    return reviewItem(id);
  }

  /** 人が付ける対象外の印（突合点検・保険者の再審査による後日の査定・再審査で戻った）。null は外す */
  function excludeItem(id: number, reason: string | null, clerkId: string) {
    itemOf(id);
    if (reason !== null && !(HUMAN_EXCLUSIONS as readonly string[]).includes(reason)) throw badRequest("選べる印ではありません", ["reason"]);
    sqlite.prepare("UPDATE review_items SET excluded = ?, excluded_by = ? WHERE id = ?").run(reason, reason === null ? null : clerkId, id);
    return reviewItem(id);
  }

  /**
   * 判定を残す（追記だけ）。対象（当て方を確かめた、対象外でない明細）だけ。結果が「同じ論点で指摘していた」なら、どの指摘かを選ぶ（確定・条件つき・患者情報を数え分ける）。
   * そうでなければ、指摘しなかった理由を 1 つ選ぶ（複数当たるときは一覧の上のもの）。点検のコードの指紋と、点検に使った版を一緒に残す
   */
  function judgeItem(id: number, clerkId: string, input: JudgeInput) {
    const { it, up } = itemOf(id);
    const st = stateOf(it, up, keyMap());
    if (st.excluded !== null) throw badRequest("対象外の明細は判定しません");
    if (st.pending !== null) throw badRequest(st.pending === "unmatched" ? "先に請求を選んでください" : "先に当て方を確かめてください");
    if (!(RESULTS as readonly string[]).includes(input.result)) throw badRequest("選べる結果ではありません", ["result"]);
    const same = input.result === RESULTS[0];
    if (same && input.reason !== undefined) throw badRequest("指摘していたときは理由を選びません", ["reason"]);
    if (!same && !(MISS_REASONS as readonly string[]).includes(input.reason ?? "")) throw badRequest("指摘しなかった理由を選んでください", ["reason"]);
    const found = findingsOf(it.claim_id!, it.line_code, it.line_by);
    const f = same ? found.findings.find((x) => x.key === input.finding) : undefined;
    if (same && !f) throw badRequest("どの指摘かを選んでください", ["finding"]);
    const finding = f ? JSON.stringify({ system: f.system, id: f.id, certainty: f.certainty, text: f.text }) : null;
    sqlite.prepare("INSERT INTO review_judgments (item_id, fingerprint, revision_id, result, reason, finding, judged_by, judged_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(id, fingerprint(), found.revisionId, input.result, same ? null : input.reason, finding, clerkId, now());
    return reviewItem(id);
  }

  /** 報告（件数だけ。氏名・番号・請求 id は入れない） */
  function reviewReport() {
    const keys = keyMap();
    const ups = new Map(uploads().map((u) => [u.sha256, u]));
    const items: ReportItem[] = itemsOf().map((it) => {
      const up = ups.get(it.upload_sha256)!;
      const row = rowOf(it);
      const st = stateOf(it, up, keys);
      return {
        kind: up.kind,
        receiptKey: `${up.sha256}:${row.receiptSeq}`,
        ...st,
        jiyu: row.jiyu,
        points: row.points,
        judgments: judgmentsOf(it.id).map((j) => ({ fingerprint: j.fingerprint, revisionId: j.revision_id, result: j.result, reason: j.reason, certainty: j.finding ? (JSON.parse(j.finding) as { certainty: Certainty }).certainty : null })),
      };
    });
    return { ...reportOf(items, [...new Set([...ups.values()].map((u) => u.fingerprint))]), fingerprint: fingerprint() };
  }

  /** 取り込んだ CSV を消す（FR-168 と同じ単位：取り込み 1 回）。明細と判定も一緒に消える。返すのは件数だけ */
  function deleteReviewUpload(sha256: string): { deleted: string; items: number } {
    return sqlite
      .transaction(() => {
        if (!uploadOf(sha256)) throw notFound("取り込んだファイルが見つかりません（消してあるかもしれません）");
        sqlite.prepare("DELETE FROM review_judgments WHERE item_id IN (SELECT id FROM review_items WHERE upload_sha256 = ?)").run(sha256);
        const items = sqlite.prepare("DELETE FROM review_items WHERE upload_sha256 = ?").run(sha256).changes;
        sqlite.prepare("DELETE FROM review_uploads WHERE sha256 = ?").run(sha256);
        return { deleted: sha256, items };
      })
      .immediate();
  }

  return { reviewList, importReview, rematchReview, reviewItem, pickClaim, pickLine, confirmMatch, excludeItem, judgeItem, reviewReport, deleteReviewUpload };
}
