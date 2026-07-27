import { describe, expect, it } from "vitest";
import {
  isLocalNetworkHost,
  isLoopbackHost,
  localEndpointBlockReason,
  localFetchInit,
} from "./local-endpoint";

describe("local endpoint", () => {
  it("recognises loopback hosts", () => {
    for (const host of ["localhost", "app.localhost", "127.0.0.1", "127.1.2.3", "[::1]", "::1"]) {
      expect(isLoopbackHost(host)).toBe(true);
      expect(isLocalNetworkHost(host)).toBe(false);
    }
    expect(isLoopbackHost("192.168.1.20")).toBe(false);
    expect(isLoopbackHost("openrouter.ai")).toBe(false);
  });

  it("recognises LAN and VPN hosts", () => {
    for (const host of [
      "192.168.17.24",
      "10.0.0.5",
      "172.16.4.1",
      "172.31.255.254",
      "169.254.10.1",
      "100.101.102.103", // Tailscale CGNAT
      "[fd7a:115c::1]",
      "gpu.local",
      "nas",
    ]) {
      expect(isLocalNetworkHost(host)).toBe(true);
    }
    for (const host of ["172.32.0.1", "8.8.8.8", "256.1.1.1", "api.openai.com", ""]) {
      expect(isLocalNetworkHost(host)).toBe(false);
    }
  });

  it("annotates only LAN requests so the local network permission can apply", () => {
    expect(localFetchInit("http://192.168.17.24:8080/v1")).toEqual({
      targetAddressSpace: "local",
    });
    expect(localFetchInit("http://gpu.local:8080/v1")).toEqual({ targetAddressSpace: "local" });
    expect(localFetchInit("http://localhost:11434/v1")).toEqual({});
    expect(localFetchInit("https://models.example.com/v1")).toEqual({});
    expect(localFetchInit("not a url")).toEqual({});
  });

  it("explains why the browser blocks a plain-http LAN endpoint", () => {
    const reason = localEndpointBlockReason("http://192.168.17.24:8080/v1", "https:");
    expect(reason).toContain("local network access");
    expect(reason).toContain("ssh -L 8080:localhost:8080 192.168.17.24");
  });

  it("tells apart a host the browser cannot classify as local", () => {
    expect(localEndpointBlockReason("http://models.example.com:8080/v1", "https:")).toContain(
      "mixed content",
    );
  });

  it("stays quiet when the browser has no objection", () => {
    expect(localEndpointBlockReason("http://localhost:11434/v1", "https:")).toBeNull();
    expect(localEndpointBlockReason("http://127.0.0.1:8080/v1", "https:")).toBeNull();
    expect(localEndpointBlockReason("https://192.168.17.24:8080/v1", "https:")).toBeNull();
    // A dev server on http can reach the LAN just fine.
    expect(localEndpointBlockReason("http://192.168.17.24:8080/v1", "http:")).toBeNull();
  });

  it("flags a base URL that is not a URL at all", () => {
    expect(localEndpointBlockReason("192.168.17.24:8080", "https:")).toContain("not a valid URL");
    expect(localEndpointBlockReason("gpu.local:8080", "https:")).toContain("missing the http://");
  });
});
