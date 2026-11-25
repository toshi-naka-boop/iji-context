// 患者の機器の種類（design.md §16-5。W-15）。在宅療養指導管理材料加算の区分キーと 1 対 1。
// 名称・コードは EM（§2-2 の行の項目名と、§2-8 の別表「規則の候補で使うコード」のマスターの名称・コード）から写したもので、テストで EM と縛る（tests/structured/devices.test.ts）。
// C171_2（在宅酸素療法材料加算 2）は機器ではない（酸素の機器と C103 の 2 から出す。16-4-7）

export type DeviceKind = {
  /** EM の行 */
  em: string;
  /** 名称：EM §2-2 の項目名と、マスターの名称（表示名をこのどれかに normName で完全一致させて当てる。16-2 の規則 4） */
  names: string[];
  /** レセ電コード（16-2 の規則 1 で区分キーに引く） */
  codes: string[];
};

/** C150 の段（指示の回数の区分）と患者の区分（イ／ロ）のコード。5〜7 は 1 コード */
export const C150_BANDS: Record<string, { イ?: string; ロ?: string; one?: string }> = {
  C150_1: { イ: "114005910", ロ: "114009910" },
  C150_2: { イ: "114046010", ロ: "114046110" },
  C150_3: { イ: "114006010", ロ: "114010010" },
  C150_4: { イ: "114007410", ロ: "114010110" },
  C150_5: { one: "114010210" },
  C150_6: { one: "114015610" },
  C150_7: { one: "114050210" },
};

export const DEVICE_KINDS = {
  C157_1: { em: "R8-24", names: ["酸素ボンベ加算 1 携帯用", "酸素ボンベ加算（携帯用酸素ボンベ）"], codes: ["114006310"] },
  C157_2: { em: "R8-211", names: ["酸素ボンベ加算 2 携帯用以外", "酸素ボンベ加算（その他）"], codes: ["114006110"] },
  C158: { em: "R8-23", names: ["酸素濃縮装置加算"], codes: ["114006210"] },
  C159_1: { em: "R8-212", names: ["液化酸素装置加算 1 設置型", "設置型液化酸素装置加算"], codes: ["114004910"] },
  C159_2: { em: "R8-213", names: ["液化酸素装置加算 2 携帯型", "携帯型液化酸素装置加算"], codes: ["114005010"] },
  "C159-2": { em: "R8-214", names: ["呼吸同調式デマンドバルブ加算"], codes: ["114015710"] },
  C160: { em: "R8-217", names: ["在宅中心静脈栄養法用輸液セット加算"], codes: ["114005110"] },
  C161: { em: "R8-218", names: ["注入ポンプ加算"], codes: ["114006710"] },
  C162: { em: "R8-219", names: ["在宅経管栄養法用栄養管セット加算"], codes: ["114005210"] },
  C164_1: { em: "R8-226", names: ["人工呼吸器加算（陽圧式人工呼吸器）"], codes: ["114006810"] },
  C164_2: { em: "R8-226", names: ["人工呼吸器加算（人工呼吸器）"], codes: ["114009610"] },
  C164_3: { em: "R8-226", names: ["人工呼吸器加算（陰圧式人工呼吸器）"], codes: ["114005510"] },
  C166: { em: "R8-220", names: ["携帯型ディスポーザブル注入ポンプ加算"], codes: ["114006910"] },
  C150: { em: "R8-221", names: ["血糖自己測定器加算"], codes: Object.values(C150_BANDS).flatMap((b) => Object.values(b)) },
} as const satisfies Record<string, DeviceKind>;

export type DeviceKey = keyof typeof DEVICE_KINDS;
export const DEVICE_KEYS = Object.keys(DEVICE_KINDS) as DeviceKey[];
export const isDeviceKey = (k: string): k is DeviceKey => Object.hasOwn(DEVICE_KINDS, k);

/** レセ電コード → 区分キー（ちょうど 1 つに当たるときだけ）。C150 は段と患者の区分も返す */
export function deviceOfRece(code: string): { kind: DeviceKey; c150?: { band: string; patientClass: "イ" | "ロ" | null } } | null {
  const hits = DEVICE_KEYS.filter((k) => (DEVICE_KINDS[k].codes as readonly string[]).includes(code));
  if (hits.length !== 1) return null;
  const kind = hits[0];
  if (kind !== "C150") return { kind };
  const [band, b] = Object.entries(C150_BANDS).find(([, x]) => Object.values(x).includes(code))!;
  return { kind, c150: { band, patientClass: b.イ === code ? "イ" : b.ロ === code ? "ロ" : null } };
}

// ───────────────────────────────────────────────────────────────────────────
// 材料加算の「同じ単位」と、前の月の分のコメント（design.md §16-4-7。段 19e）

/**
 * 請求に「ある」を、コードでなく EM の行の区分と組で見る単位（round-64 C-401・round-65 C-411）。ここにない機器は同じコードで見る。
 * EM の行（R8-221・R8-226・R8-216 の (b)(c)）と合うことをテストで縛る（tests/patient/devices.test.ts）
 */
export const DEVICE_UNITS: Record<string, { em: string; kinds: readonly DeviceKey[] }> = {
  血糖自己測定器: { em: "R8-221", kinds: ["C150"] },
  人工呼吸器: { em: "R8-226", kinds: ["C164_1", "C164_2", "C164_3"] },
  "酸素の組 (b)": { em: "R8-216", kinds: ["C157_2", "C158", "C159_1"] },
  "酸素の組 (c)": { em: "R8-216", kinds: ["C157_1", "C159_2"] },
};

/** その機器の単位（名前と、単位のどれかのコード）。単位にない機器は自分のコードだけ */
export function unitOfDevice(kind: DeviceKey): { name: string | null; codes: string[] } {
  const hit = Object.entries(DEVICE_UNITS).find(([, u]) => u.kinds.includes(kind));
  return hit ? { name: hit[0], codes: hit[1].kinds.flatMap((k) => [...DEVICE_KINDS[k].codes]) } : { name: null, codes: [...DEVICE_KINDS[kind].codes] };
}

/** 材料加算の 2 回分・3 回分の対象の月のコメント（EM §2-10 表 1-b）：コード → コメントのある請求の診療年月から何か月ずれた月か */
export const MATERIAL_MONTH_COMMENTS: Record<string, number> = { "820100122": 0, "820100124": 1, "820100123": 2, "820100125": -1, "820100126": -2 };

/** 酸素の機器（チアノーゼ型先天性心疾患の添え書き・在宅酸素療法材料加算 2 の元） */
export const OXYGEN_KINDS: readonly DeviceKey[] = ["C157_1", "C157_2", "C158", "C159_1", "C159_2", "C159-2"];

// ───────────────────────────────────────────────────────────────────────────
// 患者の機器の行（design.md §16-5）

export type C150Detail = { band: string; patientClass: "イ" | "ロ" };
/** 機器の行（追記だけ）。kind の none は「機器なし」。seq は追記の順（DB の id） */
export type DeviceRow = { seq: number; kind: DeviceKey | "none"; fromMonth: string; endMonth: string | null; c150?: C150Detail | null; source: string; checkedBy: string; checkedAt: string };

const after = (a: Pick<DeviceRow, "fromMonth" | "seq">, b: Pick<DeviceRow, "fromMonth" | "seq">) => a.fromMonth > b.fromMonth || (a.fromMonth === b.fromMonth && a.seq > b.seq);

/**
 * 診療年月 ym に効く機器の行（16-5）。種類ごとに fromMonth が ym 以前で最も新しい行（同じ月なら追記の順が後）を選び、
 * ym 以前で最も新しい「機器なし」の行より後に入れたもので、endMonth が空か ym 以後のものだけ。
 * checked：ym 以前の行が 1 つ以上ある（「機器なし」を含む）
 */
export function effectiveDevices(rows: DeviceRow[], ym: string): { checked: boolean; rows: (DeviceRow & { kind: DeviceKey })[] } {
  const upto = rows.filter((r) => r.fromMonth <= ym);
  const none = upto.filter((r) => r.kind === "none").reduce<DeviceRow | null>((a, b) => (a === null || after(b, a) ? b : a), null);
  const latest = new Map<string, DeviceRow>();
  for (const r of upto) if (r.kind !== "none" && (!latest.has(r.kind) || after(r, latest.get(r.kind)!))) latest.set(r.kind, r);
  const live = [...latest.values()].filter((r) => (r.endMonth === null || r.endMonth >= ym) && (none === null || after(r, none))) as (DeviceRow & { kind: DeviceKey })[];
  return { checked: upto.length > 0, rows: live.sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0)) };
}

/** 機器の行のコード（C150 は段と患者の区分で 1 つ。決まらなければ null） */
export function codeOfDevice(r: Pick<DeviceRow, "kind" | "c150">): string | null {
  if (r.kind === "none") return null;
  if (r.kind !== "C150") return DEVICE_KINDS[r.kind].codes[0];
  const b = r.c150 ? C150_BANDS[r.c150.band] : undefined;
  if (!b) return null;
  return b.one ?? b[r.c150!.patientClass] ?? null;
}

/** 電子カルテの指示の機器 1 つ（当てた種類。当てられなければ null） */
export type InstructedDevice = { kind: DeviceKey | null; name: string | null; startedOn: string | null; endedOn: string | null; ref: string };
/** 変える案（16-5）。end は「効く行にあって指示にない機器」（終わりの案） */
export type DeviceProposal = { kind: DeviceKey | null; name: string | null; startedOn: string | null; endedOn: string | null; ref: string };

/**
 * 電子カルテの在宅療養の指示の機器と、診療年月に効く機器の行を比べ、違うものだけを変える案にする（16-5）：
 * 新しい機器（効く行にない種類。当てられない機器を含む）・endedOn のある機器（効く行がある種類）・効く行にあって指示にない機器
 */
export function proposalsOf(instructed: InstructedDevice[], live: { kind: DeviceKey }[]): DeviceProposal[] {
  const liveKinds = new Set(live.map((r) => r.kind));
  const out: DeviceProposal[] = [];
  for (const d of instructed) {
    if (d.kind === null) out.push({ ...d });
    else if (!liveKinds.has(d.kind) && d.endedOn === null) out.push({ ...d });
    else if (liveKinds.has(d.kind) && d.endedOn !== null) out.push({ ...d });
  }
  const told = new Set(instructed.flatMap((d) => (d.kind ? [d.kind] : [])));
  for (const k of liveKinds) if (!told.has(k)) out.push({ kind: k, name: null, startedOn: null, endedOn: null, ref: `指示になし:${k}` });
  return out;
}
