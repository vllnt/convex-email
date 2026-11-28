import { convexTest } from "convex-test";
import { componentsGeneric } from "convex/server";
import { expect, test } from "vitest";
import hostSchema from "./schema";
import { register } from "../../src/test";

const hostModules = import.meta.glob("./**/*.ts");

/**
 * Untyped component refs, the same object `_generated/api.js` builds at
 * runtime. Importing the generated `api` instead would pull `example.ts` into
 * the type check of this file.
 */
const { email } = componentsGeneric();

/**
 * Type and runtime regression test for `register()`. The host schema has its
 * own `notes` table, unlike the component's `messages` table, so this file
 * fails to type-check (TS2345) when `register()` only accepts the component's
 * own schema. `pnpm typecheck:ci` checks this file (see `tsconfig.ci.json`).
 */
test("register() mounts the component in a host-schema convexTest instance", async () => {
  const t = convexTest(hostSchema, hostModules);
  register(t);

  const enqueue = email?.mutations?.enqueue;
  const get = email?.queries?.get;
  if (enqueue === undefined || get === undefined) {
    throw new Error("component refs are missing");
  }

  const enqueued = await t.mutation(enqueue, {
    messageId: "host-1",
    to: "user@example.com",
    from: "no-reply@example.com",
    transport: "jmap",
    maxAttempts: 3,
  });
  expect(enqueued).toEqual({ messageId: "host-1", deduplicated: false });
  const stored = await t.query(get, { messageId: "host-1" });
  expect(stored?.status).toBe("queued");

  await t.run(async (ctx) => {
    await ctx.db.insert("notes", { messageId: "host-1", note: "welcome" });
  });
  const notes = await t.run(async (ctx) => ctx.db.query("notes").collect());
  expect(notes).toHaveLength(1);
});
