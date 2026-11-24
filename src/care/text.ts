// 聞き取りの画面の「今の申告」の言い方（round-82 の指摘：内部のキー〔type:・status:・careHomeId: など〕を出さず、画面の言葉で出す。施設は施設名で出す）
type Home = { homeId: string; name: string };
type Use = { kind: string; start?: string | null; end?: string | null; careHomeId?: string | null; fromDischarge?: string };

const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
const homeName = (homes: Home[], id: string | null | undefined) => (id ? (homes.find((h) => h.homeId === id)?.name ?? "（消えた施設）") : null);

/** 申告 1 行の値を画面の言葉にする。item は residenceType・shortStay・nurseInsurance */
export function careValueText(item: string, value: Record<string, unknown>, homes: Home[]): string {
  if (item === "residenceType") {
    const h = homeName(homes, value.careHomeId as string | null | undefined);
    return `${String(value.type)}${h ? `（入所先：${h}）` : ""}${value.changedMidMonth ? "・この月の途中で変わった" : ""}`;
  }
  if (item === "shortStay") {
    if (value.status === "使っていない") return "使っていないと確かめた";
    if (value.status !== "使った") return String(value.status);
    const uses = (value.uses as Use[] | undefined) ?? [];
    return `使った：${uses
      .map((u) => {
        const h = homeName(homes, u.careHomeId);
        const days = u.start || u.end ? `（${u.start ? md(u.start) : "？"}〜${u.end ? md(u.end) : "？"}）` : "（日付なし）";
        return `${u.kind}${days}${h ? `・利用先：${h}` : ""}・退院日から：${u.fromDischarge ?? "分からない"}`;
      })
      .join("、")}`;
  }
  return String(value.value ?? "");
}
