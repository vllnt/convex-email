import { describe, expect, test } from "vitest";
import {
  buildEmailCreate,
  buildSubmitRequest,
  createJmapSender,
  discoverJmapSession,
  parseSubmitResponse,
  sendViaJmap,
  validateJmapConfig,
} from "./send.js";
import type { JmapConfig, JmapFetch, JmapRequestInit, JmapResponse } from "./types.js";

const CONFIG: JmapConfig = {
  endpoint: "https://mail.example.com/jmap",
  token: "tok",
  accountId: "acc1",
  identityId: "id1",
  mailboxId: "mb1",
};

/** A canned JMAP HTTP response. */
function res(body: unknown, init?: { ok?: boolean; status?: number }): JmapResponse {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: () => Promise.resolve(body),
  };
}

/** A fake fetch that returns canned responses in order and records the requests. */
function queueFetch(responses: JmapResponse[]): {
  fetchFn: JmapFetch;
  calls: Array<{ url: string; init: JmapRequestInit }>;
} {
  const calls: Array<{ url: string; init: JmapRequestInit }> = [];
  let i = 0;
  const fetchFn: JmapFetch = (url, init) => {
    calls.push({ url, init });
    const next = responses[i];
    i += 1;
    return Promise.resolve(next);
  };
  return { fetchFn, calls };
}

/** A successful Email/set + EmailSubmission/set response body. */
function sendOkBody(emailId = "E1", subId = "S1"): unknown {
  return {
    methodResponses: [
      ["Email/set", { created: { draft: { id: emailId } } }, "0"],
      ["EmailSubmission/set", { created: { sub: { id: subId } } }, "1"],
    ],
  };
}

describe("validateJmapConfig", () => {
  test("returns a fully valid config unchanged", () => {
    expect(validateJmapConfig(CONFIG)).toBe(CONFIG);
  });

  test("rejects a whitespace-only id", () => {
    expect(() => validateJmapConfig({ ...CONFIG, endpoint: "  " })).toThrow(
      /endpoint/,
    );
  });

  test("rejects a non-string id", () => {
    expect(() =>
      validateJmapConfig({ ...CONFIG, token: 123 as unknown as string }),
    ).toThrow(/token/);
  });

  test("rejects each missing required id", () => {
    expect(() => validateJmapConfig({ ...CONFIG, accountId: "" })).toThrow(
      /accountId/,
    );
    expect(() => validateJmapConfig({ ...CONFIG, identityId: "" })).toThrow(
      /identityId/,
    );
    expect(() => validateJmapConfig({ ...CONFIG, mailboxId: "" })).toThrow(
      /mailboxId/,
    );
  });
});

describe("buildEmailCreate", () => {
  test("builds a multipart/alternative body when text and html are both set", () => {
    const { email, envelope } = buildEmailCreate(
      {
        to: "to@x.com",
        from: "from@x.com",
        subject: "Hi",
        text: "plain",
        html: "<p>h</p>",
        replyTo: "r@x.com",
        headers: { "X-Tag": "welcome" },
      },
      { mailboxId: "mb1" },
    );
    expect(email.mailboxIds).toEqual({ mb1: true });
    expect(email.from).toEqual([{ email: "from@x.com" }]);
    expect(email.to).toEqual([{ email: "to@x.com" }]);
    expect(email.subject).toBe("Hi");
    expect(email.replyTo).toEqual([{ email: "r@x.com" }]);
    expect(email["header:X-Tag:asText"]).toBe("welcome");
    const structure = email.bodyStructure as { type: string };
    expect(structure.type).toBe("multipart/alternative");
    expect(email.bodyValues).toEqual({
      text: { value: "plain" },
      html: { value: "<p>h</p>" },
    });
    expect(envelope).toEqual({
      mailFrom: { email: "from@x.com" },
      rcptTo: [{ email: "to@x.com" }],
    });
  });

  test("builds an html-only body and omits subject/replyTo/headers when absent", () => {
    const { email } = buildEmailCreate(
      { to: "to@x.com", from: "f@x.com", html: "<p>h</p>" },
      {},
    );
    expect((email.bodyStructure as { type: string }).type).toBe("text/html");
    expect(email.bodyValues).toEqual({ html: { value: "<p>h</p>" } });
    expect(email.subject).toBeUndefined();
    expect(email.replyTo).toBeUndefined();
    expect(email["header:X:asText"]).toBeUndefined();
  });

  test("builds a text-only body", () => {
    const { email } = buildEmailCreate(
      { to: "to@x.com", from: "f@x.com", text: "plain" },
      {},
    );
    expect((email.bodyStructure as { type: string }).type).toBe("text/plain");
    expect(email.bodyValues).toEqual({ text: { value: "plain" } });
  });

  test("falls back to config.from and splits a comma-separated recipient list", () => {
    const { email, envelope } = buildEmailCreate(
      { to: "a@x.com, b@x.com ,c@x.com", text: "x" },
      { from: "cfg@x.com" },
    );
    expect(email.from).toEqual([{ email: "cfg@x.com" }]);
    expect(email.to).toEqual([
      { email: "a@x.com" },
      { email: "b@x.com" },
      { email: "c@x.com" },
    ]);
    expect(envelope.rcptTo).toHaveLength(3);
  });

  test("rejects an empty or non-string `to`", () => {
    expect(() => buildEmailCreate({ to: "", text: "x" }, { from: "f@x.com" })).toThrow(
      /`to`/,
    );
    expect(() =>
      buildEmailCreate({ to: 5 as unknown as string, text: "x" }, { from: "f@x.com" }),
    ).toThrow(/`to`/);
  });

  test("rejects a missing from (neither message nor config)", () => {
    expect(() => buildEmailCreate({ to: "t@x.com", text: "x" }, {})).toThrow(/`from`/);
    expect(() =>
      buildEmailCreate({ to: "t@x.com", from: "  ", text: "x" }, {}),
    ).toThrow(/`from`/);
  });

  test("rejects a body with neither text nor html", () => {
    expect(() => buildEmailCreate({ to: "t@x.com", from: "f@x.com" }, {})).toThrow(
      /text.*html/,
    );
  });

  test("rejects a recipient list that resolves to no addresses", () => {
    expect(() =>
      buildEmailCreate({ to: " , , ", from: "f@x.com", text: "x" }, {}),
    ).toThrow(/at least one address/);
  });

  test("rejects CRLF injection in from, to, replyTo, subject, and headers", () => {
    const base = { to: "t@x.com", from: "f@x.com", text: "x" };
    expect(() => buildEmailCreate({ ...base, from: "f@x.com\r\nX" }, {})).toThrow(
      /`from`/,
    );
    expect(() => buildEmailCreate({ ...base, to: "t@x.com\nBcc: e" }, {})).toThrow(
      /`to`/,
    );
    expect(() =>
      buildEmailCreate({ ...base, replyTo: "r@x.com\rX" }, {}),
    ).toThrow(/`replyTo`/);
    expect(() =>
      buildEmailCreate({ ...base, subject: "Hi\r\nInjected" }, {}),
    ).toThrow(/`subject`/);
    expect(() =>
      buildEmailCreate({ ...base, headers: { "X-A\nB": "v" } }, {}),
    ).toThrow(/headers/);
    expect(() =>
      buildEmailCreate({ ...base, headers: { "X-A": "v\r\nC" } }, {}),
    ).toThrow(/headers/);
  });
});

describe("buildSubmitRequest", () => {
  test("assembles the Email/set + EmailSubmission/set two-call batch", () => {
    const req = buildSubmitRequest(
      { to: "to@x.com", from: "f@x.com", html: "<p>h</p>" },
      CONFIG,
    );
    expect(req.using).toEqual([
      "urn:ietf:params:jmap:core",
      "urn:ietf:params:jmap:mail",
      "urn:ietf:params:jmap:submission",
    ]);
    const [emailCall, subCall] = req.methodCalls as Array<
      [string, Record<string, unknown>, string]
    >;
    expect(emailCall[0]).toBe("Email/set");
    expect(emailCall[1].accountId).toBe("acc1");
    expect(subCall[0]).toBe("EmailSubmission/set");
    const create = subCall[1].create as { sub: { emailId: string; identityId: string } };
    expect(create.sub.emailId).toBe("#draft");
    expect(create.sub.identityId).toBe("id1");
  });
});

describe("parseSubmitResponse", () => {
  test("returns the email + submission ids on success", () => {
    expect(parseSubmitResponse(sendOkBody("E9", "S9"))).toEqual({
      messageId: "S9",
      emailId: "E9",
    });
  });

  test("ignores a non-array entry and a same-name non-record invocation", () => {
    const body = {
      methodResponses: [
        42,
        ["Email/set", null, "0"],
        ["Email/set", { created: { draft: { id: "E1" } } }, "0b"],
        ["EmailSubmission/set", { created: { sub: { id: "S1" } } }, "1"],
      ],
    };
    expect(parseSubmitResponse(body)).toEqual({ messageId: "S1", emailId: "E1" });
  });

  test("throws on a non-object response", () => {
    expect(() => parseSubmitResponse(null)).toThrow(/malformed/);
  });

  test("throws when methodResponses is missing", () => {
    expect(() => parseSubmitResponse({})).toThrow(/malformed/);
  });

  test("throws on a method-level error (with and without a type)", () => {
    expect(() =>
      parseSubmitResponse({ methodResponses: [["error", { type: "unknownMethod" }, "0"]] }),
    ).toThrow(/unknownMethod/);
    expect(() =>
      parseSubmitResponse({ methodResponses: [["error", {}, "0"]] }),
    ).toThrow(/unknown/);
    expect(() =>
      parseSubmitResponse({ methodResponses: [["error", null, "0"]] }),
    ).toThrow(/unknown/);
  });

  test("throws when Email/set or EmailSubmission/set is missing", () => {
    expect(() =>
      parseSubmitResponse({
        methodResponses: [["Email/set", { created: { draft: { id: "E1" } } }, "0"]],
      }),
    ).toThrow(/missing Email\/set or EmailSubmission\/set/);
  });

  test("throws when the Email was notCreated (with and without a SetError type)", () => {
    expect(() =>
      parseSubmitResponse({
        methodResponses: [
          ["Email/set", { notCreated: { draft: { type: "tooLarge" } } }, "0"],
          ["EmailSubmission/set", { created: { sub: { id: "S1" } } }, "1"],
        ],
      }),
    ).toThrow(/Email not created \(tooLarge\)/);
    expect(() =>
      parseSubmitResponse({
        methodResponses: [
          ["Email/set", { notCreated: { draft: {} } }, "0"],
          ["EmailSubmission/set", { created: { sub: { id: "S1" } } }, "1"],
        ],
      }),
    ).toThrow(/Email not created \(unknown\)/);
  });

  test("throws when the EmailSubmission was notCreated", () => {
    expect(() =>
      parseSubmitResponse({
        methodResponses: [
          ["Email/set", { created: { draft: { id: "E1" } } }, "0"],
          ["EmailSubmission/set", { notCreated: { sub: { type: "forbidden" } } }, "1"],
        ],
      }),
    ).toThrow(/EmailSubmission not created \(forbidden\)/);
  });

  test("throws when a created entry has no id, is not an object, or created is absent", () => {
    expect(() =>
      parseSubmitResponse({
        methodResponses: [
          ["Email/set", { created: { draft: {} } }, "0"],
          ["EmailSubmission/set", { created: { sub: { id: "S1" } } }, "1"],
        ],
      }),
    ).toThrow(/Email not created \(no id/);
    expect(() =>
      parseSubmitResponse({
        methodResponses: [
          ["Email/set", { created: { draft: 5 } }, "0"],
          ["EmailSubmission/set", { created: { sub: { id: "S1" } } }, "1"],
        ],
      }),
    ).toThrow(/Email not created \(no id/);
    expect(() =>
      parseSubmitResponse({
        methodResponses: [
          ["Email/set", {}, "0"],
          ["EmailSubmission/set", { created: { sub: { id: "S1" } } }, "1"],
        ],
      }),
    ).toThrow(/Email not created \(no id/);
  });
});

describe("sendViaJmap (injected fetch)", () => {
  test("POSTs the batch with a bearer token and returns the ids", async () => {
    const { fetchFn, calls } = queueFetch([res(sendOkBody("E1", "S1"))]);
    const result = await sendViaJmap(
      fetchFn,
      { to: "to@x.com", from: "f@x.com", html: "<p>h</p>" },
      CONFIG,
    );
    expect(result).toEqual({ messageId: "S1", emailId: "E1" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(CONFIG.endpoint);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers.Authorization).toBe("Bearer tok");
  });

  test("throws on a non-2xx HTTP status", async () => {
    const { fetchFn } = queueFetch([res(null, { ok: false, status: 401 })]);
    await expect(
      sendViaJmap(fetchFn, { to: "t@x.com", from: "f@x.com", text: "x" }, CONFIG),
    ).rejects.toThrow(/HTTP 401/);
  });

  test("rejects an invalid config before any fetch", async () => {
    const { fetchFn, calls } = queueFetch([res(sendOkBody())]);
    await expect(
      sendViaJmap(fetchFn, { to: "t@x.com", from: "f@x.com", text: "x" }, {
        ...CONFIG,
        endpoint: "",
      }),
    ).rejects.toThrow(/endpoint/);
    expect(calls).toHaveLength(0);
  });

  test("rejects an invalid message before any fetch", async () => {
    const { fetchFn, calls } = queueFetch([res(sendOkBody())]);
    await expect(
      sendViaJmap(fetchFn, { to: "", from: "f@x.com", text: "x" }, CONFIG),
    ).rejects.toThrow(/`to`/);
    expect(calls).toHaveLength(0);
  });
});

describe("discoverJmapSession", () => {
  const sessionUrl = "https://mail.example.com/.well-known/jmap";
  const sessionOk = () =>
    res({
      apiUrl: "https://mail.example.com/jmap",
      primaryAccounts: { "urn:ietf:params:jmap:mail": "acc1" },
    });
  const identitiesOk = () =>
    res({
      methodResponses: [
        [
          "Identity/get",
          {
            list: [
              { id: "idA", email: "a@x.com" },
              { id: "idB", email: "b@x.com" },
            ],
          },
          "0",
        ],
      ],
    });
  const mailboxesBody = (list: unknown) => res({ methodResponses: [["Mailbox/get", { list }, "0"]] });

  test("resolves endpoint, account, sent mailbox, and identity by `from`", async () => {
    const { fetchFn } = queueFetch([
      sessionOk(),
      identitiesOk(),
      mailboxesBody([
        { id: "mbInbox", role: "inbox" },
        { id: "mbSent", role: "sent" },
      ]),
    ]);
    const cfg = await discoverJmapSession(fetchFn, {
      sessionUrl,
      token: "tok",
      from: "b@x.com",
    });
    expect(cfg).toEqual({
      endpoint: "https://mail.example.com/jmap",
      token: "tok",
      accountId: "acc1",
      identityId: "idB",
      mailboxId: "mbSent",
      from: "b@x.com",
    });
  });

  test("falls back to the first identity and its email when no `from` is given", async () => {
    const { fetchFn } = queueFetch([
      sessionOk(),
      identitiesOk(),
      mailboxesBody([{ id: "mbDrafts", role: "drafts" }]),
    ]);
    const cfg = await discoverJmapSession(fetchFn, { sessionUrl, token: "tok" });
    expect(cfg.identityId).toBe("idA");
    expect(cfg.from).toBe("a@x.com");
    expect(cfg.mailboxId).toBe("mbDrafts");
  });

  test("uses the first identity when `from` matches none, and the first mailbox with no roles", async () => {
    const { fetchFn } = queueFetch([
      sessionOk(),
      identitiesOk(),
      mailboxesBody([{ id: "mbFirst" }, { id: "mbSecond", role: "archive" }]),
    ]);
    const cfg = await discoverJmapSession(fetchFn, {
      sessionUrl,
      token: "tok",
      from: "nomatch@x.com",
    });
    expect(cfg.identityId).toBe("idA");
    expect(cfg.mailboxId).toBe("mbFirst");
  });

  test("rejects an empty sessionUrl or token", async () => {
    const { fetchFn } = queueFetch([]);
    await expect(
      discoverJmapSession(fetchFn, { sessionUrl: "", token: "tok" }),
    ).rejects.toThrow(/sessionUrl/);
    await expect(
      discoverJmapSession(fetchFn, { sessionUrl, token: "  " }),
    ).rejects.toThrow(/token/);
  });

  test("throws on a failed session request", async () => {
    const { fetchFn } = queueFetch([res(null, { ok: false, status: 403 })]);
    await expect(
      discoverJmapSession(fetchFn, { sessionUrl, token: "tok" }),
    ).rejects.toThrow(/session request failed \(HTTP 403\)/);
  });

  test("throws when the session has no apiUrl", async () => {
    const { fetchFn: f1 } = queueFetch([res({})]);
    await expect(
      discoverJmapSession(f1, { sessionUrl, token: "tok" }),
    ).rejects.toThrow(/no apiUrl/);
    const { fetchFn: f2 } = queueFetch([res(null)]);
    await expect(
      discoverJmapSession(f2, { sessionUrl, token: "tok" }),
    ).rejects.toThrow(/no apiUrl/);
  });

  test("throws when there is no primary mail account (missing or empty)", async () => {
    const { fetchFn: f1 } = queueFetch([res({ apiUrl: "u", primaryAccounts: {} })]);
    await expect(
      discoverJmapSession(f1, { sessionUrl, token: "tok" }),
    ).rejects.toThrow(/no primary mail account/);
    const { fetchFn: f2 } = queueFetch([res({ apiUrl: "u" })]);
    await expect(
      discoverJmapSession(f2, { sessionUrl, token: "tok" }),
    ).rejects.toThrow(/no primary mail account/);
  });

  test("throws on a failed Identity/get HTTP request", async () => {
    const { fetchFn } = queueFetch([sessionOk(), res(null, { ok: false, status: 500 })]);
    await expect(
      discoverJmapSession(fetchFn, { sessionUrl, token: "tok" }),
    ).rejects.toThrow(/HTTP 500/);
  });

  test("throws when no identity is found (missing invocation or non-array list)", async () => {
    const { fetchFn: f1 } = queueFetch([
      sessionOk(),
      res({ methodResponses: [["Other/get", { list: [] }, "0"]] }),
    ]);
    await expect(
      discoverJmapSession(f1, { sessionUrl, token: "tok" }),
    ).rejects.toThrow(/no sending identity/);
    const { fetchFn: f2 } = queueFetch([
      sessionOk(),
      res({ methodResponses: [["Identity/get", { list: "nope" }, "0"]] }),
    ]);
    await expect(
      discoverJmapSession(f2, { sessionUrl, token: "tok" }),
    ).rejects.toThrow(/no sending identity/);
  });

  test("throws on a malformed Mailbox/get response and when no mailbox is found", async () => {
    const { fetchFn: f1 } = queueFetch([sessionOk(), identitiesOk(), res({})]);
    await expect(
      discoverJmapSession(f1, { sessionUrl, token: "tok" }),
    ).rejects.toThrow(/malformed/);
    const { fetchFn: f2 } = queueFetch([sessionOk(), identitiesOk(), mailboxesBody([])]);
    await expect(
      discoverJmapSession(f2, { sessionUrl, token: "tok" }),
    ).rejects.toThrow(/no sent or drafts mailbox/);
    const { fetchFn: f3 } = queueFetch([
      sessionOk(),
      identitiesOk(),
      res({ methodResponses: [["Mailbox/get", { list: "nope" }, "0"]] }),
    ]);
    await expect(
      discoverJmapSession(f3, { sessionUrl, token: "tok" }),
    ).rejects.toThrow(/no sent or drafts mailbox/);
  });

  test("skips malformed identity and mailbox list entries", async () => {
    const { fetchFn } = queueFetch([
      sessionOk(),
      res({
        methodResponses: [
          [
            "Identity/get",
            { list: [42, { id: "idA" }, { id: "idOk", email: "ok@x.com" }] },
            "0",
          ],
        ],
      }),
      mailboxesBody([99, { role: "sent" }, { id: "mbReal", role: "sent" }]),
    ]);
    const cfg = await discoverJmapSession(fetchFn, { sessionUrl, token: "tok" });
    expect(cfg.identityId).toBe("idOk");
    expect(cfg.mailboxId).toBe("mbReal");
  });
});

describe("createJmapSender", () => {
  test("binds the config + fetch and sends one message", async () => {
    const { fetchFn, calls } = queueFetch([res(sendOkBody("E1", "S1"))]);
    const send = createJmapSender(CONFIG, fetchFn);
    const result = await send({ to: "to@x.com", from: "f@x.com", html: "<p>h</p>" });
    expect(result).toEqual({ messageId: "S1", emailId: "E1" });
    expect(calls).toHaveLength(1);
  });

  test("throws eagerly on an invalid config", () => {
    const { fetchFn } = queueFetch([]);
    expect(() => createJmapSender({ ...CONFIG, token: "" }, fetchFn)).toThrow(/token/);
  });
});
