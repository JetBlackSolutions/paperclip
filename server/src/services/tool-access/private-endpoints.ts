import { parsePrivateEndpointAllowlist } from "../remote-http-endpoint-guard.js";

const MCP_PRIVATE_ENDPOINT_ALLOWLIST_ENV = "PAPERCLIP_MCP_PRIVATE_ENDPOINT_ALLOWLIST";

/**
 * Exact origins remote MCP connections may reach on a private network even when
 * a public authenticated deployment otherwise blocks private addresses, such as
 * a self-hosted server over a private link: `http://10.10.0.1:3000`. Comma-separated.
 * A listed origin may also use plain HTTP, since the operator vouches for the link.
 */
export function mcpPrivateEndpointAllowlist(
  raw = process.env[MCP_PRIVATE_ENDPOINT_ALLOWLIST_ENV] ?? "",
): ReadonlySet<string> {
  return parsePrivateEndpointAllowlist(raw);
}
