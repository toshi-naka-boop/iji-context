critic: codex/gpt-6.1-sol xhigh（round-92 狭い確かめ）

- **X-450｜重大度: mid｜種別: 前提・確定条件の不足**  
  [§19-5](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:3448)の「前月にも管理料がある」は、療法の継続を保証しません。例えば、9月に算定後中止→10月3日にJ024＋酸素→20日に再導入・管理料算定では、3日分がG12・G05で確定になります。しかし、3日はU-79と同じく算定可否が未決の導入前です。[留意事項C103(3)(4)(8)](https://www.mhlw.go.jp/content/12400000/001757385.pdf#page=299)からも、前月算定だけで継続とは判断できません。**C-604／X-441の保護が再導入月に届いておらず、継続を確認できなければ条件つきに留める必要があります。**

- **X-451｜重大度: low｜種別: 設計・テスト期待値の矛盾**  
  [完了条件3(a)](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:3509)は、FT4・コルチゾール・アルドステロン（尿）の素の合算364点で、「外と読んだ行」を昇順最初の1行と期待しています。一方、[判定規則](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:3429)では、n＝3から1行外すと下限未満になるため、一部外しを試しません。成立するのは全部外しで、表示対象は**FT4とコルチゾールの2行**です。期待値を直さないと、規則どおりの実装がテストに通りません。
