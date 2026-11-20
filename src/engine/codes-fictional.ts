// 架空コードの表はやめた（design.md §11-1。診療行為コードは版が持つ：src/engine/revisions/）。
// このファイルに残っているのは、src/official/registry.ts が読む isKnownKubun の再輸出だけ。
// registry.ts の import を "../engine/revisions" に替えたら、このファイルは消す
export { isKnownKubun } from "./revisions";
