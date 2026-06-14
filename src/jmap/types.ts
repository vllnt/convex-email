/**
 * Public TypeScript surface for the optional generic-JMAP transport adapter.
 *
 * Import this from your own Convex action to send queued messages over any JMAP
 * server's HTTP API — Stalwart, Fastmail, Cyrus, Apache James. JMAP is an open
 * protocol (RFC 8620 core + 8621 mail/submission), so this adapter is generic
 * over any JMAP server: the server is host config, never baked in. The component
 * itself never sends — it records the message and its status.
 *
 * Unlike the SMTP adapter, this layer is **pure**: it drives an injected
 * {@link JmapFetch} (the host's runtime `fetch`), so it needs no Node runtime,
 * no `"use node"` action, and no third-party dependency, and is 100%-coverable
 * with a fake `fetch`.
 */

/** The minimal `Response` subset {@link JmapFetch} resolves with. */
export interface JmapResponse {
  /** Whether the HTTP status is in the 2xx range. */
  ok: boolean;
  /** The HTTP status code. */
  status: number;
  /** Parse the response body as JSON. */
  json(): Promise<unknown>;
}

/** The minimal `RequestInit` subset the adapter passes to {@link JmapFetch}. */
export interface JmapRequestInit {
  /** HTTP method (`"GET"` for session discovery, `"POST"` for the JMAP API). */
  method: string;
  /** Request headers — always carries `Authorization` and (for POST) `Content-Type`. */
  headers: Record<string, string>;
  /** The JSON request body (POST only). */
  body?: string;
}

/**
 * The injected `fetch` seam — the minimal surface the adapter drives. The host
 * passes its runtime `fetch` (`(url, init) => fetch(url, init)` in a Convex
 * action); a fake one satisfies the same shape in tests, so the whole adapter is
 * 100%-coverable with no network.
 */
export type JmapFetch = (
  url: string,
  init: JmapRequestInit,
) => Promise<JmapResponse>;

/**
 * Resolved JMAP connection config — everything {@link sendViaJmap} needs to send.
 * Host-supplied, or produced by {@link discoverJmapSession}. Generic over any
 * JMAP server: Stalwart is one configured endpoint, never baked in.
 */
export interface JmapConfig {
  /** The JMAP API endpoint the method calls POST to (the session's `apiUrl`, e.g. `https://mail.example.com/jmap`). */
  endpoint: string;
  /** The bearer access token (a secret — keep it server-side; never ships to a client). */
  token: string;
  /** The JMAP account id that owns the mailbox/identity (the `urn:ietf:params:jmap:mail` primary account). */
  accountId: string;
  /** The sending identity id (an `Identity` whose address matches `from`). */
  identityId: string;
  /** The mailbox the sent copy is filed in (typically the Sent mailbox; a JMAP `Email` must belong to a mailbox). */
  mailboxId: string;
  /** Default `From` address used when a {@link JmapMessage} omits `from`. */
  from?: string;
}

/**
 * A single outbound message handed to the JMAP transport. Mirrors the queue's
 * stored fields (`to`/`from` plus the rendered body) without coupling to the
 * component's storage shape — the host maps a stored payload onto it. Identical
 * shape to the SMTP adapter's message so a host can target either transport.
 */
export interface JmapMessage {
  /** The recipient address (one address or a comma-separated list). */
  to: string;
  /** The sender address; falls back to {@link JmapConfig.from} when omitted. */
  from?: string;
  /** The message subject line. */
  subject?: string;
  /** The plain-text body. At least one of `text`/`html` should be set. */
  text?: string;
  /** The HTML body. At least one of `text`/`html` should be set. */
  html?: string;
  /** Optional `Reply-To` address. */
  replyTo?: string;
  /** Optional extra headers (host-supplied, set as JMAP `header:Name:asText` properties). */
  headers?: Record<string, string>;
}

/**
 * The normalized result of {@link sendViaJmap}. `messageId` is the JMAP
 * `EmailSubmission` id (store it as the queue's `providerId` on `markSent`);
 * `emailId` is the created `Email` object id.
 */
export interface JmapSendResult {
  /** The `EmailSubmission` id (or the `Email` id if the server returned no submission id) — store as the queue `providerId`. */
  messageId: string;
  /** The created `Email` object id. */
  emailId: string;
}

/**
 * A bound sender: a function that sends one {@link JmapMessage} through a
 * preconfigured endpoint + `fetch`. {@link createJmapSender} returns one; the
 * host calls it inside its own Convex action.
 */
export type JmapSender = (message: JmapMessage) => Promise<JmapSendResult>;

/** Options for {@link discoverJmapSession} — resolve a {@link JmapConfig} from a JMAP session. */
export interface JmapDiscoverOptions {
  /** The JMAP session resource URL (e.g. `https://mail.example.com/.well-known/jmap`). */
  sessionUrl: string;
  /** The bearer access token. */
  token: string;
  /** Pick the sending identity whose address matches this `from`; otherwise the first identity is used (and becomes the config default `from`). */
  from?: string;
}
