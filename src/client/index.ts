import type {
  FunctionArgs,
  FunctionReference,
  FunctionReturnType,
  PaginationOptions,
  PaginationResult,
} from "convex/server";
import type {
  EmailOptions,
  EnqueueOptions,
  EnqueueResult,
  MarkFailedResult,
  MessageStatus,
  MessageView,
  Parser,
} from "./types.js";
import { DEFAULT_MAX_ATTEMPTS, DEFAULT_PRUNE_BATCH } from "../shared.js";

/**
 * The component's raw message view, before the client narrows the opaque host
 * payload. `payload` is `unknown` here; the {@link Email} client runs the host
 * validator over it at its typed boundary.
 */
type RawView = {
  messageId: string;
  to: string;
  from: string;
  transport: string;
  status: MessageStatus;
  payload?: unknown;
  subjectRef?: string;
  idempotencyKey?: string;
  providerId?: string;
  attempts: number;
  maxAttempts: number;
  error?: string;
  createdAt: number;
  updatedAt: number;
};

/**
 * The email component's function references, as exposed on the host via
 * `components.email`. The host's stored `payload` is opaque here (`unknown`); the
 * {@link Email} client narrows it at its own typed boundary.
 */
export interface EmailComponent {
  mutations: {
    enqueue: FunctionReference<
      "mutation",
      "internal",
      {
        messageId: string;
        to: string;
        from: string;
        transport: string;
        payload?: unknown;
        subjectRef?: string;
        idempotencyKey?: string;
        maxAttempts: number;
      },
      { messageId: string; deduplicated: boolean }
    >;
    markSending: FunctionReference<
      "mutation",
      "internal",
      { messageId: string },
      { attempts: number }
    >;
    markSent: FunctionReference<
      "mutation",
      "internal",
      { messageId: string; providerId?: string },
      null
    >;
    markFailed: FunctionReference<
      "mutation",
      "internal",
      { messageId: string; error?: string },
      { status: "queued" | "failed"; retried: boolean }
    >;
    prune: FunctionReference<
      "mutation",
      "internal",
      { before?: number; batch: number },
      number
    >;
  };
  queries: {
    get: FunctionReference<
      "query",
      "internal",
      { messageId: string },
      RawView | null
    >;
    listByStatus: FunctionReference<
      "query",
      "internal",
      { status: MessageStatus; paginationOpts: PaginationOptions },
      PaginationResult<RawView>
    >;
  };
}

interface RunQueryCtx {
  runQuery<Q extends FunctionReference<"query", "internal">>(
    reference: Q,
    args: FunctionArgs<Q>,
  ): Promise<FunctionReturnType<Q>>;
}

interface RunMutationCtx {
  runMutation<M extends FunctionReference<"mutation", "internal">>(
    reference: M,
    args: FunctionArgs<M>,
  ): Promise<FunctionReturnType<M>>;
}

/**
 * Consumer-facing client for the durable, transport-agnostic outbound email
 * queue. A host mutation enqueues a message with `enqueue` and gets its id back;
 * the host's own transport sender (JMAP, an HTTP API, an SMTP-relay shim — never
 * a vendor baked into this component) claims it (`markSending`), dispatches it,
 * and reports the outcome (`markSent` / `markFailed`); `markFailed` retries until
 * the attempt budget is spent. The component records intent and status — it never
 * calls a provider. The host owns meaning and auth: it passes opaque `to`/`from`
 * addresses, a `transport` adapter name, and an opaque `payload` the component
 * stores without inspecting. Pass `payloadValidator` to narrow that opaque data
 * to `TPayload` at the boundary — there is no unchecked cast.
 *
 * @typeParam TPayload - The host's rendered message payload type (defaults to `unknown`).
 *
 * @example
 * ```ts
 * const email = new Email(components.email, {
 *   payloadValidator: v.object({ subject: v.string(), html: v.string() }).parse,
 * });
 * const { messageId } = await email.enqueue(ctx, id, "user@x.com", "no-reply@app.com", "jmap", {
 *   payload: { subject: "Hi", html: "<p>Welcome</p>" },
 *   idempotencyKey: `welcome:${userId}`,
 * });
 * // ... the host's transport sender:
 * await email.markSending(ctx, messageId);
 * await email.markSent(ctx, messageId, { providerId: "jmap-123" });
 * // ... clients poll:
 * const msg = await email.get(ctx, messageId);   // typed payload
 * ```
 */
export class Email<TPayload = unknown> {
  private readonly payloadValidator: Parser<TPayload> | undefined;
  private readonly maxAttempts: number;

  constructor(
    private readonly component: EmailComponent,
    options: EmailOptions<TPayload> = {},
  ) {
    this.payloadValidator = options.payloadValidator;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  /** Narrow an opaque value through the host parser; pass `undefined` and an unset parser through. */
  private parse(value: unknown): TPayload | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (this.payloadValidator === undefined) {
      return value as TPayload;
    }
    return this.payloadValidator(value);
  }

  /** Project a raw component view into the typed, validated client view. */
  private view(raw: RawView): MessageView<TPayload> {
    return {
      messageId: raw.messageId,
      to: raw.to,
      from: raw.from,
      transport: raw.transport,
      status: raw.status,
      payload: this.parse(raw.payload),
      subjectRef: raw.subjectRef,
      idempotencyKey: raw.idempotencyKey,
      providerId: raw.providerId,
      attempts: raw.attempts,
      maxAttempts: raw.maxAttempts,
      error: raw.error,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    };
  }

  /**
   * Enqueue an outbound message and return its id immediately. `messageId` is
   * host-supplied and must be unique; `to`/`from` are opaque addresses;
   * `transport` names the host-configured adapter. `opts.payload` is opaque host
   * data validated against `payloadValidator` before storage. When
   * `opts.idempotencyKey` matches an existing message the existing id is returned
   * (`deduplicated: true`) and no new row is inserted. The message starts
   * `queued`.
   */
  enqueue(
    ctx: RunMutationCtx,
    messageId: string,
    to: string,
    from: string,
    transport: string,
    opts: EnqueueOptions<TPayload> = {},
  ): Promise<EnqueueResult> {
    return ctx.runMutation(this.component.mutations.enqueue, {
      messageId,
      to,
      from,
      transport,
      payload: opts.payload === undefined ? undefined : this.parse(opts.payload),
      subjectRef: opts.subjectRef,
      idempotencyKey: opts.idempotencyKey,
      maxAttempts: opts.maxAttempts ?? this.maxAttempts,
    });
  }

  /**
   * Claim a `queued` message for a send attempt (move it to `sending`, increment
   * `attempts`). Returns the new attempt count. Rejects a missing id, a terminal
   * message, and an already-`sending` message (claimed by another sender).
   */
  markSending(ctx: RunMutationCtx, messageId: string): Promise<{ attempts: number }> {
    return ctx.runMutation(this.component.mutations.markSending, { messageId });
  }

  /**
   * Record a successful send — the message moves to terminal `sent`, recording
   * the transport's `opts.providerId`. Idempotent against a replayed callback.
   * Rejects a missing id and an already-`failed` message.
   */
  markSent(
    ctx: RunMutationCtx,
    messageId: string,
    opts: { providerId?: string } = {},
  ): Promise<null> {
    return ctx.runMutation(this.component.mutations.markSent, {
      messageId,
      providerId: opts.providerId,
    });
  }

  /**
   * Record a failed send attempt, recording `opts.error`. The message returns to
   * `queued` for another attempt while attempts remain, or lands in terminal
   * `failed` once exhausted (see the returned `retried` flag). Rejects a missing
   * id and an already-terminal message.
   */
  markFailed(
    ctx: RunMutationCtx,
    messageId: string,
    opts: { error?: string } = {},
  ): Promise<MarkFailedResult> {
    return ctx.runMutation(this.component.mutations.markFailed, {
      messageId,
      error: opts.error,
    });
  }

  /** The current envelope for `messageId`, or `null` if no such message is held. */
  async get(
    ctx: RunQueryCtx,
    messageId: string,
  ): Promise<MessageView<TPayload> | null> {
    const raw = await ctx.runQuery(this.component.queries.get, { messageId });
    return raw === null ? null : this.view(raw);
  }

  /**
   * Page messages in one `status`, oldest first. Returns the standard Convex
   * pagination envelope with each row narrowed to the typed view.
   */
  async listByStatus(
    ctx: RunQueryCtx,
    status: MessageStatus,
    paginationOpts: PaginationOptions,
  ): Promise<PaginationResult<MessageView<TPayload>>> {
    const result = await ctx.runQuery(this.component.queries.listByStatus, {
      status,
      paginationOpts,
    });
    return { ...result, page: result.page.map((raw) => this.view(raw)) };
  }

  /**
   * Delete terminal messages whose `updatedAt < before` in bounded batches,
   * oldest first. `before` defaults to the server clock; `batch` caps each pass
   * and the sweep self-reschedules until the tail is clean. Returns the count
   * removed in the first pass. The built-in daily cron drives this automatically.
   */
  prune(
    ctx: RunMutationCtx,
    opts: { before?: number; batch?: number } = {},
  ): Promise<number> {
    return ctx.runMutation(this.component.mutations.prune, {
      before: opts.before,
      batch: opts.batch ?? DEFAULT_PRUNE_BATCH,
    });
  }
}

export type {
  EmailOptions,
  EnqueueOptions,
  EnqueueResult,
  MarkFailedResult,
  MessageStatus,
  MessageView,
  Parser,
};
