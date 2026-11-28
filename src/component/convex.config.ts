import { defineComponent } from "convex/server";

/**
 * The email component definition. Mount it in the host's `convex/convex.config.ts`
 * with `app.use(component)`, or `app.use(component, { name })` for another instance.
 */
const component = defineComponent("email");

// Nest official child components here, e.g.:
// import rateLimiter from "@convex-dev/rate-limiter/convex.config";
// component.use(rateLimiter);

export default component;
