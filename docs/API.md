# API Reference — @vllnt/convex-email

**Compatibility:** `convex@^1.45.0`; optional
`nodemailer@^8.0.4 || ^9.0.0 || ^10.0.0`, only for
[`@vllnt/convex-email/smtp`](#smtp-transport). ES modules only.

## Entry points

| Import                                                | Exports                                                                                                                                                         |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@vllnt/convex-email`                                 | `Email` class; types `EmailComponent`, `EmailOptions`, `EnqueueOptions`, `EnqueueResult`, `MarkFailedResult`, `MessageStatus`, `MessageView`, `Parser`          |
| `@vllnt/convex-email/jmap`                            | [JMAP transport](#jmap-transport): `createJmapSender`, `sendViaJmap`, `discoverJmapSession`, builders and types. No extra dependency, default Convex runtime    |
| `@vllnt/convex-email/smtp`                            | [SMTP transport](#smtp-transport): `createSmtpSender`, `createSmtpTransport`, `sendViaSmtp`, helpers and types. Needs `nodemailer` and a `"use node"` action   |
| `@vllnt/convex-email/convex.config` (or `.js`)        | default component config for `app.use(...)`                                                                                                                     |
| `@vllnt/convex-email/test`                            | `register(t, name = "email")` for `convex-test` (TypeScript source; needs Vite `import.meta.glob`)                                                              |
| `@vllnt/convex-email/_generated/component` (or `.js`) | type `ComponentApi`                                                                                                                                             |

The component stores one table, `messages`, reachable only through its
functions. It records each message and its status; it never calls a mail
server and never reads auth. Every handler stamps `createdAt` and `updatedAt`
from the server clock; no method takes a caller-supplied time.

## Lifecycle

```text
enqueue ──> queued ──markSending──> sending ──markSent──> sent (terminal)
              ^                        │
              └──markFailed, retried───┤
                                       └──markFailed, attempts used up──> failed (terminal)
```

- `markSending` moves `queued` to `sending` and adds 1 to `attempts`.
- `markFailed` returns the message to `queued` while `attempts < maxAttempts`,
  else moves it to `failed`.
- `markSent` and `markFailed` also accept a `queued` message.
- Nothing moves a message out of `sent` or `failed` (`TERMINAL_STATE`), except
  that `markSent` on a `sent` message is a no-op.

## Client

### `Email`

```ts
new Email<TPayload = unknown>(component: EmailComponent, options?: EmailOptions<TPayload>)
```

`component` is the mounted component, `components.email` (or the name passed
to `app.use`). Every method takes the host `ctx` first: methods that write need
`ctx.runMutation` (a mutation or action context), `get` and `listByStatus` need
`ctx.runQuery` (a query, mutation or action context).

`options.payloadValidator` (a [`Parser`](#parser)) runs on the payload passed
to `enqueue`, before storage, and on every payload returned by `get` and
`listByStatus`. It must return the typed value or throw. Without it, the
payload is cast to `TPayload` unchecked. `options.maxAttempts` is the default
attempt budget for `enqueue` (default 5); it is validated by `enqueue`, not by
the constructor.

### `enqueue`

```ts
enqueue(ctx, messageId: string, to: string, from: string, transport: string, opts?: EnqueueOptions<TPayload>): Promise<EnqueueResult>
```

Inserts a `queued` message with `attempts: 0` and returns
`{ messageId, deduplicated: false }`. `messageId` is chosen by the host and
must be unique. `to`, `from` and `transport` are stored as given; `transport`
is a free-form tag your sender can switch on.

Checks, in order:

1. `messageId`, `to`, `from`, `transport` and a supplied `idempotencyKey` must
   not be `""` (`INVALID_ARGUMENT`).
2. `maxAttempts` (`opts.maxAttempts`, else the client default) must be an
   integer of 1 or more (`INVALID_MAX_ATTEMPTS`).
3. If a stored message has the same `idempotencyKey`, nothing is inserted and
   that message's id is returned with `deduplicated: true`, whatever the other
   arguments are.
4. If a stored message has the same `messageId`, it throws `DUPLICATE_MESSAGE`.

The payload validator runs before the mutation is called. Pruned messages no
longer count for step 3 or 4.

### `markSending`

```ts
markSending(ctx, messageId: string): Promise<{ attempts: number }>
```

Claims a `queued` message: sets `sending`, adds 1 to `attempts`, returns the
new count. Throws `NOT_FOUND` for an unknown id, `TERMINAL_STATE` for a `sent`
or `failed` message and `INVALID_TRANSITION` for a message already `sending`.
Because it is a mutation, two concurrent claims of one message cannot both
succeed.

### `markSent`

```ts
markSent(ctx, messageId: string, opts?: { providerId?: string }): Promise<null>
```

Sets `sent`, stores `opts.providerId` and clears `error`. On a message already
`sent` it returns `null` and changes nothing (the first `providerId` is kept).
Throws `NOT_FOUND` for an unknown id and `TERMINAL_STATE` for a `failed`
message. A `queued` message is accepted too.

### `markFailed`

```ts
markFailed(ctx, messageId: string, opts?: { error?: string }): Promise<MarkFailedResult>
```

Stores `opts.error`. If `attempts < maxAttempts` the message becomes `queued`
and the result is `{ status: "queued", retried: true }`; otherwise it becomes
`failed` and the result is `{ status: "failed", retried: false }`. It sends
nothing and schedules nothing: the host schedules the next attempt. Throws
`NOT_FOUND` for an unknown id and `TERMINAL_STATE` for a `sent` or `failed`
message. A `queued` message is accepted too; it does not change `attempts`.

### `get`

```ts
get(ctx, messageId: string): Promise<MessageView<TPayload> | null>
```

Returns the message or `null`. The payload goes through `payloadValidator`
when one is set.

### `listByStatus`

```ts
listByStatus(ctx, status: MessageStatus, paginationOpts: PaginationOptions): Promise<PaginationResult<MessageView<TPayload>>>
```

One page of messages in `status`, ordered by `createdAt`, oldest first (index
`by_status`). `paginationOpts` is Convex `PaginationOptions`: start with
`{ cursor: null, numItems: 100 }` and pass `continueCursor` until `isDone`.
Every row's payload goes through `payloadValidator`.

### `prune`

```ts
prune(ctx, opts?: { before?: number; batch?: number }): Promise<number>
```

Deletes up to `batch` messages in `sent`, then `failed`, whose `updatedAt` is
older than `before`, oldest first (index `by_status_updated`). `queued` and
`sending` messages are never deleted. Defaults: `before` = server time minus 30
days, `batch` = 200. `batch` must be an integer in 1..500 (`INVALID_BATCH`);
`before` must be finite (`INVALID_BEFORE`). When a full batch is deleted it
schedules another pass with the same `before`. Returns the number deleted by
this call, not by later passes. Deleting a message also frees its `messageId`
and `idempotencyKey`.

## Types

### `EmailComponent`

The function references of the mounted component, as `components.email`. The
generated `ComponentApi` of a mount is assignable to it.

### `EmailOptions`

```ts
interface EmailOptions<TPayload> {
  payloadValidator?: Parser<TPayload>;
  maxAttempts?: number; // default 5
}
```

### `EnqueueOptions`

```ts
interface EnqueueOptions<TPayload> {
  payload?: TPayload;
  subjectRef?: string; // stored and returned; no method lists by it
  idempotencyKey?: string;
  maxAttempts?: number; // overrides EmailOptions.maxAttempts for this message
}
```

### `EnqueueResult`

```ts
interface EnqueueResult {
  messageId: string; // the existing message's id when deduplicated
  deduplicated: boolean;
}
```

### `MarkFailedResult`

```ts
interface MarkFailedResult {
  status: "queued" | "failed";
  retried: boolean; // true when the message went back to queued
}
```

### `MessageStatus`

```ts
type MessageStatus = "queued" | "sending" | "sent" | "failed";
```

### `MessageView`

```ts
interface MessageView<TPayload = unknown> {
  messageId: string;
  to: string;
  from: string;
  transport: string;
  status: MessageStatus;
  payload?: TPayload | undefined;
  subjectRef?: string | undefined;
  idempotencyKey?: string | undefined;
  providerId?: string | undefined; // set by markSent
  attempts: number; // markSending calls so far
  maxAttempts: number;
  error?: string | undefined; // from the last markFailed; cleared by markSent
  createdAt: number; // ms since epoch
  updatedAt: number; // ms since epoch, last change
}
```

### `Parser`

```ts
type Parser<T> = (value: unknown) => T;
```

Returns the typed value or throws. A Zod schema's `.parse` fits; a
`convex/values` validator has no `.parse`, so write a function.

## Errors

Component errors are `ConvexError`s whose `data` is `{ code, message }`
(`error.data.code`).

| Code                   | Thrown by                                | Message                                                           |
| ---------------------- | ---------------------------------------- | ----------------------------------------------------------------- |
| `INVALID_ARGUMENT`     | `enqueue`                                | `<field> must not be empty`                                       |
| `INVALID_MAX_ATTEMPTS` | `enqueue`                                | `maxAttempts must be a positive integer`                          |
| `DUPLICATE_MESSAGE`    | `enqueue`                                | `message "<messageId>" already exists`                            |
| `NOT_FOUND`            | `markSending`, `markSent`, `markFailed`  | `message "<messageId>" not found`                                 |
| `TERMINAL_STATE`       | `markSending`, `markFailed`              | `message "<messageId>" is already <status> and cannot transition` |
| `TERMINAL_STATE`       | `markSent` (on a `failed` message)       | `message "<messageId>" is already failed and cannot transition`   |
| `INVALID_TRANSITION`   | `markSending`                            | `message "<messageId>" is already sending`                        |
| `INVALID_BATCH`        | `prune`                                  | `batch must be an integer between 1 and 500`                      |
| `INVALID_BEFORE`       | `prune`                                  | `before must be finite`                                           |

The JMAP and SMTP helpers throw a plain `Error`:

| Message                                                                     | Thrown by                                                       |
| --------------------------------------------------------------------------- | --------------------------------------------------------------- |
| ``jmap config: `<key>` must be a non-empty string``                         | `validateJmapConfig`, `sendViaJmap`, `createJmapSender`         |
| ``jmap message: `to` must be a non-empty string``                           | `buildEmailCreate`, `buildSubmitRequest`, `sendViaJmap`         |
| ``jmap message: `to` must contain at least one address``                    | `buildEmailCreate`, `buildSubmitRequest`, `sendViaJmap`         |
| ``jmap message: `from` is required (pass `message.from` or `config.from`)`` | `buildEmailCreate`, `buildSubmitRequest`, `sendViaJmap`         |
| ``jmap message: one of `text` or `html` is required``                       | `buildEmailCreate`, `buildSubmitRequest`, `sendViaJmap`         |
| ``jmap message: `<field>` must not contain CR or LF``                       | `buildEmailCreate`, `buildSubmitRequest`, `sendViaJmap`         |
| `jmap: request failed (HTTP <status>)`                                      | `sendViaJmap`, `discoverJmapSession`                            |
| `jmap: malformed response (no methodResponses)`                             | `sendViaJmap`, `parseSubmitResponse`, `discoverJmapSession`     |
| `jmap: method error (<type>)`                                               | `sendViaJmap`, `parseSubmitResponse`                            |
| `jmap: response missing Email/set or EmailSubmission/set`                   | `sendViaJmap`, `parseSubmitResponse`                            |
| `jmap: <Email or EmailSubmission> not created (<type>)`                     | `sendViaJmap`, `parseSubmitResponse`                            |
| `jmap: <Email or EmailSubmission> not created (no id in response)`          | `sendViaJmap`, `parseSubmitResponse`                            |
| ``jmap discover: `sessionUrl` must be a non-empty string``                  | `discoverJmapSession`                                           |
| ``jmap discover: `token` must be a non-empty string``                       | `discoverJmapSession`                                           |
| `jmap discover: session request failed (HTTP <status>)`                     | `discoverJmapSession`                                           |
| `jmap discover: session has no apiUrl`                                      | `discoverJmapSession`                                           |
| `jmap discover: no primary mail account`                                    | `discoverJmapSession`                                           |
| `jmap discover: no sending identity found`                                  | `discoverJmapSession`                                           |
| `jmap discover: no sent or drafts mailbox found`                            | `discoverJmapSession`                                           |
| ``smtp config: `host` must be a non-empty string``                          | `validateSmtpConfig`, `createSmtpTransport`, `createSmtpSender` |
| ``smtp config: `port` must be an integer in 1..65535``                      | `validateSmtpConfig`, `createSmtpTransport`, `createSmtpSender` |
| ``smtp config: `auth` requires string `user` and `pass` ``                  | `validateSmtpConfig`, `createSmtpTransport`, `createSmtpSender` |
| ``smtp message: `to` must be a non-empty string``                           | `toMailOptions`, `sendViaSmtp`, an `SmtpSender`                 |
| ``smtp message: `from` is required (pass `message.from` or `config.from`)`` | `toMailOptions`, `sendViaSmtp`, an `SmtpSender`                 |
| ``smtp message: one of `text` or `html` is required``                       | `toMailOptions`, `sendViaSmtp`, an `SmtpSender`                 |
| ``smtp message: `<field>` must not contain CR or LF``                       | `toMailOptions`, `sendViaSmtp`, an `SmtpSender`                 |

Causes and fixes: [README, Errors and fixes](../README.md#errors-and-fixes).

## Cron

Each mount registers one cron, `email:prune`: every 24 hours it runs `prune`
with `batch` 200 and the default 30-day `before`. The cadence is a module
constant; it cannot be changed or turned off per mount. For a shorter
retention, call `prune` with your own `before` from a host cron.

## JMAP transport

`@vllnt/convex-email/jmap` sends over any JMAP server (RFC 8620 and 8621)
through an injected `fetch`, so it runs in a default Convex action: no
`"use node"`, no dependency. A send is one HTTP request with two method calls:
`Email/set` (create, id `draft`) then `EmailSubmission/set` (submit `#draft`).
It rejects CR and LF in `to`, `from`, `replyTo`, `subject` and header names and
values.

### `createJmapSender`

```ts
createJmapSender(config: JmapConfig, fetchFn: JmapFetch): JmapSender
```

Validates `config` now (throws on a bad one) and returns a function that sends
one `JmapMessage` with `sendViaJmap`.

### `sendViaJmap`

```ts
sendViaJmap(fetchFn: JmapFetch, message: JmapMessage, config: JmapConfig): Promise<JmapSendResult>
```

Validates `config`, builds the request with `buildSubmitRequest`, POSTs it to
`config.endpoint` with `Authorization: Bearer <token>`, and parses the reply
with `parseSubmitResponse`. Throws on a non-2xx status or a JMAP error. Store
the returned `messageId` (the `EmailSubmission` id) as `providerId`.

### `discoverJmapSession`

```ts
discoverJmapSession(fetchFn: JmapFetch, opts: JmapDiscoverOptions): Promise<JmapConfig>
```

GETs `opts.sessionUrl` for the `apiUrl` and the primary
`urn:ietf:params:jmap:mail` account, then calls `Identity/get` and
`Mailbox/get`. The identity is the one whose email matches `opts.from`
(case-insensitive), else the first. The mailbox is the one with role `sent`,
else `drafts`, else the first. The result's `from` is `opts.from`, else the
identity's email. Three HTTP requests; run it once and keep the result.

### `validateJmapConfig`

```ts
validateJmapConfig(config: JmapConfig): JmapConfig
```

Throws unless `endpoint`, `token`, `accountId`, `identityId` and `mailboxId`
are non-empty strings (after trimming). Returns `config` unchanged.

### `buildEmailCreate`

```ts
buildEmailCreate(message: JmapMessage, config: Pick<JmapConfig, "from" | "mailboxId">): {
  email: Record<string, unknown>;
  envelope: { mailFrom: { email: string }; rcptTo: Array<{ email: string }> };
}
```

The `Email/set` create object and the submission envelope. `from` is
`message.from`, else `config.from`. `to` is split on commas. With both `text`
and `html` the body is `multipart/alternative`. Each header becomes a
`header:<Name>:asText` property. The email is filed in `config.mailboxId` with
the `$seen` keyword. The return type is not exported by name.

### `buildSubmitRequest`

```ts
buildSubmitRequest(message: JmapMessage, config: JmapConfig): { using: string[]; methodCalls: unknown[] }
```

The full request body: `using` the core, mail and submission capabilities,
then `Email/set` and `EmailSubmission/set` (with `config.identityId` and the
envelope).

### `parseSubmitResponse`

```ts
parseSubmitResponse(json: unknown): JmapSendResult
```

Throws on a malformed body, an `error` method response, a missing call or a
`notCreated` entry; otherwise returns the created `Email` id and
`EmailSubmission` id.

### `JmapConfig`

```ts
interface JmapConfig {
  endpoint: string; // the session's apiUrl
  token: string; // bearer token; keep it server-side
  accountId: string;
  identityId: string;
  mailboxId: string; // where the sent copy is filed
  from?: string; // default From
}
```

### `JmapMessage`

```ts
interface JmapMessage {
  to: string; // one address or a comma-separated list
  from?: string; // else JmapConfig.from
  subject?: string;
  text?: string; // one of text or html is required
  html?: string;
  replyTo?: string;
  headers?: Record<string, string>;
}
```

### `JmapSendResult`

```ts
interface JmapSendResult {
  messageId: string; // EmailSubmission id; store as providerId
  emailId: string; // created Email id
}
```

### `JmapSender`

```ts
type JmapSender = (message: JmapMessage) => Promise<JmapSendResult>;
```

### `JmapFetch`

```ts
type JmapFetch = (url: string, init: JmapRequestInit) => Promise<JmapResponse>;
```

Pass `(url, init) => fetch(url, init)` in a Convex action, or a fake in tests.

### `JmapRequestInit`

```ts
interface JmapRequestInit {
  method: string; // "GET" for the session, "POST" for API calls
  headers: Record<string, string>;
  body?: string;
}
```

### `JmapResponse`

```ts
interface JmapResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
```

### `JmapDiscoverOptions`

```ts
interface JmapDiscoverOptions {
  sessionUrl: string; // for example https://mail.example.com/.well-known/jmap
  token: string;
  from?: string; // pick the identity with this address
}
```

## SMTP transport

`@vllnt/convex-email/smtp` sends over any SMTP server with `nodemailer`.
Importing this entry needs `nodemailer` installed, even for the helpers that do
not use it (the entry re-exports a module that imports `nodemailer`); without
it the import fails with `ERR_MODULE_NOT_FOUND`. Call it from a Node action
(`"use node"`). `nodemailer` 10.1.4 is the first release with no advisory in
the GitHub Advisory Database; 10.x needs Node.js 20 or later.

### `createSmtpSender`

```ts
createSmtpSender(config: SmtpConfig): SmtpSender
```

Builds a transport with `createSmtpTransport(config)` and returns a function
that sends one `SmtpMessage` with `sendViaSmtp`, using `config.from` as the
default sender.

### `createSmtpTransport`

```ts
createSmtpTransport(config: SmtpConfig): SmtpTransport
```

Validates `config` with `validateSmtpConfig`, then returns
`nodemailer.createTransport({ host, port, secure, auth })`.

### `sendViaSmtp`

```ts
sendViaSmtp(transport: SmtpTransport, message: SmtpMessage, config?: Pick<SmtpConfig, "from">): Promise<SmtpSendResult>
```

Builds the options with `toMailOptions`, calls `transport.sendMail`, and
returns `{ messageId, accepted, rejected }` (`messageId` is `""` when the
server returned none). Throws when the transport throws. A resolved send can
still list addresses in `rejected`.

### `validateSmtpConfig`

```ts
validateSmtpConfig(config: SmtpConfig): SmtpConfig & { secure: boolean }
```

Throws unless `host` is a non-empty string, `port` is an integer in 1..65535,
and `auth` (when set) has string `user` and `pass`. Returns the config with
`secure` set: the given value, else `true` for port 465 and `false` otherwise.

### `toMailOptions`

```ts
toMailOptions(message: SmtpMessage, config: Pick<SmtpConfig, "from">): SmtpMailOptions
```

Resolves `from` (`message.from`, else `config.from`), requires `to` and one of
`text`/`html`, and throws on CR or LF in `to`, `from`, `replyTo`, `subject` and
header names and values.

### `SmtpConfig`

```ts
interface SmtpConfig {
  host: string;
  port: number;
  secure?: boolean; // default: true for port 465, else false
  auth?: { user: string; pass: string }; // omit for an unauthenticated relay
  from?: string; // default From
}
```

### `SmtpMessage`

```ts
interface SmtpMessage {
  to: string;
  from?: string; // else SmtpConfig.from
  subject?: string;
  text?: string; // one of text or html is required
  html?: string;
  replyTo?: string;
  headers?: Record<string, string>;
}
```

### `SmtpMailOptions`

```ts
interface SmtpMailOptions {
  to: string;
  from: string;
  subject?: string | undefined;
  text?: string | undefined;
  html?: string | undefined;
  replyTo?: string | undefined;
  headers?: Record<string, string> | undefined;
}
```

### `SmtpSendInfo`

```ts
interface SmtpSendInfo {
  messageId?: string;
  accepted?: ReadonlyArray<string | { address: string }>;
  rejected?: ReadonlyArray<string | { address: string }>;
}
```

### `SmtpSendResult`

```ts
interface SmtpSendResult {
  messageId: string; // store as providerId
  accepted: string[];
  rejected: string[];
}
```

### `SmtpSender`

```ts
type SmtpSender = (message: SmtpMessage) => Promise<SmtpSendResult>;
```

### `SmtpTransport`

```ts
interface SmtpTransport {
  sendMail(options: SmtpMailOptions): Promise<SmtpSendInfo>;
}
```

A `nodemailer` transporter fits; pass a fake in tests.

## Other entry points

### `convex.config`

```ts
import email from "@vllnt/convex-email/convex.config";
```

The component definition (`defineComponent("email")`). Pass it to
`app.use(email)`, or `app.use(email, { name })` for another instance with its
own table and cron.

### `register`

```ts
register<TSchema extends GenericSchema>(t: TestConvex<SchemaDefinition<TSchema, boolean>>, name?: string): void
```

Registers the component in a `convex-test` instance built with any host
schema. `name` defaults to `"email"` and must match the `app.use` name. The
entry ships TypeScript source that uses Vite's `import.meta.glob`, so the app
needs `convex-test`, `vitest` and `vite`.

### `ComponentApi`

```ts
import type { ComponentApi } from "@vllnt/convex-email/_generated/component";
```

The generated type of a mounted instance (`components.email`).
