/**
 * Pure, injectable generic-JMAP send logic. Everything here is runtime-neutral
 * and network-free: it drives an injected {@link JmapFetch} (the host's runtime
 * `fetch`), so a fake gives full coverage with no socket. There is no Node-only
 * piece — JMAP is plain HTTP — so the whole adapter is covered at 100%.
 *
 * Sending is the JMAP two-call batch (RFC 8621): `Email/set` creates the message
 * in a mailbox, then `EmailSubmission/set` submits it. {@link discoverJmapSession}
 * resolves the account / identity / mailbox ids from a JMAP session so a host need
 * not hand-wire them.
 */

import type {
  JmapConfig,
  JmapDiscoverOptions,
  JmapFetch,
  JmapMessage,
  JmapSendResult,
  JmapSender,
} from "./types.js";

/** A control character (CR/LF) that must never reach a header value. */
const CRLF = /[\r\n]/;

/** The JMAP capability URNs the adapter uses. */
const CAP_CORE = "urn:ietf:params:jmap:core";
const CAP_MAIL = "urn:ietf:params:jmap:mail";
const CAP_SUBMISSION = "urn:ietf:params:jmap:submission";

/** Narrow an unknown value to a plain object without a type assertion. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Guard a single header-bound value against CR/LF injection. */
function assertNoCrlf(label: string, value: string): void {
  if (CRLF.test(value)) {
    throw new Error(`jmap message: \`${label}\` must not contain CR or LF`);
  }
}

/** Split a comma-separated address list into trimmed, non-empty addresses. */
function splitAddresses(raw: string): string[] {
  return raw
    .split(",")
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
}

/**
 * Validate a host-supplied {@link JmapConfig}: every id must be a non-empty
 * string. Throws a plain `Error` on an invalid config — the host surfaces it.
 * Pure: no I/O.
 *
 * @param config - The resolved JMAP connection config.
 * @returns The same config, unchanged.
 */
export function validateJmapConfig(config: JmapConfig): JmapConfig {
  const keys = [
    "endpoint",
    "token",
    "accountId",
    "identityId",
    "mailboxId",
  ] as const;
  for (const key of keys) {
    const value = config[key];
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`jmap config: \`${key}\` must be a non-empty string`);
    }
  }
  return config;
}

/** The JMAP `Email` create object plus the submission envelope for one message. */
interface EmailCreate {
  /** The JMAP `Email/set` create object. */
  email: Record<string, unknown>;
  /** The `EmailSubmission` envelope (`mailFrom` + `rcptTo`). */
  envelope: {
    mailFrom: { email: string };
    rcptTo: Array<{ email: string }>;
  };
}

/**
 * Build the JMAP `Email` create object and the submission envelope from a
 * {@link JmapMessage}: resolve `from` (message → `config.from`), require one of
 * `text`/`html`, and reject CR/LF in `to`/`from`/`replyTo`/`subject`/`headers`.
 * Pure.
 *
 * @param message - The outbound message.
 * @param config - The resolved config (for the `from` default + the mailbox).
 * @returns The `Email` create object and the submission envelope.
 */
export function buildEmailCreate(
  message: JmapMessage,
  config: Pick<JmapConfig, "from" | "mailboxId">,
): EmailCreate {
  if (typeof message.to !== "string" || message.to.trim() === "") {
    throw new Error("jmap message: `to` must be a non-empty string");
  }
  const from = message.from ?? config.from;
  if (from === undefined || from.trim() === "") {
    throw new Error(
      "jmap message: `from` is required (pass `message.from` or `config.from`)",
    );
  }
  if (message.text === undefined && message.html === undefined) {
    throw new Error("jmap message: one of `text` or `html` is required");
  }
  const recipients = splitAddresses(message.to);
  if (recipients.length === 0) {
    throw new Error("jmap message: `to` must contain at least one address");
  }
  assertNoCrlf("from", from);
  for (const rcpt of recipients) {
    assertNoCrlf("to", rcpt);
  }
  if (message.replyTo !== undefined) {
    assertNoCrlf("replyTo", message.replyTo);
  }
  if (message.subject !== undefined) {
    assertNoCrlf("subject", message.subject);
  }

  let body: Record<string, unknown>;
  if (message.text !== undefined && message.html !== undefined) {
    body = {
      bodyStructure: {
        type: "multipart/alternative",
        subParts: [
          { type: "text/plain", partId: "text" },
          { type: "text/html", partId: "html" },
        ],
      },
      bodyValues: {
        text: { value: message.text },
        html: { value: message.html },
      },
    };
  } else if (message.html !== undefined) {
    body = {
      bodyStructure: { type: "text/html", partId: "html" },
      bodyValues: { html: { value: message.html } },
    };
  } else {
    body = {
      bodyStructure: { type: "text/plain", partId: "text" },
      bodyValues: { text: { value: message.text } },
    };
  }

  const email: Record<string, unknown> = {
    mailboxIds: { [config.mailboxId]: true },
    keywords: { $seen: true },
    from: [{ email: from }],
    to: recipients.map((email) => ({ email })),
    ...(message.subject !== undefined ? { subject: message.subject } : {}),
    ...(message.replyTo !== undefined
      ? { replyTo: [{ email: message.replyTo }] }
      : {}),
    ...body,
  };
  if (message.headers !== undefined) {
    for (const [key, value] of Object.entries(message.headers)) {
      assertNoCrlf(`headers.${key}`, key);
      assertNoCrlf(`headers.${key}`, value);
      email[`header:${key}:asText`] = value;
    }
  }

  return {
    email,
    envelope: {
      mailFrom: { email: from },
      rcptTo: recipients.map((email) => ({ email })),
    },
  };
}

/**
 * Build the full JMAP request body for sending one {@link JmapMessage}: an
 * `Email/set` create (creation id `draft`) followed by an `EmailSubmission/set`
 * that back-references it (`#draft`). Pure.
 *
 * @param message - The message to send.
 * @param config - The resolved JMAP config.
 * @returns The JMAP request body to POST to the endpoint.
 */
export function buildSubmitRequest(
  message: JmapMessage,
  config: JmapConfig,
): { using: string[]; methodCalls: unknown[] } {
  const { email, envelope } = buildEmailCreate(message, config);
  return {
    using: [CAP_CORE, CAP_MAIL, CAP_SUBMISSION],
    methodCalls: [
      ["Email/set", { accountId: config.accountId, create: { draft: email } }, "0"],
      [
        "EmailSubmission/set",
        {
          accountId: config.accountId,
          create: {
            sub: {
              emailId: "#draft",
              identityId: config.identityId,
              envelope,
            },
          },
        },
        "1",
      ],
    ],
  };
}

/** Find the arguments of the first method response with the given name. */
function findInvocation(
  responses: unknown[],
  name: string,
): Record<string, unknown> | null {
  for (const inv of responses) {
    if (Array.isArray(inv) && inv[0] === name && isRecord(inv[1])) {
      return inv[1];
    }
  }
  return null;
}

/** Describe a JMAP `SetError` (its `type`, or `"unknown"`). */
function describeSetError(value: unknown): string {
  return isRecord(value) && typeof value.type === "string"
    ? value.type
    : "unknown";
}

/** Read a created object's id from a `Foo/set` response, throwing on `notCreated`. */
function readCreatedId(
  args: Record<string, unknown>,
  createId: string,
  label: string,
): string {
  const notCreated = args.notCreated;
  if (isRecord(notCreated) && createId in notCreated) {
    throw new Error(
      `jmap: ${label} not created (${describeSetError(notCreated[createId])})`,
    );
  }
  const created = args.created;
  if (isRecord(created)) {
    const entry = created[createId];
    if (isRecord(entry) && typeof entry.id === "string") {
      return entry.id;
    }
  }
  throw new Error(`jmap: ${label} not created (no id in response)`);
}

/**
 * Parse a JMAP send response into a {@link JmapSendResult}: reject method-level
 * errors and `notCreated` entries, then read the created `Email` id and the
 * `EmailSubmission` id. Throws on any failure (the host catches it and calls
 * `markFailed`). Pure.
 *
 * @param json - The parsed JMAP response body.
 * @returns The created email id and submission id (the latter as `messageId`).
 */
export function parseSubmitResponse(json: unknown): JmapSendResult {
  if (!isRecord(json) || !Array.isArray(json.methodResponses)) {
    throw new Error("jmap: malformed response (no methodResponses)");
  }
  const responses = json.methodResponses;
  for (const inv of responses) {
    if (Array.isArray(inv) && inv[0] === "error") {
      throw new Error(`jmap: method error (${describeSetError(inv[1])})`);
    }
  }
  const emailArgs = findInvocation(responses, "Email/set");
  const subArgs = findInvocation(responses, "EmailSubmission/set");
  if (emailArgs === null || subArgs === null) {
    throw new Error("jmap: response missing Email/set or EmailSubmission/set");
  }
  const emailId = readCreatedId(emailArgs, "draft", "Email");
  const messageId = readCreatedId(subArgs, "sub", "EmailSubmission");
  return { messageId, emailId };
}

/**
 * Send one {@link JmapMessage} through an injected {@link JmapFetch} and return a
 * normalized {@link JmapSendResult}. Validates the config, builds the two-call
 * JMAP batch, POSTs it, and parses the result. Throws on an HTTP or JMAP error
 * (the host catches it and calls `markFailed`). Pure: pass the host's runtime
 * `fetch` in production, or a fake in a unit test.
 *
 * @param fetchFn - The injected `fetch` (the host's runtime `fetch`, or a fake).
 * @param message - The message to send.
 * @param config - The resolved JMAP config.
 * @returns The normalized send result — store `messageId` as the queue `providerId`.
 *
 * @example
 * ```ts
 * // host Convex action (no "use node" — fetch runs in V8):
 * const { messageId } = await sendViaJmap((u, i) => fetch(u, i), { to, html }, config);
 * await email.markSent(ctx, id, { providerId: messageId });
 * ```
 */
export async function sendViaJmap(
  fetchFn: JmapFetch,
  message: JmapMessage,
  config: JmapConfig,
): Promise<JmapSendResult> {
  validateJmapConfig(config);
  const body = buildSubmitRequest(message, config);
  const res = await fetchFn(config.endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`jmap: request failed (HTTP ${res.status})`);
  }
  return parseSubmitResponse(await res.json());
}

/** POST a JMAP request and return its `methodResponses`, throwing on HTTP/shape errors. */
async function jmapCall(
  fetchFn: JmapFetch,
  endpoint: string,
  token: string,
  request: { using: string[]; methodCalls: unknown[] },
): Promise<unknown[]> {
  const res = await fetchFn(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(request),
  });
  if (!res.ok) {
    throw new Error(`jmap: request failed (HTTP ${res.status})`);
  }
  const json = await res.json();
  if (!isRecord(json) || !Array.isArray(json.methodResponses)) {
    throw new Error("jmap: malformed response (no methodResponses)");
  }
  return json.methodResponses;
}

/** Pick the sending identity (by `from`, else the first) from an `Identity/get` list. */
function pickIdentity(
  list: unknown[],
  from?: string,
): { id: string; email: string } | null {
  const valid: Array<{ id: string; email: string }> = [];
  for (const item of list) {
    if (
      isRecord(item) &&
      typeof item.id === "string" &&
      typeof item.email === "string"
    ) {
      valid.push({ id: item.id, email: item.email });
    }
  }
  const lower = from?.toLowerCase();
  const matched =
    lower !== undefined
      ? valid.find((i) => i.email.toLowerCase() === lower)
      : undefined;
  return matched ?? valid[0] ?? null;
}

/** Pick the mailbox to file the sent copy in: role `sent`, else `drafts`, else first. */
function pickMailboxId(list: unknown[]): string | null {
  const valid: Array<{ id: string; role: string | null }> = [];
  for (const item of list) {
    if (isRecord(item) && typeof item.id === "string") {
      valid.push({
        id: item.id,
        role: typeof item.role === "string" ? item.role : null,
      });
    }
  }
  const sent = valid.find((m) => m.role === "sent");
  if (sent !== undefined) {
    return sent.id;
  }
  const drafts = valid.find((m) => m.role === "drafts");
  if (drafts !== undefined) {
    return drafts.id;
  }
  return valid[0]?.id ?? null;
}

/**
 * Resolve a {@link JmapConfig} from a JMAP session: fetch the session resource
 * for the `apiUrl` + primary mail account, then `Identity/get` for the sending
 * identity and `Mailbox/get` for the Sent (or Drafts) mailbox. Pure: drives the
 * injected {@link JmapFetch}. The host runs this once and passes the result to
 * {@link createJmapSender} / {@link sendViaJmap}.
 *
 * @param fetchFn - The injected `fetch`.
 * @param opts - The session URL, bearer token, and optional preferred `from`.
 * @returns A resolved {@link JmapConfig} ready to send with.
 */
export async function discoverJmapSession(
  fetchFn: JmapFetch,
  opts: JmapDiscoverOptions,
): Promise<JmapConfig> {
  if (typeof opts.sessionUrl !== "string" || opts.sessionUrl.trim() === "") {
    throw new Error("jmap discover: `sessionUrl` must be a non-empty string");
  }
  if (typeof opts.token !== "string" || opts.token.trim() === "") {
    throw new Error("jmap discover: `token` must be a non-empty string");
  }
  const sres = await fetchFn(opts.sessionUrl, {
    method: "GET",
    headers: { Authorization: `Bearer ${opts.token}`, Accept: "application/json" },
  });
  if (!sres.ok) {
    throw new Error(`jmap discover: session request failed (HTTP ${sres.status})`);
  }
  const session = await sres.json();
  if (!isRecord(session) || typeof session.apiUrl !== "string") {
    throw new Error("jmap discover: session has no apiUrl");
  }
  const accounts = session.primaryAccounts;
  const accountId = isRecord(accounts) ? accounts[CAP_MAIL] : undefined;
  if (typeof accountId !== "string") {
    throw new Error("jmap discover: no primary mail account");
  }
  const endpoint = session.apiUrl;

  const idResponses = await jmapCall(fetchFn, endpoint, opts.token, {
    using: [CAP_CORE, CAP_SUBMISSION],
    methodCalls: [["Identity/get", { accountId, ids: null }, "0"]],
  });
  const idArgs = findInvocation(idResponses, "Identity/get");
  const identity = pickIdentity(
    idArgs !== null && Array.isArray(idArgs.list) ? idArgs.list : [],
    opts.from,
  );
  if (identity === null) {
    throw new Error("jmap discover: no sending identity found");
  }

  const mbResponses = await jmapCall(fetchFn, endpoint, opts.token, {
    using: [CAP_CORE, CAP_MAIL],
    methodCalls: [["Mailbox/get", { accountId, ids: null }, "0"]],
  });
  const mbArgs = findInvocation(mbResponses, "Mailbox/get");
  const mailboxId = pickMailboxId(
    mbArgs !== null && Array.isArray(mbArgs.list) ? mbArgs.list : [],
  );
  if (mailboxId === null) {
    throw new Error("jmap discover: no sent or drafts mailbox found");
  }

  return {
    endpoint,
    token: opts.token,
    accountId,
    identityId: identity.id,
    mailboxId,
    from: opts.from ?? identity.email,
  };
}

/**
 * Build a bound {@link JmapSender} over a resolved config and an injected
 * `fetch`: a function that sends one message and returns the normalized result.
 * Validates the config eagerly. This is the one call a host wires into its flush
 * action (a plain Convex action — no `"use node"`).
 *
 * @param config - The resolved JMAP config (e.g. from {@link discoverJmapSession}).
 * @param fetchFn - The host's runtime `fetch`.
 * @returns A sender that dispatches one {@link JmapMessage} via the configured server.
 *
 * @example
 * ```ts
 * const config = await discoverJmapSession((u, i) => fetch(u, i), {
 *   sessionUrl: "https://mail.example.com/.well-known/jmap",
 *   token: process.env.JMAP_TOKEN!,
 *   from: "no-reply@app.com",
 * });
 * const send = createJmapSender(config, (u, i) => fetch(u, i));
 * const { messageId } = await send({ to, subject, html });
 * ```
 */
export function createJmapSender(
  config: JmapConfig,
  fetchFn: JmapFetch,
): JmapSender {
  validateJmapConfig(config);
  return (message) => sendViaJmap(fetchFn, message, config);
}
