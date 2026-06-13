<!-- convex-ai-start -->
This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read `example/convex/_generated/ai/guidelines.md` first** for
important guidelines on how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running `npx convex ai-files install`.
<!-- convex-ai-end -->

# @vllnt/convex-email

A durable, transport-agnostic outbound transactional email queue, as a Convex component. A host
mutation enqueues a message and gets its id back; the host's own transport sender claims it and reports
the outcome, with retry until the attempt budget is spent; clients poll the per-message delivery status
(`queued → sending → sent | failed`). It follows the vllnt Component Standard (see the
`convex-components` hub `.claude/rules/component-standard.md`).

## Architecture

```
src/
├── shared.ts              # constants: component name, lifecycle states, retention, attempts, batch size
├── test.ts                # convex-test register() helper
├── client/
│   ├── index.ts           # Email<TPayload> class (consumer-facing API)
│   └── types.ts           # public TypeScript interfaces
└── component/
    ├── schema.ts           # sandboxed table: messages {messageId, to, from, transport, status, payload?, attempts, ...}
    ├── convex.config.ts    # defineComponent("email")
    ├── mutations.ts        # enqueue, markSending, markSent, markFailed, prune
    ├── queries.ts          # get, listByStatus
    ├── validators.ts       # shared validators (messageStatus, messageView, jsonValue)
    └── crons.ts            # daily prune cron (self-rescheduling)
```

Sandboxed table: `messages` — indexed `by_message_id` (lookup), `by_idempotency_key` (dedup),
`by_status` (poll a status queue), `by_subject` (subject-centric listing), and `by_status_updated`
(retention sweep). No host tables are touched. The stored `payload` is opaque to the component; the host
narrows it via `payloadValidator` at the client boundary.

## Ownership boundary

**Component owns:**

- The message queue (`messages` table) — record intent, transition status, count attempts, prune
- Server-sourced time — `Date.now()` inside every handler stamps `createdAt`/`updatedAt`; no caller clock
- The lifecycle state machine: `queued → sending → sent | failed`, with terminal states final and a
  retry edge (`sending → queued`) while the attempt budget remains
- Idempotency — an `idempotencyKey` dedups a re-enqueue; a `messageId` rejects a plain duplicate
- The retry budget bookkeeping (`attempts` / `maxAttempts`) and the retry-vs-terminal decision
- The daily prune cron and `prune` mutation (terminal messages past retention only)

**Host owns:**

- The transport — the host configures and DRIVES the adapter (JMAP, an HTTP API, an SMTP-relay shim).
  The component records intent + status and **never calls any provider**.
- The actual send and the outcome callbacks (`markSending`/`markSent`/`markFailed`) and the backoff
  schedule for re-claiming a re-queued message
- Auth and authorization — whether a caller may enqueue or transition a given message
- The opaque `to`/`from` addresses, the `transport` adapter name, and the rendered `payload`
- Generating and namespacing `messageId` (an opaque string) and the `idempotencyKey`
- The stored `payload` type (`TPayload`) — opaque to the component, narrowed by the host validator

**Auth:** the component is completely auth-agnostic. The host resolves identity, decides access, and
passes opaque refs. There is no built-in scope dimension — the host namespaces ids itself, or mounts a
second instance (`app.use(component, { name })`) for a static partition.

## Key design decisions

- **Provider-neutral by mandate (the core invariant):** the transport is a pluggable adapter the HOST
  configures and drives — the component records intent (`transport` is just a host-supplied string tag)
  and per-message status, and NEVER calls a mail provider. No vendor (Stalwart, Resend, SES, Postmark)
  is baked in anywhere; this is why the component is `convex-email`, never `convex-stalwart`. The
  Convex runtime has `fetch()` but no raw SMTP socket, so a real adapter reaches a server over HTTP — but
  that adapter lives in the host, not here. Swapping the backing vendor never forces a rename.

- **Terminal states are final:** `markSent`/`markFailed`/`markSending` reject any transition out of a
  terminal `sent`/`failed` with `ConvexError({ code: "TERMINAL_STATE" })`. A late or duplicate delivery
  callback — common with at-least-once webhooks — can never overwrite a recorded outcome. `markSent` is
  additionally idempotent on an already-`sent` message (a replayed success is a no-op).

- **Idempotent enqueue dedups a double-submit:** an `idempotencyKey` makes a second `enqueue` return the
  existing message (`deduplicated: true`) instead of inserting a duplicate row, so a retried request or
  an at-least-once producer can never queue the same email twice. A bare duplicate `messageId` (no key)
  throws `DUPLICATE_MESSAGE`.

- **Retry budget lives in the component, transport lives in the host:** `markFailed` re-queues the
  message (`sending → queued`) while `attempts < maxAttempts`, then lands it in terminal `failed`. The
  component owns the count and the retry-vs-terminal decision; the host owns the backoff timing and the
  actual re-send. `markSending` increments `attempts` and is the claim that stops two senders
  double-sending the same row.

- **Server-sourced time:** every handler stamps `createdAt`/`updatedAt` from `Date.now()` internally;
  no API surface accepts a caller-supplied timestamp. Ordering and retention cannot be skewed by a
  client clock.

- **Typed-generic opaque payload, never `v.any()` dumped raw:** `payload` rides through the single
  documented `jsonValue` alias and is narrowed to `TPayload` by the host parser at the client boundary on
  both write and read — no unchecked cast. The component never inspects the message body.

- **Bounded prune + self-reschedule (terminal-only):** `prune` removes up to `batch` terminal messages
  (default 200) past their `updatedAt` cutoff per pass and self-reschedules via `ctx.scheduler` when a
  full batch was removed. Queued/sending messages are never swept. Idempotent; the built-in daily cron
  drives it automatically. Default retention 30 days.

- **Backend-only (no `./react` entry):** delivery-status display is an ordinary reactive `useQuery` over
  the host's own re-exported `get`/`listByStatus` refs — a dedicated hook would wrap the host's `api`
  with no added value, and the message body is host-rendered. Explicit analysis decision (see README);
  re-run when a real management-surface consumer appears.

## Conventions

- Mutations in `mutations.ts`, queries in `queries.ts` (enforced by `@vllnt/eslint-config/convex`).
- Explicit `args` + `returns` on every Convex function.
- Host data via typed generics / host validators — never `v.any()` dumps; `jsonValue` is the documented
  last resort for the stored opaque `payload`.
- No hardcoded provider/vendor anywhere — the transport is a host-supplied string tag + host-driven send.
- 100% test coverage is BLOCKING (`vitest.config.mts` thresholds: statements, branches, functions, lines).
- Runtime deps: only official `@convex-dev/*` + `@vllnt/*`.

## Docs sync

| Changed | Update in the same commit |
|---------|--------------------------|
| Public API (enqueue/markSending/markSent/markFailed/get/listByStatus/prune signatures) | README API Reference table, `docs/API.md`, `llms.txt` context, regenerate `llms-full.txt` |
| Config options / defaults (validator, maxAttempts, retention, batch) | README API Reference, `docs/API.md` constructor section |
| Schema / table / indexes | README Architecture, `docs/API.md` |
| Error codes | `docs/API.md` → `## Error codes` table |
| `peerDependencies.convex` version | `llms.txt` context line (`convex@^X.Y.Z`), `docs/API.md` Compatibility line, README Installation peer note |
| Lifecycle / state machine | `docs/API.md` mutation sections, Key design decisions above |
| Any change | `pnpm generate:llms` to keep `llms-full.txt` current |

Grep old values before committing (e.g. after a `peerDependencies.convex` bump, `git grep "1.41.0"` → only the new range survives).
