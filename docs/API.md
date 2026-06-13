# API Reference — @vllnt/convex-email

**Compatibility:** `convex@^1.41.0`

Construct the client with the mounted component and optional host config:

```ts
import { Email } from "@vllnt/convex-email";
import { v } from "convex/values";

const email = new Email<MyPayload>(components.email, {
  payloadValidator: v.object({ subject: v.string(), html: v.string() }).parse, // narrow stored payload
  maxAttempts: 5, // default retry budget (per-message override at enqueue)
});
```

`Email<TPayload = unknown>` is generic over the host's opaque `payload` type. All
methods take the host `ctx` (a query or mutation context) as the first argument.

**Provider-neutral.** The component records send *intent* and *status* — it never
calls a mail provider. `transport` is an opaque host-supplied string tag naming
the adapter the host drives (`markSending` → host send → `markSent`/`markFailed`).

**Time is server-sourced.** Every handler stamps `createdAt`/`updatedAt` from
`Date.now()` itself; no method accepts a caller-supplied clock.

**Validation.** When `payloadValidator` is set it runs at the client boundary:
over the value written by `enqueue` (before storage) and over the value returned
by `get` / `listByStatus` (on read). It must return the typed value or throw. Omit
it to leave the opaque payload unvalidated.

## Mutations

### `enqueue(ctx, messageId, to, from, transport, opts?) → { messageId, deduplicated }`

`opts`: `{ payload?: TPayload; subjectRef?: string; idempotencyKey?: string; maxAttempts?: number }`.

Enqueue an outbound message and return its id immediately (the durable queue
entry). The message is inserted in `queued` with `attempts: 0` and
`createdAt`/`updatedAt` stamped from the server clock. `messageId` is host-supplied
and **must be unique**; `to`/`from` are opaque addresses; `transport` is the
host-configured adapter name; `payload` is opaque host data validated against
`payloadValidator` before storage.

When `opts.idempotencyKey` matches an existing message the existing id is returned
(`deduplicated: true`) and no new row is inserted — a retried enqueue can never
queue the same email twice. A bare duplicate `messageId` (no key) throws
`ConvexError({ code: "DUPLICATE_MESSAGE" })`.

### `markSending(ctx, messageId) → { attempts }`

Claim a `queued` message for a send attempt: move it to `sending` and increment
`attempts` (returned). A transport sender calls this before dispatching so
concurrent flushers don't double-send the same row. Rejects a missing id
(`NOT_FOUND`), a terminal message (`TERMINAL_STATE`), and an already-`sending`
message (`INVALID_TRANSITION` — another sender owns it).

### `markSent(ctx, messageId, opts?) → null`

`opts`: `{ providerId?: string }`.

Record a successful send — the message moves to terminal `sent`, recording the
transport's own `opts.providerId` (its message handle, opaque to the component) and
clearing any prior `error`. Idempotent against a replayed callback: re-marking an
already-`sent` message is a no-op (the recorded `providerId` is preserved). Rejects
a missing id (`NOT_FOUND`) and an already-`failed` message (`TERMINAL_STATE`).

### `markFailed(ctx, messageId, opts?) → { status, retried }`

`opts`: `{ error?: string }`. Returns `{ status: "queued" | "failed"; retried: boolean }`.

Record a failed send attempt, recording `opts.error`. While `attempts < maxAttempts`
the message returns to `queued` for another attempt (`retried: true`); once attempts
are exhausted it lands in terminal `failed` (`retried: false`). The host's backoff
scheduler re-claims a re-queued message when ready. Rejects a missing id
(`NOT_FOUND`) and an already-terminal `sent`/`failed` message (`TERMINAL_STATE`).

### `prune(ctx, opts?) → number`

`opts`: `{ before?: number; batch?: number }` (defaults: `before = Date.now()`,
`batch = 200`).

Delete up to `batch` **terminal** messages whose `updatedAt < before`, oldest
first (`sent` then `failed`, each via the `by_status_updated` index), and return
the count removed in the first pass. Queued and sending messages are never pruned.
If a full batch was removed the sweep self-reschedules through the component
scheduler until the terminal tail is clean. Idempotent — safe to run anytime. A
built-in daily cron drives it automatically; call `prune` directly only for an
extra or custom-cadence sweep.

## Queries

### `get(ctx, messageId) → MessageView | null`

The current envelope for `messageId`, or `null` if no such message is held.
`MessageView` is `{ messageId, to, from, transport, status, payload?, subjectRef?,
idempotencyKey?, providerId?, attempts, maxAttempts, error?, createdAt, updatedAt }`;
`payload` is narrowed by the host validator when set.

### `listByStatus(ctx, status, paginationOpts) → PaginationResult<MessageView>`

Page messages in one `status` (`"queued" | "sending" | "sent" | "failed"`), oldest
first via the `by_status` index. Takes the standard Convex `paginationOpts` and
returns the standard paginated envelope (`page`, `isDone`, `continueCursor`) with
each row narrowed to the typed view. Poll `queued` to flush, watch `sending`, or
audit a terminal `sent`/`failed` history reactively.

## Error codes

Coded `ConvexError`s thrown by the component (`error.data.code`):

| Code | Thrown by | Meaning |
|------|-----------|---------|
| `DUPLICATE_MESSAGE` | `enqueue` | A message with this `messageId` already exists (and no `idempotencyKey` matched). |
| `NOT_FOUND` | `markSending`, `markSent`, `markFailed` | No message has this `messageId`. |
| `TERMINAL_STATE` | `markSending`, `markSent`, `markFailed` | The message is already `sent`/`failed` and cannot transition. |
| `INVALID_TRANSITION` | `markSending` | The message is already `sending` (claimed by another sender). |

## Cron / Maintenance

The component registers one cron (`crons.ts`):

| Job | Cadence | Action |
|-----|---------|--------|
| `email:prune` | every 24h (`PRUNE_INTERVAL`) | runs `prune` with `batch = PRUNE_BATCH` (200), self-rescheduling until the terminal tail is clean |

Cadence is a static module constant (Convex cron definitions are static per
deployment). A host wanting a different cadence drives `prune` from its own
scheduler with an explicit `before` cutoff. The cron is per-mount, so each
`app.use(component, { name })` instance prunes its own sandbox independently.
