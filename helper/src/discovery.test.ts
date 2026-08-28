import { describe, expect, test } from "bun:test";
import { type Service } from "bonjour-service";
import { preferredScanners, toScanner, type Scanner } from "./discovery";

function scanner(partial: Partial<Scanner> & Pick<Scanner, "id" | "host" | "port" | "baseUrl">): Scanner {
  return {
    name: partial.name ?? partial.host,
    model: partial.model ?? "HP OfficeJet Pro 7740",
    sources: [],
    duplex: true,
    isSimulator: false,
    isManual: false,
    lastSeen: 0,
    ...partial,
  };
}

describe("preferredScanners", () => {
  test("keeps HTTP :8080 over HTTPS :443 on the same host", () => {
    const http = scanner({
      id: "uuid-http",
      host: "192.168.1.50",
      port: 8080,
      baseUrl: "http://192.168.1.50:8080/eSCL",
    });
    const https = scanner({
      id: "uuid-https",
      host: "192.168.1.50",
      port: 443,
      baseUrl: "https://192.168.1.50/eSCL",
    });

    expect(preferredScanners([https, http])).toEqual([http]);
    expect(preferredScanners([http, https])).toEqual([http]);
  });

  test("keeps :8080 over port 80 on the same host", () => {
    const eSCL = scanner({
      id: "host-8080",
      host: "192.168.1.50",
      port: 8080,
      baseUrl: "http://192.168.1.50:8080/eSCL",
    });
    const webUi = scanner({
      id: "host-80",
      host: "192.168.1.50",
      port: 80,
      baseUrl: "http://192.168.1.50/eSCL",
    });

    expect(preferredScanners([webUi, eSCL])).toEqual([eSCL]);
  });

  test("hides a manual bare-IP entry when discovery found :8080", () => {
    const discovered = scanner({
      id: "uuid",
      host: "192.168.1.50",
      port: 8080,
      baseUrl: "http://192.168.1.50:8080/eSCL",
    });
    const manual = scanner({
      id: "manual-192.168.1.50-80",
      host: "192.168.1.50",
      port: 80,
      baseUrl: "http://192.168.1.50/eSCL",
      isManual: true,
      name: "192.168.1.50",
    });

    expect(preferredScanners([discovered, manual])).toEqual([discovered]);
  });

  test("keeps printers on different hosts", () => {
    const a = scanner({
      id: "a",
      host: "192.168.1.50",
      port: 8080,
      baseUrl: "http://192.168.1.50:8080/eSCL",
    });
    const b = scanner({
      id: "b",
      host: "192.168.1.51",
      port: 8090,
      baseUrl: "http://192.168.1.51:8090/eSCL",
      isSimulator: true,
    });

    expect(preferredScanners([a, b])).toEqual([a, b]);
  });

  test("keeps a port-80 scanner when it is the only advertisement", () => {
    const only = scanner({
      id: "only",
      host: "192.168.1.50",
      port: 80,
      baseUrl: "http://192.168.1.50/eSCL",
    });

    expect(preferredScanners([only])).toEqual([only]);
  });
});

function fakeService(port: number, txt: Record<string, string>): Service {
  return {
    name: "HP OfficeJet Pro 7740",
    host: "HP7740.local",
    port,
    addresses: ["192.168.1.50"],
    txt,
  } as Service;
}

describe("toScanner", () => {
  test("treats HP's uppercase UUID TXT key as the stable id", () => {
    const txt = {
      UUID: "1c852a4d-b800-1f08-abcd-843497f7816c",
      rs: "eSCL",
      ty: "HP OfficeJet Pro 7740",
    };
    const http = toScanner(fakeService(8080, txt), false);
    const https = toScanner(fakeService(443, txt), true);

    expect(http?.id).toBe(txt.UUID);
    expect(https?.id).toBe(txt.UUID);
    expect(http?.port).toBe(8080);
    expect(https?.port).toBe(443);
  });
});
