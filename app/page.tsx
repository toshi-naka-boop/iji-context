import Link from "next/link";
import { TopBar } from "./nav";

export default function Home() {
  return (
    <main className="shell">
      <TopBar />
      <div className="panel">
        <p>医療事務一人ひとりに、隣で働く同僚としての AI メンターを。</p>
        <ul>
          <li><Link href="/work">算定（1 件＝1 問）</Link></li>
          <li><Link href="/doctor">医師確認</Link></li>
          <li><Link href="/meeting">レセメン会議</Link></li>
          <li><Link href="/manager">事務長レポート</Link></li>
        </ul>
        <p className="muted">合成データ・架空コードによるデモです。医療事務（請求・記載）の支援であり、診断・治療には関与しません。</p>
      </div>
    </main>
  );
}
