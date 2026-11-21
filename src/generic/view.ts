// データで動く点検の結果を、画面に出す形にする（design.md §12-5）：指摘の文（定型文）、当たる行の名称、出どころ、点検の範囲（動いた点検・動かさなかった点検と理由）
import { FACT_LABEL, fillLocal, genericNotRunText, genericText, LOCAL_PAIR_TEXT } from "../messages";
import { exceptionOf } from "./haihan";
import { localKey, type LocalAttach } from "./local-pair";
import type { RowNames } from "./lookup";
import type { GenericScope } from "./scope";
import type { GenericResult } from "./types";

/**
 * 背反の特例条件の例外の問い（G05.exception_ask。design.md §13-3）。取り込んだレセプトの点検の画面が、指摘の下に選択肢を出す。
 * choice＝例外の問い（key は haihan:*。値は選択肢の文字列）／fact＝R10 と同じ「別々の診療か」の入力（sameDaySeparate。はい・いいえ）。dates は答えの日（請求ごとの問いは空）
 */
export type GenericAsk = { kind: "choice"; hx: string; key: string; dates: string[]; question: string; choices: string[] } | { kind: "fact"; hx: string; key: "sameDaySeparate"; dates: string[]; question: string };

/**
 * 指摘に添えた院内の知識（design.md §14-3）。texts は添える文、press は Lv.5 以上・承認済みの allow のボタン（key は押した事実の key、date は押す日。同一月の表は null）
 */
export type GenericLocal = { mode: LocalAttach["mode"]; pair: LocalAttach["pair"]; ids: string[]; texts: string[]; press: { key: string; date: string | null }[] };

export type GenericView = {
  findings: { check: string; kind: string; certainty: "確定" | "条件つき"; text: string; codes: { code: string; name: string | null }[]; source: { data: string; ref: string }; asks?: GenericAsk[]; local?: GenericLocal; localPair?: LocalAttach["pair"] }[];
  /** 動いた点検。「指摘なし」は、ここにある点検についてだけ言える */
  ran: { check: string; kind: string }[];
  /** 動かさなかった点検と理由。reason は、データがない（noMasters・noSnapshot）／準備ができていない（notReady）／まだ入っていない（notBuilt） */
  notRun: { check: string; kind: string; reason: string; text: string }[];
  /** 上限（FINDING_LIMIT）を超えたので返さなかった指摘の数（点検ごと）。画面は「ほか N 件」と出す */
  omitted: { check: string; kind: string; count: number }[];
  /** 検算（G02）の数と対象外の理由、G02・G03 が点検していないこと（src/generic/scope.ts。呼び出し側が足す） */
  scope?: GenericScope;
};

/** names は、行の名称（マスターがなければ null）。持っているマスターにないコードは、指摘の値（params.name）にある名称を添える */
export function genericView(result: GenericResult, names: RowNames | null): GenericView {
  return {
    findings: result.findings.map((f) => ({
      check: f.check,
      kind: f.kind,
      certainty: f.certainty,
      text: genericText(f),
      codes: f.codes.map((code) => ({ code, name: names?.items[code]?.name ?? f.params.name ?? null })),
      source: f.source,
      ...(f.params.asks ? { asks: asksOf(f.params.asks) } : {}),
      ...(f.params.local ? { local: localOf(f.params.local) } : {}),
      // 院内の知識を添える対象の組（design.md §14-2：取り込んだレセプトの点検は、ここに作る入口を出す）
      ...(f.params.localPair ? { localPair: JSON.parse(f.params.localPair) as LocalAttach["pair"] } : {}),
    })),
    ran: result.ran,
    notRun: result.notRun.map((n) => ({ check: n.check, kind: n.kind, reason: n.reason, text: genericNotRunText(n) })),
    omitted: result.omitted ?? [],
  };
}

/** 指摘の値（params.asks。G05 が JSON で入れる）を、問いの文と選択肢つきにする。問いのない例外の id は落とす */
function asksOf(json: string): GenericAsk[] {
  return (JSON.parse(json) as { hx: string; key: string; dates: string[] }[]).flatMap((a): GenericAsk[] => {
    if (a.key === "sameDaySeparate") return [{ kind: "fact", hx: a.hx, key: "sameDaySeparate", dates: a.dates, question: FACT_LABEL.sameDaySeparate }];
    const ask = exceptionOf(a.hx)?.ask;
    return ask ? [{ kind: "choice", hx: a.hx, key: a.key, dates: a.dates, question: ask.question, choices: ask.choices.map((c) => c.label) }] : [];
  });
}

/** 指摘の値（params.local。G05 が JSON で入れる）を、添える文とボタンにする（design.md §14-3） */
function localOf(json: string): GenericLocal {
  const a = JSON.parse(json) as LocalAttach;
  const ids = a.knowledge.map((k) => k.id);
  const note = (k: LocalAttach["knowledge"][number]) => ({ note: k.conditionNote });
  const texts =
    a.mode === "allow"
      ? a.knowledge.map((k) => fillLocal(LOCAL_PAIR_TEXT.allow, note(k)))
      : a.mode === "hint"
        ? a.knowledge.map((k) => fillLocal(k.polarity === "allow" ? LOCAL_PAIR_TEXT.hintAllow : LOCAL_PAIR_TEXT.hintAvoid, note(k)))
        : a.mode === "conflict"
          ? [fillLocal(LOCAL_PAIR_TEXT.conflict, { ids: ids.join("・") })]
          : a.mode === "unverified"
            ? [fillLocal(LOCAL_PAIR_TEXT.unverified, { ids: ids.join("・") })]
            : [];
  // ボタンは、承認済みの allow の知識ごと・押していない日ごと（同一月の表は請求に 1 つ）
  const press = a.mode === "allow" ? a.knowledge.flatMap((k) => (a.dates.length > 0 ? a.dates : [null]).map((date) => ({ key: localKey(k.id, k.rev, a.pair.a, a.pair.b), date }))) : [];
  return { mode: a.mode, pair: a.pair, ids, texts, press };
}
