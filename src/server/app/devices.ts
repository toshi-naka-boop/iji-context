// 患者の在宅療養の機器と、電子カルテからの変える案（design.md §16-5・16-7・16-8。段 19e。FR-208）。
// 正は患者の情報の 1 か所（patient_devices。追記だけ）。電子カルテの在宅療養の指示は「変える案」（device_proposals）として届き、医療事務が「入れる／入れない」を選ぶまで判定に使わない。
// 機器の値（種類・月）はログ・エラー文・AI に送る文脈に出さない（監査ログは入口で種類の鍵だけ）
import { YEAR_MONTH } from "../../demo/period";
import { C150_BANDS, effectiveDevices, isDeviceKey, proposalsOf, type C150Detail, type DeviceKey, type DeviceRow, type InstructedDevice } from "../../structured/devices";
import { badRequest, notFound } from "../errors";
import type { Clerks } from "./clerks";
import type { Clock } from "./clock";
import type { AppContext } from "./context";

/** 出どころの印（16-5） */
export const DEVICE_SOURCES = { ehr: "電子カルテ（確かめた）", clerk: "医療事務が入れた" } as const;

type Row = { id: number; kind: string; from_month: string; end_month: string | null; detail: string | null; source: string; checked_by: string; checked_at: string; name: string | null };
type ProposalRow = { id: number; kind: string | null; started_on: string | null; ended_on: string | null; ref: string; connector_id: string; received_at: string; decision: string | null };

/** 機器の行の入力（POST /api/patient/devices） */
export type DeviceInput = { kind: string; fromMonth: string; endMonth?: string | null; c150?: C150Detail };
/** 変える案への答え（POST /api/patient/device-proposals/[id]）。種類の決まらない案は kind を選ぶ */
export type ProposalDecision = { action: "accept" | "reject"; kind?: string; fromMonth?: string; endMonth?: string | null; c150?: C150Detail };

/** 変える案の画面の 1 行（接続先の行の id は返さない） */
export type ProposalView = { id: number; kind: DeviceKey | null; startedOn: string | null; endedOn: string | null; type: "start" | "end" | "choose"; receivedAt: string };

const monthOf = (date: string | null) => (date ? date.slice(0, 7) : null);

export function createDevices(ctx: Pick<AppContext, "sqlite">, clock: Pick<Clock, "now">, clerks: Pick<Clerks, "clerk">) {
  const { sqlite } = ctx;

  /** 患者の機器の行（追記の順）。checkedBy は医療事務の名前 */
  function rowsOf(patientId: string): DeviceRow[] {
    const rows = sqlite
      .prepare("SELECT d.id, d.kind, d.from_month, d.end_month, d.detail, d.source, d.checked_by, d.checked_at, c.name FROM patient_devices d LEFT JOIN clerks c ON c.id = d.checked_by WHERE d.patient_id = ? ORDER BY d.id")
      .all(patientId) as Row[];
    return rows.map((r) => ({
      seq: r.id,
      kind: r.kind as DeviceKey | "none",
      fromMonth: r.from_month,
      endMonth: r.end_month,
      ...(r.detail ? { c150: JSON.parse(r.detail) as C150Detail } : {}),
      source: r.source === DEVICE_SOURCES.clerk ? `${DEVICE_SOURCES.clerk}（${r.name ?? ""}・${r.checked_at}）` : r.source,
      checkedBy: r.name ?? "",
      checkedAt: r.checked_at,
    }));
  }

  const checkC150 = (c150: C150Detail | undefined): C150Detail => {
    if (!c150 || !Object.hasOwn(C150_BANDS, c150.band) || (c150.patientClass !== "イ" && c150.patientClass !== "ロ")) throw badRequest("血糖自己測定器は、測定回数の区分と患者の区分（イ／ロ）を選んでください", ["c150"]);
    return c150;
  };
  const checkMonth = (m: string | null | undefined, field: string) => {
    if (m !== null && m !== undefined && !YEAR_MONTH.test(m)) throw badRequest("月は YYYY-MM で指定する", [field]);
  };

  function insert(patientId: string, clerkId: string, kind: DeviceKey | "none", fromMonth: string, endMonth: string | null, c150: C150Detail | null, source: string) {
    sqlite
      .prepare("INSERT INTO patient_devices (patient_id, kind, from_month, end_month, detail, source, checked_by, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(patientId, kind, fromMonth, endMonth, c150 ? JSON.stringify(c150) : null, source, clerkId, clock.now());
  }

  /** 機器の行を追記する（医療事務が入れた）。種類は DEVICE_KINDS のキーか none、fromMonth は必須。C150 は区分と患者の区分が要る */
  function addDevice(patientId: string, clerkId: string, input: DeviceInput): { saved: true } {
    clerks.clerk(clerkId);
    if (input.kind !== "none" && !isDeviceKey(input.kind)) throw badRequest("機器の種類が違います", ["kind"]);
    checkMonth(input.fromMonth, "fromMonth");
    checkMonth(input.endMonth, "endMonth");
    if (input.endMonth && input.endMonth < input.fromMonth) throw badRequest("終わりの月は、いつからの月より後にしてください", ["endMonth"]);
    const c150 = input.kind === "C150" ? checkC150(input.c150) : null;
    insert(patientId, clerkId, input.kind as DeviceKey | "none", input.fromMonth, input.endMonth ?? null, c150, DEVICE_SOURCES.clerk);
    return { saved: true };
  }

  /** まだ決めていない変える案 */
  function pendingOf(patientId: string): ProposalRow[] {
    return sqlite.prepare("SELECT id, kind, started_on, ended_on, ref, connector_id, received_at, decision FROM device_proposals WHERE patient_id = ? AND decision IS NULL ORDER BY id").all(patientId) as ProposalRow[];
  }

  /**
   * 電子カルテの在宅療養の指示から、変える案を作る（接続先から読んだとき）。今の効く行と違うものだけ。
   * 同じ中身（種類・開始・終わり・接続先の行）の案が、決めていないか「入れない」で閉じていれば足さない（違う中身なら足す）。黙って機器の行を上書きしない
   */
  function syncProposals(patientId: string, yearMonth: string, connectorId: string, instructed: InstructedDevice[]): number {
    const live = effectiveDevices(rowsOf(patientId), yearMonth).rows;
    const props = proposalsOf(instructed, live);
    const same = sqlite.prepare("SELECT 1 FROM device_proposals WHERE patient_id = ? AND kind IS ? AND started_on IS ? AND ended_on IS ? AND ref = ? AND connector_id = ? AND (decision IS NULL OR decision = 'reject')");
    const put = sqlite.prepare("INSERT INTO device_proposals (patient_id, kind, started_on, ended_on, ref, connector_id, received_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    let n = 0;
    for (const p of props) {
      if (same.get(patientId, p.kind, p.startedOn, p.endedOn, p.ref, connectorId)) continue;
      put.run(patientId, p.kind, p.startedOn, p.endedOn, p.ref, connectorId, clock.now());
      n++;
    }
    return n;
  }

  /** 変える案の種類（始まり・終わり・種類を選ぶ） */
  const typeOf = (p: ProposalRow): ProposalView["type"] => (p.kind === null ? "choose" : p.ended_on !== null || p.ref.startsWith("指示になし:") ? "end" : "start");

  /**
   * 変える案に答える。accept は機器の行を追記する（出どころ「電子カルテ（確かめた）」）。始まりの案の fromMonth の初期値は開始の月、終わりの案は今の効く行の fromMonth と終わりの月。
   * C150 の案は測定回数の区分と患者の区分がないと受けない（400。round-66 X-253）。reject は案を閉じる
   */
  function decideProposal(patientId: string, id: number, clerkId: string, input: ProposalDecision): { saved: true } {
    clerks.clerk(clerkId);
    const p = sqlite.prepare("SELECT id, kind, started_on, ended_on, ref, connector_id, received_at, decision FROM device_proposals WHERE id = ? AND patient_id = ?").get(id, patientId) as ProposalRow | undefined;
    if (!p) throw notFound("変える案がありません");
    if (p.decision !== null) throw badRequest("この案はもう決めてあります");
    if (input.action === "accept") {
      const kind = p.kind ?? input.kind ?? null;
      if (kind === null || !isDeviceKey(kind)) throw badRequest("機器の種類を選んでください", ["kind"]);
      checkMonth(input.fromMonth, "fromMonth");
      checkMonth(input.endMonth, "endMonth");
      const c150 = kind === "C150" ? checkC150(input.c150) : null;
      const end = typeOf(p) === "end";
      // 終わりの案は、その種類の最後に入れた行（効いている行）に終わりの月を付けた行を追記する
      const current = rowsOf(patientId).filter((r) => r.kind === kind).at(-1);
      const fromMonth = input.fromMonth ?? (end ? (current?.fromMonth ?? monthOf(p.ended_on)) : monthOf(p.started_on));
      if (!fromMonth) throw badRequest("いつの診療月からかを入れてください", ["fromMonth"]);
      const endMonth = input.endMonth !== undefined ? input.endMonth : monthOf(p.ended_on);
      if (end && !endMonth) throw badRequest("終わりの月を入れてください", ["endMonth"]);
      insert(patientId, clerkId, kind, fromMonth, endMonth, c150 ?? (current?.c150 ?? null), DEVICE_SOURCES.ehr);
    }
    sqlite.prepare("UPDATE device_proposals SET decision = ?, decided_by = ?, decided_at = ? WHERE id = ?").run(input.action, clerkId, clock.now(), id);
    return { saved: true };
  }

  /** 患者の情報の画面の機器の欄（GET /api/patient/devices）：診療年月に効く行・変更の記録・確かめたか・決めていない変える案 */
  function devicesView(patientId: string, yearMonth: string) {
    const rows = rowsOf(patientId);
    const eff = effectiveDevices(rows, yearMonth);
    return {
      yearMonth,
      checked: eff.checked,
      live: eff.rows.map(({ seq: _seq, ...r }) => r),
      history: rows.map(({ seq: _seq, ...r }) => r),
      proposals: pendingOf(patientId).map((p): ProposalView => ({ id: p.id, kind: p.kind !== null && isDeviceKey(p.kind) ? p.kind : null, startedOn: p.started_on, endedOn: p.ended_on, type: typeOf(p), receivedAt: p.received_at })),
    };
  }

  /** G11 の材料加算の入力のうち、患者の情報から決まるもの（効く行・確かめたか・決めていない案の種類） */
  function deviceInputOf(patientId: string, yearMonth: string) {
    const eff = effectiveDevices(rowsOf(patientId), yearMonth);
    return {
      checked: eff.checked,
      rows: eff.rows.map((r) => ({ kind: r.kind, fromMonth: r.fromMonth, ...(r.c150 ? { c150: r.c150 } : {}), source: r.source })),
      pending: pendingOf(patientId).map((p) => (p.kind !== null && isDeviceKey(p.kind) ? p.kind : null)),
    };
  }

  return { rowsOf, addDevice, syncProposals, decideProposal, devicesView, deviceInputOf };
}

export type Devices = ReturnType<typeof createDevices>;
