/**
 * Environment, validated at the point of use rather than at import. Nothing
 * here runs when a module is merely imported, so the unit tests and `npm run
 * probe` do not need a full production environment to load a file.
 */

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`Missing required env var ${name}. See .env.example.`);
  }
  return value.trim();
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export const config = {
  slack: {
    get botToken(): string {
      return required("SLACK_BOT_TOKEN");
    },
    get signingSecret(): string {
      return required("SLACK_SIGNING_SECRET");
    },
  },
  midland: {
    get baseUrl(): string {
      return trimTrailingSlash(required("MIDLAND_BASE_URL"));
    },
    /** Both default off the base URL; discovery fills the token endpoint in. */
    get mcpUrl(): string | undefined {
      return optional("MIDLAND_MCP_URL");
    },
    get tokenUrl(): string | undefined {
      return optional("MIDLAND_TOKEN_URL");
    },
    get clientId(): string {
      return required("MIDLAND_CLIENT_ID");
    },
    get clientSecret(): string {
      return required("MIDLAND_CLIENT_SECRET");
    },
  },
  anthropic: {
    get apiKey(): string {
      return required("ANTHROPIC_API_KEY");
    },
    get model(): string {
      return optional("ANTHROPIC_MODEL") ?? "claude-opus-5";
    },
  },
  get port(): number {
    return Number(optional("PORT") ?? 3000);
  },
  /** Writes are off until you deliberately turn them on. */
  get dryRun(): boolean {
    return (optional("DRY_RUN") ?? "true").toLowerCase() !== "false";
  },
} as const;

export function mcpUrl(): string {
  return config.midland.mcpUrl ?? `${config.midland.baseUrl}/api/mcp`;
}
