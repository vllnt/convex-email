import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { register } from "../../src/test";
import crons, { PRUNE_BATCH, PRUNE_INTERVAL } from "../../src/component/crons";

const modules = import.meta.glob("./**/*.ts");

function setup() {
  const t = convexTest(schema, modules);
  register(t); // default "email" mount
  register(t, "imports"); // second named mount — proves mount-safety
  return t;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("email — happy path (the durable send queue)", () => {
  test("enqueue → markSending → markSent walks the full lifecycle", async () => {
    const t = setup();
    const { messageId, deduplicated } = await t.mutation(api.example.enqueue, {
      messageId: "m1",
      to: "user@x.com",
      from: "no-reply@app.com",
      transport: "jmap",
      payload: { subject: "Hi", html: "<p>Welcome</p>" },
      subjectRef: "subject_42",
    });
    expect(messageId).toBe("m1");
    expect(deduplicated).toBe(false);

    const queued = await t.query(api.example.get, { messageId: "m1" });
    expect(queued?.status).toBe("queued");
    expect(queued?.to).toBe("user@x.com");
    expect(queued?.from).toBe("no-reply@app.com");
    expect(queued?.transport).toBe("jmap");
    expect(queued?.payload).toEqual({ subject: "Hi", html: "<p>Welcome</p>" });
    expect(queued?.subjectRef).toBe("subject_42");
    expect(queued?.attempts).toBe(0);
    expect(queued?.maxAttempts).toBe(5);
    expect(queued?.providerId).toBeUndefined();
    expect(queued?.createdAt).toBe(0);

    vi.setSystemTime(1_000);
    const claim = await t.mutation(api.example.markSending, { messageId: "m1" });
    expect(claim.attempts).toBe(1);
    const sending = await t.query(api.example.get, { messageId: "m1" });
    expect(sending?.status).toBe("sending");
    expect(sending?.attempts).toBe(1);
    expect(sending?.updatedAt).toBe(1_000);

    vi.setSystemTime(2_000);
    await t.mutation(api.example.markSent, {
      messageId: "m1",
      providerId: "jmap-abc",
    });
    const sent = await t.query(api.example.get, { messageId: "m1" });
    expect(sent?.status).toBe("sent");
    expect(sent?.providerId).toBe("jmap-abc");
    expect(sent?.error).toBeUndefined();
    expect(sent?.updatedAt).toBe(2_000);
  });

  test("markSent clears a prior error from an earlier failed attempt", async () => {
    const t = setup();
    await t.mutation(api.example.enqueue, {
      messageId: "m_retry",
      to: "u@x.com",
      from: "f@x.com",
      transport: "jmap",
    });
    await t.mutation(api.example.markSending, { messageId: "m_retry" });
    const failed = await t.mutation(api.example.markFailed, {
      messageId: "m_retry",
      error: "transient 421",
    });
    expect(failed.status).toBe("queued");
    expect(failed.retried).toBe(true);
    // second attempt succeeds
    await t.mutation(api.example.markSending, { messageId: "m_retry" });
    await t.mutation(api.example.markSent, { messageId: "m_retry" });
    const msg = await t.query(api.example.get, { messageId: "m_retry" });
    expect(msg?.status).toBe("sent");
    expect(msg?.error).toBeUndefined();
    expect(msg?.attempts).toBe(2);
  });

  test("markSent is idempotent on an already-sent message (replayed callback)", async () => {
    const t = setup();
    await t.mutation(api.example.enqueue, {
      messageId: "m_dup_sent",
      to: "u@x.com",
      from: "f@x.com",
      transport: "jmap",
    });
    await t.mutation(api.example.markSending, { messageId: "m_dup_sent" });
    await t.mutation(api.example.markSent, {
      messageId: "m_dup_sent",
      providerId: "p1",
    });
    vi.setSystemTime(500);
    await t.mutation(api.example.markSent, {
      messageId: "m_dup_sent",
      providerId: "p2",
    });
    const msg = await t.query(api.example.get, { messageId: "m_dup_sent" });
    expect(msg?.status).toBe("sent");
    // the original providerId is preserved; the no-op did not overwrite or advance time
    expect(msg?.providerId).toBe("p1");
    expect(msg?.updatedAt).toBe(0);
  });

  test("enqueue with no payload records an undefined payload", async () => {
    const t = setup();
    await t.mutation(api.example.enqueue, {
      messageId: "m_nopay",
      to: "u@x.com",
      from: "f@x.com",
      transport: "jmap",
    });
    const msg = await t.query(api.example.get, { messageId: "m_nopay" });
    expect(msg?.payload).toBeUndefined();
  });
});

describe("email — retry / backoff budget", () => {
  test("markFailed re-queues until maxAttempts is exhausted, then is terminal", async () => {
    const t = setup();
    // strict client caps maxAttempts at 2
    await t.mutation(api.example.enqueueStrict, {
      messageId: "m_burn",
      payload: { subject: "s", html: "h" },
    });
    // attempt 1 fails → re-queued
    await t.mutation(api.example.markSending, { messageId: "m_burn" });
    const first = await t.mutation(api.example.markFailed, {
      messageId: "m_burn",
      error: "e1",
    });
    expect(first).toEqual({ status: "queued", retried: true });
    // attempt 2 fails → attempts (2) === maxAttempts (2) → terminal failed
    await t.mutation(api.example.markSending, { messageId: "m_burn" });
    const second = await t.mutation(api.example.markFailed, {
      messageId: "m_burn",
      error: "e2",
    });
    expect(second).toEqual({ status: "failed", retried: false });
    const msg = await t.query(api.example.getStrict, { messageId: "m_burn" });
    expect(msg?.status).toBe("failed");
    expect(msg?.error).toBe("e2");
    expect(msg?.attempts).toBe(2);
  });
});

describe("email — idempotency (dedup prevents double-enqueue)", () => {
  test("a second enqueue with the same idempotencyKey returns the existing message", async () => {
    const t = setup();
    const first = await t.mutation(api.example.enqueue, {
      messageId: "m_idem_1",
      to: "u@x.com",
      from: "f@x.com",
      transport: "jmap",
      idempotencyKey: "welcome:user_7",
    });
    expect(first.deduplicated).toBe(false);
    // a retried submit under a different messageId, same key → no new row
    const second = await t.mutation(api.example.enqueue, {
      messageId: "m_idem_2",
      to: "u@x.com",
      from: "f@x.com",
      transport: "jmap",
      idempotencyKey: "welcome:user_7",
    });
    expect(second).toEqual({ messageId: "m_idem_1", deduplicated: true });
    // the second id never landed
    expect(await t.query(api.example.get, { messageId: "m_idem_2" })).toBeNull();
    // exactly one queued message
    const queued = await t.query(api.example.listByStatus, {
      status: "queued",
      paginationOpts: { cursor: null, numItems: 10 },
    });
    expect(queued.page).toHaveLength(1);
  });

  test("dedup works through the strict client too", async () => {
    const t = setup();
    await t.mutation(api.example.enqueueStrict, {
      messageId: "s_idem_1",
      payload: { subject: "s", html: "h" },
      idempotencyKey: "k",
    });
    const again = await t.mutation(api.example.enqueueStrict, {
      messageId: "s_idem_2",
      payload: { subject: "s", html: "h" },
      idempotencyKey: "k",
    });
    expect(again).toEqual({ messageId: "s_idem_1", deduplicated: true });
  });
});

describe("email — adversarial transitions", () => {
  test("get on a missing id returns null", async () => {
    const t = setup();
    expect(await t.query(api.example.get, { messageId: "ghost" })).toBeNull();
  });

  test("markSent on a missing id throws NOT_FOUND", async () => {
    const t = setup();
    await expect(
      t.mutation(api.example.markSent, { messageId: "ghost" }),
    ).rejects.toThrow(/not found/);
  });

  test("markSending on a missing id throws NOT_FOUND", async () => {
    const t = setup();
    await expect(
      t.mutation(api.example.markSending, { messageId: "ghost" }),
    ).rejects.toThrow(/not found/);
  });

  test("markFailed on a missing id throws NOT_FOUND", async () => {
    const t = setup();
    await expect(
      t.mutation(api.example.markFailed, { messageId: "ghost" }),
    ).rejects.toThrow(/not found/);
  });

  test("a duplicate enqueue (no key) throws DUPLICATE_MESSAGE", async () => {
    const t = setup();
    await t.mutation(api.example.enqueue, {
      messageId: "dup",
      to: "u@x.com",
      from: "f@x.com",
      transport: "jmap",
    });
    await expect(
      t.mutation(api.example.enqueue, {
        messageId: "dup",
        to: "u@x.com",
        from: "f@x.com",
        transport: "jmap",
      }),
    ).rejects.toThrow(/already exists/);
  });

  test("markSending a second time is rejected (another sender owns it)", async () => {
    const t = setup();
    await t.mutation(api.example.enqueue, {
      messageId: "m_claim",
      to: "u@x.com",
      from: "f@x.com",
      transport: "jmap",
    });
    await t.mutation(api.example.markSending, { messageId: "m_claim" });
    await expect(
      t.mutation(api.example.markSending, { messageId: "m_claim" }),
    ).rejects.toThrow(/already sending/);
  });

  test("markSent out of a failed (terminal) state is rejected", async () => {
    const t = setup();
    await t.mutation(api.example.enqueueStrict, {
      messageId: "term_f",
      payload: { subject: "s", html: "h" },
    });
    // burn both attempts → terminal failed
    await t.mutation(api.example.markSending, { messageId: "term_f" });
    await t.mutation(api.example.markFailed, { messageId: "term_f" });
    await t.mutation(api.example.markSending, { messageId: "term_f" });
    await t.mutation(api.example.markFailed, { messageId: "term_f" });
    await expect(
      t.mutation(api.example.markSent, { messageId: "term_f" }),
    ).rejects.toThrow(/already failed/);
  });

  test("markFailed out of a sent (terminal) state is rejected", async () => {
    const t = setup();
    await t.mutation(api.example.enqueue, {
      messageId: "term_s",
      to: "u@x.com",
      from: "f@x.com",
      transport: "jmap",
    });
    await t.mutation(api.example.markSending, { messageId: "term_s" });
    await t.mutation(api.example.markSent, { messageId: "term_s" });
    await expect(
      t.mutation(api.example.markFailed, { messageId: "term_s", error: "late" }),
    ).rejects.toThrow(/already sent/);
    // the original outcome is preserved
    const msg = await t.query(api.example.get, { messageId: "term_s" });
    expect(msg?.status).toBe("sent");
  });

  test("markSending on a terminal message is rejected", async () => {
    const t = setup();
    await t.mutation(api.example.enqueue, {
      messageId: "term_r",
      to: "u@x.com",
      from: "f@x.com",
      transport: "jmap",
    });
    await t.mutation(api.example.markSending, { messageId: "term_r" });
    await t.mutation(api.example.markSent, { messageId: "term_r" });
    await expect(
      t.mutation(api.example.markSending, { messageId: "term_r" }),
    ).rejects.toThrow(/already sent/);
  });
});

describe("email — concurrency", () => {
  test("two senders claiming the same queued message yield one winner", async () => {
    const t = setup();
    await t.mutation(api.example.enqueue, {
      messageId: "race",
      to: "u@x.com",
      from: "f@x.com",
      transport: "jmap",
    });
    const results = await Promise.allSettled([
      t.mutation(api.example.markSending, { messageId: "race" }),
      t.mutation(api.example.markSending, { messageId: "race" }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });
});

describe("email — listByStatus (paginated polling)", () => {
  test("pages messages in one status, oldest first", async () => {
    const t = setup();
    await t.mutation(api.example.enqueue, {
      messageId: "p1",
      to: "u@x.com",
      from: "f@x.com",
      transport: "jmap",
    });
    vi.setSystemTime(10);
    await t.mutation(api.example.enqueue, {
      messageId: "p2",
      to: "u@x.com",
      from: "f@x.com",
      transport: "jmap",
    });
    vi.setSystemTime(20);
    await t.mutation(api.example.enqueue, {
      messageId: "p3",
      to: "u@x.com",
      from: "f@x.com",
      transport: "jmap",
    });
    // move one out of queued
    await t.mutation(api.example.markSending, { messageId: "p2" });

    const queued = await t.query(api.example.listByStatus, {
      status: "queued",
      paginationOpts: { cursor: null, numItems: 10 },
    });
    expect(queued.page.map((m) => m.messageId)).toEqual(["p1", "p3"]);
    expect(queued.isDone).toBe(true);

    const sending = await t.query(api.example.listByStatus, {
      status: "sending",
      paginationOpts: { cursor: null, numItems: 10 },
    });
    expect(sending.page).toHaveLength(1);
    expect(sending.page[0].messageId).toBe("p2");
  });

  test("respects the page size and returns a continue cursor", async () => {
    const t = setup();
    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(i);
      await t.mutation(api.example.enqueue, {
        messageId: `q${i}`,
        to: "u@x.com",
        from: "f@x.com",
        transport: "jmap",
      });
    }
    const first = await t.query(api.example.listByStatus, {
      status: "queued",
      paginationOpts: { cursor: null, numItems: 2 },
    });
    expect(first.page).toHaveLength(2);
    expect(first.isDone).toBe(false);
    const second = await t.query(api.example.listByStatus, {
      status: "queued",
      paginationOpts: { cursor: first.continueCursor, numItems: 2 },
    });
    expect(second.page).toHaveLength(1);
    expect(second.isDone).toBe(true);
  });

  test("listByStatus on an empty status returns an empty done page", async () => {
    const t = setup();
    const r = await t.query(api.example.listByStatus, {
      status: "sent",
      paginationOpts: { cursor: null, numItems: 10 },
    });
    expect(r.page).toEqual([]);
    expect(r.isDone).toBe(true);
  });
});

describe("email — host payload validator (strict client)", () => {
  test("a valid payload round-trips through the strict client", async () => {
    const t = setup();
    await t.mutation(api.example.enqueueStrict, {
      messageId: "s_ok",
      payload: { subject: "Hello", html: "<p>x</p>" },
    });
    const msg = await t.query(api.example.getStrict, { messageId: "s_ok" });
    expect(msg?.payload).toEqual({ subject: "Hello", html: "<p>x</p>" });
  });

  test("a payload failing the host validator is rejected before storage", async () => {
    const t = setup();
    await expect(
      t.mutation(api.example.enqueueStrict, {
        messageId: "s_bad",
        payload: { subject: "no html" },
      }),
    ).rejects.toThrow(/invalid payload/);
    expect(await t.query(api.example.get, { messageId: "s_bad" })).toBeNull();
  });
});

describe("email — mount-safety (independent named mount)", () => {
  test("the same messageId in two mounts is independent", async () => {
    const t = setup();
    await t.mutation(api.example.enqueue, {
      messageId: "shared",
      to: "main@x.com",
      from: "f@x.com",
      transport: "jmap",
    });
    const r = await t.mutation(api.example.enqueueImport, {
      messageId: "shared",
      to: "import@x.com",
      from: "f@x.com",
    });
    expect(r.messageId).toBe("shared");
    expect(r.deduplicated).toBe(false);
    expect((await t.query(api.example.get, { messageId: "shared" }))?.to).toBe(
      "main@x.com",
    );
    expect(
      (await t.query(api.example.getImport, { messageId: "shared" }))?.to,
    ).toBe("import@x.com");
    expect(await t.mutation(api.example.pruneImport, {})).toBe(0);
  });
});

describe("email — prune (bounded + self-rescheduling)", () => {
  test("prunes only terminal messages past the cutoff", async () => {
    const t = setup();
    // terminal sent + old
    await t.mutation(api.example.enqueue, {
      messageId: "old_sent",
      to: "u@x.com",
      from: "f@x.com",
      transport: "jmap",
    });
    await t.mutation(api.example.markSending, { messageId: "old_sent" });
    await t.mutation(api.example.markSent, { messageId: "old_sent" });
    // terminal failed + old (cap attempts at 1 via the strict client's budget=2: two fails)
    await t.mutation(api.example.enqueueStrict, {
      messageId: "old_fail",
      payload: { subject: "s", html: "h" },
    });
    await t.mutation(api.example.markSending, { messageId: "old_fail" });
    await t.mutation(api.example.markFailed, { messageId: "old_fail" });
    await t.mutation(api.example.markSending, { messageId: "old_fail" });
    await t.mutation(api.example.markFailed, { messageId: "old_fail" });
    // queued (never pruned) + a fresh terminal after the cutoff
    await t.mutation(api.example.enqueue, {
      messageId: "still_queued",
      to: "u@x.com",
      from: "f@x.com",
      transport: "jmap",
    });
    vi.setSystemTime(1_000);
    await t.mutation(api.example.enqueue, {
      messageId: "new_sent",
      to: "u@x.com",
      from: "f@x.com",
      transport: "jmap",
    });
    await t.mutation(api.example.markSending, { messageId: "new_sent" });
    await t.mutation(api.example.markSent, { messageId: "new_sent" });

    const removed = await t.mutation(api.example.prune, {
      before: 100,
      batch: 200,
    });
    expect(removed).toBe(2);
    expect(await t.query(api.example.get, { messageId: "old_sent" })).toBeNull();
    expect(await t.query(api.example.get, { messageId: "old_fail" })).toBeNull();
    expect(
      await t.query(api.example.get, { messageId: "still_queued" }),
    ).not.toBeNull();
    expect(
      await t.query(api.example.get, { messageId: "new_sent" }),
    ).not.toBeNull();
  });

  test("prune with no cutoff defaults to server now", async () => {
    const t = setup();
    await t.mutation(api.example.enqueue, {
      messageId: "d",
      to: "u@x.com",
      from: "f@x.com",
      transport: "jmap",
    });
    await t.mutation(api.example.markSending, { messageId: "d" });
    await t.mutation(api.example.markSent, { messageId: "d" });
    vi.setSystemTime(1_000);
    expect(await t.mutation(api.example.prune, {})).toBe(1);
  });

  test("prune on an empty table returns 0", async () => {
    const t = setup();
    expect(
      await t.mutation(api.example.prune, { before: 9_999_999, batch: 200 }),
    ).toBe(0);
  });

  test("prune above the batch size self-reschedules and clears the whole tail", async () => {
    const t = setup();
    for (let i = 0; i < 5; i++) {
      await t.mutation(api.example.enqueue, {
        messageId: `t${i}`,
        to: "u@x.com",
        from: "f@x.com",
        transport: "jmap",
      });
      await t.mutation(api.example.markSending, { messageId: `t${i}` });
      await t.mutation(api.example.markSent, { messageId: `t${i}` });
    }
    vi.setSystemTime(1_000);
    const firstPass = await t.mutation(api.example.prune, {
      before: 1_000,
      batch: 2,
    });
    expect(firstPass).toBe(2);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    for (let i = 0; i < 5; i++) {
      expect(await t.query(api.example.get, { messageId: `t${i}` })).toBeNull();
    }
  });

  test("prune fills a batch across both terminal states", async () => {
    const t = setup();
    await t.mutation(api.example.enqueue, {
      messageId: "b_s",
      to: "u@x.com",
      from: "f@x.com",
      transport: "jmap",
    });
    await t.mutation(api.example.markSending, { messageId: "b_s" });
    await t.mutation(api.example.markSent, { messageId: "b_s" });
    await t.mutation(api.example.enqueueStrict, {
      messageId: "b_f",
      payload: { subject: "s", html: "h" },
    });
    await t.mutation(api.example.markSending, { messageId: "b_f" });
    await t.mutation(api.example.markFailed, { messageId: "b_f" });
    await t.mutation(api.example.markSending, { messageId: "b_f" });
    await t.mutation(api.example.markFailed, { messageId: "b_f" });
    vi.setSystemTime(1_000);
    // batch=1 → first pass removes one sent, self-reschedules for the failed
    const firstPass = await t.mutation(api.example.prune, {
      before: 1_000,
      batch: 1,
    });
    expect(firstPass).toBe(1);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.query(api.example.get, { messageId: "b_s" })).toBeNull();
    expect(await t.query(api.example.get, { messageId: "b_f" })).toBeNull();
  });
});

describe("email — built-in prune cron", () => {
  test("registers a daily self-rescheduling prune job with the default page size", () => {
    expect(PRUNE_INTERVAL).toEqual({ hours: 24 });
    expect(PRUNE_BATCH).toBe(200);
    expect(Object.keys(crons.crons)).toContain("email:prune");
    const job = crons.crons["email:prune"];
    expect(job?.name).toBe("mutations:prune");
    expect(job?.args).toEqual([{ batch: 200 }]);
  });
});

describe("email — queue → SMTP send wiring (flushQueuedOverSmtp)", () => {
  test("flushes queued messages over the (fake) SMTP transport and records the outcome", async () => {
    const t = setup();
    await t.mutation(api.example.enqueue, {
      messageId: "ok1",
      to: "user@x.com",
      from: "no-reply@app.com",
      transport: "smtp",
      payload: { subject: "Hi", html: "<p>Welcome</p>" },
    });
    await t.mutation(api.example.enqueue, {
      messageId: "bad1",
      to: "bounce@x.com",
      from: "no-reply@app.com",
      transport: "smtp",
    });

    const outcomes = await t.mutation(api.example.flushQueuedOverSmtp, {});
    expect(outcomes).toContainEqual({
      messageId: "ok1",
      outcome: "sent",
      providerId: "<smtp-user@x.com>",
    });
    expect(outcomes).toContainEqual({ messageId: "bad1", outcome: "failed" });

    const sent = await t.query(api.example.get, { messageId: "ok1" });
    expect(sent?.status).toBe("sent");
    expect(sent?.providerId).toBe("<smtp-user@x.com>");

    // the bounce re-queued (attempts remain under the default budget of 5)
    const bounced = await t.query(api.example.get, { messageId: "bad1" });
    expect(bounced?.status).toBe("queued");
    expect(bounced?.attempts).toBe(1);
    expect(bounced?.error).toMatch(/550 mailbox unavailable/);
  });

  test("flush on an empty queue is a no-op", async () => {
    const t = setup();
    expect(await t.mutation(api.example.flushQueuedOverSmtp, {})).toEqual([]);
  });

  test("flush respects the limit", async () => {
    const t = setup();
    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(i);
      await t.mutation(api.example.enqueue, {
        messageId: `f${i}`,
        to: "user@x.com",
        from: "no-reply@app.com",
        transport: "smtp",
        payload: { subject: "s", html: "<p>h</p>" },
      });
    }
    const outcomes = await t.mutation(api.example.flushQueuedOverSmtp, {
      limit: 2,
    });
    expect(outcomes).toHaveLength(2);
    expect(outcomes.map((o) => o.messageId)).toEqual(["f0", "f1"]);
  });
});

describe("email — host/component table isolation", () => {
  test("a host note lives in the host table, separate from the component", async () => {
    const t = setup();
    await t.mutation(api.example.enqueue, {
      messageId: "iso",
      to: "u@x.com",
      from: "f@x.com",
      transport: "jmap",
    });
    await t.mutation(api.example.addNote, { messageId: "iso", note: "hi" });
    expect(await t.query(api.example.getNote, { messageId: "iso" })).toBe("hi");
    expect((await t.query(api.example.get, { messageId: "iso" }))?.status).toBe(
      "queued",
    );
    // a note for a message with no component row is fine — fully decoupled
    await t.mutation(api.example.addNote, { messageId: "orphan", note: "x" });
    expect(await t.query(api.example.getNote, { messageId: "orphan" })).toBe("x");
    expect(await t.query(api.example.get, { messageId: "orphan" })).toBeNull();
  });
});
