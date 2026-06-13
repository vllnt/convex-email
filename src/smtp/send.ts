/**
 * Pure, injectable generic-SMTP send logic. Everything here is runtime-neutral
 * and network-free: {@link sendViaSmtp} drives an injected {@link SmtpTransport},
 * so a fake transport gives full coverage with no socket. The only piece that
 * needs Node is the thin real-`nodemailer` wrapper in `./transport` (excluded
 * from coverage, consumer-E2E verified).
 */

import type {
  SmtpConfig,
  SmtpMailOptions,
  SmtpMessage,
  SmtpSendInfo,
  SmtpSendResult,
  SmtpTransport,
} from "./types.js";

/** A control character (CR/LF) that must never reach a raw SMTP header. */
const CRLF = /[\r\n]/;

/**
 * Validate and normalize a host-supplied {@link SmtpConfig}, returning a config
 * with `secure` resolved (defaults to `true` for port 465, else `false`). Throws
 * a plain `Error` on an invalid config — the host surfaces it. Pure: no I/O.
 *
 * @param config - The raw host SMTP config.
 * @returns The same config with `secure` resolved to a concrete boolean.
 */
export function validateSmtpConfig(
  config: SmtpConfig,
): SmtpConfig & { secure: boolean } {
  if (typeof config.host !== "string" || config.host.trim() === "") {
    throw new Error("smtp config: `host` must be a non-empty string");
  }
  if (
    typeof config.port !== "number" ||
    !Number.isInteger(config.port) ||
    config.port <= 0 ||
    config.port > 65535
  ) {
    throw new Error("smtp config: `port` must be an integer in 1..65535");
  }
  if (config.auth !== undefined) {
    if (
      typeof config.auth.user !== "string" ||
      typeof config.auth.pass !== "string"
    ) {
      throw new Error("smtp config: `auth` requires string `user` and `pass`");
    }
  }
  const secure = config.secure ?? config.port === 465;
  return { ...config, secure };
}

/** Guard a single address-like header value against CRLF injection. */
function assertNoCrlf(label: string, value: string): void {
  if (CRLF.test(value)) {
    throw new Error(`smtp message: \`${label}\` must not contain CR or LF`);
  }
}

/**
 * Build the transport `sendMail` options from a {@link SmtpMessage} and the
 * resolved config, resolving `from` (message → config default) and guarding the
 * address/subject/header fields against SMTP header (CRLF) injection. Pure.
 *
 * @param message - The outbound message.
 * @param config - The resolved SMTP config (for the `from` default).
 * @returns The mail options to hand to {@link SmtpTransport.sendMail}.
 */
export function toMailOptions(
  message: SmtpMessage,
  config: Pick<SmtpConfig, "from">,
): SmtpMailOptions {
  if (typeof message.to !== "string" || message.to.trim() === "") {
    throw new Error("smtp message: `to` must be a non-empty string");
  }
  const from = message.from ?? config.from;
  if (from === undefined || from.trim() === "") {
    throw new Error(
      "smtp message: `from` is required (pass `message.from` or `config.from`)",
    );
  }
  if (message.text === undefined && message.html === undefined) {
    throw new Error("smtp message: one of `text` or `html` is required");
  }
  assertNoCrlf("to", message.to);
  assertNoCrlf("from", from);
  if (message.replyTo !== undefined) {
    assertNoCrlf("replyTo", message.replyTo);
  }
  if (message.subject !== undefined) {
    assertNoCrlf("subject", message.subject);
  }
  if (message.headers !== undefined) {
    for (const [key, value] of Object.entries(message.headers)) {
      assertNoCrlf(`headers.${key}`, key);
      assertNoCrlf(`headers.${key}`, value);
    }
  }
  return {
    to: message.to,
    from,
    subject: message.subject,
    text: message.text,
    html: message.html,
    replyTo: message.replyTo,
    headers: message.headers,
  };
}

/** Flatten a nodemailer address entry (string or `{ address }`) to a string. */
function addressOf(entry: string | { address: string }): string {
  return typeof entry === "string" ? entry : entry.address;
}

/** Normalize a transport's raw send info into the public {@link SmtpSendResult}. */
function toSendResult(info: SmtpSendInfo): SmtpSendResult {
  return {
    messageId: info.messageId ?? "",
    accepted: (info.accepted ?? []).map(addressOf),
    rejected: (info.rejected ?? []).map(addressOf),
  };
}

/**
 * Send one {@link SmtpMessage} through an injected {@link SmtpTransport} and
 * return a normalized {@link SmtpSendResult}. This is the pure, testable core:
 * pass a real `nodemailer` transport in the host's `"use node"` action, or a fake
 * one in a unit test. Throws when the transport throws (the host catches it and
 * calls `markFailed`).
 *
 * @param transport - The injected transport (real nodemailer or a fake).
 * @param message - The message to send.
 * @param config - The resolved config, for the `from` default.
 * @returns The normalized send result — store `messageId` as the queue `providerId`.
 *
 * @example
 * ```ts
 * // host "use node" action:
 * const transport = createSmtpTransport(config);   // real nodemailer
 * const { messageId } = await sendViaSmtp(transport, { to, html }, config);
 * await email.markSent(ctx, id, { providerId: messageId });
 * ```
 */
export async function sendViaSmtp(
  transport: SmtpTransport,
  message: SmtpMessage,
  config: Pick<SmtpConfig, "from"> = {},
): Promise<SmtpSendResult> {
  const options = toMailOptions(message, config);
  const info = await transport.sendMail(options);
  return toSendResult(info);
}
