/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    mutations: {
      enqueue: FunctionReference<
        "mutation",
        "internal",
        {
          from: string;
          idempotencyKey?: string;
          maxAttempts: number;
          messageId: string;
          payload?: any;
          subjectRef?: string;
          to: string;
          transport: string;
        },
        { deduplicated: boolean; messageId: string },
        Name
      >;
      markSending: FunctionReference<
        "mutation",
        "internal",
        { messageId: string },
        { attempts: number },
        Name
      >;
      markSent: FunctionReference<
        "mutation",
        "internal",
        { messageId: string; providerId?: string },
        null,
        Name
      >;
      markFailed: FunctionReference<
        "mutation",
        "internal",
        { error?: string; messageId: string },
        { retried: boolean; status: "queued" | "failed" },
        Name
      >;
      prune: FunctionReference<
        "mutation",
        "internal",
        { batch: number; before?: number },
        number,
        Name
      >;
    };
    queries: {
      get: FunctionReference<
        "query",
        "internal",
        { messageId: string },
        null | {
          attempts: number;
          createdAt: number;
          error?: string;
          from: string;
          idempotencyKey?: string;
          maxAttempts: number;
          messageId: string;
          payload?: any;
          providerId?: string;
          status: "queued" | "sending" | "sent" | "failed";
          subjectRef?: string;
          to: string;
          transport: string;
          updatedAt: number;
        },
        Name
      >;
      listByStatus: FunctionReference<
        "query",
        "internal",
        {
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
          status: "queued" | "sending" | "sent" | "failed";
        },
        {
          continueCursor: string;
          isDone: boolean;
          page: Array<{
            attempts: number;
            createdAt: number;
            error?: string;
            from: string;
            idempotencyKey?: string;
            maxAttempts: number;
            messageId: string;
            payload?: any;
            providerId?: string;
            status: "queued" | "sending" | "sent" | "failed";
            subjectRef?: string;
            to: string;
            transport: string;
            updatedAt: number;
          }>;
          pageStatus?: "SplitRecommended" | "SplitRequired" | null;
          splitCursor?: string | null;
        },
        Name
      >;
    };
  };
