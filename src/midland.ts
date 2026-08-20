import { config } from "./config.ts";
import { log } from "./log.ts";

/**
 * Midland's own OAuth 2.1 server issues machine-writer tokens through the
 * client_credentials grant. The access token expires within the working day and
 * there is no refresh token, so the only two correct shapes are mint-per-run
 * and re-mint-on-401. This module does both: it caches a token until shortly
 * before expiry, and `forceRefresh` throws the cache away when a call comes
 * back unauthorized.
 *
 * The failure this avoids: a process that mints once at startup stops writing
 * partway through the day, silently. Nothing in Midland detects that for you.
 */

/** Re-mint this long before the server's own expiry, to cover clock skew. */
const EXPIRY_MARGIN_SECONDS = 60;

type CachedToken = { value: string; expiresAtMs: number };

let cached: CachedToken | undefined;
let discoveredTokenUrl: string | undefined;

const TokenResponse = (body: unknown): { access_token: string; expires_in?: number } => {
  if (typeof body !== "object" || body === null) throw new Error("Token response was not an object.");
  const record = body as Record<string, unknown>;
  if (typeof record.access_token !== "string" || record.access_token === "") {
    throw new Error("Token response carried no access_token.");
  }
  const expiresIn = typeof record.expires_in === "number" ? record.expires_in : undefined;
  return { access_token: record.access_token, expires_in: expiresIn };
};

/**
 * RFC 8414 discovery, so the token endpoint comes from the server rather than
 * from a path guessed here. Falls back to the conventional route.
 */
async function resolveTokenUrl(): Promise<string> {
  if (config.midland.tokenUrl !== undefined) return config.midland.tokenUrl;
  if (discoveredTokenUrl !== undefined) return discoveredTokenUrl;

  const wellKnown = `${config.midland.baseUrl}/.well-known/oauth-authorization-server`;
  try {
    const response = await fetch(wellKnown, { headers: { accept: "application/json" } });
    if (response.ok) {
      const body = (await response.json()) as Record<string, unknown>;
      if (typeof body.token_endpoint === "string" && body.token_endpoint !== "") {
        discoveredTokenUrl = body.token_endpoint;
        log.info(`Discovered token endpoint ${discoveredTokenUrl}`);
        return discoveredTokenUrl;
      }
    }
    log.warn(`Discovery at ${wellKnown} returned ${response.status}; falling back to the default route.`);
  } catch (err) {
    log.warn("Discovery failed; falling back to the default route.", err);
  }

  discoveredTokenUrl = `${config.midland.baseUrl}/api/oauth/token`;
  return discoveredTokenUrl;
}

async function mint(): Promise<CachedToken> {
  const tokenUrl = await resolveTokenUrl();
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: config.midland.clientId,
      client_secret: config.midland.clientSecret,
    }),
  });

  if (!response.ok) {
    // Never echo the body: it can carry the credential back at you.
    throw new Error(
      `Minting a Midland token failed with ${response.status}. ` +
        `A repeated 401 here means the credential is revoked or disabled, which is an operator problem, not a retry.`,
    );
  }

  const parsed = TokenResponse(await response.json());
  const lifetime = parsed.expires_in ?? 15 * 60;
  return {
    value: parsed.access_token,
    expiresAtMs: Date.now() + Math.max(lifetime - EXPIRY_MARGIN_SECONDS, 30) * 1000,
  };
}

/** A token good for right now. Mints one if the cache is empty or near expiry. */
export async function getMidlandToken(): Promise<string> {
  if (cached !== undefined && cached.expiresAtMs > Date.now()) return cached.value;
  cached = await mint();
  log.info("Minted a Midland access token.");
  return cached.value;
}

/** Throw the cached token away so the next call mints a fresh one. */
export function forceRefresh(): void {
  cached = undefined;
}
