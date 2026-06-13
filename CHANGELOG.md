# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-06-14

### Added

- First release of `@vllnt/convex-email` — a durable, transport-agnostic outbound
  transactional email queue.
- Provider-neutral by mandate: the transport is a host-configured, host-driven
  adapter (`transport` is an opaque string tag). The component records send intent
  and per-message status and **never calls a mail provider** — no vendor is baked
  in.
- `enqueue(messageId, to, from, transport, opts?)` records a message in `queued`
  and returns its id immediately; `messageId` is host-supplied and must be unique.
  An `idempotencyKey` dedups a re-enqueue (`deduplicated: true`) so a retry never
  double-sends.
- `markSending(messageId)` claims a `queued` message for a send attempt
  (increments `attempts`); `markSent(messageId, { providerId? })` records a
  terminal success; `markFailed(messageId, { error? })` re-queues while
  `attempts < maxAttempts` else lands in terminal `failed`.
- `get(messageId)` returns the current envelope (or `null`); `listByStatus(status,
  paginationOpts)` pages messages in one status oldest-first via the standard
  Convex pagination envelope.
- Terminal states are final: any transition out of `sent`/`failed` is rejected
  with `ConvexError({ code: "TERMINAL_STATE" })`, so a late or duplicate delivery
  callback can never overwrite a recorded outcome; `markSent` is idempotent.
- Server-sourced time: every handler stamps `createdAt`/`updatedAt` from
  `Date.now()` inside the mutation — no caller-supplied clock.
- Typed generics: `Email<TPayload>` with an optional `payloadValidator` host
  parser narrowing the opaque stored `payload` at the client boundary on write and
  read — no `v.any()` dump, no unchecked cast.
- Bounded, self-rescheduling `prune` (`take(batch)` + scheduler) that removes only
  terminal messages past their `updatedAt` cutoff, plus a built-in daily prune
  cron (`crons.ts`); idempotent. Default retention 30 days.
- Mount-safe: correct under multiple `app.use(component, { name })` mounts — each
  instance is sandboxed, the cron is registered per instance.
