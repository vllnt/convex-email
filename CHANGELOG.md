# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - Unreleased

### Added

- The npm tarball now ships `docs/API.md`, `CHANGELOG.md` and `llms.txt` next to `README.md`, so
  coding agents can read docs that match the installed version from
  `node_modules/@vllnt/convex-email/`. `README.md` and `llms.txt` gain a "For coding agents" note,
  and the README a "Related packages" section.
- `docs/API.md` now has an entry-point map and documents the `@vllnt/convex-email/test` helper,
  `JmapDiscoverOptions` and the SMTP and JMAP sender and transport types.
- `pnpm lint` (run by CI and before every publish) fails when a required file (`README.md`,
  `LICENSE`, `CHANGELOG.md`, `llms.txt`, `docs/API.md`) is missing from the packed tarball, or
  when an inline Markdown link in `llms.txt`, `README.md` or `docs/API.md` points outside the
  tarball or uses a GitHub URL into this repository for a shipped file
  (`scripts/check-package-docs.mjs`).

### Fixed

- Shipped TSDoc: the `Email` and `Parser` docs no longer suggest a `convex/values`
  validator's `.parse` (it has none), and `prune` documents its real default cutoff (30 days
  before the server clock).
- `enqueue` rejects an empty `messageId`, `to`, `from`, `transport` or `idempotencyKey` with
  `ConvexError({ code: "INVALID_ARGUMENT" })`, and a `maxAttempts` that is not a positive
  integer with `ConvexError({ code: "INVALID_MAX_ATTEMPTS" })`.
- `@vllnt/convex-email/test` now type-checks under `moduleResolution: nodenext` (explicit `.js`
  relative imports, Vite client types referenced).

### Changed

- `package.json` `homepage` is now `https://oss.vllnt.com/packages/convex-email`. `llms.txt` links
  to shipped files are relative; links to files outside the package are absolute GitHub URLs.
- The Publish workflow publishes a `canary` on every push to `main` that touches the package or its
  shipped docs, with no repository-variable gate. A canary is published under
  the `canary` dist-tag only and never moves `latest`.
- Adopt pnpm 10 with a release-age gate; releases are published only from CI with npm
  trusted publishing and provenance.
- The optional `nodemailer` peer range is now `^8.0.4 || ^9.0.0 || ^10.0.0` (was `^8.0.4`),
  so hosts can move to nodemailer 10.1.4 or later, which fixes the addressparser DoS and
  recipient-domain-bypass advisories still open in 8.x and 9.x. Prefer `^10.1.4`, the first
  release without a published advisory; it requires Node 20+. This package's own tests now
  run on nodemailer 10.4.0 and `@types/nodemailer` is dropped (nodemailer 10 ships its types).
- `MessageView`'s optional fields (`payload`, `subjectRef`, `idempotencyKey`, `providerId`,
  `error`) and `SmtpMailOptions`' optional fields are typed `?: T | undefined`, so hosts that
  enable `exactOptionalPropertyTypes` can pass them through unchanged. The client no longer
  sends optional arguments that are `undefined`; the values on the wire are the same.
- Development dependencies upgraded: `convex` 1.51, `convex-test` 0.0.73, `vitest` 5.1.1,
  `eslint` 10, `@vllnt/typescript` 3 (stricter compiler flags), pnpm 10.34.9, Node 24.22.3.
  The `convex` and `nodemailer` peer ranges are unchanged.

## [0.1.0] - 2026-09-01

### Added

- First release of `@vllnt/convex-email` — a durable, transport-agnostic outbound
  transactional email queue.
- Provider-neutral: the transport is a host-configured, host-driven adapter
  (`transport` is an opaque string tag). The component records send intent and
  per-message status and **never calls a mail provider**.
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
- **Optional generic SMTP transport** (`@vllnt/convex-email/smtp`) — sends a queued
  message over **any** SMTP server (Stalwart, Postfix, any provider's relay). The
  server is host config.
  - `sendViaSmtp(transport, message, config?)` — the **pure, injectable** send core
    (driven by an injected `SmtpTransport`), plus `validateSmtpConfig` and
    `toMailOptions`. The validators reject CR/LF (SMTP header) injection in every
    address, subject, and header value.
  - `createSmtpTransport(config)` / `createSmtpSender(config)` — the **thin
    `nodemailer` wrapper**, called from the host's own `"use node"` action.
  - `example/convex/` includes `flushQueuedOverSmtp` — the queue→send wiring
    (`listByStatus("queued")` → `markSending` → send → `markSent`/`markFailed`)
    exercised end to end against the component runtime with a fake transport.
- `nodemailer` is an **optional peer dependency** (`^8.0.4` — the floor that fixes
  the `envelope.size` CRLF injection advisory GHSA-c7w3-x93f-qmm8 / CVE-2025-14874).
  The queue core still installs and runs with **zero third-party runtime deps**; only
  a host importing `@vllnt/convex-email/smtp` pulls `nodemailer`.
- **Optional generic JMAP transport** (`@vllnt/convex-email/jmap`) — sends a queued
  message over **any JMAP server's HTTP API** (Stalwart, Fastmail, Cyrus, Apache
  James). JMAP is the protocol (RFC 8620/8621); the server is host config, so no
  vendor is baked in — the adapter is `./jmap`, never `./stalwart`.
  - Runs in a **plain Convex action** — JMAP is HTTP, so `fetch` works in V8: **no
    `"use node"`, no `nodemailer`, zero extra dependencies** (unlike the SMTP
    adapter's raw socket).
  - Pure, injected-`fetch` core — `sendViaJmap(fetchFn, message, config)`,
    `discoverJmapSession(fetchFn, opts)` (resolves account / identity / Sent mailbox
    from the JMAP session), `createJmapSender(config, fetchFn)`, plus
    `validateJmapConfig` / `buildEmailCreate` / `buildSubmitRequest` /
    `parseSubmitResponse`. The whole adapter is **100% covered** with a fake `fetch`
    (no excluded wrapper); it rejects CR/LF header injection in every address,
    subject, and header value.
  - `example/convex/` adds `flushQueuedOverJmap` (the queue→JMAP wiring) and
    `flushQueuedRouted` (one queue routed per message by its `transport` tag —
    `smtp` vs `jmap`), exercised end to end against the component runtime with a
    fake `fetch`.

### Fixed

- Apply the documented 30-day terminal-message retention and reject invalid prune batches to
  prevent premature audit deletion and scheduler loops.

### Changed

- Treat Convex `_generated` output as CLI-owned, exclude it from formatting, and expose a
  dedicated codegen script.
- Refresh all direct dependencies to their latest compatible releases .
- Require `convex@^1.45.0` and update `convex-test` to `^0.0.56`.
