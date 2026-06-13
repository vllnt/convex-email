import { describe, expect, test } from "vitest";
import { sendViaSmtp, toMailOptions, validateSmtpConfig } from "./send.js";
import type { SmtpMailOptions, SmtpSendInfo, SmtpTransport } from "./types.js";

/** A fake transport: records the options it received and returns a canned info. */
function fakeTransport(info: SmtpSendInfo): {
  transport: SmtpTransport;
  calls: SmtpMailOptions[];
} {
  const calls: SmtpMailOptions[] = [];
  const transport: SmtpTransport = {
    sendMail: (options) => {
      calls.push(options);
      return Promise.resolve(info);
    },
  };
  return { calls, transport };
}

describe("validateSmtpConfig", () => {
  test("resolves secure=true for port 465 by default", () => {
    const c = validateSmtpConfig({ host: "smtp.example.com", port: 465 });
    expect(c.secure).toBe(true);
  });

  test("resolves secure=false for a non-465 port by default", () => {
    const c = validateSmtpConfig({ host: "smtp.example.com", port: 587 });
    expect(c.secure).toBe(false);
  });

  test("honors an explicit secure flag over the port default", () => {
    expect(
      validateSmtpConfig({ host: "h", port: 465, secure: false }).secure,
    ).toBe(false);
    expect(
      validateSmtpConfig({ host: "h", port: 587, secure: true }).secure,
    ).toBe(true);
  });

  test("accepts a valid auth block and passes it through", () => {
    const c = validateSmtpConfig({
      host: "h",
      port: 587,
      auth: { user: "u", pass: "p" },
    });
    expect(c.auth).toEqual({ user: "u", pass: "p" });
  });

  test("rejects an empty or non-string host", () => {
    expect(() => validateSmtpConfig({ host: "", port: 25 })).toThrow(/host/);
    expect(() => validateSmtpConfig({ host: "   ", port: 25 })).toThrow(/host/);
    expect(() =>
      validateSmtpConfig({ host: 123 as unknown as string, port: 25 }),
    ).toThrow(/host/);
  });

  test("rejects an out-of-range, non-integer, or non-number port", () => {
    expect(() => validateSmtpConfig({ host: "h", port: 0 })).toThrow(/port/);
    expect(() => validateSmtpConfig({ host: "h", port: 70000 })).toThrow(/port/);
    expect(() => validateSmtpConfig({ host: "h", port: 5.5 })).toThrow(/port/);
    expect(() =>
      validateSmtpConfig({ host: "h", port: "25" as unknown as number }),
    ).toThrow(/port/);
  });

  test("rejects an auth block with non-string credentials", () => {
    expect(() =>
      validateSmtpConfig({
        host: "h",
        port: 25,
        auth: { user: 1 as unknown as string, pass: "p" },
      }),
    ).toThrow(/auth/);
    expect(() =>
      validateSmtpConfig({
        host: "h",
        port: 25,
        auth: { user: "u", pass: 2 as unknown as string },
      }),
    ).toThrow(/auth/);
  });
});

describe("toMailOptions", () => {
  test("maps every field and uses message.from when present", () => {
    const opts = toMailOptions(
      {
        to: "to@x.com",
        from: "msg@x.com",
        subject: "Hi",
        text: "t",
        html: "<p>h</p>",
        replyTo: "r@x.com",
        headers: { "X-Tag": "welcome" },
      },
      { from: "cfg@x.com" },
    );
    expect(opts).toEqual({
      to: "to@x.com",
      from: "msg@x.com",
      subject: "Hi",
      text: "t",
      html: "<p>h</p>",
      replyTo: "r@x.com",
      headers: { "X-Tag": "welcome" },
    });
  });

  test("falls back to config.from when the message omits from", () => {
    const opts = toMailOptions({ to: "to@x.com", text: "t" }, { from: "cfg@x.com" });
    expect(opts.from).toBe("cfg@x.com");
  });

  test("rejects an empty or non-string `to`", () => {
    expect(() => toMailOptions({ to: "", text: "t" }, {})).toThrow(/`to`/);
    expect(() =>
      toMailOptions({ to: 5 as unknown as string, text: "t" }, {}),
    ).toThrow(/`to`/);
  });

  test("rejects a missing from (neither message nor config supplies one)", () => {
    expect(() => toMailOptions({ to: "to@x.com", text: "t" }, {})).toThrow(/`from`/);
    expect(() =>
      toMailOptions({ to: "to@x.com", from: "  ", text: "t" }, {}),
    ).toThrow(/`from`/);
  });

  test("rejects a body with neither text nor html", () => {
    expect(() => toMailOptions({ to: "to@x.com", from: "f@x.com" }, {})).toThrow(
      /text.*html/,
    );
  });

  test("accepts an html-only and a text-only body", () => {
    expect(
      toMailOptions({ to: "t@x.com", from: "f@x.com", html: "<p>x</p>" }, {}).html,
    ).toBe("<p>x</p>");
    expect(
      toMailOptions({ to: "t@x.com", from: "f@x.com", text: "x" }, {}).text,
    ).toBe("x");
  });

  test("rejects CRLF injection in to, from, replyTo, subject, and headers", () => {
    const base = { to: "t@x.com", from: "f@x.com", text: "x" };
    expect(() => toMailOptions({ ...base, to: "t@x.com\r\nBCC: e" }, {})).toThrow(
      /`to`/,
    );
    expect(() =>
      toMailOptions({ ...base, from: "f@x.com\nDATA" }, {}),
    ).toThrow(/`from`/);
    expect(() =>
      toMailOptions({ ...base, replyTo: "r@x.com\rX" }, {}),
    ).toThrow(/`replyTo`/);
    expect(() =>
      toMailOptions({ ...base, subject: "Hi\r\nInjected" }, {}),
    ).toThrow(/`subject`/);
    expect(() =>
      toMailOptions({ ...base, headers: { "X-A\nB": "v" } }, {}),
    ).toThrow(/headers/);
    expect(() =>
      toMailOptions({ ...base, headers: { "X-A": "v\r\nC" } }, {}),
    ).toThrow(/headers/);
  });

  test("accepts a clean message with optional fields omitted", () => {
    const opts = toMailOptions({ to: "t@x.com", from: "f@x.com", text: "x" }, {});
    expect(opts.subject).toBeUndefined();
    expect(opts.replyTo).toBeUndefined();
    expect(opts.headers).toBeUndefined();
  });
});

describe("sendViaSmtp (injected transport)", () => {
  test("sends through the transport and normalizes the result", async () => {
    const { transport, calls } = fakeTransport({
      messageId: "<smtp-1@server>",
      accepted: ["to@x.com"],
      rejected: [],
    });
    const result = await sendViaSmtp(
      transport,
      { to: "to@x.com", subject: "Hi", html: "<p>x</p>" },
      { from: "no-reply@app.com" },
    );
    expect(result).toEqual({
      messageId: "<smtp-1@server>",
      accepted: ["to@x.com"],
      rejected: [],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].from).toBe("no-reply@app.com");
    expect(calls[0].to).toBe("to@x.com");
  });

  test("flattens object-form accepted/rejected address entries", async () => {
    const { transport } = fakeTransport({
      messageId: "<id>",
      accepted: [{ address: "ok@x.com" }, "two@x.com"],
      rejected: [{ address: "no@x.com" }],
    });
    const result = await sendViaSmtp(
      transport,
      { to: "ok@x.com", from: "f@x.com", text: "x" },
    );
    expect(result.accepted).toEqual(["ok@x.com", "two@x.com"]);
    expect(result.rejected).toEqual(["no@x.com"]);
  });

  test("defaults messageId to '' and accepted/rejected to [] when absent", async () => {
    const { transport } = fakeTransport({});
    const result = await sendViaSmtp(
      transport,
      { to: "t@x.com", from: "f@x.com", text: "x" },
    );
    expect(result).toEqual({ messageId: "", accepted: [], rejected: [] });
  });

  test("uses the default empty config when none is passed", async () => {
    const { transport, calls } = fakeTransport({ messageId: "x" });
    await sendViaSmtp(transport, { to: "t@x.com", from: "msg@x.com", text: "x" });
    expect(calls[0].from).toBe("msg@x.com");
  });

  test("propagates a transport send failure to the caller", async () => {
    const transport: SmtpTransport = {
      sendMail: () => Promise.reject(new Error("connection refused")),
    };
    await expect(
      sendViaSmtp(transport, { to: "t@x.com", from: "f@x.com", text: "x" }),
    ).rejects.toThrow(/connection refused/);
  });

  test("rejects an invalid message before touching the transport", async () => {
    const { transport, calls } = fakeTransport({ messageId: "x" });
    await expect(
      sendViaSmtp(transport, { to: "", from: "f@x.com", text: "x" }),
    ).rejects.toThrow(/`to`/);
    expect(calls).toHaveLength(0);
  });
});
