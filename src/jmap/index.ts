/**
 * The optional generic-JMAP transport adapter — a `./jmap` entry the host imports
 * into its OWN Convex action to actually send queued messages over a JMAP server's
 * HTTP API (Stalwart, Fastmail, Cyrus, any JMAP server). It is NOT part of the
 * sandboxed component: the component records intent + status and never sends.
 *
 * Unlike `./smtp`, this layer is **pure** and dependency-free: it drives an
 * injected `fetch` (the host's runtime `fetch`), so it needs no `nodemailer`, no
 * `"use node"` action (JMAP is plain HTTP — `fetch` runs in a normal Convex
 * action), and is 100%-covered with a fake `fetch` (no excluded wrapper).
 *
 * Tree-shake boundary: a backend-only consumer importing `@vllnt/convex-email`
 * (the `.` entry) pulls ZERO JMAP code. Importing this `./jmap` entry is the
 * explicit opt-in.
 *
 * JMAP is a protocol (RFC 8620/8621), not a vendor — Stalwart is one configured
 * server (`{ endpoint, token }`), never baked in, so this is `./jmap`, never
 * `./stalwart`.
 */

export {
  validateJmapConfig,
  buildEmailCreate,
  buildSubmitRequest,
  parseSubmitResponse,
  sendViaJmap,
  discoverJmapSession,
  createJmapSender,
} from "./send.js";
export type {
  JmapConfig,
  JmapMessage,
  JmapSendResult,
  JmapSender,
  JmapFetch,
  JmapRequestInit,
  JmapResponse,
  JmapDiscoverOptions,
} from "./types.js";
