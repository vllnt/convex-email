import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * The example host app's own table. It is host-side state living entirely
 * outside the component's sandboxed `messages` table — used to prove the
 * component never reaches into host tables (and the host never into the
 * component's, except through the exported client).
 */
export default defineSchema({
  notes: defineTable({
    messageId: v.string(),
    note: v.string(),
  }).index("by_message_id", ["messageId"]),
});
