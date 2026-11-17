// 合成 UKE：見本の 2 本の読み込み、アップロードの取り込み（spec FR-106〜109）、利用者ごとの取り込みの記録
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { UkeFile, UkePatient } from "../../uke/types";
import { parseUke, UkeError } from "../../uke/uke";
import { badRequest, notFound } from "../errors";
import type { Clerks } from "./clerks";
import type { AppContext } from "./context";

export function createUke(ctx: AppContext, clerks: Clerks) {
  const { paths, setting, setSetting } = ctx;
  const { clerk } = clerks;

  const UKE_FILES = ["fixtures/uke/kokuhoren.UKE", "fixtures/uke/shiharaikikin.UKE"];
  const sampleBytes = () => UKE_FILES.map((f) => readFileSync(path.join(paths.root, f)));
  const ukeFiles = () => sampleBytes().map((b) => parseUke(b));
  /** UKE の取り込み（利用者ごとに記録） */
  const importedUke = (clerkId: string): string[] => JSON.parse(setting(`uke:${clerkId}`) ?? "[]") as string[];
  function ukeList(clerkId: string) {
    const done = importedUke(clerkId);
    return UKE_FILES.map((f, i) => {
      const u = ukeFiles()[i];
      const name = path.basename(f);
      return { name, payer: u.payer, prefecture: u.prefecture, billingMonth: u.billingMonth, receipts: u.receipts.map((x) => ({ claimId: x.claimId, patient: x.patient.name })), imported: done.includes(name) };
    });
  }
  function importUke(clerkId: string, name: string) {
    clerk(clerkId);
    if (!UKE_FILES.some((f) => path.basename(f) === name)) throw badRequest(`取り込める UKE ではない: ${name}`);
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

  /** アップロードした UKE の置き場（クリニックごと。DB と同じ場所の下） */
  const uploadDir = () => path.join(path.dirname(paths.dbFile), "uke");
  /**
   * アップロードした UKE を取り込む（FR-106〜109）。条件を 1 つでも満たさなければファイルごと断り、何も保存しない。
   * 断る理由は行番号つきの定型文で、ファイルの中の値（氏名・番号・コード）は返さない。
   * 保存は、クリニックごとの場所に、内容のハッシュを名前にして行う（請求 id やファイル名をパスに使わない）。
   *
   * いまは仮置きとして、点検に並べられるのは見本と同じ内容の UKE だけにしている：
   * 判定に要るカルテ側の事実は同梱の症例（EM 5-1）にしかなく、症例と同じ請求 id で中身の違うレセプトを受け取ると、
   * どちらを点検しているのかがクリニックの中で食い違うため。見本と違う内容は、形式が正しくても断る
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
    const samples = sampleBytes();
    const hit = samples.findIndex((b) => b.equals(buf));
    if (hit < 0) {
      const known = new Set(samples.flatMap((b) => parseUke(b).receipts.map((r) => r.claimId)));
      // RE の行番号（読み込みを通ったあとなので、行は CRLF で区切られている）
      const reLines = buf.toString("latin1").split("\r\n").flatMap((l, i) => (l.startsWith("RE,") ? [i + 1] : []));
      const unknown = file.receipts.findIndex((r) => !known.has(r.claimId));
      return reject(unknown >= 0 ? `${reLines[unknown]} 行目：同梱の症例にない請求 id` : "同梱の症例と同じ請求 id で、見本と内容が違う。症例のレセプトの差し替えには、まだ対応していません");
    }
    const dir = uploadDir();
    mkdirSync(dir, { recursive: true });
    const stored = path.join(dir, `${createHash("sha256").update(buf).digest("hex")}.UKE`);
    if (!existsSync(stored)) writeFileSync(stored, buf);
    return importUke(clerkId, path.basename(UKE_FILES[hit]));
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
