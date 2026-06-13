/**
 * The optional generic-SMTP transport adapter — a host-side `./smtp` entry the
 * host imports into its OWN `"use node"` action to actually send queued messages
 * over SMTP (Stalwart, Postfix, any server). It is NOT part of the sandboxed
 * component: a Convex component runs in V8 and cannot open a raw SMTP socket or
 * ship a `"use node"` action, so the real send is host-side glue.
 *
 * Tree-shake boundary: a backend-only consumer importing `@vllnt/convex-email`
 * (the `.` entry) pulls ZERO SMTP code and no `nodemailer`. Importing this `./smtp`
 * entry is the explicit opt-in; `nodemailer` is an optional peer dep loaded only
 * by {@link createSmtpTransport} / {@link createSmtpSender} here.
 *
 * Two layers:
 * - pure + 100%-covered: {@link sendViaSmtp}, {@link validateSmtpConfig},
 *   {@link toMailOptions} — driven by an injected transport, unit-tested with a fake.
 * - thin Node wrapper (coverage-excluded): {@link createSmtpTransport},
 *   {@link createSmtpSender} — the real `nodemailer.createTransport`, consumer-E2E verified.
 */

export { sendViaSmtp, validateSmtpConfig, toMailOptions } from "./send.js";
export { createSmtpTransport, createSmtpSender } from "./transport.js";
export type {
  SmtpConfig,
  SmtpMessage,
  SmtpMailOptions,
  SmtpSendInfo,
  SmtpSendResult,
  SmtpSender,
  SmtpTransport,
} from "./types.js";
