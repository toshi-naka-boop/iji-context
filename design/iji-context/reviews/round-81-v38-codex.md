critic: codex/gpt-6.1-sol xhigh（round-81。狭い確かめ。対象 §18-12・em-v38-draft.md の round-80 の直し）

- **X-380｜mid｜設計（新規）— 誤登録した認定を「分からない」に戻せない。**  
  [§18-12(1)](/Users/toshixa/Documents/iji-context/design/iji-context/design.md:3364) は、期間つき認定を後からの「分からない」にも常に優先します。要介護1（1〜12月）の誤登録に気づき、11月点検で「分からない」を追記しても、11月の `careLevel=1` が残り、包括的支援加算へ確定の `R03.not_eligible` が出ることを[現実装](/Users/toshixa/Documents/iji-context/.claude/worktrees/v37-cdf/src/patient/facts.ts:144)でも再現しました。追記方式なので、過去月への回答と、同月の認定の訂正・撤回を区別する規則が必要です。
