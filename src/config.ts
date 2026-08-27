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
    /** Socket Mode. Present means dial out; absent means listen on HTTP. */
    get appToken(): string {
      return required("SLACK_APP_TOKEN");
    },
    get hasAppToken(): boolean {
      return optional("SLACK_APP_TOKEN") !== undefined;
    },
  },
  sento: {
    get baseUrl(): string {
      return trimTrailingSlash(required("SENTO_BASE_URL"));
    },
    /** Defaults off the base URL. */
    get mcpUrl(): string | undefined {
      return optional("SENTO_MCP_URL");
    },
    /**
     * The connection key from the Members panel, shown once at creation. It
     * does not expire and is the entire credential; a 401 means it was
     * revoked. Lives in the environment, never in source.
     */
    get connectionKey(): string {
      return required("SENTO_CONNECTION_KEY");
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
  return config.sento.mcpUrl ?? `${config.sento.baseUrl}/api/mcp`;
}
