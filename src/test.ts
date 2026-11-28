/// <reference types="vite/client" />
import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import schema from "./component/schema.js";

const modules = import.meta.glob("./component/**/*.ts");

/**
 * Register this component with a `convex-test` instance so consuming apps can
 * test integration: `import { register } from "@vllnt/convex-email/test"`.
 *
 * @param t - The host app's `convexTest(hostSchema, modules)` instance; any host schema is accepted.
 * @param name - The mount name, matching `app.use(component, { name })`. Defaults to `"email"`.
 */
export function register<TSchema extends GenericSchema>(
  t: TestConvex<SchemaDefinition<TSchema, boolean>>,
  name = "email",
): void {
  t.registerComponent(name, schema, modules);
}
