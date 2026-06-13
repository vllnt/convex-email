import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { jsonValue, messageStatus } from "./validators";

/**
 * Sandboxed table — the outbound-email queue's own concern. A `messageId` is a
 * host-opaque string that uniquely names one queued message; `to`/`from` are the
 * opaque envelope addresses; `transport` names the host-configured adapter (never
 * a baked-in vendor); `status` tracks the lifecycle. `payload` carries the opaque
 * rendered message host data (never inspected). `subjectRef` is an opaque host
 * ref (e.g. the addressee subject) for subject-centric listing; `idempotencyKey`
 * deduplicates double-enqueue; `attempts`/`maxAttempts` drive retry-vs-terminal.
 *
 * Indexes: `by_message_id` (lookup), `by_idempotency_key` (dedup), `by_status`
 * (poll a status queue oldest-first), `by_subject` (subject-centric listing), and
 * `by_status_updated` (retention sweep — prune terminal rows oldest-first).
 */
export default defineSchema({
  messages: defineTable({
    messageId: v.string(),
    to: v.string(),
    from: v.string(),
    transport: v.string(),
    status: messageStatus,
    payload: v.optional(jsonValue),
    subjectRef: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
    providerId: v.optional(v.string()),
    attempts: v.number(),
    maxAttempts: v.number(),
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_message_id", ["messageId"])
    .index("by_idempotency_key", ["idempotencyKey"])
    .index("by_status", ["status", "createdAt"])
    .index("by_subject", ["subjectRef", "createdAt"])
    .index("by_status_updated", ["status", "updatedAt"]),
});
