import { defineApp } from "convex/server";
import component from "../../src/component/convex.config";

const app = defineApp();
// Default mount, plus a second named mount — proves the component is mount-safe
// (sandboxed per instance, no cross-mount singletons) per the Component Standard.
app.use(component);
app.use(component, { name: "imports" });

export default app;
