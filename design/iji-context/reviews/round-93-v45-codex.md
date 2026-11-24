critic: codex/gpt-6.1-sol xhigh（round-93 狭い確かめ。§19-13 と v45 の追記）

- **X-460｜重大度: mid｜種別: EM・設計整合性／例外の統合漏れ**  
  [HP-57・58](/Users/toshixa/Documents/iji-context/design/iji-context/sources/em-gh-draft.md:290) は、既存の [HP-35](/Users/toshixa/Documents/iji-context/design/iji-context/sources/evidence-master-iji-context.md:2026) と重複します。[現実装は最初に一致した組を採用](/Users/toshixa/Documents/iji-context/.claude/worktrees/v44-gh/src/generic/g05.ts:183)するため、末尾追加では HX-25 に到達せず、§19-13③の条件分けが働きません。新組を優先するだけでは、今度は既存の入院例外 HX-20 が抜けます。HP-35 の改訂または分割と、HX-20 の継承が必要です。現在は該当組が `certain` 未登録なので、現時点の確定誤指摘とは断定しません。
