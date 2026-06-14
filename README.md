<!-- Badges -->
[![convex-component](https://img.shields.io/badge/convex-component-EE342F.svg)](https://www.convex.dev/components)
[![npm](https://img.shields.io/npm/v/@vllnt/convex-email.svg)](https://www.npmjs.com/package/@vllnt/convex-email)
[![CI](https://github.com/vllnt/convex-email/actions/workflows/ci.yml/badge.svg)](https://github.com/vllnt/convex-email/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@vllnt/convex-email.svg)](./LICENSE)

# @vllnt/convex-email

A durable, **transport-agnostic** outbound transactional email queue, as a Convex
component. A host mutation enqueues a message and gets its id back; the host's own
transport sender claims it and reports the outcome — with retry until the attempt
budget is spent; clients poll the per-message delivery status
(`queued → sending → sent | failed`).

**Provider-neutral.** The transport is a pluggable adapter the **host** configures
and drives. This component records the *intent* and the *status* — it **never calls
a mail provider**. Stalwart, Resend, SES, Postmark, an SMTP-relay shim — all are
*host-configured transports*, picked in config. Domain-neutral too: a game's
verification email, a SaaS receipt, a blog's transactional newsletter — same queue;
payload and transport are config.

## Features

- **Enqueue-and-return** — `enqueue(messageId, to, from, transport, opts?)` inserts a `queued` message and hands back its id immediately; the caller never blocks on the send.
- **Host-driven transport** — the host's sender claims a message (`markSending`), dispatches it through whatever adapter it configured (generic SMTP, JMAP, an HTTP API), and reports the outcome (`markSent` / `markFailed`). The component never reaches a provider; `transport` is just an opaque host string tag.
- **Optional generic SMTP adapter** — `@vllnt/convex-email/smtp` sends through any SMTP server (Stalwart, Postfix, any provider's relay) from the host's `"use node"` action. `nodemailer` is an *optional* peer dep; the queue core stays dependency-clean. See [Transports](#transports).
- **Idempotent enqueue** — an `idempotencyKey` makes a re-enqueue return the existing message (`deduplicated: true`) instead of inserting a duplicate, so a retried request or an at-least-once producer can never queue the same email twice. A bare duplicate `messageId` throws `ConvexError({ code: "DUPLICATE_MESSAGE" })`.
- **Retry with budget** — `markFailed` re-queues the message (`sending → queued`) while `attempts < maxAttempts`, then lands it in terminal `failed`. The component owns the count and the retry-vs-terminal decision; the host owns the backoff timing.
- **Terminal states are final** — any transition out of `sent`/`failed` is rejected with `ConvexError({ code: "TERMINAL_STATE" })`, so a late or duplicate delivery callback can never overwrite a recorded outcome. `markSent` is idempotent on an already-`sent` message.
- **Poll or subscribe** — `get(id)` returns the current envelope; `listByStatus(status, paginationOpts)` pages the `queued` backlog to flush, watches `sending`, or audits a terminal history via the standard Convex pagination envelope. In a reactive Convex query these update live.
- **Server-sourced time** — `createdAt`/`updatedAt` are stamped from the server clock inside every handler; a caller can never supply a timestamp.
- **Typed, opaque payload** — `Email<TPayload>` types the stored `payload` end to end; pass `payloadValidator` to narrow the opaque value at the boundary (no unchecked cast, no `v.any()` dump). The component stores the rendered body opaquely.
- **Bounded prune + cron** — a built-in daily prune cron sweeps terminal messages past a retention window in bounded batches and self-reschedules until the tail is clean; idempotent. Queued/sending messages are never pruned.
- **Mount-safe** — runs correctly under multiple named `app.use` mounts (e.g. a transactional mount and a marketing mount); each instance is an isolated sandbox.

## Architecture

```
src/
├── shared.ts              # constants (component name, states, retention, attempts, batch)
├── test.ts                # convex-test register() helper
├── client/                # Email class (the public API)
└── component/             # schema (messages) + mutations + queries + prune cron
```

Sandboxed table: `messages {messageId, to, from, transport, status, payload?,
subjectRef?, idempotencyKey?, providerId?, attempts, maxAttempts, error?,
createdAt, updatedAt}` — indexed for lookup (`by_message_id`), dedup
(`by_idempotency_key`), status polling (`by_status`), subject-centric listing
(`by_subject`), and the retention sweep (`by_status_updated`). No host tables are
touched. A built-in cron (`crons.ts`) prunes terminal messages daily.

**The transport seam.** The real send happens in the host's action; the component
stays a transport-independent queue/retry/status core.

## Installation

```bash
pnpm add @vllnt/convex-email
```

Peer dependency: `convex@^1.41.0`. The queue core has **zero third-party runtime
deps**. `nodemailer@^8.0.4` is an **optional** peer dependency — install it only if
you use the generic SMTP transport (`@vllnt/convex-email/smtp`); see
[Transports](#transports).

## Usage

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
import { mutation, internalAction } from "./_generated/server";
import { v } from "convex/values";
import { Email } from "@vllnt/convex-email";

const email = new Email<{ subject: string; html: string }>(components.email, {
  payloadValidator: v.object({ subject: v.string(), html: v.string() }).parse,
});

// 1) Enqueue the message and schedule the send. The component records intent only.
export const sendWelcome = mutation({
  args: { userId: v.string(), to: v.string() },
  handler: async (ctx, { userId, to }) => {
    const messageId = crypto.randomUUID();
    await email.enqueue(ctx, messageId, to, "no-reply@app.com", "jmap", {
      payload: { subject: "Welcome", html: "<p>Hello</p>" },
      idempotencyKey: `welcome:${userId}`, // a retry never double-sends
    });
    await ctx.scheduler.runAfter(0, internal.notify.flush, { messageId });
    return { messageId };
  },
});

// 2) The host's transport sender claims, dispatches, and reports the outcome.
//    The HTTP call to your mail server lives HERE — never in the component.
export const flush = internalAction({
  args: { messageId: v.string() },
  handler: async (ctx, { messageId }) => {
    await email.markSending(ctx, messageId);
    try {
      const providerId = await sendOverJmap(messageId); // your transport
      await email.markSent(ctx, messageId, { providerId });
    } catch (e) {
      const { retried } = await email.markFailed(ctx, messageId, {
        error: String(e),
      });
      if (retried) {
        await ctx.scheduler.runAfter(backoffMs(), internal.notify.flush, { messageId });
      }
    }
  },
});

// 3) Clients poll the delivery status (reactively, in a Convex query).
export const status = query({
  args: { messageId: v.string() },
  handler: (ctx, { messageId }) => email.get(ctx, messageId),
});
```

## API Reference

See [docs/API.md](docs/API.md). Summary:

| Method | Kind | Result |
|--------|------|--------|
| `enqueue(ctx, messageId, to, from, transport, opts?)` | mutation | `{ messageId, deduplicated }` (`opts`: `{ payload?; subjectRef?; idempotencyKey?; maxAttempts? }`) |
| `markSending(ctx, messageId)` | mutation | `{ attempts }` |
| `markSent(ctx, messageId, opts?)` | mutation | `null` (`opts`: `{ providerId? }`) |
| `markFailed(ctx, messageId, opts?)` | mutation | `{ status: "queued" \| "failed"; retried }` (`opts`: `{ error? }`) |
| `get(ctx, messageId)` | query | `MessageView \| null` |
| `listByStatus(ctx, status, paginationOpts)` | query | `PaginationResult<MessageView>` |
| `prune(ctx, opts?)` | mutation | `number` (terminal messages removed in the first bounded pass) |

Client options:
`new Email(component, { payloadValidator?, maxAttempts? })` (`maxAttempts` default 5).
`prune` opts: `{ before?; batch? }` (defaults `before = Date.now()`, `batch = 200`).

## Transports

The queue is **transport-agnostic** — it records intent and status and never
sends. The actual send is the host's job, and the package ships **one optional,
generic transport adapter** to make the common case turnkey:

**Generic SMTP** (`@vllnt/convex-email/smtp`) — sends through **any** SMTP server:
**Stalwart, Postfix, a localhost MTA, or any provider's SMTP relay**. SMTP is the
protocol; the server is host config. Swap the backing server (Stalwart → SES SMTP →
Postfix) by changing config alone; no code change.

```ts
import { createSmtpSender } from "@vllnt/convex-email/smtp";

const send = createSmtpSender({
  host: process.env.SMTP_HOST!, // any SMTP server — Stalwart, Postfix, a relay
  port: 465,
  secure: true, // implicit TLS (defaults to true for port 465)
  auth: { user: process.env.SMTP_USER!, pass: process.env.SMTP_PASS! },
  from: "no-reply@app.com", // default From when a message omits one
});
```

The SMTP send runs in your own `"use node"` action — import `createSmtpSender`
there; the component itself never sends.

**`nodemailer` is an optional peer dependency**: the queue core installs and runs
with **zero third-party runtime deps**. Only a host that imports
`@vllnt/convex-email/smtp` needs `nodemailer`:

```bash
pnpm add nodemailer   # only if you use the SMTP transport
```

The adapter is two layers: a **pure, injectable** `sendViaSmtp(transport, message,
config?)` (driven by an injected transport, runs anywhere) plus a **thin
`nodemailer` wrapper** (`createSmtpTransport` / `createSmtpSender`), the Node-only
piece. Bring your own transport — pass any object with `sendMail(opts)` to
`sendViaSmtp` — to use a different SMTP library or a fake in tests.

### Wiring the queue to SMTP

The host's flush action pages the `queued` backlog, claims each message
(`markSending`), sends it, and records the outcome (`markSent` with the SMTP
message id as `providerId`, or `markFailed`). `markFailed` re-queues until the
attempt budget is spent — the host reschedules with its own backoff:

```ts
"use node";
import { internalAction } from "./_generated/server";
import { createSmtpSender } from "@vllnt/convex-email/smtp";
import { Email } from "@vllnt/convex-email";
import { components } from "./_generated/api";

const email = new Email<{ subject: string; html: string }>(components.email);
const send = createSmtpSender({
  host: process.env.SMTP_HOST!,
  port: 465,
  secure: true,
  auth: { user: process.env.SMTP_USER!, pass: process.env.SMTP_PASS! },
});

export const flushQueued = internalAction({
  handler: async (ctx) => {
    const { page } = await email.listByStatus(ctx, "queued", {
      cursor: null,
      numItems: 50,
    });
    for (const msg of page) {
      await email.markSending(ctx, msg.messageId);
      try {
        const { messageId } = await send({
          to: msg.to,
          from: msg.from,
          subject: msg.payload?.subject,
          html: msg.payload?.html,
        });
        await email.markSent(ctx, msg.messageId, { providerId: messageId });
      } catch (e) {
        await email.markFailed(ctx, msg.messageId, { error: String(e) });
      }
    }
  },
});
```

See `example/convex/` (`flushQueuedOverSmtp`) for the full loop exercised end to
end against the component runtime with a fake transport.

## React

This component ships **backend-only** — no `./react` entry. Delivery-status
display is an ordinary reactive `useQuery` over the host's own re-exported `get` /
`listByStatus` function refs (those return live in Convex), and the message body
is host-rendered, so a dedicated hook would add a wrapper with no value over the
host's existing `api`.

## Security Model

The component is **auth-agnostic** and **provider-neutral**: it never
authenticates, authorizes, or contacts a mail provider. The host resolves
identity, decides whether a caller may enqueue or transition a message, configures
and drives the transport, and passes opaque `to`/`from` addresses, a `transport`
tag, and the rendered `payload`. Component tables are sandboxed — the host reaches
them only through the exported functions, and the component never reads host or
sibling tables. The stored `payload` is opaque to the component; it never inspects
or sends it.

**Terminal states are final**, so a replayed or duplicate delivery callback can
never overwrite a recorded outcome. **Idempotent enqueue** (via `idempotencyKey`)
prevents a double-submit from queuing the same email twice. **Time is
server-sourced** — `createdAt`/`updatedAt` come from `Date.now()` inside each
handler, never from the caller. The host may narrow the opaque `payload` with
`payloadValidator`, applied at the client boundary on both write and read.

## Testing

```bash
pnpm test           # single run
pnpm test:coverage  # enforced 100% on covered files
```

Tests run against the real component runtime via `convex-test` (`@edge-runtime/vm`), not mocks.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Author

Built by [bntvllnt](https://github.com/bntvllnt) · [bntvllnt.com](https://bntvllnt.com) · [X @bntvllnt](https://x.com/bntvllnt)

Part of the [@vllnt](https://github.com/vllnt) Convex component fleet — [vllnt.com](https://vllnt.com)

If this is useful, [sponsor the work](https://github.com/sponsors/bntvllnt).

## License

MIT — see [LICENSE](LICENSE).
