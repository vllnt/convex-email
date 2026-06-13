import { ConvexError, v } from "convex/values";
import { api } from "./_generated/api";
import { mutation } from "./_generated/server";
import { jsonValue } from "./validators";

/**
 * Enqueue an outbound message and return its id immediately — the durable queue
 * entry. The message is inserted in `queued` state with `attempts: 0`,
 * `createdAt`/`updatedAt` stamped from the server clock (`Date.now()` inside the
 * handler — never caller-supplied). The host owns the meaning of `to`/`from`, the
 * opaque `payload`, and the `transport` adapter name — the component records the
 * intent and never calls any provider. A transport sender later claims the
 * message ({@link markSending}) and reports the outcome ({@link markSent} /
 * {@link markFailed}).
 *
 * `messageId` is host-supplied (the host names its own message). The id must be
 * unique — re-using an existing id throws
 * `ConvexError({ code: "DUPLICATE_MESSAGE" })`. When `idempotencyKey` is supplied
 * and a message already carries it, the existing message's id is returned and no
 * new row is inserted — a retried enqueue (double-submit, at-least-once delivery)
 * can never produce a duplicate send.
 */
export const enqueue = mutation({
  args: {
    messageId: v.string(),
    to: v.string(),
    from: v.string(),
    transport: v.string(),
    payload: v.optional(jsonValue),
    subjectRef: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
    maxAttempts: v.number(),
  },
  returns: v.object({ messageId: v.string(), deduplicated: v.boolean() }),
  handler: async (ctx, args) => {
    if (args.idempotencyKey !== undefined) {
      const dupe = await ctx.db
        .query("messages")
        .withIndex("by_idempotency_key", (q) =>
          q.eq("idempotencyKey", args.idempotencyKey),
        )
        .unique();
      if (dupe !== null) {
        return { messageId: dupe.messageId, deduplicated: true };
      }
    }

    const existing = await ctx.db
      .query("messages")
      .withIndex("by_message_id", (q) => q.eq("messageId", args.messageId))
      .unique();
    if (existing !== null) {
      throw new ConvexError({
        code: "DUPLICATE_MESSAGE",
        message: `message "${args.messageId}" already exists`,
      });
    }

    const now = Date.now();
    await ctx.db.insert("messages", {
      messageId: args.messageId,
      to: args.to,
      from: args.from,
      transport: args.transport,
      status: "queued",
      payload: args.payload,
      subjectRef: args.subjectRef,
      idempotencyKey: args.idempotencyKey,
      attempts: 0,
      maxAttempts: args.maxAttempts,
      createdAt: now,
      updatedAt: now,
    });
    return { messageId: args.messageId, deduplicated: false };
  },
});

/**
 * Claim a `queued` message for a send attempt: move it to `sending` and increment
 * `attempts`. A transport sender calls this before dispatching, so concurrent
 * flushers don't double-send the same row. Re-claiming an already-`sending`
 * message is rejected (another sender owns it). A terminal message is rejected.
 *
 * @throws `ConvexError({ code: "NOT_FOUND" })` when no message has `messageId`.
 * @throws `ConvexError({ code: "TERMINAL_STATE" })` when the message is terminal.
 * @throws `ConvexError({ code: "INVALID_TRANSITION" })` when the message is
 *   already `sending` (claimed by another sender).
 */
export const markSending = mutation({
  args: { messageId: v.string() },
  returns: v.object({ attempts: v.number() }),
  handler: async (ctx, args) => {
    const msg = await ctx.db
      .query("messages")
      .withIndex("by_message_id", (q) => q.eq("messageId", args.messageId))
      .unique();
    if (msg === null) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: `message "${args.messageId}" not found`,
      });
    }
    if (msg.status === "sent" || msg.status === "failed") {
      throw new ConvexError({
        code: "TERMINAL_STATE",
        message: `message "${args.messageId}" is already ${msg.status} and cannot transition`,
      });
    }
    if (msg.status === "sending") {
      throw new ConvexError({
        code: "INVALID_TRANSITION",
        message: `message "${args.messageId}" is already sending`,
      });
    }

    const attempts = msg.attempts + 1;
    await ctx.db.patch(msg._id, {
      status: "sending",
      attempts,
      updatedAt: Date.now(),
    });
    return { attempts };
  },
});

/**
 * Record a successful send — the message moves to terminal `sent`, recording the
 * transport's own `providerId` (its message handle, opaque to the component) and
 * clearing any prior `error`. Idempotent against a replayed callback: re-marking
 * an already-`sent` message is a no-op (the recorded `providerId` is preserved).
 * Any other terminal state (`failed`) is rejected — a `failed` message is final.
 *
 * @throws `ConvexError({ code: "NOT_FOUND" })` when no message has `messageId`.
 * @throws `ConvexError({ code: "TERMINAL_STATE" })` when the message is already
 *   `failed` (a final state may not be transitioned out of).
 */
export const markSent = mutation({
  args: { messageId: v.string(), providerId: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const msg = await ctx.db
      .query("messages")
      .withIndex("by_message_id", (q) => q.eq("messageId", args.messageId))
      .unique();
    if (msg === null) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: `message "${args.messageId}" not found`,
      });
    }
    if (msg.status === "sent") {
      return null;
    }
    if (msg.status === "failed") {
      throw new ConvexError({
        code: "TERMINAL_STATE",
        message: `message "${args.messageId}" is already failed and cannot transition`,
      });
    }

    await ctx.db.patch(msg._id, {
      status: "sent",
      providerId: args.providerId,
      error: undefined,
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * Record a failed send attempt, recording the host-supplied `error`. The outcome
 * depends on the retry budget: if `attempts < maxAttempts` the message returns to
 * `queued` for another attempt (`retried: true`); once attempts are exhausted it
 * lands in terminal `failed` (`retried: false`). The host's backoff scheduler
 * re-claims a re-queued message when ready. An already-`sent` message is rejected
 * (it succeeded); an already-`failed` message is rejected (it is terminal).
 *
 * @throws `ConvexError({ code: "NOT_FOUND" })` when no message has `messageId`.
 * @throws `ConvexError({ code: "TERMINAL_STATE" })` when the message is already
 *   `sent` or `failed`.
 */
export const markFailed = mutation({
  args: { messageId: v.string(), error: v.optional(v.string()) },
  returns: v.object({ status: v.union(v.literal("queued"), v.literal("failed")), retried: v.boolean() }),
  handler: async (ctx, args) => {
    const msg = await ctx.db
      .query("messages")
      .withIndex("by_message_id", (q) => q.eq("messageId", args.messageId))
      .unique();
    if (msg === null) {
      throw new ConvexError({
        code: "NOT_FOUND",
        message: `message "${args.messageId}" not found`,
      });
    }
    if (msg.status === "sent" || msg.status === "failed") {
      throw new ConvexError({
        code: "TERMINAL_STATE",
        message: `message "${args.messageId}" is already ${msg.status} and cannot transition`,
      });
    }

    const retried = msg.attempts < msg.maxAttempts;
    const status = retried ? ("queued" as const) : ("failed" as const);
    await ctx.db.patch(msg._id, {
      status,
      error: args.error,
      updatedAt: Date.now(),
    });
    return { status, retried };
  },
});

/**
 * Delete up to `batch` terminal messages whose `updatedAt < before`, oldest first
 * — `sent` then `failed`, each via the `by_status_updated` index. `before`
 * defaults to the server clock (`Date.now()`) when omitted, so the built-in cron
 * sweeps exactly the messages terminal-and-stale as of the run. If a full batch
 * was removed there may be more, so the sweep self-reschedules through
 * `ctx.scheduler` until a short batch signals the tail is clean. Idempotent: only
 * ever removes already-terminal, past-retention rows. Queued and sending messages
 * are never pruned.
 */
export const prune = mutation({
  args: { before: v.optional(v.number()), batch: v.number() },
  returns: v.number(),
  handler: async (ctx, args) => {
    const before = args.before ?? Date.now();

    // Both terminal states, queried explicitly (no query-in-loop): sent first,
    // then failed for whatever batch budget remains.
    const sent = await ctx.db
      .query("messages")
      .withIndex("by_status_updated", (q) =>
        q.eq("status", "sent").lt("updatedAt", before),
      )
      .take(args.batch);
    const failed =
      sent.length < args.batch
        ? await ctx.db
            .query("messages")
            .withIndex("by_status_updated", (q) =>
              q.eq("status", "failed").lt("updatedAt", before),
            )
            .take(args.batch - sent.length)
        : [];

    for (const row of [...sent, ...failed]) {
      await ctx.db.delete(row._id);
    }
    const removed = sent.length + failed.length;

    if (removed === args.batch) {
      await ctx.scheduler.runAfter(0, api.mutations.prune, {
        before,
        batch: args.batch,
      });
    }
    return removed;
  },
});
