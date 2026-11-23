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
