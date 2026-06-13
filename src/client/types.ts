/** Public TypeScript surface for the email client. */

/** The four lifecycle states a message moves through. */
export type MessageStatus = "queued" | "sending" | "sent" | "failed";

/**
 * Validates and narrows the opaque stored `payload` to a host type `T` at the
 * client boundary. Receives the raw value the component returned (`unknown`) and
 * MUST return a typed `T` or throw. A `convex/values` validator's `.parse` (or a
 * Zod `.parse`) fits directly; omit it to keep the value unvalidated.
 *
 * @typeParam T - The host's stored message `payload` type.
 */
export type Parser<T> = (value: unknown) => T;

/** The public envelope returned by {@link Email.get}. */
export interface MessageView<TPayload = unknown> {
  /** The host-supplied id naming this message. */
  messageId: string;
  /** The opaque destination address. */
  to: string;
  /** The opaque sender address. */
  from: string;
  /** The host-configured transport adapter this message is routed through. */
  transport: string;
  /** The current lifecycle status. */
  status: MessageStatus;
  /** The opaque rendered message payload (narrowed if a `payloadValidator` is set). */
  payload?: TPayload;
  /** An opaque host ref for subject-centric listing (e.g. the addressee subject). */
  subjectRef?: string;
  /** The dedup key, if the message was enqueued with one. */
  idempotencyKey?: string;
  /** The transport's own message handle, recorded once `sent`. */
  providerId?: string;
  /** The number of send attempts made so far. */
  attempts: number;
  /** The maximum send attempts before a failure is terminal. */
  maxAttempts: number;
  /** The host-supplied failure reason from the last failed attempt. */
  error?: string;
  /** Absolute ms timestamp the message was enqueued. */
  createdAt: number;
  /** Absolute ms timestamp of the last transition. */
  updatedAt: number;
}

/** The result of {@link Email.enqueue}. */
export interface EnqueueResult {
  /** The id of the queued message — the existing one when `deduplicated`. */
  messageId: string;
  /** True when an existing `idempotencyKey` matched and no new row was inserted. */
  deduplicated: boolean;
}

/** Per-call options for {@link Email.enqueue}. */
export interface EnqueueOptions<TPayload> {
  /** The opaque rendered message payload (validated against `payloadValidator` before storage). */
  payload?: TPayload;
  /** An opaque host ref recorded for subject-centric listing. */
  subjectRef?: string;
  /** A dedup key — a second enqueue carrying the same key returns the existing message. */
  idempotencyKey?: string;
  /** Override the client-level `maxAttempts` for this message. */
  maxAttempts?: number;
}

/** The result of {@link Email.markFailed}. */
export interface MarkFailedResult {
  /** `queued` when the message was re-queued for retry, `failed` when terminal. */
  status: "queued" | "failed";
  /** True when the message was re-queued (attempts remained), false when terminal. */
  retried: boolean;
}

/** Construction options for the {@link Email} client. */
export interface EmailOptions<TPayload> {
  /**
   * Validates/narrows a stored `payload` to `TPayload` at the boundary — applied
   * to the `payload` passed into `enqueue` (before storage) and the `payload`
   * returned by `get` / `listByStatus`. Throws on a mismatch. Omit to leave the
   * payload unvalidated.
   */
  payloadValidator?: Parser<TPayload>;
  /**
   * The default maximum send attempts before a `markFailed` is terminal. Per-call
   * `enqueue` `maxAttempts` overrides it. Defaults to `DEFAULT_MAX_ATTEMPTS` (5).
   */
  maxAttempts?: number;
}
