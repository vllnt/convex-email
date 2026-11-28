/**
 * The optional generic-SMTP transport adapter — a host-side `./smtp` entry the
 * host imports into its OWN `"use node"` action to actually send queued messages
 * over SMTP (Stalwart, Postfix, any server). It is NOT part of the sandboxed
 * component: a Convex component runs in V8 and cannot open a raw SMTP socket or
 * ship a `"use node"` action, so the real send is host-side glue.
 *
 * Tree-shake boundary: a backend-only consumer importing `@vllnt/convex-email`
 * (the `.` entry) or `@vllnt/convex-email/jmap` pulls ZERO SMTP code and never
 * needs `nodemailer`. Importing this `./smtp` entry is the explicit opt-in and
 * REQUIRES `nodemailer` (an optional peer dep) to be installed, even for the pure
 * helpers: this barrel re-exports `./transport.js`, which imports `nodemailer` at
 * the top level, so the import fails with `ERR_MODULE_NOT_FOUND` without it.
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
