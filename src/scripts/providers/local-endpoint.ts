/**
 * Helpers for the `local` provider, whose base URL is whatever OpenAI-compatible
 * server the user runs: `http://localhost:11434/v1`, but just as often a box on
 * the LAN or a VPN (`http://192.168.1.20:8080/v1`, `http://gpu.local:8080/v1`).
 *
 * Browsers guard those requests twice over: an https page may not load plain
 * http subresources (mixed content), and reaching a private address needs the
 * Local Network Access permission. Both are relaxed only when the browser can
 * tell the target is local *before* resolving it — an IP literal, a `.local`
 * name, or a request annotated with `targetAddressSpace: "local"`.
 */

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Strips the brackets IPv6 authorities carry in a URL (`[::1]` → `::1`). */
const bareHost = (host: string) => host.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();

/** Loopback is a trustworthy origin: plain http works from an https page. */
export function isLoopbackHost(host: string): boolean {
  const h = bareHost(host);
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  const ip = IPV4.exec(h);
  return ip ? Number(ip[1]) === 127 : false;
}

/**
 * Private address literals: RFC 1918, CGNAT (Tailscale & co. hand out
 * 100.64/10) and link-local. Loopback is deliberately excluded — it has its own
 * address space and must not be annotated as `local`.
 */
function isPrivateIPv4(host: string): boolean {
  const ip = IPV4.exec(bareHost(host));
  if (!ip) return false;
  const octets = ip.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return a === 100 && b >= 64 && b <= 127;
}

/** `fc00::/7` unique-local and `fe80::/10` link-local IPv6. */
function isPrivateIPv6(host: string): boolean {
  const h = bareHost(host);
  if (!h.includes(":")) return false;
  return /^f[cd]/.test(h) || /^fe[89ab]/.test(h);
}

/**
 * Hosts the browser can classify as local up front, so the Local Network Access
 * permission (and with it the mixed-content exemption) can apply.
 */
export function isLocalNetworkHost(host: string): boolean {
  const h = bareHost(host);
  if (!h || isLoopbackHost(h)) return false;
  if (isPrivateIPv4(h) || isPrivateIPv6(h)) return true;
  if (h.endsWith(".local")) return true;
  // Single-label names (`gpu`, `nas`) only resolve inside a local network.
  return !h.includes(".") && !h.includes(":");
}

const parse = (url: string): URL | null => {
  try {
    return new URL(url.trim());
  } catch {
    return null;
  }
};

/**
 * Extra `fetch` init for user-supplied endpoints. Annotating LAN requests with
 * `targetAddressSpace` is what lets a `.local` or single-label host through;
 * browsers without Local Network Access ignore the unknown key.
 */
export function localFetchInit(url: string): RequestInit {
  const parsed = parse(url);
  if (!parsed || !isLocalNetworkHost(parsed.hostname)) return {};
  return { targetAddressSpace: "local" } as RequestInit;
}

/**
 * Why the browser refused a local endpoint, with the way out. Returns null when
 * the URL is one browsers are happy to fetch and the failure is something else
 * (server down, CORS, wrong path).
 */
export function localEndpointBlockReason(
  url: string,
  pageProtocol = typeof location === "undefined" ? "https:" : location.protocol,
): string | null {
  const parsed = parse(url);
  const example = "Use the full base URL, e.g. http://192.168.1.20:8080/v1";
  if (!parsed) return `"${url.trim()}" is not a valid URL. ${example}`;
  if (parsed.protocol === "https:") return null;
  // `new URL("gpu.local:8080")` parses, with "gpu.local:" as the scheme.
  if (parsed.protocol !== "http:") return `"${url.trim()}" is missing the http:// prefix. ${example}`;
  const host = parsed.hostname;
  if (isLoopbackHost(host) || pageProtocol !== "https:") return null;
  const port = parsed.port || "8080";
  const forward = `ssh -L ${port}:localhost:${port} ${host}`;
  return isLocalNetworkHost(host)
    ? `The browser blocks http://${parsed.host} from this https page until you allow local network access — accept the prompt, serve the model over https, or forward it to localhost: ${forward}`
    : `The browser blocks http://${parsed.host} from this https page (mixed content). Use its LAN IP or a .local name so the browser can treat it as local, serve it over https, or forward it to localhost: ${forward}`;
}
