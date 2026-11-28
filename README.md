# @vllnt/convex-email

TypeScript Convex component for outbound transactional email: durable send
queue, retry budget, idempotent enqueue, delivery status, SMTP and JMAP senders.

## For coding agents

Docs for the installed version are in `node_modules/@vllnt/convex-email/`:
`docs/API.md`, `llms.txt`, `CHANGELOG.md` and the TypeScript `src/`. Read them
before writing code against this package.

## When to use

- Use it when a mutation must record an outbound email and return before the
  email is sent.
- Use it when you send through your own SMTP or JMAP server, or another
  transport you call from a Convex action.
- Use it when you need a per-message status (`queued`, `sending`, `sent`,
  `failed`) and a cap on send attempts.
- Use it when a retried request must not queue the same email twice.
- Do not use it when the message is an in-app inbox item with read/unread
  state: use `@vllnt/convex-notifications`.
- Do not use it when you want a component that calls the Resend API itself and
  tracks delivery webhooks: use `@convex-dev/resend`.

## Install

```bash
pnpm add @vllnt/convex-email
```

Peer dependency: `convex@^1.45.0`. Add `nodemailer` only for the SMTP sender.

## Quick start

```ts
// convex/convex.config.ts
import email from "@vllnt/convex-email/convex.config";
import { defineApp } from "convex/server";

const app = defineApp();
app.use(email);
export default app;
```

```ts
// convex/email.ts
import { Email } from "@vllnt/convex-email";
import { createJmapSender } from "@vllnt/convex-email/jmap";
import { v } from "convex/values";

import { components, internal } from "./_generated/api";
import { internalAction, internalMutation, query } from "./_generated/server";

const email = new Email<{ subject: string; html: string }>(components.email);

// Record the email and schedule the send. A repeated call returns the same id.
export const sendWelcome = internalMutation({
  args: { userId: v.string(), to: v.string() },
  returns: v.string(),
  handler: async (ctx, { userId, to }): Promise<string> => {
    const { messageId, deduplicated } = await email.enqueue(
      ctx,
      crypto.randomUUID(),
      to,
      "no-reply@example.com",
      "jmap",
      {
        payload: { subject: "Welcome", html: "<p>Hello</p>" },
        idempotencyKey: `welcome:${userId}`,
      },
    );
    if (!deduplicated) {
      await ctx.scheduler.runAfter(0, internal.email.deliver, { messageId });
    }
    return messageId;
  },
});

// Claim, send, record the outcome. The host schedules retries.
export const deliver = internalAction({
  args: { messageId: v.string() },
  returns: v.null(),
  handler: async (ctx, { messageId }): Promise<null> => {
    const message = await email.get(ctx, messageId);
    if (message === null || message.status !== "queued") return null;
    const { attempts } = await email.markSending(ctx, messageId);
    let providerId: string;
    try {
      // Inside the try: a missing JMAP_* variable is recorded by markFailed.
      const send = createJmapSender(
        {
          endpoint: process.env.JMAP_API_URL ?? "",
          token: process.env.JMAP_TOKEN ?? "",
          accountId: process.env.JMAP_ACCOUNT_ID ?? "",
          identityId: process.env.JMAP_IDENTITY_ID ?? "",
          mailboxId: process.env.JMAP_MAILBOX_ID ?? "",
        },
        (url, init) => fetch(url, init),
      );
      const result = await send({
        to: message.to,
        from: message.from,
        subject: message.payload?.subject,
        html: message.payload?.html ?? "",
      });
      providerId = result.messageId;
    } catch (error) {
      const failed = await email.markFailed(ctx, messageId, {
        error: String(error),
      });
      if (failed.retried) {
        const delay = 60_000 * attempts;
        await ctx.scheduler.runAfter(delay, internal.email.deliver, {
          messageId,
        });
      }
      return null;
    }
    await email.markSent(ctx, messageId, { providerId });
    return null;
  },
});

// Delivery status for a client: queued, sending, sent or failed.
export const status = query({
  args: { messageId: v.string() },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, { messageId }) =>
    (await email.get(ctx, messageId))?.status ?? null,
});
```

Run `npx convex dev` once to generate `components.email`, and set the five
`JMAP_*` environment variables in your deployment (see
[Find the JMAP ids](#find-the-jmap-ids-once)). The component never sends
email and never reads auth: your functions decide who may enqueue, and your
action calls the mail server. Keep `sendWelcome` internal or check the caller
before you call it from a public mutation.

## API

Full reference: [docs/API.md](docs/API.md).

| Export                                                                         | Import from                                | What it does                                                         |
| ------------------------------------------------------------------------------ | ------------------------------------------ | -------------------------------------------------------------------- |
| [`Email`](docs/API.md#email)                                                   | `@vllnt/convex-email`                      | Host client: `new Email<TPayload>(components.email, options?)`       |
| [`enqueue(ctx, messageId, to, from, transport, opts?)`](docs/API.md#enqueue)   | `Email` method, mutation                   | Insert a `queued` message; returns `{ messageId, deduplicated }`     |
| [`markSending(ctx, messageId)`](docs/API.md#marksending)                       | `Email` method, mutation                   | Claim a `queued` message: `sending`, `attempts + 1`                  |
| [`markSent(ctx, messageId, opts?)`](docs/API.md#marksent)                      | `Email` method, mutation                   | Record a send: terminal `sent`, stores `providerId`                  |
| [`markFailed(ctx, messageId, opts?)`](docs/API.md#markfailed)                  | `Email` method, mutation                   | Record a failure: back to `queued`, or terminal `failed`             |
| [`get(ctx, messageId)`](docs/API.md#get)                                       | `Email` method, query                      | One message, or `null`                                               |
| [`listByStatus(ctx, status, paginationOpts)`](docs/API.md#listbystatus)        | `Email` method, query                      | One page of messages in a status, oldest first                       |
| [`prune(ctx, opts?)`](docs/API.md#prune)                                       | `Email` method, mutation                   | Delete old `sent`/`failed` messages in batches                       |
| [`EmailComponent`](docs/API.md#emailcomponent)                                 | `@vllnt/convex-email` (type)               | Type of `components.email` accepted by `Email`                       |
| [`EmailOptions`](docs/API.md#emailoptions)                                     | `@vllnt/convex-email` (type)               | `{ payloadValidator?, maxAttempts? }`                                |
| [`EnqueueOptions`](docs/API.md#enqueueoptions)                                 | `@vllnt/convex-email` (type)               | `{ payload?, subjectRef?, idempotencyKey?, maxAttempts? }`           |
| [`EnqueueResult`](docs/API.md#enqueueresult)                                   | `@vllnt/convex-email` (type)               | `{ messageId, deduplicated }`                                        |
| [`MarkFailedResult`](docs/API.md#markfailedresult)                             | `@vllnt/convex-email` (type)               | `{ status: "queued" \| "failed", retried }`                          |
| [`MessageStatus`](docs/API.md#messagestatus)                                   | `@vllnt/convex-email` (type)               | `"queued" \| "sending" \| "sent" \| "failed"`                        |
| [`MessageView`](docs/API.md#messageview)                                       | `@vllnt/convex-email` (type)               | Result of `get` and `listByStatus` rows                              |
| [`Parser`](docs/API.md#parser)                                                 | `@vllnt/convex-email` (type)               | `(value: unknown) => T`, the `payloadValidator` shape                |
| [`createJmapSender`](docs/API.md#createjmapsender)                             | `@vllnt/convex-email/jmap`                 | Bind a config and `fetch` into a one-call JMAP sender                |
| [`sendViaJmap`](docs/API.md#sendviajmap)                                       | `@vllnt/convex-email/jmap`                 | Send one message over JMAP with an injected `fetch`                  |
| [`discoverJmapSession`](docs/API.md#discoverjmapsession)                       | `@vllnt/convex-email/jmap`                 | Read account, identity and mailbox ids from a JMAP session           |
| [`validateJmapConfig`](docs/API.md#validatejmapconfig)                         | `@vllnt/convex-email/jmap`                 | Throw unless every `JmapConfig` id is a non-empty string             |
| [`buildEmailCreate`](docs/API.md#buildemailcreate)                             | `@vllnt/convex-email/jmap`                 | JMAP `Email/set` create object and submission envelope               |
| [`buildSubmitRequest`](docs/API.md#buildsubmitrequest)                         | `@vllnt/convex-email/jmap`                 | Full JMAP request body: `Email/set` then `EmailSubmission/set`       |
| [`parseSubmitResponse`](docs/API.md#parsesubmitresponse)                       | `@vllnt/convex-email/jmap`                 | Read the email and submission ids from a JMAP response               |
| [`JmapConfig`](docs/API.md#jmapconfig)                                         | `@vllnt/convex-email/jmap` (type)          | `{ endpoint, token, accountId, identityId, mailboxId, from? }`       |
| [`JmapMessage`](docs/API.md#jmapmessage)                                       | `@vllnt/convex-email/jmap` (type)          | `{ to, from?, subject?, text?, html?, replyTo?, headers? }`          |
| [`JmapSendResult`](docs/API.md#jmapsendresult)                                 | `@vllnt/convex-email/jmap` (type)          | `{ messageId, emailId }`                                             |
| [`JmapSender`](docs/API.md#jmapsender)                                         | `@vllnt/convex-email/jmap` (type)          | `(message: JmapMessage) => Promise<JmapSendResult>`                  |
| [`JmapFetch`](docs/API.md#jmapfetch)                                           | `@vllnt/convex-email/jmap` (type)          | The injected `fetch` shape                                           |
| [`JmapRequestInit`](docs/API.md#jmaprequestinit)                               | `@vllnt/convex-email/jmap` (type)          | `{ method, headers, body? }` passed to `JmapFetch`                   |
| [`JmapResponse`](docs/API.md#jmapresponse)                                     | `@vllnt/convex-email/jmap` (type)          | `{ ok, status, json() }` returned by `JmapFetch`                     |
| [`JmapDiscoverOptions`](docs/API.md#jmapdiscoveroptions)                       | `@vllnt/convex-email/jmap` (type)          | `{ sessionUrl, token, from? }`                                       |
| [`createSmtpSender`](docs/API.md#createsmtpsender)                             | `@vllnt/convex-email/smtp`                 | One-call sender over a real `nodemailer` transport (Node only)       |
| [`createSmtpTransport`](docs/API.md#createsmtptransport)                       | `@vllnt/convex-email/smtp`                 | Real `nodemailer` transport from an `SmtpConfig` (Node only)         |
| [`sendViaSmtp`](docs/API.md#sendviasmtp)                                       | `@vllnt/convex-email/smtp`                 | Send one message through an injected `SmtpTransport`                 |
| [`validateSmtpConfig`](docs/API.md#validatesmtpconfig)                         | `@vllnt/convex-email/smtp`                 | Check an `SmtpConfig` and resolve `secure`                           |
| [`toMailOptions`](docs/API.md#tomailoptions)                                   | `@vllnt/convex-email/smtp`                 | Build `sendMail` options; rejects CR/LF in headers                   |
| [`SmtpConfig`](docs/API.md#smtpconfig)                                         | `@vllnt/convex-email/smtp` (type)          | `{ host, port, secure?, auth?, from? }`                              |
| [`SmtpMessage`](docs/API.md#smtpmessage)                                       | `@vllnt/convex-email/smtp` (type)          | `{ to, from?, subject?, text?, html?, replyTo?, headers? }`          |
| [`SmtpMailOptions`](docs/API.md#smtpmailoptions)                               | `@vllnt/convex-email/smtp` (type)          | What `toMailOptions` returns                                         |
| [`SmtpSendInfo`](docs/API.md#smtpsendinfo)                                     | `@vllnt/convex-email/smtp` (type)          | Raw `sendMail` result read by `sendViaSmtp`                          |
| [`SmtpSendResult`](docs/API.md#smtpsendresult)                                 | `@vllnt/convex-email/smtp` (type)          | `{ messageId, accepted, rejected }`                                  |
| [`SmtpSender`](docs/API.md#smtpsender)                                         | `@vllnt/convex-email/smtp` (type)          | `(message: SmtpMessage) => Promise<SmtpSendResult>`                  |
| [`SmtpTransport`](docs/API.md#smtptransport)                                   | `@vllnt/convex-email/smtp` (type)          | `{ sendMail(options) }`, the injected transport shape                |
| [`default` (component config)](docs/API.md#convexconfig)                       | `@vllnt/convex-email/convex.config`        | Pass to `app.use(...)`                                               |
| [`register`](docs/API.md#register)                                             | `@vllnt/convex-email/test`                 | Mount the component in `convex-test`                                 |
| [`ComponentApi`](docs/API.md#componentapi)                                     | `@vllnt/convex-email/_generated/component` | Generated type of the mounted component                              |

## Common tasks

### Validate the payload

`payloadValidator` runs on the payload passed to `enqueue` and on every payload
returned by `get` and `listByStatus`. It must return the typed value or throw.
A `convex/values` validator has no `.parse`, so write a function (a Zod
schema's `.parse` also fits).

```ts
// convex/receipts.ts
import { Email } from "@vllnt/convex-email";
import { v } from "convex/values";

import { components } from "./_generated/api";
import { internalMutation } from "./_generated/server";

type Receipt = { subject: string; html: string };

const email = new Email<Receipt>(components.email, {
  payloadValidator: (value) => {
    if (
      typeof value !== "object" ||
      value === null ||
      !("subject" in value) ||
      !("html" in value) ||
      typeof value.subject !== "string" ||
      typeof value.html !== "string"
    ) {
      throw new Error("Expected { subject: string; html: string }");
    }
    return { subject: value.subject, html: value.html };
  },
  maxAttempts: 3,
});

export const queueReceipt = internalMutation({
  args: { orderId: v.string(), to: v.string() },
  returns: v.string(),
  handler: async (ctx, { orderId, to }) => {
    const { messageId } = await email.enqueue(
      ctx,
      `receipt:${orderId}`,
      to,
      "billing@example.com",
      "jmap",
      { payload: { subject: "Your receipt", html: "<p>Thanks</p>" } },
    );
    return messageId;
  },
});
```

### Send over SMTP

`nodemailer` opens a raw socket, so the SMTP sender runs only in a Node action
(`"use node"`). Add `nodemailer` to your app. A `"use node"` file may contain
only actions.

```ts
// convex/smtp.ts
"use node";
import { Email } from "@vllnt/convex-email";
import { createSmtpSender } from "@vllnt/convex-email/smtp";
import { v } from "convex/values";

import { components } from "./_generated/api";
import { internalAction } from "./_generated/server";

const email = new Email<{ subject: string; text: string }>(components.email);

export const deliverOverSmtp = internalAction({
  args: { messageId: v.string() },
  returns: v.null(),
  handler: async (ctx, { messageId }): Promise<null> => {
    const message = await email.get(ctx, messageId);
    if (message === null || message.status !== "queued") return null;
    await email.markSending(ctx, messageId);
    let providerId: string;
    try {
      // Inside the try: a missing SMTP_* variable is recorded by markFailed.
      const send = createSmtpSender({
        host: process.env.SMTP_HOST ?? "",
        port: 465,
        secure: true,
        auth: {
          user: process.env.SMTP_USER ?? "",
          pass: process.env.SMTP_PASS ?? "",
        },
      });
      const result = await send({
        to: message.to,
        from: message.from,
        subject: message.payload?.subject,
        text: message.payload?.text ?? "",
      });
      providerId = result.messageId;
    } catch (error) {
      // markFailed returns { retried: true } while attempts remain; schedule
      // another run then, as the Quick start does.
      await email.markFailed(ctx, messageId, { error: String(error) });
      return null;
    }
    await email.markSent(ctx, messageId, { providerId });
    return null;
  },
});
```

To use both senders on one queue, read `message.transport` (the string you
passed to `enqueue`) and call the matching sender.

### Find the JMAP ids once

`discoverJmapSession` reads the API URL, account, identity and Sent mailbox ids
from the server's JMAP session. Run it once, then store the values as the
`JMAP_*` environment variables used in Quick start.

```ts
// convex/jmapSetup.ts
import { discoverJmapSession } from "@vllnt/convex-email/jmap";
import { v } from "convex/values";

import { internalAction } from "./_generated/server";

export const discover = internalAction({
  args: { sessionUrl: v.string(), from: v.string() },
  returns: v.object({
    endpoint: v.string(),
    accountId: v.string(),
    identityId: v.string(),
    mailboxId: v.string(),
  }),
  handler: async (_ctx, { sessionUrl, from }) => {
    const config = await discoverJmapSession((url, init) => fetch(url, init), {
      sessionUrl,
      token: process.env.JMAP_TOKEN ?? "",
      from,
    });
    return {
      endpoint: config.endpoint,
      accountId: config.accountId,
      identityId: config.identityId,
      mailboxId: config.mailboxId,
    };
  },
});
```

Run it with
`npx convex run jmapSetup:discover '{"sessionUrl":"https://mail.example.com/.well-known/jmap","from":"no-reply@example.com"}'`.

### Recover messages stuck in `sending`

If an action dies between `markSending` and `markSent`/`markFailed`, the
message stays in `sending`: the component has no lease or timeout. This host
function moves old `sending` messages back through `markFailed`, which
re-queues them while attempts remain. The email may already have been
delivered, so only do this after a timeout longer than any send.

```ts
// convex/recovery.ts
import { Email } from "@vllnt/convex-email";
import { v } from "convex/values";

import { components } from "./_generated/api";
import { internalMutation } from "./_generated/server";

const email = new Email(components.email);
const STUCK_AFTER_MS = 15 * 60 * 1000;

export const requeueStuck = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const { page } = await email.listByStatus(ctx, "sending", {
      cursor: null,
      numItems: 100,
    });
    const stuck = page.filter(
      (message) => message.updatedAt < Date.now() - STUCK_AFTER_MS,
    );
    for (const message of stuck) {
      await email.markFailed(ctx, message.messageId, {
        error: "sender timed out",
      });
    }
    return stuck.length;
  },
});
```

Re-queued messages need a new `deliver` run; schedule one per message, or run
a host cron that sends every `queued` message.

### Mount a second instance

Each `app.use` gets its own table, cron and data. Use it to keep two streams
apart; the component has no other partition.

```ts
// convex/convex.config.ts
import email from "@vllnt/convex-email/convex.config";
import { defineApp } from "convex/server";

const app = defineApp();
app.use(email);
app.use(email, { name: "marketingEmail" });
export default app;
```

```ts
// convex/clients.ts
import { Email } from "@vllnt/convex-email";

import { components } from "./_generated/api";

export const transactional = new Email(components.email);
export const marketing = new Email(components.marketingEmail, {
  maxAttempts: 2,
});
```

### Keep sent mail for less than 30 days

The built-in cron deletes `sent` and `failed` messages 30 days after their last
update. Call `prune` from your own cron for a shorter window; the built-in
30-day sweep keeps running.

```ts
// convex/retention.ts
import { Email } from "@vllnt/convex-email";
import { v } from "convex/values";

import { components } from "./_generated/api";
import { internalMutation } from "./_generated/server";

const email = new Email(components.email);
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export const pruneWeek = internalMutation({
  args: {},
  returns: v.number(),
  handler: (ctx) => email.prune(ctx, { before: Date.now() - SEVEN_DAYS_MS }),
});
```

## Errors and fixes

Component errors are `ConvexError`s whose `data` is `{ code, message }`. Catch
them in the host with `error instanceof ConvexError` and read
`error.data.code`. Arguments of the wrong type are rejected by Convex argument
validation before the component runs. Full table:
[docs/API.md#errors](docs/API.md#errors).

| Code                   | Message                                                                                           | Cause                                                                                    | Fix                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `INVALID_ARGUMENT`     | `<field> must not be empty`                                                                       | `enqueue` got `""` for `messageId`, `to`, `from`, `transport` or `idempotencyKey`        | Pass a non-empty string, or omit `idempotencyKey`                                         |
| `INVALID_MAX_ATTEMPTS` | `maxAttempts must be a positive integer`                                                          | `enqueue` got a `maxAttempts` (per call or client default) below 1 or not an integer    | Pass an integer of 1 or more, or omit it (default 5)                                      |
| `DUPLICATE_MESSAGE`    | `message "<messageId>" already exists`                                                            | `enqueue` reused a `messageId` and no `idempotencyKey` matched                           | Use a new `messageId`, or pass the same `idempotencyKey` to get the existing message back |
| `NOT_FOUND`            | `message "<messageId>" not found`                                                                 | `markSending`, `markSent` or `markFailed` got an unknown id (or one already pruned)      | Use the `messageId` returned by `enqueue`                                                 |
| `TERMINAL_STATE`       | `message "<messageId>" is already <status> and cannot transition`                                 | The message is `sent` or `failed`. `markSent` says `message "<messageId>" is already failed and cannot transition`; on a `sent` message it is a no-op | Read the status with `get` first; do not retry a terminal message                         |
| `INVALID_TRANSITION`   | `message "<messageId>" is already sending`                                                        | `markSending` on a message another sender has claimed                                    | Skip it; the other sender reports the outcome                                             |
| `INVALID_BATCH`        | `batch must be an integer between 1 and 500`                                                      | `prune` got a `batch` outside 1..500 or not an integer                                   | Pass 1..500, or omit it (default 200)                                                     |
| `INVALID_BEFORE`       | `before must be finite`                                                                           | `prune` got `NaN` or `Infinity` as `before`                                              | Pass a millisecond timestamp, or omit it (default 30 days ago)                            |

The JMAP and SMTP helpers throw a plain `Error`. Catch it in your action and
call `markFailed`. Config errors repeat on every attempt, so fix the config
instead of retrying.

| Message                                                                     | Thrown by                                                 | Fix                                                                       |
| --------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------- |
| ``jmap config: `<key>` must be a non-empty string``                         | `validateJmapConfig`, `sendViaJmap`, `createJmapSender`   | Set `endpoint`, `token`, `accountId`, `identityId` and `mailboxId`        |
| ``jmap message: `to` must be a non-empty string``                           | `buildEmailCreate`, `sendViaJmap`                         | Pass a recipient address                                                  |
| ``jmap message: `to` must contain at least one address``                    | `buildEmailCreate`, `sendViaJmap`                         | `to` held only commas or spaces; pass at least one address                |
| ``jmap message: `from` is required (pass `message.from` or `config.from`)`` | `buildEmailCreate`, `sendViaJmap`                         | Pass `from` on the message or in `JmapConfig`                             |
| ``jmap message: one of `text` or `html` is required``                       | `buildEmailCreate`, `sendViaJmap`                         | Pass `text`, `html` or both                                               |
| ``jmap message: `<field>` must not contain CR or LF``                       | `buildEmailCreate`, `sendViaJmap`                         | Remove line breaks from `to`, `from`, `replyTo`, `subject` and `headers`  |
| `jmap: request failed (HTTP <status>)`                                      | `sendViaJmap`, `discoverJmapSession`                      | Check `endpoint`, the token and the server; 401 means a bad token         |
| `jmap: malformed response (no methodResponses)`                             | `sendViaJmap`, `parseSubmitResponse`, `discoverJmapSession` | `endpoint` is not a JMAP API URL; use the session's `apiUrl`            |
| `jmap: method error (<type>)`                                               | `sendViaJmap`, `parseSubmitResponse`                      | The server rejected a method call; check the account and capabilities     |
| `jmap: response missing Email/set or EmailSubmission/set`                   | `sendViaJmap`, `parseSubmitResponse`                      | The server skipped a call; check that the account has submission rights   |
| `jmap: <Email or EmailSubmission> not created (<type>)`                     | `sendViaJmap`, `parseSubmitResponse`                      | Read the `SetError` type; check `mailboxId` and `identityId`              |
| `jmap: <Email or EmailSubmission> not created (no id in response)`          | `sendViaJmap`, `parseSubmitResponse`                      | The server returned no created id; check the server logs                  |
| ``jmap discover: `sessionUrl` must be a non-empty string``                  | `discoverJmapSession`                                     | Pass the session URL, such as `https://host/.well-known/jmap`             |
| ``jmap discover: `token` must be a non-empty string``                       | `discoverJmapSession`                                     | Pass the bearer token                                                     |
| `jmap discover: session request failed (HTTP <status>)`                     | `discoverJmapSession`                                     | Check `sessionUrl` and the token                                          |
| `jmap discover: session has no apiUrl`                                      | `discoverJmapSession`                                     | `sessionUrl` is not a JMAP session resource                               |
| `jmap discover: no primary mail account`                                    | `discoverJmapSession`                                     | The account has no mail capability on this server                         |
| `jmap discover: no sending identity found`                                  | `discoverJmapSession`                                     | Create a sending identity for the account                                 |
| `jmap discover: no sent or drafts mailbox found`                            | `discoverJmapSession`                                     | The account has no mailbox; create one                                    |
| ``smtp config: `host` must be a non-empty string``                          | `validateSmtpConfig`, `createSmtpTransport`, `createSmtpSender` | Pass the SMTP server host name                                      |
| ``smtp config: `port` must be an integer in 1..65535``                      | `validateSmtpConfig`, `createSmtpTransport`, `createSmtpSender` | Pass a port such as 465 or 587                                      |
| ``smtp config: `auth` requires string `user` and `pass` ``                  | `validateSmtpConfig`, `createSmtpTransport`, `createSmtpSender` | Pass both strings, or omit `auth` for an open relay                 |
| ``smtp message: `to` must be a non-empty string``                           | `toMailOptions`, `sendViaSmtp`, an `SmtpSender`           | Pass a recipient address                                                  |
| ``smtp message: `from` is required (pass `message.from` or `config.from`)`` | `toMailOptions`, `sendViaSmtp`, an `SmtpSender`           | Pass `from` on the message or in `SmtpConfig`                             |
| ``smtp message: one of `text` or `html` is required``                       | `toMailOptions`, `sendViaSmtp`, an `SmtpSender`           | Pass `text`, `html` or both                                               |
| ``smtp message: `<field>` must not contain CR or LF``                       | `toMailOptions`, `sendViaSmtp`, an `SmtpSender`           | Remove line breaks from `to`, `from`, `replyTo`, `subject` and `headers`  |

A `payloadValidator` error is your own `Error`, thrown by `enqueue` before
anything is stored, or by `get` and `listByStatus` when a stored payload no
longer matches.

## Limits and gotchas

- `maxAttempts` defaults to 5 and counts `markSending` calls: with
  `maxAttempts: 3`, the third failed attempt ends in `failed`.
- `markFailed` never sends and never waits. When it returns `retried: true` the
  message is `queued` again and your code must schedule the next attempt.
- There is no lease: a message stays in `sending` if your action dies before
  reporting. See [Recover messages stuck in sending](#recover-messages-stuck-in-sending).
- There is no exactly-once delivery. If the server accepts the email and
  `markSent` then fails, a retry sends it again. Record `providerId` and
  reconcile before you resend.
- `markSent` and `markFailed` also accept a `queued` message (no claim needed);
  only `markSending` increments `attempts`. `markFailed` on a `queued` message
  with attempts left keeps it `queued` and records `error`.
- `markSent` on a message that is already `sent` returns `null` and changes
  nothing, even with a different `providerId`.
- An `idempotencyKey` match returns the first message, whatever `to`, `from`
  or `payload` you pass the second time. Use the returned `messageId`.
- `prune` deletes the row and its `idempotencyKey`, so the same key queues a
  new message after the row is gone.
- `prune` removes only `sent` and `failed` messages whose `updatedAt` is older
  than `before` (default 30 days ago). `batch` defaults to 200 and must be
  1..500. A full batch schedules another pass; the return value counts the
  first pass only.
- The built-in cron runs `prune` every 24 hours with `batch` 200 and the
  30-day default. It cannot be turned off or reconfigured.
- `listByStatus` orders by `createdAt`, so a re-queued message keeps its place.
  `paginationOpts` is the standard Convex `{ cursor, numItems }`.
- `subjectRef` is stored and returned, but no method lists messages by it.
- `to`, `from` and `transport` are stored as given. The component does not
  check addresses; the JMAP and SMTP helpers only reject empty values and line
  breaks.
- The payload is stored in the component's table and returned by `get`. Do not
  put secrets in it.
- There is no suppression list, consent check or rate limit. Check those before
  you call `enqueue`.

## Compatibility

- Peer dependency: `convex@^1.45.0`. CI runs the unit tests on the locked
  convex version (1.51.0), and type-checks the README examples and runs the
  README test against the packed package with convex 1.45.0.
- Optional peer dependency: `nodemailer@^8.0.4 || ^9.0.0 || ^10.0.0`, only for
  `@vllnt/convex-email/smtp`. Importing that entry without `nodemailer` fails
  with `ERR_MODULE_NOT_FOUND`. Prefer 10.1.4 or later: the GitHub Advisory
  Database lists advisories for every earlier release.
- Node.js: `package.json` `engines` says `>=18`, but convex 1.45 to 1.48 need
  Node.js 20 or later, convex 1.49 and later need 22, and nodemailer 10 needs
  20.
- ES modules only (no CommonJS build).
- Runtimes: `@vllnt/convex-email` and `@vllnt/convex-email/jmap` run in the
  default Convex runtime, with no `"use node"`. JMAP sending and discovery call
  `fetch`, so run them in an action. `@vllnt/convex-email/smtp` needs a Node
  action (`"use node"`).
- `@vllnt/convex-email/test` ships TypeScript source and needs `convex-test`,
  `vitest` and `vite` in your app (plus `@edge-runtime/vm` for Vitest's
  `edge-runtime` environment).
- React: not applicable. There is no `./react` entry; read the status with your
  own query and `useQuery`.

## Testing

Mount the component in your own `convex-test` suite with `register`. Use the
Vitest settings `convex-test` recommends:

```ts
// vitest.config.mts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
  },
});
```

This test runs the Quick start functions with a fake JMAP server:

```ts
// convex/email.test.ts
/// <reference types="vite/client" />
import { register } from "@vllnt/convex-email/test";
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";

import { api, internal } from "./_generated/api";
import schema from "./schema";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test("a welcome email is queued once and sent", async () => {
  vi.useFakeTimers();
  for (const name of ["API_URL", "TOKEN", "ACCOUNT_ID", "IDENTITY_ID", "MAILBOX_ID"]) {
    vi.stubEnv(`JMAP_${name}`, "test");
  }
  const methodResponses = [
    ["Email/set", { created: { draft: { id: "email-1" } } }, "0"],
    ["EmailSubmission/set", { created: { sub: { id: "sub-1" } } }, "1"],
  ];
  vi.stubGlobal("fetch", async () =>
    new Response(JSON.stringify({ methodResponses })),
  );
  const t = convexTest(schema, import.meta.glob("./**/*.ts"));
  register(t);
  const args = { userId: "user-1", to: "ada@example.com" };
  const messageId = await t.mutation(internal.email.sendWelcome, args);
  expect(await t.mutation(internal.email.sendWelcome, args)).toBe(messageId);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(await t.query(api.email.status, { messageId })).toBe("sent");
});
```

`register(t, name)` takes the mount name when you used
`app.use(email, { name })`.

This repository's own tests run the component in `convex-test`
(`pnpm test:coverage`, 100% coverage enforced). `pnpm test:package` packs the
package, checks these docs and runs this README's examples against it.

## Security

- The component does not authenticate. Call `Email` methods only from your own
  server functions, after your own access check; a public mutation that calls
  `enqueue` with client-supplied addresses lets anyone send mail from your
  domain.
- Its table is reachable only through the component's functions.
- Keep SMTP passwords and JMAP tokens in environment variables read inside
  actions, never in `payload` (it is stored and returned by `get`).
- The JMAP and SMTP helpers reject CR and LF in addresses, subject and header
  values (header injection).

Report vulnerabilities as described in
[SECURITY.md](https://github.com/vllnt/convex-email/blob/main/SECURITY.md).

## Related packages

None. No other @vllnt package is a runtime dependency of this one or appears in
its example app or tests (`@vllnt/eslint-config` and `@vllnt/typescript` are
build tooling only).

## Contributing

See
[CONTRIBUTING.md](https://github.com/vllnt/convex-email/blob/main/CONTRIBUTING.md).

## Links

- Docs and changelog: [oss.vllnt.com/packages/convex-email](https://oss.vllnt.com/packages/convex-email) · [release feed](https://oss.vllnt.com/packages/convex-email/rss.xml)
- All @vllnt packages: [oss.vllnt.com](https://oss.vllnt.com) · [search packages and docs on index.vllnt.com](https://index.vllnt.com)
- Source and issues: [GitHub](https://github.com/vllnt/convex-email) · [issues](https://github.com/vllnt/convex-email/issues) · [npm](https://www.npmjs.com/package/@vllnt/convex-email)
- Questions and updates: [Discord](https://bntvllnt.com/discord) · [X @bntvllnt](https://x.com/bntvllnt)
- Company and author: [vllnt.com](https://vllnt.com) · [bntvllnt.com](https://bntvllnt.com) · [GitHub @bntvllnt](https://github.com/bntvllnt) · [LinkedIn](https://linkedin.com/in/bntvllnt)
- Sponsor: [GitHub Sponsors](https://github.com/sponsors/bntvllnt)

## License

MIT. See [LICENSE](LICENSE).

[![npm version of @vllnt/convex-email](https://img.shields.io/npm/v/@vllnt/convex-email.svg)](https://www.npmjs.com/package/@vllnt/convex-email)
[![CI status](https://github.com/vllnt/convex-email/actions/workflows/ci.yml/badge.svg)](https://github.com/vllnt/convex-email/actions/workflows/ci.yml)

---

Part of [vllnt open source](https://oss.vllnt.com) · [Package page](https://oss.vllnt.com/packages/convex-email) · [vllnt.com](https://vllnt.com) · Built by [bntvllnt](https://bntvllnt.com)
