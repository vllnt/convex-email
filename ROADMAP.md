# Roadmap — convex-email

> A durable, transport-agnostic outbound transactional email queue as a Convex
> component — enqueue, retry, idempotent send, per-message delivery status; the
> transport is an optional, host-driven adapter.

**Now:** none active — `jmap-transport` shipped; next candidates in [Later](#later)
**Last updated:** 2026-06-14

> **Hold (2026-06-14):** part of the fleet hold — `@vllnt/convex-email` stays
> **private** and pinned at **`0.1.0`**; new features (including the JMAP transport
> below) land **in `0.1.0`** with no version bump, and `publish.yml` stays disabled.
> The public canary/release path is gated by the hub's `fleet-dogfood` /
> `fleet-publish` phases. See the hub `.claude/rules/component-standard.md` ›
> *Visibility + version hold*.

## transactional-queue [DONE 2026-06]

**Goal:** Ship the durable, transport-agnostic transactional email queue
(enqueue / retry / idempotent / status) as a Convex component at green `0.1.0`,
with one optional generic SMTP adapter.

**Exit criteria:** `@vllnt/convex-email` `0.1.0` — a sandboxed `messages` queue
with the `queued → sending → sent | failed` lifecycle (terminal-final), idempotent
enqueue, a retry budget, a bounded prune cron, and mount-safe isolation; an
optional `./smtp` adapter (`nodemailer` optional peer); 100% E2E coverage green;
standard CI/docs.

- [x] transactional-queue.1 Build the `messages` queue + lifecycle state machine `queued → sending → sent | failed` (terminal-final, `TERMINAL_STATE`), server-sourced time
- [x] transactional-queue.2 Idempotent enqueue (`idempotencyKey` dedup; bare duplicate `messageId` → `DUPLICATE_MESSAGE`) + retry budget (`attempts`/`maxAttempts`, the retry-vs-terminal decision in `markFailed`)
- [x] transactional-queue.3 Add `get` / `listByStatus` queries + a bounded self-rescheduling prune cron (terminal-only, 30-day retention)
- [x] transactional-queue.4 Typed-generic opaque `payload` (`Email<TPayload>` + host `payloadValidator`), mount-safe across named `app.use` mounts
- [x] transactional-queue.5 Ship the optional `./smtp` adapter — pure `sendViaSmtp` (100% covered, CRLF-guarded) + a thin `nodemailer` wrapper (optional peer, host `"use node"` action)
- [x] transactional-queue.6 100% E2E via `example/convex` (every client method, happy + adversarial) + standard CI, docs, `llms.txt`/`llms-full.txt`

## jmap-transport [DONE 2026-06]

**Goal:** Ship an optional, **vendor-neutral generic JMAP** transport adapter
(`./jmap`) so a host can flush the queue over any JMAP server's HTTP API —
Stalwart, Fastmail, Cyrus, Apache James — from a **plain Convex action** (native
`fetch`, no `"use node"`, zero runtime deps), symmetric with the shipped `./smtp`
adapter. JMAP is a protocol like SMTP, so it is `./jmap`, never `convex-stalwart`;
Stalwart is one configured server (`{ endpoint, token }`).

**Exit criteria:** `@vllnt/convex-email/jmap` exports a generic JMAP sender
validated against Stalwart (`POST /jmap`, `Authorization: Bearer`,
`EmailSubmission/set`); the pure `sendViaJmap` core is at 100% coverage via a fake
`fetch` (CRLF-guarded, mirroring `sendViaSmtp`); `example/convex` flush routes per
`msg.transport` (`smtp` vs `jmap`) end-to-end; README / `docs/API.md` / llms /
AGENTS updated; stays in `0.1.0` (no version bump; publish gated by the fleet hold).

- [x] jmap-transport.1 Add pure `sendViaJmap(fetchFn, message, config)` — build the `Email/set` → `EmailSubmission/set` 2-call batch, parse `methodResponses` → `providerId` (the `EmailSubmission` id) or throw on a JMAP error; reject CRLF header injection; 100% covered via a fake `fetch` (mirror `src/smtp/send.ts`)
- [x] jmap-transport.2 Add JMAP session discovery (`/.well-known/jmap` → `accountId` + `Identity/get` `identityId` + `Mailbox/get` drafts mailbox) or accept them via `JmapConfig`; resolve once per sender
- [x] jmap-transport.3 Ship the `./jmap` subpath export — zero runtime deps, native `fetch`, runs in a plain action (no `"use node"`); add the `package.json` exports entry, dist build, and `vitest` `coverage.include`
- [x] jmap-transport.4 Route per-transport in the `example/convex` flush (`smtp` vs `jmap` by `msg.transport`) and exercise the JMAP path end-to-end at 100% E2E against the component runtime with a fake `fetch`
- [x] jmap-transport.5 Docs sync — README Transports (generic JMAP: any JMAP server, config `{ endpoint, token }`, plain-action note), `docs/API.md` JMAP section, CLAUDE.md/AGENTS Key design decision, regenerate `llms-full.txt`

## Later

- Renderer recipe (the "react-email ready to use" gap — no renderer example ships today): document body authoring with a react-email worked example (mjml / jsx-email / plain HTML identical, since the seam is an HTML string) and recommend a `{ subject, html, text? }` payload — both transports already carry `text`, but the docs omit it
- Re-evaluate an optional `./react` entry if a delivery-status management-surface consumer appears (currently backend-only by explicit analysis — status display is a plain `useQuery` over the host's re-exported `get`/`listByStatus`)
- Transport retry/backoff helper — only if a 2nd consumer wants it; the host owns backoff timing today by design
