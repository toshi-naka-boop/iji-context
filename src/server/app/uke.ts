// UKE：見本の 2 本と、アップロードで受け取った UKE の読み込み（spec FR-106〜109）、利用者ごとの取り込みの記録
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { UkeClaim, UkeFile, UkePatient, UkeReceipt } from "../../uke/types";
import { parseUke, readStoredUke, readUke, UkeError } from "../../uke/uke";
import { uploadClaimIdOf } from "../../uke/upload";
import { hasRevision, resolveRevision } from "../../engine/revisions";
import { badRequest, notFound } from "../errors";
import type { Clerks } from "./clerks";
import type { AppContext } from "./context";

export function createUke(ctx: AppContext, clerks: Clerks) {
  const { paths, sqlite, setting, setSetting } = ctx;
  const { clerk } = clerks;

  const UKE_FILES = ["fixtures/uke/kokuhoren.UKE", "fixtures/uke/shiharaikikin.UKE"];
  /** 形式そのものが読めなくなった、保存済みのファイルの理由（以前の形式で作られた UKE など） */
  const FILE_UNREADABLE = "いまの形式では読めない UKE です。いまの形式で書き出した UKE を取り込み直してください";
  const sampleBytes = () => UKE_FILES.map((f) => readFileSync(path.join(paths.root, f)));

  /** アップロードした UKE の置き場（クリニックごと。DB と同じ場所の下） */
  const uploadDir = () => path.join(path.dirname(paths.dbFile), "uke");
  /** 置き場のファイルの名前は、内容のハッシュだけ */
  const STORED_NAME = /^[0-9a-f]{64}\.UKE$/;
  /**
   * 取り込みの一覧（design.md §11-11）：クリニックが受け取った、見本と違う内容の UKE。受け取った順に、取り込みの連番（seq）と内容のハッシュ（sha256）を持つ。
   * next は次の連番。消したファイルの番号を使い回さないよう、一覧とは別に持つ。見本と同じ内容のものは見本として扱うので、ここには入れない。
   * 連番を入れる前の形（ハッシュ名の配列）は、並びの順に 1 から番号を振って読む
   */
  type Upload = { seq: number; sha256: string };
  function uploadState(): { next: number; files: Upload[] } {
    const raw = JSON.parse(setting("uke-uploads") ?? "[]") as string[] | { next: number; files: Upload[] };
    const state = Array.isArray(raw) ? { next: raw.length + 1, files: raw.map((n, i) => ({ seq: i + 1, sha256: n.replace(/\.UKE$/, "") })) } : raw;
    return { next: state.next, files: state.files.filter((u) => STORED_NAME.test(nameOf(u))) };
  }
  const nameOf = (u: Upload) => `${u.sha256}.UKE`;
  const uploads = (): Upload[] => uploadState().files;
  const uploadOf = (name: string): Upload | undefined => uploads().find((u) => nameOf(u) === name);
  /**
   * 保存した UKE を読み返す。読むのは置き場の中のハッシュ名だけ。同じ名前は同じ内容なので、読んだ結果は覚えておく。
   * 読み直しでは断らない（design.md §11-12）：受け取ったあとでコードの表・点数表が変わり、いまの表と食い違うようになったレセプトは、
   * そのレセプトだけが unreadable（理由つき）になり、ほかのレセプトは今までどおり読める。形式そのものが読めなくなったファイルは null（ファイルごと「読めない」と出す）。
   * どちらも一覧からは落とさず、点検には並べない（1 件のために一覧ごと止めない）
   */
  const parsed = new Map<string, UkeFile | null>();
  /** 請求 id は、取り込みの連番とファイルの中の通し番号から決まる（src/uke/upload.ts）。同じファイルを読み直しても同じ id になる */
  function storedUke(u: Upload): UkeFile | null {
    const name = nameOf(u);
    if (!STORED_NAME.test(name)) throw notFound("取り込んだ UKE ではありません");
    let stored = parsed.get(name);
    if (stored === undefined) {
      try {
        stored = readStoredUke(readFileSync(path.join(uploadDir(), name)), uploadClaimIdOf(u.seq));
      } catch (e) {
        if (!(e instanceof UkeError)) throw e;
        stored = null;
      }
      parsed.set(name, stored);
    }
    return stored;
  }
  /** 見本の 2 本と、クリニックが受け取った UKE。名前は見本のファイル名か、内容のハッシュ名。file が null のものは、いまの形式では読めない */
  const named = (): { name: string; uploaded: boolean; file: UkeFile | null }[] => [
    ...sampleBytes().map((b, i) => ({ name: path.basename(UKE_FILES[i]), uploaded: false, file: readUke(b) })),
    ...uploads().map((u) => ({ name: nameOf(u), uploaded: true, file: storedUke(u) })),
  ];
  /**
   * 診療年月の版で読めたレセプトだけ（点検・患者マスタ・照合・通知の対応づけが使う）。
   * 読み直しで読めなかったレセプト（unreadable）と、診療年月に版がないレセプト（noRevision。design.md §11-12）は入れない
   */
  const ukeFiles = (): UkeFile[] => named().flatMap((u) => (u.file ? [{ ...u.file, receipts: u.file.receipts.filter((r) => !r.unreadable && !r.noRevision) }] : []));
  /** 一覧にあるレセプトをすべて（読み直しで読めなかったもの・版のないものも含む。請求 id と患者の情報は持っている） */
  const ukeReceipts = (): UkeReceipt[] => named().flatMap((u) => u.file?.receipts ?? []);
  /**
   * 一覧にあるレセプト 1 件（取り込んだレセプトの点検と試算が使う。版のないものも含む）。uploaded は、見本ではなくアップロードで受け取ったものか。
   * file は、そのレセプトだけを持つファイル（審査支払機関・都道府県を請求にするときに使う）。
   * claim は、形式だけを読んだレセプト（コードと単位のまま。版を見ない）。試算が、選んだ版で区分に引く。呼ぶまで読まない
   */
  function receiptOf(claimId: string): { receipt: UkeReceipt; uploaded: boolean; file: UkeFile; claim: () => UkeClaim } {
    for (const [i, u] of named().entries()) {
      const n = u.file?.receipts.findIndex((x) => x.claimId === claimId) ?? -1;
      if (!u.file || n < 0) continue;
      const receipt = u.file.receipts[n];
      // 見本は named() の先頭に、UKE_FILES と同じ並びで入っている。レセプトの並びは、ファイルの中の並びのまま
      const bytes = () => (u.uploaded ? readFileSync(path.join(uploadDir(), u.name)) : sampleBytes()[i]);
      return { receipt, uploaded: u.uploaded, file: { ...u.file, receipts: [receipt] }, claim: () => parseUke(bytes()).claims[n] };
    }
    throw notFound("UKE にないレセプトです");
  }
  /** UKE の取り込み（利用者ごとに記録） */
  const importedUke = (clerkId: string): string[] => JSON.parse(setting(`uke:${clerkId}`) ?? "[]") as string[];
  /** 同じ患者（氏名・生年月日・性別）の、同じ診療年月・同じレセプト種別のレセプトか、を比べる鍵 */
  const sameMonthKey = (r: UkeFile["receipts"][number]) => [r.patient.name.replace(/\s/g, ""), r.patient.birth, r.patient.sex, r.yearMonth, r.patient.receiptType].join("|");
  function ukeList(clerkId: string) {
    const done = importedUke(clerkId);
    const all = named();
    /** 鍵 → その鍵のレセプトがあるファイルの数。別のファイルにもあれば、断らずに両方に知らせる（どちらが正しいかは人が決め、要らないファイルを消す） */
    const filesWith = new Map<string, number>();
    for (const u of all) for (const k of new Set((u.file?.receipts ?? []).map(sameMonthKey))) filesWith.set(k, (filesWith.get(k) ?? 0) + 1);
    return all.map(({ name, uploaded, file: u }) => ({
      name,
      /** 見本ではなく、アップロードで受け取ったものか */
      uploaded,
      /** いまの形式では読めないファイルか（取り込み直しが要る。中身は出さない）。読めれば null */
      unreadable: u === null ? { reason: FILE_UNREADABLE } : null,
      payer: u?.payer ?? null,
      prefecture: u?.prefecture ?? null,
      billingMonth: u?.billingMonth ?? null,
      /**
       * patientNo は UKE の「カルテ番号等」（取り込んだ UKE だけ）。sameMonth は「同じ月のレセプトがすでにあります」（別のファイルに、同じ患者・同じ診療年月・同じレセプト種別のレセプトがある）。
       * otherRows は点検の対象外の行の数。unreadable は、読み直しで読めなかったレセプトの理由（読めれば null）。
       * revisionId は、診療年月から決まる版。null は「この診療年月の版はありません（試算できます）」：月末の点検・提出には並ばない（design.md §11-12）
       */
      receipts: (u?.receipts ?? []).map((x) => ({
        claimId: x.claimId,
        patient: x.patient.name,
        patientNo: uploaded ? (x.patientNo ?? "") : null,
        sameMonth: (filesWith.get(sameMonthKey(x)) ?? 0) > 1,
        otherRows: (x.others ?? []).reduce((s, o) => s + o.codes.length, 0),
        unreadable: x.unreadable?.reason ?? null,
        revisionId: !x.noRevision && hasRevision(x.yearMonth) ? resolveRevision(x.yearMonth).id : null,
      })),
      imported: u !== null && done.includes(name),
    }));
  }
  function importUke(clerkId: string, name: string) {
    clerk(clerkId);
    const upload = uploadOf(name);
    if (!UKE_FILES.some((f) => path.basename(f) === name) && !upload) throw badRequest(`取り込める UKE ではない: ${name}`);
    if (upload && storedUke(upload) === null) throw badRequest(FILE_UNREADABLE);
    const done = importedUke(clerkId);
    if (!done.includes(name)) setSetting(`uke:${clerkId}`, JSON.stringify([...done, name]));
    return ukeList(clerkId);
  }
  /** 見本の UKE のバイト列（ダウンロード用。FR-109）。名前は一覧にあるものだけ */
  function sampleUke(name: string): { name: string; bytes: Buffer } {
    const i = UKE_FILES.findIndex((f) => path.basename(f) === name);
    if (i < 0) throw notFound("見本の UKE ではありません");
    return { name: path.basename(UKE_FILES[i]), bytes: sampleBytes()[i] };
  }

  /**
   * アップロードした UKE を取り込む（FR-106〜109）。条件を 1 つでも満たさなければファイルごと断り、何も保存しない。
   * 断る理由は行番号つきの定型文で、ファイルの中の値（氏名・番号・コード）は返さない。
   * 保存は、クリニックごとの場所に、内容のハッシュを名前にして行う（請求 id やファイル名をパスに使わない）。
   *
   * 読み込みを通ったものは、見本と違う内容でも受け取る。対応していないコードの行は断らず、点検の対象外として残す。
   * 診療年月に版がないレセプトも断らない：一覧には出すが、月末の点検・提出には並べず、版を選んで試算する（design.md §11-12）。請求 id はアプリが振る（U<取り込みの連番>-<通し番号>。design.md §11-11）ので、
   * 同じ患者の別の月・同じファイルの 2 枚目・カルテ番号が空のレセプトも受け取れる。カルテ側の事実を持たないまま点検に並ぶ（src/server/app/cases.ts）。
   * 断るのは、同じファイル（同じ内容のハッシュ）の取り込み直しだけ。見本と同じ内容のファイルは、見本として取り込む（請求 id は症例の番号のまま）
   */
  function uploadUke(clerkId: string, buf: Buffer) {
    clerk(clerkId);
    const reject = (reason: string): never => {
      throw badRequest(`この UKE は取り込めません（${reason}）`);
    };
    const hit = sampleBytes().findIndex((b) => b.equals(buf));
    const sha256 = createHash("sha256").update(buf).digest("hex");
    const state = uploadState();
    if (hit < 0 && state.files.some((u) => u.sha256 === sha256)) return reject("同じファイルをすでに取り込んでいます。取り込み直すときは、取り込み済みのファイルを消してからにしてください");
    const upload: Upload = { seq: state.next, sha256 };
    let read: UkeFile;
    try {
      read = hit >= 0 ? readUke(buf) : readUke(buf, uploadClaimIdOf(upload.seq));
    } catch (e) {
      if (e instanceof UkeError) return reject(e.message);
      throw e;
    }
    const dir = uploadDir();
    mkdirSync(dir, { recursive: true });
    const stored = path.join(dir, nameOf(upload));
    if (!existsSync(stored)) writeFileSync(stored, buf);
    if (hit >= 0) return importUke(clerkId, path.basename(UKE_FILES[hit]));
    // 連番は、取り込めたときにだけ進める
    setSetting("uke-uploads", JSON.stringify({ next: state.next + 1, files: [...state.files, upload] }));
    parsed.set(nameOf(upload), read);
    return importUke(clerkId, nameOf(upload));
  }

  /** 取り込んだ UKE に入っているレセプト（月末の点検の対象）。読み直しで読めなかったレセプトと、診療年月に版がないレセプトは並べない */
  const importedClaims = (clerkId: string): string[] =>
    ukeList(clerkId).filter((u) => u.imported).flatMap((u) => u.receipts.filter((x) => x.unreadable === null && x.revisionId !== null).map((x) => x.claimId));
  function patientOf(claimId: string): UkePatient {
    const r = ukeFiles().flatMap((f) => f.receipts).find((x) => x.claimId === claimId);
    if (!r) throw notFound(`UKE にないレセプト: ${claimId}`);
    return r.patient;
  }

  /** 取り込んだファイルの中のレセプト（消す操作が使う。読み直しで読めなかったレセプトも含む）。取り込みの一覧にないハッシュは「ない」。いまの形式では読めないファイルは、レセプトなしとして返す（ファイルだけ消せる） */
  function uploadedFile(sha256: string): { receipts: UkeFile["receipts"] } {
    const u = uploads().find((x) => x.sha256 === sha256);
    if (!u) throw notFound("取り込んだファイルが見つかりません（消してあるかもしれません）");
    return { receipts: storedUke(u)?.receipts ?? [] };
  }
  /**
   * 取り込みの一覧・利用者ごとの取り込みの記録・読み直しのキャッシュから外し、原本のファイルのパスを返す（ファイルを消すのは呼び出し側。src/server/app/erase.ts）。
   * 次の連番（next）は戻さない：消したファイルの連番は使い回さない
   */
  function forgetUpload(sha256: string): string {
    const state = uploadState();
    const name = nameOf({ seq: 0, sha256 });
    setSetting("uke-uploads", JSON.stringify({ next: state.next, files: state.files.filter((u) => u.sha256 !== sha256) }));
    for (const r of sqlite.prepare("SELECT key, value FROM app_settings WHERE key LIKE 'uke:%'").all() as { key: string; value: string }[]) {
      const kept = (JSON.parse(r.value) as string[]).filter((n) => n !== name);
      setSetting(r.key, JSON.stringify(kept));
    }
    parsed.delete(name);
    return path.join(uploadDir(), name);
  }

  return { ukeFiles, ukeReceipts, receiptOf, ukeList, importUke, sampleUke, uploadUke, importedClaims, patientOf, uploadedFile, forgetUpload };
}

export type Uke = ReturnType<typeof createUke>;
