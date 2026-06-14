/**
 * Public TypeScript surface for the optional generic-SMTP transport adapter.
 *
 * Import this from your own `"use node"` action to send queued messages over any
 * SMTP server. The component itself never sends — it records the message and its
 * status; the SMTP server is host config.
 */

/**
 * Generic SMTP connection config — works with Stalwart, Postfix, or any SMTP
 * server. Host-supplied; mirrors the subset of nodemailer's transport options
 * this adapter drives.
 */
export interface SmtpConfig {
  /** SMTP server hostname (e.g. `"smtp.example.com"`, a Stalwart host, a Postfix relay). */
  host: string;
  /** SMTP server port (commonly 465 for implicit TLS, 587 for STARTTLS, 25 for relay). */
  port: number;
  /**
   * Use implicit TLS on connect (`true` ⇒ typically port 465). When `false`,
   * nodemailer upgrades via STARTTLS if the server offers it. Defaults to `true`
   * when the port is 465, else `false` — set it explicitly to be unambiguous.
   */
  secure?: boolean;
  /** SMTP AUTH credentials. Omit for an unauthenticated relay (e.g. a localhost MTA). */
  auth?: {
    /** SMTP AUTH username. */
    user: string;
    /** SMTP AUTH password (a secret — keep it server-side; never ships to a client). */
    pass: string;
  };
  /**
   * Default `From` address used when a {@link SmtpMessage} omits `from`. The host
   * supplies the opaque address; the adapter never invents one.
   */
  from?: string;
}

/**
 * A single outbound message handed to the SMTP transport. Mirrors the queue's
 * stored fields (`to`/`from` plus the rendered body) without coupling to the
 * component's storage shape — the host maps a {@link MessageView} payload onto it.
 */
export interface SmtpMessage {
  /** The recipient address (one address or a comma-separated list). */
  to: string;
  /** The sender address; falls back to {@link SmtpConfig.from} when omitted. */
  from?: string;
  /** The message subject line. */
  subject?: string;
  /** The plain-text body. At least one of `text`/`html` should be set. */
  text?: string;
  /** The HTML body. At least one of `text`/`html` should be set. */
  html?: string;
  /** Optional `Reply-To` address. */
  replyTo?: string;
  /** Optional extra SMTP headers (host-supplied, opaque to the adapter). */
  headers?: Record<string, string>;
}

/**
 * The injected transport seam — the minimal surface {@link sendViaSmtp} drives.
 * The real implementation is a `nodemailer` transporter; a fake one satisfies the
 * same shape in tests, so the pure send logic is 100%-coverable with no network.
 */
export interface SmtpTransport {
  /**
   * Dispatch one message. Returns the transport's own send result; `sendViaSmtp`
   * normalizes it to a {@link SmtpSendResult}. Throws on a send failure (the host
   * catches it and calls `markFailed`).
   */
  sendMail(options: SmtpMailOptions): Promise<SmtpSendInfo>;
}

/**
 * The mail options passed to {@link SmtpTransport.sendMail} — the nodemailer
 * `sendMail` argument shape, narrowed to the fields this adapter sets. Declared
 * locally so the public surface stays dependency-free (no `@types/nodemailer` in
 * the published types).
 */
export interface SmtpMailOptions {
  to: string;
  from: string;
  subject?: string;
  text?: string;
  html?: string;
  replyTo?: string;
  headers?: Record<string, string>;
}

/**
 * The raw result a transport's `sendMail` resolves with — the nodemailer
 * `SentMessageInfo` subset this adapter reads. `accepted`/`rejected` are address
 * lists; `messageId` is the SMTP message handle recorded as the queue's `providerId`.
 */
export interface SmtpSendInfo {
  /** The SMTP message id assigned by the server (recorded as `providerId`). */
  messageId?: string;
  /** Addresses the server accepted. */
  accepted?: ReadonlyArray<string | { address: string }>;
  /** Addresses the server rejected. */
  rejected?: ReadonlyArray<string | { address: string }>;
}

/**
 * The normalized result of {@link sendViaSmtp}. `messageId` is the transport's
 * own handle (store it as the queue's `providerId` on `markSent`); `accepted` /
 * `rejected` are flattened address lists.
 */
export interface SmtpSendResult {
  /** The SMTP message handle, or `""` when the transport returned none. */
  messageId: string;
  /** Addresses the server accepted. */
  accepted: string[];
  /** Addresses the server rejected (non-empty even on a resolved send is a partial failure). */
  rejected: string[];
}

/**
 * A bound sender: a function that sends one {@link SmtpMessage} through a
 * preconfigured transport. {@link createSmtpSender} returns one over a real
 * `nodemailer` transport; the host calls it inside its own `"use node"` action.
 */
export type SmtpSender = (message: SmtpMessage) => Promise<SmtpSendResult>;
