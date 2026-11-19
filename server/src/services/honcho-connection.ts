import { connectionInstructionsConfig, type AppDefinition } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

type ConfiguredConnection = { config: Record<string, unknown>; transportConfig?: Record<string, unknown> };

const SELF_HOSTED_HONCHO_MCP_URL_ENV = "PAPERCLIP_HONCHO_MCP_URL";

/**
 * The Honcho MCP server this instance uses instead of Honcho's hosted
 * `https://mcp.honcho.dev`, for a self-hosted Honcho: for example
 * `http://10.10.0.1:3000/mcp`. Honcho's MCP server reads its own API address
 * from `HONCHO_API_URL`. A private address must also be listed in
 * `PAPERCLIP_MCP_PRIVATE_ENDPOINT_ALLOWLIST` on a public deployment.
 */
export function selfHostedHonchoMcpUrl(
  raw = process.env[SELF_HOSTED_HONCHO_MCP_URL_ENV] ?? "",
): string | null {
  const value = raw.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw unprocessable(`${SELF_HOSTED_HONCHO_MCP_URL_ENV} is not a valid URL`);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.hash)
    throw unprocessable(`${SELF_HOSTED_HONCHO_MCP_URL_ENV} must be an http(s) URL without credentials`);
  return url.toString();
}

/** Point Honcho's catalog method at this instance's self-hosted Honcho MCP server, when one is configured. */
export function appWithSelfHostedHoncho(app: AppDefinition, serverUrl = selfHostedHonchoMcpUrl()): AppDefinition {
  if (app.slug !== "honcho" || !serverUrl) return app;
  return {
    ...app,
    methods: app.methods.map((method) =>
      method.transport === "mcp_remote" && method.defaults?.serverUrl
        ? { ...method, defaults: { ...method.defaults, serverUrl } }
        : method),
  };
}

/** Honcho's workspace is connection configuration, independent of its prompt. */
export function honchoWorkspace(connection: ConfiguredConnection): string | null {
  const config = connectionInstructionsConfig(connection);
  if (config.sourceTemplateKey !== "honcho") return null;
  const settings = config.methodConfig;
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  const value = (settings as Record<string, unknown>).workspaceId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function honchoManagedArguments(
  connection: ConfiguredConnection,
  schema: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const workspace = honchoWorkspace(connection);
  const properties = schema.properties;
  return workspace && properties && typeof properties === "object" && "workspace_id" in properties
    ? { workspace_id: workspace }
    : undefined;
}
