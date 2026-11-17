// 外向きの通信の守り（spec FR-113）：許可リスト・https・リダイレクト・タイムアウト・サイズ・content-type・内部アドレス・認証情報の秘匿
import http from "node:http";
import https from "node:https";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ORCA_WIRE } from "../../src/connect/orca";
import { connectJson, connectorConfig, dnsResolver, isInternalAddress, resolveTarget } from "../../src/connect/fetch";
import { failure, pointAt, startMock, type Mock } from "./helpers";

let mock: Mock;
beforeAll(async () => {
  mock = await startMock();
});
afterAll(() => mock.close());
afterEach(() => vi.unstubAllEnvs());

const patient = `${ORCA_WIRE.patientPath}?id=K1&format=json`;
const get = () => connectJson("orca", patient);

describe("接続先の制限", () => {
  it("設定と許可リストがそろえば読める。許可リストが空（既定）・別のポートだけ・設定なしでは出ない", async () => {
    pointAt(mock);
    expect(await get()).toHaveProperty(ORCA_WIRE.patientRoot);

    vi.stubEnv("RESEMEN_CONNECT_ALLOW", "");
    expect((await failure(get)).kind).toBe("not_allowed");
    // 完全一致だけ（ホストだけ・別のポート・前方一致は通さない）
    vi.stubEnv("RESEMEN_CONNECT_ALLOW", `127.0.0.1, 127.0.0.1:${mock.port + 1}, 127.0.0.1:${mock.port}0`);
    expect((await failure(get)).kind).toBe("not_allowed");

    pointAt(mock);
    vi.stubEnv("RESEMEN_CONNECT_ORCA_URL", "");
    expect((await failure(get)).kind).toBe("config");
  });

  it("接続先の URL に認証情報を書かせない。コネクタ id は決まった文字だけ", async () => {
    pointAt(mock);
    vi.stubEnv("RESEMEN_CONNECT_ORCA_URL", `http://someone:secret-in-url@127.0.0.1:${mock.port}/orca`);
    const e = await failure(get);
    expect(e.kind).toBe("config");
    expect(e.message).not.toContain("secret-in-url");
    expect((await failure(() => connectJson("../x", patient))).kind).toBe("config");
  });

  it("http は、本番でない・ループバック・許可リストにある、がそろったときだけ", async () => {
    // ループバックでない http は、許可リストにあっても出ない
    pointAt(mock);
    vi.stubEnv("RESEMEN_CONNECT_ALLOW", "192.0.2.10:8000");
    vi.stubEnv("RESEMEN_CONNECT_ORCA_URL", "http://192.0.2.10:8000/orca");
    const plain = await failure(get);
    expect([plain.kind, plain.message]).toEqual(["not_allowed", expect.stringContaining("https")]);

    // 本番では、ループバックの http（模擬サーバー）の例外を持てない
    pointAt(mock);
    vi.stubEnv("NODE_ENV", "production");
    const prod = await failure(get);
    expect([prod.kind, prod.message]).toEqual(["not_allowed", expect.stringContaining("https")]);
  });

  it("本番では、プライベート・リンクローカル・ループバック宛てを、名前解決した IP で拒否する", async () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const host of ["10.0.0.5", "172.16.3.4", "192.168.1.1", "169.254.169.254", "127.0.0.1", "[::1]", "[fd00::1]", "[fe80::1]", "localhost"]) {
      vi.stubEnv("RESEMEN_CONNECT_ALLOW", `${host}:443`);
      vi.stubEnv("RESEMEN_CONNECT_ORCA_URL", `https://${host}/api`);
      const e = await failure(get);
      expect([host, e.kind, e.message]).toEqual([host, "not_allowed", expect.stringContaining("内部のアドレス")]);
    }
  });

  it("内部アドレスの判定", () => {
    for (const ip of ["10.1.2.3", "172.31.255.255", "192.168.0.1", "169.254.169.254", "127.0.0.53", "0.0.0.0", "::1", "::", "fc00::1", "fdff::1", "fe80::abcd", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "読めない値"]) {
      expect([ip, isInternalAddress(ip)]).toEqual([ip, true]);
    }
    // CGNAT・機器の試験用・マルチキャスト・予約済み・NAT64
    for (const ip of ["100.64.0.1", "100.127.255.255", "198.18.0.1", "198.19.255.255", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255", "ff02::1", "64:ff9b::a00:1", "::ffff:100.64.0.1"]) {
      expect([ip, isInternalAddress(ip)]).toEqual([ip, true]);
    }
    for (const ip of ["8.8.8.8", "172.32.0.1", "172.15.0.1", "192.167.1.1", "169.253.0.1", "2001:db8::1", "::ffff:8.8.8.8", "100.63.255.255", "100.128.0.1", "198.17.255.255", "198.20.0.1", "223.255.255.255", "64:ff9c::1", "fe00::1"]) {
      expect([ip, isInternalAddress(ip)]).toEqual([ip, false]);
    }
  });

  it("名前解決は 1 回だけ。検査のあとで解決器の答えが変わっても、検査済みの IP にしか接続しない", async () => {
    pointAt(mock);
    vi.stubEnv("RESEMEN_CONNECT_ALLOW", `localhost:${mock.port}`);
    vi.stubEnv("RESEMEN_CONNECT_ORCA_URL", `http://localhost:${mock.port}/orca`);
    // 1 回目は模擬サーバー（127.0.0.1）、2 回目からは別の IP を返す解決器（DNS リバインディングの再現）
    const resolve = vi.spyOn(dnsResolver, "resolve").mockResolvedValueOnce(["127.0.0.1"]).mockResolvedValue(["192.0.2.1"]);
    const request = vi.spyOn(http, "request");
    expect(await get()).toHaveProperty(ORCA_WIRE.patientRoot);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith("localhost");
    // 接続に渡した lookup は、何を聞かれても検査済みの IP だけを返す。ホスト名は元のまま渡っている（Host ヘッダ・証明書の照合に使われる）
    const opts = request.mock.calls[0][0] as http.RequestOptions;
    expect([opts.hostname, opts.agent]).toEqual(["localhost", false]);
    const asked: unknown[] = [];
    opts.lookup!("evil.example.net", { all: false }, (_e, address, family) => asked.push([address, family]));
    opts.lookup!("evil.example.net", { all: true }, (_e, list) => asked.push(list));
    expect(asked).toEqual([["127.0.0.1", 4], [{ address: "127.0.0.1", family: 4 }]]);
    // 模擬サーバーが受け取った Host は元のホスト名
    expect(request.mock.results[0].value.getHeader("host")).toBe(`localhost:${mock.port}`);
    vi.restoreAllMocks();
  });

  it("本番：解決した IP のどれか 1 つでも内部なら出ない。通った IP に固定して https で接続する（SNI・証明書の照合は元のホスト名）", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RESEMEN_CONNECT_ALLOW", "recept.example.test:443");
    vi.stubEnv("RESEMEN_CONNECT_ORCA_URL", "https://recept.example.test/api");
    const request = vi.spyOn(https, "request").mockImplementation(() => {
      throw new Error("ここで止める（実際には接続しない）");
    });
    const plain = vi.spyOn(http, "request");

    // 公開の IP と内部の IP が混ざった答え → 接続しない
    const resolve = vi.spyOn(dnsResolver, "resolve").mockResolvedValue(["203.0.113.10", "10.0.0.5"]);
    const mixed = await failure(get);
    expect([mixed.kind, mixed.message]).toEqual(["not_allowed", expect.stringContaining("内部のアドレス")]);
    expect(request).not.toHaveBeenCalled();

    // 1 回目は公開の IP、2 回目からは内部の IP を返す解決器 → 1 回目の IP に固定して接続しにいく
    resolve.mockReset().mockResolvedValueOnce(["203.0.113.10"]).mockResolvedValue(["169.254.169.254"]);
    expect((await failure(get)).kind).toBe("network");
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(plain).not.toHaveBeenCalled();
    const opts = request.mock.calls[0][0] as https.RequestOptions;
    // hostname が元の名前のまま＝ SNI と証明書の照合は元のホスト名で行われる。servername・rejectUnauthorized を上書きしていない
    expect([opts.protocol, opts.hostname, opts.port, opts.agent]).toEqual(["https:", "recept.example.test", "443", false]);
    expect("servername" in opts || "rejectUnauthorized" in opts || "checkServerIdentity" in opts).toBe(false);
    const asked: unknown[] = [];
    opts.lookup!("recept.example.test", { all: true }, (_e, list) => asked.push(list));
    expect(asked).toEqual([[{ address: "203.0.113.10", family: 4 }]]);
    vi.restoreAllMocks();
  });

  it("名前を解決できない・IP として読めない答えは、接続しない", async () => {
    pointAt(mock);
    vi.stubEnv("RESEMEN_CONNECT_ALLOW", `localhost:${mock.port}`);
    vi.stubEnv("RESEMEN_CONNECT_ORCA_URL", `http://localhost:${mock.port}/orca`);
    const resolve = vi.spyOn(dnsResolver, "resolve").mockRejectedValueOnce(new Error("ENOTFOUND secret-host"));
    const none = await failure(get);
    expect([none.kind, none.message]).toEqual(["network", expect.not.stringContaining("secret-host")]);
    resolve.mockResolvedValueOnce([]);
    expect((await failure(get)).kind).toBe("network");
    resolve.mockResolvedValueOnce(["not-an-ip"]);
    expect((await failure(get)).kind).toBe("network");
    vi.restoreAllMocks();
  });

  it("相対パスも絶対 URL も、設定した接続先の範囲（同じ origin・同じパスの下）に収まらなければ拒否する", () => {
    vi.stubEnv("RESEMEN_CONNECT_FHIR_URL", "https://emr.example.test/fhir");
    const { base } = connectorConfig("fhir");
    const ok = (t: string) => resolveTarget("fhir", base, t).href;
    expect(ok("Patient?identifier=a%7Cb")).toBe("https://emr.example.test/fhir/Patient?identifier=a%7Cb");
    expect(ok("https://emr.example.test/fhir/Encounter?_page=2")).toBe("https://emr.example.test/fhir/Encounter?_page=2");
    for (const bad of [
      "https://other.example.test/fhir/Patient",
      "http://emr.example.test/fhir/Patient",
      "https://emr.example.test:8443/fhir/Patient",
      "https://emr.example.test/admin",
      "https://emr.example.test/fhir/../admin",
      "https://emr.example.test/fhirx/Patient",
      "https://u:p@emr.example.test/fhir/Patient",
      "../admin",
      "//other.example.test/x/../../..",
      "\\\\other.example.test\\x\\..\\..\\..",
      "file:///etc/hosts",
    ]) {
      expect(() => resolveTarget("fhir", base, bad), bad).toThrow(/範囲の外|読めない/);
    }
  });
});

describe("応答の制限（模擬サーバーの壊した応答）", () => {
  it("リダイレクトには従わない", async () => {
    pointAt(mock, "redirect");
    expect((await failure(get)).kind).toBe("redirect");
  });

  it("時間内に応答がなければ打ち切る", async () => {
    pointAt(mock, "slow");
    vi.stubEnv("RESEMEN_CONNECT_TIMEOUT_MS", "150");
    const started = Date.now();
    expect((await failure(get)).kind).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("上限を超える応答は取り込まない（content-length が正しい・ない・小さく偽っている）", async () => {
    vi.stubEnv("RESEMEN_CONNECT_MAX_BYTES", "65536");
    pointAt(mock, "huge");
    expect((await failure(get)).kind).toBe("too_large");
    pointAt(mock, "huge-chunked");
    expect((await failure(get)).kind).toBe("too_large");
    // 偽った長さの分しか読まない（残りは読まない）ので、切れた JSON として拒否される
    pointAt(mock, "lying-length");
    expect(["format", "too_large", "network"]).toContain((await failure(get)).kind);
    // 上限以内の応答は読める
    pointAt(mock);
    expect(await get()).toHaveProperty(ORCA_WIRE.patientRoot);
  });

  it("content-type が JSON でない・本文が JSON でない応答は形式違い", async () => {
    pointAt(mock, "html");
    expect((await failure(get)).kind).toBe("format");
    pointAt(mock, "notjson");
    expect((await failure(get)).kind).toBe("format");
  });

  it("認証に失敗したら auth。相手の 404 は not_found、つながらなければ network", async () => {
    pointAt(mock);
    vi.stubEnv("RESEMEN_CONNECT_ORCA_PASSWORD", "wrong-password");
    const e = await failure(get);
    expect([e.kind, e.status]).toEqual(["auth", 401]);
    pointAt(mock);
    expect((await failure(() => connectJson("orca", "no/such/path"))).kind).toBe("not_found");
    // 閉じたポート
    const closed = await startMock();
    await closed.close();
    pointAt(closed);
    expect((await failure(get)).kind).toBe("network");
  });
});

describe("認証情報と応答の本文を外に出さない", () => {
  it("どの失敗でも、エラー（message・stack・JSON・cause）とコンソールに、認証情報・接続先のパス・応答の本文が出ない", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const basic = Buffer.from(`${mock.auth.orca.user}:${mock.auth.orca.password}`).toString("base64");
    const secrets = [mock.auth.orca.password, basic, mock.auth.fhir.token, "wrong-password", "patientgetv2", "id=K1", "これは JSON ではない", "login", "架空"];
    const cases: (() => void)[] = [
      () => pointAt(mock, "notjson"),
      () => pointAt(mock, "html"),
      () => pointAt(mock, "broken"),
      () => pointAt(mock, "redirect"),
      () => pointAt(mock, "huge"),
      () => (pointAt(mock), vi.stubEnv("RESEMEN_CONNECT_ORCA_PASSWORD", "wrong-password")),
      () => (pointAt(mock), vi.stubEnv("RESEMEN_CONNECT_ALLOW", "")),
      () => (pointAt(mock), vi.stubEnv("NODE_ENV", "production")),
    ];
    for (const setup of cases) {
      vi.unstubAllEnvs();
      setup();
      vi.stubEnv("RESEMEN_CONNECT_MAX_BYTES", "65536");
      // broken は JSON としては読めるので、ここでは成功してよい（スキーマの検査はコネクタ側。connectors.test.ts）
      const e = await get().then(
        () => null,
        (x) => x,
      );
      if (e === null) continue;
      const shown = [String(e), e.message, e.stack, JSON.stringify(e), JSON.stringify(Object.getOwnPropertyNames(e).map((k) => e[k])), String(e.cause)].join("\n");
      for (const s of secrets) expect(shown, s).not.toContain(s);
      expect(e.cause).toBeUndefined();
    }
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
  });
});
