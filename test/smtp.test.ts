import { describe, expect, it } from "vitest";
import { buildMime, encodeHeader, sendSmtp, type Connect, type SmtpConfig } from "../src/smtp";

const cfg: SmtpConfig = { host: "mail.privateemail.com", port: 465, secure: "on", user: "admin@alderlux.com", pass: "secret-pass", from: "admin@alderlux.com", fromName: "Alderlux" };
const msg = { to: "client@example.com", subject: "Confirmed: Succession – 20 November", text: "Hello", html: "<p>Hello</p>", replyTo: "admin@alderlux.com", attachments: [{ filename: "alderlux-call.ics", contentType: "text/calendar; charset=utf-8; method=PUBLISH", content: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n" }] };

/** Simulated SMTP server: scripted replies, records everything the client sends. */
function fakeServer(opts: { failAuth?: boolean } = {}) {
  const received: string[] = [];
  let dataMode = false;
  let data = "";
  const connect: Connect = (addr, o) => {
    let push!: (s: string) => void;
    const readable = new ReadableStream<Uint8Array>({ start(c) { push = (s) => c.enqueue(new TextEncoder().encode(s)); push("220 mail ESMTP ready\r\n"); } });
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        const text = new TextDecoder().decode(chunk);
        if (dataMode) {
          data += text;
          if (data.endsWith("\r\n.\r\n")) { dataMode = false; push("250 2.0.0 queued\r\n"); }
          return;
        }
        for (const line of text.split("\r\n").filter(Boolean)) {
          received.push(line);
          if (line.startsWith("EHLO")) push("250-mail\r\n250-AUTH LOGIN PLAIN\r\n250 8BITMIME\r\n");
          else if (line === "AUTH LOGIN") push("334 VXNlcm5hbWU6\r\n");
          else if (received.length === 3) push("334 UGFzc3dvcmQ6\r\n");
          else if (received.length === 4) push(opts.failAuth ? "535 5.7.8 auth failed\r\n" : "235 2.7.0 ok\r\n");
          else if (line.startsWith("MAIL FROM")) push("250 ok\r\n");
          else if (line.startsWith("RCPT TO")) push("250 ok\r\n");
          else if (line === "DATA") { dataMode = true; push("354 go ahead\r\n"); }
          else if (line === "QUIT") push("221 bye\r\n");
        }
      },
    });
    (connect as unknown as { last: unknown }).last = { addr, o };
    return { readable, writable, close: async () => {} };
  };
  return { connect, received, get data() { return data; } };
}

describe("SMTP sending from admin@alderlux.com", () => {
  it("logs in, sends one message to the client and quits, over TLS on 465", async () => {
    const s = fakeServer();
    await sendSmtp(cfg, msg, s.connect);
    expect((s.connect as unknown as { last: { addr: unknown; o: unknown } }).last).toEqual({ addr: { hostname: "mail.privateemail.com", port: 465 }, o: { secureTransport: "on" } });
    expect(s.received[0]).toBe("EHLO alderlux.com");
    expect(s.received[2]).toBe(btoa("admin@alderlux.com"));
    expect(s.received).toContain("MAIL FROM:<admin@alderlux.com>");
    expect(s.received).toContain("RCPT TO:<client@example.com>");
    expect(s.received.at(-1)).toBe("QUIT");
    expect(s.data).toContain("From: Alderlux <admin@alderlux.com>");
    expect(s.data).toContain('filename="alderlux-call.ics"');
    expect(s.data.endsWith("\r\n.\r\n")).toBe(true);
  });

  it("reports a clear error when the mailbox password is wrong", async () => {
    await expect(sendSmtp(cfg, msg, fakeServer({ failAuth: true }).connect)).rejects.toThrow(/AUTH password/);
  });

  it("refuses header injection in the recipient address", async () => {
    await expect(sendSmtp(cfg, { ...msg, to: "a@b.com\r\nBcc: x@y.com" }, fakeServer().connect)).rejects.toThrow(/Invalid email/);
  });
});

describe("MIME message", () => {
  it("encodes a non-ASCII subject and builds text, HTML and a calendar attachment", () => {
    const m = buildMime(cfg, msg, new Date("2026-11-06T12:00:00Z"), "fixed-id");
    expect(m).toContain(`Subject: ${encodeHeader(msg.subject)}`);
    expect(encodeHeader(msg.subject)).toMatch(/^=\?UTF-8\?B\?/);
    expect(m).toContain("Message-ID: <fixed-id@alderlux.com>");
    expect(m).toContain("Reply-To: <admin@alderlux.com>");
    expect(m).toContain("multipart/mixed");
    expect(m).toContain("text/calendar; charset=utf-8; method=PUBLISH");
    expect(m.split("\r\n").every((l) => l.length <= 998)).toBe(true);
  });
});
