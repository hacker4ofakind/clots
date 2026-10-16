import { randomBytes } from "node:crypto";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformation, OAuthClientInformationFull, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Store } from "../store.js";

/** How long a login link can be used. */
export const LOGIN_TTL_MS = 10 * 60_000;

const stateKey = (state: string) => `oauth-state:${state}`;

/**
 * The server a login's `state` was made for, once: the state is forgotten when it is read, and
 * one older than ten minutes names nothing.
 */
export function consumeLoginState(store: Store, state: string, now: number): string | undefined {
  const saved = store.getState(stateKey(state));
  if (saved === undefined) return undefined;
  store.deleteState(stateKey(state));
  const { server, at } = JSON.parse(saved) as { server: string; at: number };
  return now - at <= LOGIN_TTL_MS ? server : undefined;
}

/**
 * One MCP server's OAuth login, kept in the daemon's database: the client it registered as, its
 * tokens, and the code verifier of a login in progress (which never leaves the daemon). A login
 * link is handed to `onLink`, for the daemon to post in chat.
 */
export class StoredOAuth implements OAuthClientProvider {
  constructor(private o: { server: string; store: Store; redirectUrl: string; now: () => number; onLink: (url: string) => void }) {}

  private read<T>(what: string): T | undefined {
    const value = this.o.store.getState(`oauth:${this.o.server}:${what}`);
    return value === undefined ? undefined : (JSON.parse(value) as T);
  }

  private write(what: string, value: unknown): void {
    this.o.store.setState(`oauth:${this.o.server}:${what}`, JSON.stringify(value));
  }

  get redirectUrl(): string {
    return this.o.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return { client_name: "Clots", redirect_uris: [this.o.redirectUrl], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  }

  state(): string {
    const state = randomBytes(24).toString("base64url");
    this.o.store.setState(stateKey(state), JSON.stringify({ server: this.o.server, at: this.o.now() }));
    return state;
  }

  clientInformation(): OAuthClientInformation | undefined {
    return this.read<OAuthClientInformation>("client");
  }

  saveClientInformation(info: OAuthClientInformationFull): void {
    this.write("client", info);
  }

  tokens(): OAuthTokens | undefined {
    return this.read<OAuthTokens>("tokens");
  }

  saveTokens(tokens: OAuthTokens): void {
    this.write("tokens", tokens);
  }

  redirectToAuthorization(url: URL): void {
    this.o.onLink(url.toString());
  }

  saveCodeVerifier(verifier: string): void {
    this.write("verifier", verifier);
  }

  codeVerifier(): string {
    const verifier = this.read<string>("verifier");
    if (typeof verifier !== "string") throw new Error("no login is in progress for this server");
    return verifier;
  }

  /** Forgets what the SDK says is no longer good. The daemon keeps no discovery state of its own, so "discovery" forgets nothing. */
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "discovery") return;
    for (const what of scope === "all" ? ["client", "tokens", "verifier"] : [scope]) this.o.store.deleteState(`oauth:${this.o.server}:${what}`);
  }

  /** Whether the server has given tokens. */
  loggedIn(): boolean {
    return this.tokens() !== undefined;
  }
}
