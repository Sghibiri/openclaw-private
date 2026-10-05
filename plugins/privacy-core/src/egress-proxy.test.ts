// The egress proxy over real loopback sockets: HTTPS CONNECT to allowlisted
// public hosts on 443 passes; plain HTTP, other ports, other hosts, private
// addresses and an unsafe config get 403, and refusals are recorded once.
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  resetServiceRegistryForTest,
  serviceState,
} from "../../../shared/rules/service-registry.js";
import { createEgressProxy, isNonPublicAddress, type EgressProxy } from "./egress-proxy.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
  resetServiceRegistryForTest();
});

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return (server.address() as AddressInfo).port;
}

async function startProxy(params: {
  allow: string[];
  allowImap?: string[];
  addresses?: Record<string, string[]>;
  guard?: () => string | undefined;
}) {
  const echo = net.createServer((socket) => socket.pipe(socket));
  const echoPort = await listen(echo);
  const refused: string[] = [];
  const dialed: string[] = [];
  const ports: number[] = [];
  const proxy: EgressProxy = createEgressProxy({
    port: 0,
    allow: () => params.allow,
    ...(params.allowImap ? { allowImap: () => params.allowImap ?? [] } : {}),
    guard: params.guard,
    onRefused: (host, reason) => refused.push(`${reason}:${host}`),
    resolve: async (host) => params.addresses?.[host] ?? ["93.184.216.34"],
    // Every public upstream is the local echo server.
    connect: (port, address) => {
      dialed.push(address);
      ports.push(port);
      return net.connect(echoPort, "127.0.0.1");
    },
  });
  const url = new URL(await proxy.start());
  cleanups.push(() => proxy.stop());
  return { proxyPort: Number(url.port), refused, dialed, ports };
}

function connectViaProxy(
  proxyPort: number,
  authority: string,
): Promise<{ status: number; echo?: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port: proxyPort,
      method: "CONNECT",
      path: authority,
    });
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        resolve({ status: res.statusCode ?? 0 });
        return;
      }
      socket.once("data", (data) => {
        socket.destroy();
        resolve({ status: 200, echo: data.toString() });
      });
      socket.write("ping");
    });
    req.on("error", reject);
    req.end();
  });
}

function plainHttpViaProxy(proxyPort: number, target: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: proxyPort, method: "GET", path: target },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("privacy egress proxy", () => {
  it("tunnels HTTPS to allowlisted hosts, including *.domain patterns, and reports itself up", async () => {
    const { proxyPort, dialed } = await startProxy({ allow: ["*.tinfoil.sh"] });
    expect(serviceState("privacy-egress-proxy")?.up).toBe(true);
    await expect(connectViaProxy(proxyPort, "router.tinfoil.sh:443")).resolves.toEqual({
      status: 200,
      echo: "ping",
    });
    expect(dialed).toEqual(["93.184.216.34"]);
    await expect(connectViaProxy(proxyPort, "tinfoil.sh:443")).resolves.toEqual({ status: 403 });
  });

  it("refuses plain HTTP, other ports and other hosts, recording each refusal once", async () => {
    const { proxyPort, refused } = await startProxy({ allow: ["api.example.com"] });
    await expect(plainHttpViaProxy(proxyPort, "http://api.example.com/x")).resolves.toBe(403);
    await expect(connectViaProxy(proxyPort, "api.example.com:80")).resolves.toEqual({
      status: 403,
    });
    await expect(connectViaProxy(proxyPort, "evil.example.org:443")).resolves.toEqual({
      status: 403,
    });
    await expect(connectViaProxy(proxyPort, "evil.example.org:443")).resolves.toEqual({
      status: 403,
    });
    expect(refused).toEqual([
      "not_https:api.example.com",
      "not_allowlisted:api.example.com",
      "not_allowlisted:evil.example.org",
    ]);
  });

  it("refuses an allowlisted name that resolves to a private or loopback address", async () => {
    const { proxyPort, refused, dialed } = await startProxy({
      allow: ["api.example.com"],
      addresses: { "api.example.com": ["127.0.0.1"] },
    });
    await expect(connectViaProxy(proxyPort, "api.example.com:443")).resolves.toEqual({
      status: 403,
    });
    expect(refused).toEqual(["private_address:api.example.com"]);
    expect(dialed).toEqual([]);
  });

  it("refuses everything while the privacy config is unsafe", async () => {
    const { proxyPort, refused } = await startProxy({
      allow: ["api.example.com"],
      guard: () => "the privacy config has 1 problem",
    });
    await expect(connectViaProxy(proxyPort, "api.example.com:443")).resolves.toEqual({
      status: 403,
    });
    expect(refused).toEqual(["config_unsafe:api.example.com"]);
  });

  it("classifies non-public addresses", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.1",
      "192.168.1.1",
      "169.254.1.1",
      "100.64.0.1",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "0.0.0.0",
    ]) {
      expect(isNonPublicAddress(address), address).toBe(true);
    }
    for (const address of ["93.184.216.34", "2606:4700::1111"]) {
      expect(isNonPublicAddress(address), address).toBe(false);
    }
  });
});

describe("egress proxy: the mail port", () => {
  it("opens port 993 only to the connected mail provider, and 443 stays as it was", async () => {
    const { proxyPort, refused, ports } = await startProxy({
      allow: ["api.tinfoil.sh", "calendar.google.com"],
      allowImap: ["imap.gmail.com"],
    });
    expect(await connectViaProxy(proxyPort, "imap.gmail.com:993")).toEqual({
      status: 200,
      echo: "ping",
    });
    expect(ports).toEqual([993]);
    // The mail host is not reachable on other ports, and other hosts not on 993.
    expect((await connectViaProxy(proxyPort, "imap.gmail.com:443")).status).toBe(403);
    expect((await connectViaProxy(proxyPort, "api.tinfoil.sh:993")).status).toBe(403);
    expect((await connectViaProxy(proxyPort, "imap.evil.example:993")).status).toBe(403);
    expect((await connectViaProxy(proxyPort, "calendar.google.com:443")).status).toBe(200);
    expect(refused).toEqual([
      "not_allowlisted:imap.gmail.com",
      "not_allowlisted:api.tinfoil.sh",
      "not_allowlisted:imap.evil.example",
    ]);
  });

  it("keeps port 993 closed when no mailbox is connected", async () => {
    const { proxyPort } = await startProxy({ allow: ["imap.gmail.com"] });
    expect((await connectViaProxy(proxyPort, "imap.gmail.com:993")).status).toBe(403);
  });

  it("refuses a mail host that resolves into the local network", async () => {
    const { proxyPort, refused } = await startProxy({
      allow: [],
      allowImap: ["imap.gmail.com"],
      addresses: { "imap.gmail.com": ["192.168.1.10"] },
    });
    expect((await connectViaProxy(proxyPort, "imap.gmail.com:993")).status).toBe(403);
    expect(refused).toEqual(["private_address:imap.gmail.com"]);
  });
});
