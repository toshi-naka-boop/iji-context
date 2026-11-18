// 合成 UKE：見本の 2 本と、アップロードで受け取った UKE の読み込み（spec FR-106〜109）、利用者ごとの取り込みの記録
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { UkeFile, UkePatient } from "../../uke/types";
import { parseUke, UkeError } from "../../uke/uke";
import { badRequest, notFound } from "../errors";
import { caseFileOf } from "./case-files";
import type { Clerks } from "./clerks";
import type { AppContext } from "./context";

export function createUke(ctx: AppContext, clerks: Clerks) {
  const { paths, setting, setSetting } = ctx;
  const { clerk } = clerks;

  const UKE_FILES = ["fixtures/uke/kokuhoren.UKE", "fixtures/uke/shiharaikikin.UKE"];
  const sampleBytes = () => UKE_FILES.map((f) => readFileSync(path.join(paths.root, f)));

  /** アップロードした UKE の置き場（クリニックごと。DB と同じ場所の下） */
  const uploadDir = () => path.join(path.dirname(paths.dbFile), "uke");
  /** 置き場のファイルの名前は、内容のハッシュだけ */
  const STORED_NAME = /^[0-9a-f]{64}\.UKE$/;
  /** クリニックが受け取った、見本と違う内容の UKE（内容のハッシュ名。受け取った順）。見本と同じ内容のものは見本として扱うので、ここには入れない */
  const uploads = (): string[] => (JSON.parse(setting("uke-uploads") ?? "[]") as string[]).filter((n) => STORED_NAME.test(n));
  /** 保存した UKE を読み返す。読むのは置き場の中のハッシュ名だけ。同じ名前は同じ内容なので、読んだ結果は覚えておく */
  const parsed = new Map<string, UkeFile>();
  function storedUke(name: string): UkeFile {
    if (!STORED_NAME.test(name)) throw notFound("取り込んだ UKE ではありません");
    let file = parsed.get(name);
    if (!file) {
      file = parseUke(readFileSync(path.join(uploadDir(), name)));
      parsed.set(name, file);
    }
    return file;
  }
  /** 見本の 2 本と、クリニックが受け取った UKE。名前は見本のファイル名か、内容のハッシュ名 */
  const named = (): { name: string; uploaded: boolean; file: UkeFile }[] => [
    ...sampleBytes().map((b, i) => ({ name: path.basename(UKE_FILES[i]), uploaded: false, file: parseUke(b) })),
    ...uploads().map((name) => ({ name, uploaded: true, file: storedUke(name) })),
  ];
  const ukeFiles = () => named().map((u) => u.file);
  /** UKE の取り込み（利用者ごとに記録） */
  const importedUke = (clerkId: string): string[] => JSON.parse(setting(`uke:${clerkId}`) ?? "[]") as string[];
  function ukeList(clerkId: string) {
    const done = importedUke(clerkId);
    return named().map(({ name, uploaded, file: u }) => ({
      name,
      /** 見本ではなく、アップロードで受け取ったものか */
      uploaded,
      payer: u.payer,
      prefecture: u.prefecture,
      billingMonth: u.billingMonth,
      receipts: u.receipts.map((x) => ({ claimId: x.claimId, patient: x.patient.name })),
      imported: done.includes(name),
    }));
  }
  function importUke(clerkId: string, name: string) {
    clerk(clerkId);
    if (!UKE_FILES.some((f) => path.basename(f) === name) && !uploads().includes(name)) throw badRequest(`取り込める UKE ではない: ${name}`);
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
   * 読み込み（parseUke）を通ったものは、見本と違う内容でも受け取る。同梱の症例にないレセプトは、カルテ側の事実を持たないまま点検に並ぶ（src/server/app/cases.ts）。
   * 断るのは、どちらを点検しているのかがクリニックの中で食い違うもの：同梱の症例の請求 id を使っていて見本と内容が違うファイルと、
   * すでに受け取った別のファイルと同じ請求 id を持つファイル
   */
  function uploadUke(clerkId: string, buf: Buffer) {
    clerk(clerkId);
    const reject = (reason: string): never => {
      throw badRequest(`この UKE は取り込めません（${reason}）`);
    };
    let file: UkeFile;
    try {
      file = parseUke(buf);
    } catch (e) {
      if (e instanceof UkeError) return reject(e.message);
      throw e;
    }
    const hit = sampleBytes().findIndex((b) => b.equals(buf));
    const name = `${createHash("sha256").update(buf).digest("hex")}.UKE`;
    if (hit < 0 && !uploads().includes(name)) {
      // RE の行番号（読み込みを通ったあとなので、行は CRLF で区切られている）
      const reLines = buf.toString("latin1").split("\r\n").flatMap((l, i) => (l.startsWith("RE,") ? [i + 1] : []));
      const bundled = file.receipts.findIndex((r) => caseFileOf(paths.root, r.claimId) !== null);
      if (bundled >= 0) return reject(`${reLines[bundled]} 行目：同梱の症例と同じ請求 id で、見本と内容が違う。症例のレセプトの差し替えには対応していません`);
      const taken = new Set(uploads().flatMap((n) => storedUke(n).receipts.map((r) => r.claimId)));
      const again = file.receipts.findIndex((r) => taken.has(r.claimId));
      if (again >= 0) return reject(`${reLines[again]} 行目：すでに取り込んだ UKE と同じ請求 id で、内容が違う。取り込んだレセプトの差し替えには対応していません`);
    }
    const dir = uploadDir();
    mkdirSync(dir, { recursive: true });
    const stored = path.join(dir, name);
    if (!existsSync(stored)) writeFileSync(stored, buf);
    if (hit >= 0) return importUke(clerkId, path.basename(UKE_FILES[hit]));
    if (!uploads().includes(name)) setSetting("uke-uploads", JSON.stringify([...uploads(), name]));
    return importUke(clerkId, name);
  }

  /** 取り込んだ UKE に入っているレセプト（月末の点検の対象） */
  const importedClaims = (clerkId: string): string[] => ukeList(clerkId).filter((u) => u.imported).flatMap((u) => u.receipts.map((x) => x.claimId));
  function patientOf(claimId: string): UkePatient {
    const r = ukeFiles().flatMap((f) => f.receipts).find((x) => x.claimId === claimId);
    if (!r) throw notFound(`UKE にないレセプト: ${claimId}`);
    return r.patient;
  }

  return { ukeFiles, ukeList, importUke, sampleUke, uploadUke, importedClaims, patientOf };
}

export type Uke = ReturnType<typeof createUke>;
