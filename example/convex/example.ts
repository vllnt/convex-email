import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { components } from "./_generated/api";
import { mutation, query } from "./_generated/server";
import { Email } from "../../src/client";
import { sendViaSmtp } from "../../src/smtp/send";
import type { SmtpSendInfo, SmtpTransport } from "../../src/smtp/types";

/**
 * Host-app wrappers. The host owns auth and the transport: resolve identity here,
 * then pass opaque `to`/`from` addresses, a host-configured `transport` adapter
 * name (never a vendor baked into the component), and an opaque `payload` into the
 * client. Time is server-sourced inside the component — there is no `now`
 * override to pass. The host's own sender drives `markSending`/`markSent`/`markFailed`.
 */
const email = new Email<{ subject: string; html: string } | string>(
  components.email,
);

/** A second client on the named `imports` mount — proves mount-safe isolation. */
const importEmail = new Email(components.imports);

/**
 * A strict client that validates the payload against a host parser and caps
 * attempts low — proves the `payloadValidator` boundary and the retry budget.
 */
const strictEmail = new Email<{ subject: string; html: string }>(
  components.email,
  {
    maxAttempts: 2,
    payloadValidator: (value) => {
      if (
        typeof value !== "object" ||
        value === null ||
        typeof (value as { subject?: unknown }).subject !== "string" ||
        typeof (value as { html?: unknown }).html !== "string"
      ) {
        throw new Error("invalid payload: expected { subject, html }");
      }
      return value as { subject: string; html: string };
    },
  },
);

const messageView = v.object({
  messageId: v.string(),
  to: v.string(),
  from: v.string(),
  transport: v.string(),
  status: v.union(
    v.literal("queued"),
    v.literal("sending"),
    v.literal("sent"),
    v.literal("failed"),
  ),
  payload: v.optional(v.any()),
  subjectRef: v.optional(v.string()),
  idempotencyKey: v.optional(v.string()),
  providerId: v.optional(v.string()),
  attempts: v.number(),
  maxAttempts: v.number(),
  error: v.optional(v.string()),
  createdAt: v.number(),
  updatedAt: v.number(),
});

const paginated = v.object({
  page: v.array(messageView),
  isDone: v.boolean(),
  continueCursor: v.string(),
  splitCursor: v.optional(v.union(v.string(), v.null())),
  pageStatus: v.optional(
    v.union(v.literal("SplitRecommended"), v.literal("SplitRequired"), v.null()),
  ),
});

export const enqueue = mutation({
  args: {
    messageId: v.string(),
    to: v.string(),
    from: v.string(),
    transport: v.string(),
    payload: v.optional(v.any()),
    subjectRef: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
    maxAttempts: v.optional(v.number()),
  },
  returns: v.object({ messageId: v.string(), deduplicated: v.boolean() }),
  handler: (ctx, a) =>
    email.enqueue(ctx, a.messageId, a.to, a.from, a.transport, {
      payload: a.payload,
      subjectRef: a.subjectRef,
      idempotencyKey: a.idempotencyKey,
      maxAttempts: a.maxAttempts,
    }),
});

export const markSending = mutation({
  args: { messageId: v.string() },
  returns: v.object({ attempts: v.number() }),
  handler: (ctx, a) => email.markSending(ctx, a.messageId),
});

export const markSent = mutation({
  args: { messageId: v.string(), providerId: v.optional(v.string()) },
  returns: v.null(),
  handler: (ctx, a) =>
    email.markSent(ctx, a.messageId, { providerId: a.providerId }),
});

export const markFailed = mutation({
  args: { messageId: v.string(), error: v.optional(v.string()) },
  returns: v.object({
    status: v.union(v.literal("queued"), v.literal("failed")),
    retried: v.boolean(),
  }),
  handler: (ctx, a) => email.markFailed(ctx, a.messageId, { error: a.error }),
});

export const get = query({
  args: { messageId: v.string() },
  returns: v.union(v.null(), messageView),
  handler: (ctx, a) => email.get(ctx, a.messageId),
});

export const listByStatus = query({
  args: {
    status: v.union(
      v.literal("queued"),
      v.literal("sending"),
      v.literal("sent"),
      v.literal("failed"),
    ),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginated,
  handler: (ctx, a) => email.listByStatus(ctx, a.status, a.paginationOpts),
});

export const prune = mutation({
  args: { before: v.optional(v.number()), batch: v.optional(v.number()) },
  returns: v.number(),
  handler: (ctx, a) => email.prune(ctx, { before: a.before, batch: a.batch }),
});

/** Named-mount variants — prove a second instance is independent. */
export const enqueueImport = mutation({
  args: { messageId: v.string(), to: v.string(), from: v.string() },
  returns: v.object({ messageId: v.string(), deduplicated: v.boolean() }),
  handler: (ctx, a) =>
    importEmail.enqueue(ctx, a.messageId, a.to, a.from, "jmap"),
});

export const getImport = query({
  args: { messageId: v.string() },
  returns: v.union(v.null(), messageView),
  handler: (ctx, a) => importEmail.get(ctx, a.messageId),
});

export const pruneImport = mutation({
  args: {},
  returns: v.number(),
  handler: (ctx) => importEmail.prune(ctx),
});

/** Strict-client variants — exercise the payload validator and the retry budget. */
export const enqueueStrict = mutation({
  args: {
    messageId: v.string(),
    payload: v.any(),
    idempotencyKey: v.optional(v.string()),
  },
  returns: v.object({ messageId: v.string(), deduplicated: v.boolean() }),
  handler: (ctx, a) =>
    strictEmail.enqueue(ctx, a.messageId, "to@x.com", "from@x.com", "jmap", {
      payload: a.payload,
      idempotencyKey: a.idempotencyKey,
    }),
});

export const getStrict = query({
  args: { messageId: v.string() },
  returns: v.union(v.null(), messageView),
  handler: (ctx, a) => strictEmail.get(ctx, a.messageId),
});

/**
 * Host-side note helper — writes the host's own `notes` table, completely outside
 * the component's sandbox, proving host/component table isolation.
 */
export const addNote = mutation({
  args: { messageId: v.string(), note: v.string() },
  returns: v.null(),
  handler: async (ctx, { messageId, note }) => {
    await ctx.db.insert("notes", { messageId, note });
    return null;
  },
});

export const getNote = query({
  args: { messageId: v.string() },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, { messageId }) => {
    const row = await ctx.db
      .query("notes")
      .withIndex("by_message_id", (q) => q.eq("messageId", messageId))
      .unique();
    return row?.note ?? null;
  },
});

/**
 * A fake SMTP transport — stands in for `nodemailer` so the queue→send wiring is
 * exercised in edge-runtime with no socket. A real host instead calls
 * `createSmtpSender(config)` from `@vllnt/convex-email/smtp` inside a `"use node"`
 * action and sends over a real server (Stalwart, Postfix, any SMTP host).
 */
function fakeSmtpTransport(): SmtpTransport {
  return {
    sendMail: (options): Promise<SmtpSendInfo> => {
      if (options.to === "bounce@x.com") {
        return Promise.reject(new Error("550 mailbox unavailable"));
      }
      return Promise.resolve({
        messageId: `<smtp-${options.to}>`,
        accepted: [options.to],
        rejected: [],
      });
    },
  };
}

/**
 * The host's transport sender, the wiring this component is built for: page the
 * `queued` backlog, claim each (`markSending`), send it over SMTP via the pure
 * `sendViaSmtp`, then record the outcome (`markSent` with the SMTP `providerId`,
 * or `markFailed`). In a real app this is a `"use node"` action driving
 * `createSmtpSender(config)`; here it is a mutation over a fake transport so the
 * full loop runs under `convex-test`. Returns the per-message outcomes.
 */
export const flushQueuedOverSmtp = mutation({
  args: { limit: v.optional(v.number()) },
  returns: v.array(
    v.object({
      messageId: v.string(),
      outcome: v.union(v.literal("sent"), v.literal("failed")),
      providerId: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, { limit }) => {
    const transport = fakeSmtpTransport();
    const queued = await email.listByStatus(ctx, "queued", {
      cursor: null,
      numItems: limit ?? 50,
    });
    const outcomes: Array<{
      messageId: string;
      outcome: "sent" | "failed";
      providerId?: string;
    }> = [];
    for (const msg of queued.page) {
      await email.markSending(ctx, msg.messageId);
      const body =
        typeof msg.payload === "object" && msg.payload !== null
          ? (msg.payload as { subject?: string; html?: string })
          : {};
      try {
        const { messageId: providerId } = await sendViaSmtp(
          transport,
          {
            to: msg.to,
            from: msg.from,
            subject: body.subject,
            html: body.html ?? "<p></p>",
          },
          {},
        );
        await email.markSent(ctx, msg.messageId, { providerId });
        outcomes.push({ messageId: msg.messageId, outcome: "sent", providerId });
      } catch (e) {
        await email.markFailed(ctx, msg.messageId, { error: String(e) });
        outcomes.push({ messageId: msg.messageId, outcome: "failed" });
      }
    }
    return outcomes;
  },
});
