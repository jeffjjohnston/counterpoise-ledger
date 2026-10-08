import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { resetTestDatabase, setupTestDatabase } from "../helpers/db-utils";
import { count, exec, row } from "../helpers/sql";
import { sessionHttpClient, startHttpTestServer } from "../helpers/http-parity";

/**
 * OAuth 2.1 for /api/mcp (rust-api/server/src/oauth/): discovery, client
 * registration, the consent calls, the token endpoint, and the token's use.
 * The server's public URL is its test address, so the issuer is
 * `http://127.0.0.1:<port>`.
 */

const CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
};

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

describe("MCP OAuth", () => {
  let baseUrl: string;
  let stop: () => Promise<void>;
  let session: Awaited<ReturnType<typeof sessionHttpClient>>;

  const url = (path: string) => new URL(path, baseUrl).toString();

  // Each registration counts against a per-address limit. The test server
  // trusts X-Forwarded-For, so each call gives a new address.
  let registrations = 0;
  const register = async (body: Record<string, unknown> = {}) =>
    fetch(url("/api/oauth/register"), {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `203.0.113.${++registrations % 250}` },
      body: JSON.stringify({
        client_name: "Claude",
        redirect_uris: [CALLBACK],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: "claudeai",
        ...body,
      }),
    });

  const registeredClient = async (): Promise<string> => {
    const response = await register();
    expect(response.status).toBe(201);
    return ((await response.json()) as { client_id: string }).client_id;
  };

  const authorizationQuery = (
    clientId: string,
    challenge: string,
    extra: Record<string, string> = {}
  ) =>
    new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: CALLBACK,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "state-123",
      resource: `${baseUrl}/api/mcp`,
      ...extra,
    }).toString();

  const decide = async (query: string, approve: boolean) => {
    const response = await session.request("/api/oauth/consent", {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ query, approve }),
    });
    return { status: response.status, body: (await response.json()) as { redirectTo?: string; error?: string } };
  };

  const token = (parameters: Record<string, string>) =>
    fetch(url("/api/oauth/token"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(parameters).toString(),
    });

  /** The whole flow for user 1: a client, consent, and the code exchange. */
  const connect = async () => {
    const clientId = await registeredClient();
    const { verifier, challenge } = pkce();
    const { body } = await decide(authorizationQuery(clientId, challenge), true);
    const code = new URL(body.redirectTo!).searchParams.get("code")!;
    const response = await token({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: CALLBACK,
      resource: `${baseUrl}/api/mcp`,
    });
    expect(response.status).toBe(200);
    const tokens = (await response.json()) as { access_token: string; refresh_token: string };
    return { clientId, code, verifier, ...tokens };
  };

  const mcp = (accessToken: string, body: unknown = INITIALIZE) =>
    fetch(url("/api/mcp"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });

  const listBooks = async (accessToken: string) => {
    const response = await mcp(accessToken, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "list_books", arguments: {} },
    });
    return { status: response.status, body: (await response.json()) as { result?: { content: { text: string }[]; isError?: boolean } } };
  };

  beforeAll(async () => {
    await setupTestDatabase();
    ({ baseUrl, stop } = await startHttpTestServer((base) => ({ COUNTERPOISE_PUBLIC_URL: base })));
  }, 120_000);

  beforeEach(async () => {
    await resetTestDatabase();
    session = await sessionHttpClient(baseUrl);
  });

  afterAll(async () => {
    await stop();
  });

  describe("discovery", () => {
    it("answers a request without a token with a challenge that names the metadata", async () => {
      const response = await fetch(url("/api/mcp"), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify(INITIALIZE),
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe(
        `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource/api/mcp", scope="mcp"`
      );
      const bad = await mcp(`cpo_${"0".repeat(64)}`);
      expect(bad.status).toBe(401);
      expect(bad.headers.get("www-authenticate")).toMatch(/^Bearer error="invalid_token", resource_metadata=/);
    });

    it("serves the protected resource metadata at both well-known paths", async () => {
      for (const path of ["/.well-known/oauth-protected-resource/api/mcp", "/.well-known/oauth-protected-resource"]) {
        const response = await fetch(url(path));
        expect(response.status).toBe(200);
        expect(response.headers.get("access-control-allow-origin")).toBe("*");
        expect(await response.json()).toEqual({
          resource: `${baseUrl}/api/mcp`,
          authorization_servers: [baseUrl],
          scopes_supported: ["mcp"],
          bearer_methods_supported: ["header"],
          resource_name: "Counterpoise",
        });
      }
    });

    it("serves the authorization server metadata that Claude needs", async () => {
      const response = await fetch(url("/.well-known/oauth-authorization-server"));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/api/oauth/authorize`,
        token_endpoint: `${baseUrl}/api/oauth/token`,
        registration_endpoint: `${baseUrl}/api/oauth/register`,
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        client_id_metadata_document_supported: true,
        authorization_response_iss_parameter_supported: true,
      });
    });
  });

  describe("registration", () => {
    it("registers a public client", async () => {
      const response = await register();
      expect(response.status).toBe(201);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.json();
      expect(body).toMatchObject({
        client_name: "Claude",
        redirect_uris: [CALLBACK],
        token_endpoint_auth_method: "none",
      });
      expect(body.client_id).toMatch(/^cpc_[0-9a-f]{32}$/);
      expect(await count("oauth_clients")).toBe(1);
    });

    it("refuses a confidential client and a redirect URI that is not https or loopback", async () => {
      const secret = await register({ token_endpoint_auth_method: "client_secret_basic" });
      expect(secret.status).toBe(400);
      expect(await secret.json()).toMatchObject({ error: "invalid_client_metadata" });
      const plain = await register({ redirect_uris: ["http://claude.ai/callback"] });
      expect(plain.status).toBe(400);
      expect(await plain.json()).toMatchObject({ error: "invalid_redirect_uri" });
    });
  });

  describe("authorization", () => {
    it("sends a browser without a session to login, and then to the consent page", async () => {
      const query = authorizationQuery("cpc_x", "c".repeat(43));
      const anonymous = await fetch(url(`/api/oauth/authorize?${query}`), { redirect: "manual" });
      expect(anonymous.status).toBe(302);
      const login = new URL(anonymous.headers.get("location")!, baseUrl);
      expect(login.pathname).toBe("/login");
      expect(login.searchParams.get("next")).toBe(`/oauth/consent?${query}`);
      const signedIn = await session.request(`/api/oauth/authorize?${query}`, { redirect: "manual" });
      expect(signedIn.status).toBe(302);
      expect(signedIn.headers.get("location")).toBe(`/oauth/consent?${query}`);
    });

    it("gives the consent page the client, the redirect host and the user", async () => {
      const clientId = await registeredClient();
      const response = await session.request(`/api/oauth/consent?${authorizationQuery(clientId, pkce().challenge)}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        client: { name: "Claude", clientId, metadataDocument: false, host: null },
        redirectUri: CALLBACK,
        redirectHost: "claude.ai",
        loopbackOnly: false,
        username: "testuser",
        server: baseUrl,
      });
    });

    it("never redirects for an unknown client or an unregistered redirect URI", async () => {
      const clientId = await registeredClient();
      const unknown = await session.request(`/api/oauth/consent?${authorizationQuery("cpc_unknown", pkce().challenge)}`);
      expect(unknown.status).toBe(400);
      expect(await unknown.json()).not.toHaveProperty("redirectTo");
      const elsewhere = await session.request(
        `/api/oauth/consent?${authorizationQuery(clientId, pkce().challenge, { redirect_uri: "https://evil.example/cb" })}`
      );
      expect(elsewhere.status).toBe(400);
      expect(await elsewhere.json()).not.toHaveProperty("redirectTo");
    });

    it("returns a request without PKCE or for another resource to the client with an error", async () => {
      const clientId = await registeredClient();
      const noPkce = await session.request(
        `/api/oauth/consent?${authorizationQuery(clientId, pkce().challenge, { code_challenge_method: "plain" })}`
      );
      // `returnTo`, not `redirectTo`: the page shows the error and the host,
      // and goes there only when the user clicks (RFC 9700 section 4.11.2).
      const refused = (await noPkce.json()) as { error: string; returnTo: string; returnHost: string };
      expect(refused).not.toHaveProperty("redirectTo");
      expect(refused.returnHost).toBe("claude.ai");
      expect(refused.error).toContain("PKCE");
      const redirect = new URL(refused.returnTo);
      expect(redirect.origin + redirect.pathname).toBe(CALLBACK);
      expect(redirect.searchParams.get("error")).toBe("invalid_request");
      expect(redirect.searchParams.get("state")).toBe("state-123");
      expect(redirect.searchParams.get("iss")).toBe(baseUrl);
      const other = await session.request(
        `/api/oauth/consent?${authorizationQuery(clientId, pkce().challenge, { resource: "https://evil.example/api/mcp" })}`
      );
      expect(new URL(((await other.json()) as { returnTo: string }).returnTo).searchParams.get("error")).toBe(
        "invalid_target"
      );
    });

    it("refuses the consent calls without a session cookie, even with a token", async () => {
      const { access_token } = await connect();
      const clientId = await registeredClient();
      const query = authorizationQuery(clientId, pkce().challenge);
      const response = await fetch(url(`/api/oauth/consent?${query}`), {
        headers: { authorization: `Bearer ${access_token}` },
      });
      expect(response.status).toBe(401);
      const post = await fetch(url("/api/oauth/consent"), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${access_token}` },
        body: JSON.stringify({ query, approve: true }),
      });
      expect(post.status).toBe(401);
    });

    it("sends a denial to the client as access_denied, with no grant", async () => {
      const clientId = await registeredClient();
      const { body } = await decide(authorizationQuery(clientId, pkce().challenge), false);
      const redirect = new URL(body.redirectTo!);
      expect(redirect.searchParams.get("error")).toBe("access_denied");
      expect(redirect.searchParams.get("state")).toBe("state-123");
      expect(redirect.searchParams.has("code")).toBe(false);
      expect(await count("oauth_grants")).toBe(0);
    });
  });

  describe("tokens", () => {
    it("exchanges a code for tokens that run the MCP tools as the user", async () => {
      const { access_token, refresh_token } = await connect();
      expect(access_token).toMatch(/^cpo_[0-9a-f]{64}$/);
      expect(refresh_token).toMatch(/^cpr_[0-9a-f]{64}$/);
      const initialize = await mcp(access_token);
      expect(initialize.status).toBe(200);
      const books = await listBooks(access_token);
      expect(books.status).toBe(200);
      expect(books.body.result?.isError).toBeFalsy();
      expect(books.body.result?.content[0].text).toContain("Test Book");
      expect(await row("SELECT last_used_at FROM oauth_grants")).toMatchObject({ lastUsedAt: expect.any(Date) });
    });

    it("refuses an access token outside the MCP endpoint", async () => {
      const { access_token } = await connect();
      const response = await fetch(url("/api/books"), { headers: { authorization: `Bearer ${access_token}` } });
      expect(response.status).toBe(401);
    });

    it("refuses a wrong verifier, another client, another redirect URI and a second use of a code", async () => {
      const clientId = await registeredClient();
      const { verifier, challenge } = pkce();
      const { body } = await decide(authorizationQuery(clientId, challenge), true);
      const code = new URL(body.redirectTo!).searchParams.get("code")!;
      const exchange = (changes: Record<string, string>) =>
        token({
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          client_id: clientId,
          redirect_uri: CALLBACK,
          ...changes,
        });
      const wrong: Record<string, string>[] = [
        { code_verifier: pkce().verifier },
        { client_id: "cpc_other" },
        { redirect_uri: "https://claude.ai/other" },
      ];
      for (const changes of wrong) {
        const response = await exchange(changes);
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: "invalid_grant" });
      }
      const target = await exchange({ resource: "https://evil.example/api/mcp" });
      expect(await target.json()).toMatchObject({ error: "invalid_target" });
      const first = await exchange({});
      expect(first.status).toBe(200);
      const { access_token } = (await first.json()) as { access_token: string };
      const second = await exchange({});
      expect(second.status).toBe(400);
      // A second use of a code revokes the grant and its tokens.
      expect((await mcp(access_token)).status).toBe(401);
    });

    it("exchanges a code without redirect_uri, as OAuth 2.1 allows", async () => {
      const clientId = await registeredClient();
      const { verifier, challenge } = pkce();
      const { body } = await decide(authorizationQuery(clientId, challenge), true);
      const response = await token({
        grant_type: "authorization_code",
        code: new URL(body.redirectTo!).searchParams.get("code")!,
        code_verifier: verifier,
        client_id: clientId,
        resource: `${baseUrl}/api/mcp`,
      });
      expect(response.status).toBe(200);
      const { access_token } = (await response.json()) as { access_token: string };
      expect((await mcp(access_token)).status).toBe(200);
    });

    it("refuses an expired code and an expired access token", async () => {
      const clientId = await registeredClient();
      const { verifier, challenge } = pkce();
      const { body } = await decide(authorizationQuery(clientId, challenge), true);
      await exec("UPDATE oauth_codes SET expires_at = '2000-01-01 00:00:00'");
      const late = await token({
        grant_type: "authorization_code",
        code: new URL(body.redirectTo!).searchParams.get("code")!,
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: CALLBACK,
      });
      expect(late.status).toBe(400);
      const { access_token } = await connect();
      await exec("UPDATE oauth_tokens SET expires_at = '2000-01-01 00:00:00' WHERE kind = 'access'");
      expect((await mcp(access_token)).status).toBe(401);
    });

    it("rotates the refresh token, and revokes the grant when a used one comes back later", async () => {
      const { clientId, access_token, refresh_token } = await connect();
      const refresh = (value: string) =>
        token({ grant_type: "refresh_token", refresh_token: value, client_id: clientId });
      const first = await refresh(refresh_token);
      expect(first.status).toBe(200);
      const next = (await first.json()) as { access_token: string; refresh_token: string };
      expect(next.refresh_token).not.toBe(refresh_token);
      expect((await mcp(next.access_token)).status).toBe(200);
      // Within the grace time, a retry gets invalid_grant and the grant stays.
      expect((await refresh(refresh_token)).status).toBe(400);
      expect((await mcp(next.access_token)).status).toBe(200);
      // Later, the same reuse revokes the grant.
      await exec("UPDATE oauth_tokens SET used_at = '2000-01-01 00:00:00' WHERE used_at IS NOT NULL");
      expect((await refresh(refresh_token)).status).toBe(400);
      expect((await mcp(next.access_token)).status).toBe(401);
      expect((await mcp(access_token)).status).toBe(401);
      expect((await refresh(next.refresh_token)).status).toBe(400);
    });

    it("keeps a used refresh token after it expires, so that its replay still revokes the grant", async () => {
      const { clientId, refresh_token } = await connect();
      const refresh = (value: string) =>
        token({ grant_type: "refresh_token", refresh_token: value, client_id: clientId });
      const first = await refresh(refresh_token);
      expect(first.status).toBe(200);
      const next = (await first.json()) as { access_token: string; refresh_token: string };
      await exec(
        "UPDATE oauth_tokens SET used_at = '2000-01-01 00:00:00', expires_at = '2000-01-02 00:00:00' WHERE used_at IS NOT NULL"
      );
      // The grants list runs the sweep of expired rows.
      expect((await session.request("/api/oauth/grants")).status).toBe(200);
      expect(await count("oauth_tokens", "used_at IS NOT NULL")).toBe(1);
      expect((await refresh(refresh_token)).status).toBe(400);
      expect((await mcp(next.access_token)).status).toBe(401);
      expect((await refresh(next.refresh_token)).status).toBe(400);
    });

    it("deletes a used refresh token when its grant has no token that is not expired", async () => {
      const { clientId, refresh_token } = await connect();
      const rotated = await token({ grant_type: "refresh_token", refresh_token, client_id: clientId });
      expect(rotated.status).toBe(200);
      await exec("UPDATE oauth_tokens SET expires_at = '2000-01-01 00:00:00'");
      await exec("UPDATE oauth_codes SET expires_at = '2000-01-01 00:00:00'");
      expect((await session.request("/api/oauth/grants")).status).toBe(200);
      expect(await count("oauth_tokens")).toBe(0);
      expect(await count("oauth_grants")).toBe(0);
    });

    it("stops the tokens when the user disconnects the app on the account page", async () => {
      const { access_token } = await connect();
      const list = await session.request("/api/oauth/grants");
      const grants = (await list.json()) as { id: number; clientName: string; redirectHost: string }[];
      expect(grants).toEqual([expect.objectContaining({ clientName: "Claude", redirectHost: "claude.ai" })]);
      const removed = await session.request(`/api/oauth/grants/${grants[0].id}`, {
        method: "DELETE",
        headers: { "sec-fetch-site": "same-origin" },
      });
      expect(removed.status).toBe(200);
      expect((await mcp(access_token)).status).toBe(401);
      expect(await (await session.request("/api/oauth/grants")).json()).toEqual([]);
    });

    it("revokes a refresh token with its grant at the revocation endpoint", async () => {
      const { clientId, access_token, refresh_token } = await connect();
      const response = await fetch(url("/api/oauth/revoke"), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: refresh_token, client_id: clientId }).toString(),
      });
      expect(response.status).toBe(200);
      expect((await mcp(access_token)).status).toBe(401);
    });

    it("stores only digests of codes and tokens", async () => {
      const { code, access_token, refresh_token } = await connect();
      const stored = JSON.stringify([
        await row("SELECT * FROM oauth_codes"),
        await row("SELECT * FROM oauth_tokens WHERE kind = 'access'"),
        await row("SELECT * FROM oauth_tokens WHERE kind = 'refresh'"),
      ]);
      for (const secret of [code, access_token, refresh_token]) expect(stored).not.toContain(secret);
      expect(stored).toContain(createHash("sha256").update(access_token).digest("hex"));
    });
  });

  it("connects the MCP SDK's own OAuth client from discovery to a tool call", async () => {
    let information: OAuthClientInformationMixed | undefined;
    let saved: OAuthTokens | undefined;
    let verifier = "";
    let authorizationUrl: URL | undefined;
    const provider: OAuthClientProvider = {
      redirectUrl: CALLBACK,
      clientMetadata: {
        client_name: "SDK test client",
        redirect_uris: [CALLBACK],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      } satisfies OAuthClientMetadata,
      clientInformation: () => information,
      saveClientInformation: (value) => {
        information = value;
      },
      tokens: () => saved,
      saveTokens: (value) => {
        saved = value;
      },
      redirectToAuthorization: (value) => {
        authorizationUrl = value;
      },
      saveCodeVerifier: (value) => {
        verifier = value;
      },
      codeVerifier: () => verifier,
    };
    const endpoint = new URL("/api/mcp", baseUrl);
    const first = new StreamableHTTPClientTransport(endpoint, { authProvider: provider });
    await expect(new Client({ name: "sdk", version: "1" }).connect(first)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(authorizationUrl?.pathname).toBe("/api/oauth/authorize");
    // The browser part: the consent page sends the same query with approve.
    const { body } = await decide(authorizationUrl!.search.slice(1), true);
    await first.finishAuth(new URL(body.redirectTo!).searchParams.get("code")!);
    const client = new Client({ name: "sdk", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(endpoint, { authProvider: provider }));
    const tools = await client.listTools();
    expect(tools.tools.length).toBe(63);
    await client.close();
  });
});

describe("MCP OAuth while COUNTERPOISE_PUBLIC_URL is not set", () => {
  let baseUrl: string;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    await setupTestDatabase();
    ({ baseUrl, stop } = await startHttpTestServer({ COUNTERPOISE_PUBLIC_URL: "" }));
  }, 120_000);

  afterAll(async () => {
    await stop();
  });

  it("serves no metadata and keeps the plain Bearer challenge", async () => {
    expect((await fetch(new URL("/.well-known/oauth-authorization-server", baseUrl))).status).toBe(404);
    expect((await fetch(new URL("/.well-known/oauth-protected-resource", baseUrl))).status).toBe(404);
    expect(
      (await fetch(new URL("/api/oauth/register", baseUrl), { method: "POST", body: "{}" })).status
    ).toBe(404);
    const response = await fetch(new URL("/api/mcp", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(INITIALIZE),
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  });
});
