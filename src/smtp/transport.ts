/**
 * The thin real-`nodemailer` wrapper — the ONLY piece that needs Node (raw SMTP
 * sockets). It builds a real transport from a host {@link SmtpConfig} and binds it
 * to {@link sendViaSmtp}. The host imports this from its OWN `"use node"` action;
 * a Convex component runs in V8 and cannot host a Node action, so this never runs
 * inside the sandboxed component.
 *
 * `nodemailer` is an **optional peer dependency** — the queue core installs and
 * runs with zero third-party runtime deps. This module is import-tested only when
 * the host opts into SMTP. It is **excluded from `coverage.include`**: it is a
 * trivial pass-through to the real library, consumer-E2E verified (exactly as the
 * `./react` live-backend integration is the consuming app's E2E). The pure
 * {@link sendViaSmtp} + config validation it delegates to ARE covered at 100%.
 */

import nodemailer from "nodemailer";
import { sendViaSmtp, validateSmtpConfig } from "./send.js";
import type { SmtpConfig, SmtpSender, SmtpTransport } from "./types.js";

/**
 * Build a real `nodemailer` SMTP transport from a host {@link SmtpConfig}. The
 * config is validated first (throws on an invalid one). Generic over any SMTP
 * server — Stalwart, Postfix, anything — the host supplies the connection.
 *
 * @param config - The host SMTP connection config.
 * @returns A {@link SmtpTransport} backed by `nodemailer.createTransport`.
 */
export function createSmtpTransport(config: SmtpConfig): SmtpTransport {
  const resolved = validateSmtpConfig(config);
  return nodemailer.createTransport({
    host: resolved.host,
    port: resolved.port,
    secure: resolved.secure,
    auth: resolved.auth,
  });
}

/**
 * Build a bound {@link SmtpSender} over a real `nodemailer` transport: a function
 * that sends one message and returns the normalized result. This is the one call
 * a host wires into its `"use node"` flush action.
 *
 * @param config - The host SMTP connection config.
 * @returns A sender that dispatches one {@link SmtpMessage} via the configured server.
 *
 * @example
 * ```ts
 * "use node";
 * import { createSmtpSender } from "@vllnt/convex-email/smtp";
 * const send = createSmtpSender({ host: process.env.SMTP_HOST!, port: 465, secure: true,
 *   auth: { user: process.env.SMTP_USER!, pass: process.env.SMTP_PASS! } });
 * const { messageId } = await send({ to, from, subject, html });
 * ```
 */
export function createSmtpSender(config: SmtpConfig): SmtpSender {
  const transport = createSmtpTransport(config);
  return (message) => sendViaSmtp(transport, message, config);
}
