import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { query } from "./_generated/server";
import { messageStatus, messageView } from "./validators";
import type { Doc } from "./_generated/dataModel";

/** Project a stored message row to its public view (drops internal fields). */
function view(msg: Doc<"messages">) {
  return {
    messageId: msg.messageId,
    to: msg.to,
    from: msg.from,
    transport: msg.transport,
    status: msg.status,
    payload: msg.payload,
    subjectRef: msg.subjectRef,
    idempotencyKey: msg.idempotencyKey,
    providerId: msg.providerId,
    attempts: msg.attempts,
    maxAttempts: msg.maxAttempts,
    error: msg.error,
    createdAt: msg.createdAt,
    updatedAt: msg.updatedAt,
  };
}

/** The current envelope for one message, or `null` if no such id is held. */
export const get = query({
  args: { messageId: v.string() },
  returns: v.union(v.null(), messageView),
  handler: async (ctx, args) => {
    const msg = await ctx.db
      .query("messages")
      .withIndex("by_message_id", (q) => q.eq("messageId", args.messageId))
      .unique();
    return msg === null ? null : view(msg);
  },
});

/**
 * Page messages in one `status`, oldest first via the `by_status` index. Takes
 * the standard Convex `paginationOpts` and returns the standard paginated
 * envelope (`page`, `isDone`, `continueCursor`) so the host can poll the
 * `queued` backlog to flush, watch `sending`, or audit a terminal `sent`/`failed`
 * history reactively.
 */
export const listByStatus = query({
  args: { status: messageStatus, paginationOpts: paginationOptsValidator },
  returns: v.object({
    page: v.array(messageView),
    isDone: v.boolean(),
    continueCursor: v.string(),
    splitCursor: v.optional(v.union(v.string(), v.null())),
    pageStatus: v.optional(
      v.union(
        v.literal("SplitRecommended"),
        v.literal("SplitRequired"),
        v.null(),
      ),
    ),
  }),
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("messages")
      .withIndex("by_status", (q) => q.eq("status", args.status))
      .order("asc")
      .paginate(args.paginationOpts);
    return { ...result, page: result.page.map(view) };
  },
});
