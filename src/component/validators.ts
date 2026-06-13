import { v } from "convex/values";

/**
 * Opaque host-owned data stored on a message — its `payload` (rendered body,
 * template name + data, headers, attachment refs — whatever the host's transport
 * needs to send). The component never inspects it; it is last-resort arbitrary
 * data, aliased here rather than left bare in function signatures. The host
 * narrows it at the {@link Email} client boundary via an optional
 * `payloadValidator` parser.
 *
 * This is the single documented `v.any()` escape hatch in the component; the lint
 * rule `convex-rules/no-bare-v-any` is satisfied by routing every arbitrary host
 * payload through this alias instead of a bare `v.any()`.
 */
export const jsonValue = v.any();

/** The four lifecycle states a message moves through. */
export const messageStatus = v.union(
  v.literal("queued"),
  v.literal("sending"),
  v.literal("sent"),
  v.literal("failed"),
);

/**
 * Public projection of a message returned by {@link get}. `payload` is opaque
 * host data; `transport` names the host-configured adapter the message is routed
 * through (never a baked-in vendor); `providerId` is the transport's own message
 * handle recorded on a successful send; `error` is the host-supplied failure
 * reason recorded on a failed attempt.
 */
export const messageView = v.object({
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
});
