import { config } from "./config.ts";

/**
 * Sento machine connections authenticate with a connection key: one
 * long-lived value, created by a workspace admin and shown once, sent as the
 * Authorization bearer on every request. There is no token endpoint, nothing
 * to mint, exchange, or refresh — the key is the whole credential.
 *
 * That makes a 401 unambiguous: the key (or the connection it belongs to) was
 * revoked. It never means "expired, try again". A retry loop cannot restore
 * access that no longer exists, so the correct response to a 401 is to stop
 * and tell whoever manages the workspace.
 */
export function getSentoKey(): string {
  return config.sento.connectionKey;
}
