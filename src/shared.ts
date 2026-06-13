/** Shared constants used by both `client/` and `component/`. */

export const COMPONENT_NAME = "email";

/**
 * The standard message lifecycle states. `queued` is the freshly-enqueued state;
 * the host's transport sender claims it (`sending`), then records a terminal
 * `sent` or `failed`. A `sending` message can return to `queued` for a retry
 * while attempts remain. Terminal states are final — once `sent`, or `failed`
 * with attempts exhausted, the message never transitions again.
 */
export const MESSAGE_STATUSES = ["queued", "sending", "sent", "failed"] as const;

/** A single message lifecycle status. */
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/** The two terminal states — once reached, a message never transitions again. */
export const TERMINAL_STATUSES: ReadonlySet<MessageStatus> = new Set([
  "sent",
  "failed",
]);

/**
 * Default maximum send attempts before a `markFailed` is permanent (the message
 * lands in terminal `failed` instead of returning to `queued` for another
 * attempt). The host owns the actual transport send and reports each outcome; the
 * component only counts attempts and decides retry-vs-terminal. A per-message
 * override is accepted at `enqueue`; this is the client-level default.
 */
export const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * Default retention (ms) for terminal messages before the prune cron sweeps them:
 * 30 days. Bounds unbounded growth of the `messages` table while leaving a
 * generous audit window for delivery records. A host that wants a different
 * window drives `prune` from its own scheduler with an explicit `before` cutoff.
 */
export const DEFAULT_RETENTION_MS = 2_592_000_000;

/** Default page size for a `prune` pass before the sweep self-reschedules. */
export const DEFAULT_PRUNE_BATCH = 200;
