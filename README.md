<!-- Badges -->

[![convex-component](https://img.shields.io/badge/convex-component-EE342F.svg)](https://www.convex.dev/components)
[![npm](https://img.shields.io/npm/v/@vllnt/convex-email.svg)](https://www.npmjs.com/package/@vllnt/convex-email)
[![CI](https://github.com/vllnt/convex-email/actions/workflows/ci.yml/badge.svg)](https://github.com/vllnt/convex-email/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@vllnt/convex-email.svg)](./LICENSE)

# @vllnt/convex-email

A durable, transport-agnostic outbound transactional email queue, as a Convex
component — the host enqueues a message, its own transport sends it, and clients
poll the delivery status.

```ts
const email = new Email(components.email);
await email.enqueue(ctx, messageId, to, from, "smtp", { idempotencyKey });
await email.markSending(ctx, messageId); // host sends, then:
await email.markSent(ctx, messageId, { providerId }); // or markFailed → host schedules retry
```

## Features

- **Enqueue-and-return** — insert a `queued` message, get its id back; the
  caller never blocks on the send.
- **Host-driven transport** — the host claims (`markSending`), sends, and
  reports (`markSent`/`markFailed`); the component never reaches a provider.
- **Optional generic SMTP adapter** — `@vllnt/convex-email/smtp` sends through
  any SMTP server; `nodemailer` is an optional peer dep.
- **Optional generic JMAP adapter** — `@vllnt/convex-email/jmap` sends over any
  JMAP server's HTTP API (Stalwart, Fastmail, Cyrus) from a plain action —
  `fetch`-based, no `"use node"`, no extra dep.
- **Idempotent enqueue** — an `idempotencyKey` dedups a re-enqueue while the
  existing row is retained; it does not guarantee exactly-once provider
  delivery.
- **Retry with budget** — `markFailed` re-queues until `attempts` hit
  `maxAttempts`, then lands in terminal `failed`.
- **Terminal states are final** — a late or duplicate delivery callback can
  never overwrite a recorded outcome.
- **Poll or subscribe** — `get` / `listByStatus` update live in a reactive
  Convex query.
- **Server-sourced time, typed opaque payload, bounded prune cron, mount-safe.**

## Installation

```bash
pnpm add @vllnt/convex-email@canary convex@^1.45.0
```

Peer dependency: `convex@^1.45.0`. The queue core has zero third-party runtime
deps. `nodemailer@^8.0.4` is an optional peer dep — only for the SMTP transport.
The JMAP transport (`@vllnt/convex-email/jmap`) is `fetch`-based and needs no
extra dependency.

This README follows `main` and the canary channel; `latest` is the separate
stable release. Pin an exact canary version for reproducible installs.

## Quick start

After mounting, run `pnpm exec convex dev` to generate `components.email`. This
internal enqueue function is for trusted server callers; public wrappers must
check sender/recipient permissions and prevent arbitrary outbound mail.

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import email from "@vllnt/convex-email/convex.config";

const app = defineApp();
app.use(email);
export default app;
```

```ts
// convex/notify.ts — host owns auth AND the transport; pass opaque refs in.
import { components } from "./_generated/api";
import { internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { Email } from "@vllnt/convex-email";

const email = new Email<{ subject: string; html: string }>(components.email, {
  payloadValidator: (value) => {
    if (
      typeof value !== "object" ||
      value === null ||
      !("subject" in value) ||
      !("html" in value) ||
      typeof value.subject !== "string" ||
      typeof value.html !== "string"
    ) {
      throw new Error("Expected subject and html strings");
    }
    return { subject: value.subject, html: value.html };
  },
});

// Record intent only. A host worker polls queued messages and sends them.
export const sendWelcome = internalMutation({
  args: { userId: v.string(), to: v.string() },
  handler: async (ctx, { userId, to }) => {
    const messageId = crypto.randomUUID();
    return email.enqueue(ctx, messageId, to, "no-reply@example.com", "jmap", {
      payload: { subject: "Welcome", html: "<p>Hello</p>" },
      idempotencyKey: `welcome:${userId}`, // returns the existing id when deduplicated
    });
  },
});
```

## API Reference

| Method                                                | Kind     | Result                          |
| ----------------------------------------------------- | -------- | ------------------------------- |
| `enqueue(ctx, messageId, to, from, transport, opts?)` | mutation | `{ messageId, deduplicated }`   |
| `markSending(ctx, messageId)`                         | mutation | `{ attempts }`                  |
| `markSent(ctx, messageId, opts?)`                     | mutation | `null`                          |
| `markFailed(ctx, messageId, opts?)`                   | mutation | `{ status, retried }`           |
| `get(ctx, messageId)`                                 | query    | `MessageView \| null`           |
| `listByStatus(ctx, status, paginationOpts)`           | query    | `PaginationResult<MessageView>` |
| `prune(ctx, opts?)`                                   | mutation | `number`                        |

Full reference: [docs/API.md](docs/API.md).

## Options and limitations

- Constructor: `payloadValidator?: (unknown) => TPayload` and
  `maxAttempts?: number` (default 5). Convex `v.*` validators do not have
  `.parse`.
- Enqueue options: `{ payload?, subjectRef?, idempotencyKey?, maxAttempts? }`.
  Use the returned `messageId`, which may differ from the proposed id on
  deduplication.
- The host polls `listByStatus("queued")`, claims with `markSending`, calls a
  transport, and reports the outcome. `markFailed` only requeues; it does not
  send, schedule backoff, or recover a crashed worker stuck in `sending`.
- No exactly-once transport guarantee: a provider may accept a message before a
  network error or status-write failure. Do not treat a failed `markSent` as
  proof the send failed; reconcile ambiguous outcomes before retrying.
- `markSent` and `markFailed` also accept `queued` rows; the host must maintain
  claim/send/report discipline. Only `markSending` increments attempts.
- Prune defaults to 30 days from terminal `updatedAt`, batch 200 (integer
  1–500). Custom cutoffs do not extend the built-in daily cron's retention;
  pruning removes the row's dedup key too.
- Mount separately with `app.use(email, { name: "transactionalEmail" })` and
  `new Email(components.transactionalEmail)`.

## Integrations

No `./react` entry: expose authorized host queries for delivery status. Provider
credentials stay in host actions, never in message payloads or client bundles.

## SMTP transport (optional)

A generic SMTP adapter ships at `@vllnt/convex-email/smtp` — it sends through
any SMTP server (Stalwart, Postfix, any relay). The real send runs in the host's
own `"use node"` action; the component never sends.

Install the optional peer with `pnpm add nodemailer@^8.0.4`.

```ts
"use node";
import { createSmtpSender } from "@vllnt/convex-email/smtp";

const send = createSmtpSender({
  host: process.env.SMTP_HOST!,
  port: 465,
  secure: true,
  auth: { user: process.env.SMTP_USER!, pass: process.env.SMTP_PASS! },
});
```

Full queue-to-SMTP wiring in [docs/API.md](docs/API.md).

## JMAP transport (optional)

A generic JMAP adapter ships at `@vllnt/convex-email/jmap` — it sends over any
JMAP server's HTTP API (Stalwart, Fastmail, Cyrus, Apache James). JMAP is HTTP,
so it runs in a **plain Convex action** — no `"use node"`, no `nodemailer`, zero
extra deps. It's a protocol, not a vendor: `./jmap`, never `./stalwart`.

```ts
import {
  createJmapSender,
  discoverJmapSession,
} from "@vllnt/convex-email/jmap";

// Resolve account / identity / Sent mailbox once, then bind a sender over your `fetch`.
const config = await discoverJmapSession((u, i) => fetch(u, i), {
  sessionUrl: "https://mail.example.com/.well-known/jmap", // e.g. a Stalwart host
  token: process.env.JMAP_TOKEN!,
  from: "no-reply@app.com",
});
const send = createJmapSender(config, (u, i) => fetch(u, i));
```

To send some mail over SMTP and some over Stalwart's HTTP (JMAP), keep **one
queue** and route per message by its stored `transport` tag (a `senders` map
keyed by `"smtp"` / `"jmap"`). Full JMAP wiring + routing in
[docs/API.md](docs/API.md).

## Security

- Auth-agnostic and provider-neutral — the host gates access and drives the
  transport; the component never authenticates or contacts a provider.
- Tables are sandboxed (reached only via exported functions); the stored
  `payload` is opaque.
- Terminal states are final, enqueue is idempotent, and time is server-sourced.

See [docs/API.md](docs/API.md).

## Testing

```bash
pnpm test           # single run
pnpm test:coverage  # enforced 100% on covered files
```

Tests run against the real component runtime via `convex-test`
(`@edge-runtime/vm`), not mocks.

## Documentation

`llms.txt` is the maintained discovery index. `pnpm generate:llms` checks its
heading and local links without generating a source bundle.

[API reference](docs/API.md) · [LLM index](llms.txt) ·
[Security policy](SECURITY.md)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Author

Built by [bntvllnt](https://github.com/bntvllnt) ·
[bntvllnt.com](https://bntvllnt.com) · [X @bntvllnt](https://x.com/bntvllnt)

Part of the [@vllnt](https://github.com/vllnt) Convex component fleet —
[vllnt.com](https://vllnt.com)

If this is useful, [sponsor the work](https://github.com/sponsors/bntvllnt).

## License

MIT — see [LICENSE](LICENSE).
