// 合成の査定通知（増減点連絡書に見立てたもの）を fixtures/notices/ に書き出す。`npx tsx scripts/gen-notice.ts`
// EM 5-1 の K6（前の月の診療分の BNP が、傷病名が「心不全の疑い」のままの連月の算定として査定）を 1 枚の PDF にする。
// 様式・番号はすべて架空で、点数欄は載せない。理由の文は EM §2-4 SJ-319 の要旨に沿って書いたもので、原文の転載ではない。
// 読み取った結果（.json）は fixtures/notices/ に手で置く（PDF を Claude に読ませて、本人が確かめた結果に当たるもの）。
// PDF への変換は手元の Google Chrome（ヘッドレス）を使う。見つからなければ HTML だけを書く
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { claimIdOf } from "../src/demo/period";
import { payerLabel } from "../src/messages";
import { SAMPLE_NOTICE_BASE, SAMPLE_NOTICE_MONTH } from "../src/notice/sample";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const NOTICE_BASE = SAMPLE_NOTICE_BASE;
/** 通知に書く理由（合成） */
export const NOTICE_REASON = "傷病名が「心不全の疑い」のまま、連月で算定されているため";

/** "YYYY-MM" を和暦（令和）の表記にする */
function wareki(yearMonth: string): string {
  const [y, m] = yearMonth.split("-").map(Number);
  return `令和${y - 2018}年${m}月`;
}

type Patients = { clinic: { code: string; name: string }; patients: Record<string, { name: string; insurer: { number: string; symbol: string; no: string } }> };

export function noticeHtml(): string {
  const src = JSON.parse(readFileSync(path.join(root, "fixtures", "uke", "patients.json"), "utf8")) as Patients;
  const p = src.patients[claimIdOf("K6")];
  const rows = [{ ym: wareki(SAMPLE_NOTICE_MONTH), name: p.name, insurer: p.insurer.number, item: "BNP", result: "査定", reason: NOTICE_REASON }];
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>増減点連絡書（合成）</title>
<style>body{font-family:"Hiragino Sans","Noto Sans JP",sans-serif;margin:32px;font-size:12px}h1{font-size:18px;text-align:center}
table{border-collapse:collapse;width:100%;margin-top:12px}td,th{border:1px solid #333;padding:6px}th{background:#eee}.note{color:#a00;font-weight:bold}</style></head><body>
<p class="note">合成データ。実在の様式・機関・患者の文書ではありません（ハッカソン提出物「レセメン」のテスト用）。</p>
<h1>増減点連絡書（合成）</h1>
<p>審査支払機関：${payerLabel("支払基金")}（合成）　都道府県：東京都　審査区分：原審査</p>
<p>医療機関コード：${src.clinic.code}　医療機関名：${src.clinic.name}</p>
<table><tr><th>診療年月</th><th>患者氏名</th><th>保険者番号</th><th>項目</th><th>増減の区分</th><th>理由</th></tr>
${rows.map((r) => `<tr><td>${r.ym}</td><td>${r.name}</td><td>${r.insurer}</td><td>${r.item}</td><td>${r.result}</td><td>${r.reason}</td></tr>`).join("\n")}
</table>
<p>上記のとおり審査しましたので連絡します。</p></body></html>`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const html = path.join(root, `${NOTICE_BASE}.html`);
  writeFileSync(html, noticeHtml());
  if (existsSync(CHROME)) {
    execFileSync(CHROME, ["--headless", "--disable-gpu", "--no-pdf-header-footer", `--print-to-pdf=${path.join(root, `${NOTICE_BASE}.pdf`)}`, `file://${html}`], { stdio: "ignore" });
    console.log(`書き出し: ${NOTICE_BASE}.html / .pdf`);
  } else {
    console.log(`書き出し: ${NOTICE_BASE}.html（Chrome が見つからないので PDF は作らない）`);
  }
}
