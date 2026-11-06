// Minimal SMTP client for Cloudflare Workers (cloudflare:sockets), used to send booking emails from
// admin@alderlux.com through the domain's own mail server (Namecheap Private Email). No extra cost:
// it uses the mailbox Alderlux already pays for. Port 25 is blocked on Workers; 465 (TLS) or 587
// (STARTTLS) are used instead.

export interface SmtpConfig {
  host: string;
  port: number;
  secure: "on" | "starttls" | "off"; // "off" only for local testing
  user: string;
  pass: string;
  from: string; // e.g. admin@alderlux.com
  fromName: string; // e.g. Alderlux
  heloName?: string;
}

export interface Attachment {
  filename: string;
  contentType: string; // e.g. 'text/calendar; charset=utf-8; method=PUBLISH'
  content: string;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
  attachments?: Attachment[];
}

export interface SocketLike {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  opened?: Promise<unknown>;
  close(): Promise<void>;
  startTls?(): SocketLike;
}

export type Connect = (addr: { hostname: string; port: number }, opts: { secureTransport: "on" | "off" | "starttls"; allowHalfOpen?: boolean }) => SocketLike;

const enc = new TextEncoder();

function b64(s: string): string {
  const bytes = enc.encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function wrap76(s: string): string {
  return s.replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

/** RFC 2047 encoded-word for headers that may contain non-ASCII text. */
export function encodeHeader(s: string): string {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`;
}

function addressOk(a: string): boolean {
  return /^[^\s<>@,;"]+@[^\s<>@,;"]+$/.test(a);
}

export function buildMime(cfg: SmtpConfig, msg: MailMessage, now = new Date(), id = crypto.randomUUID()): string {
  const domain = cfg.from.split("@")[1];
  const boundaryMixed = `mixed_${id}`;
  const boundaryAlt = `alt_${id}`;
  const headers = [
    `From: ${encodeHeader(cfg.fromName)} <${cfg.from}>`,
    `To: <${msg.to}>`,
    `Subject: ${encodeHeader(msg.subject)}`,
    `Date: ${now.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${id}@${domain}>`,
    ...(msg.replyTo ? [`Reply-To: <${msg.replyTo}>`] : []),
    "MIME-Version: 1.0",
    "Auto-Submitted: auto-generated",
  ];
  const alt = [
    `--${boundaryAlt}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(b64(msg.text)),
    `--${boundaryAlt}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    wrap76(b64(msg.html)),
    `--${boundaryAlt}--`,
  ].join("\r\n");
  if (!msg.attachments?.length) {
    return [...headers, `Content-Type: multipart/alternative; boundary="${boundaryAlt}"`, "", alt, ""].join("\r\n");
  }
  const parts = msg.attachments.map((a) =>
    [`--${boundaryMixed}`, `Content-Type: ${a.contentType}; name="${a.filename}"`, `Content-Disposition: attachment; filename="${a.filename}"`, "Content-Transfer-Encoding: base64", "", wrap76(b64(a.content))].join("\r\n"),
  );
  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${boundaryMixed}"`,
    "",
    `--${boundaryMixed}`,
    `Content-Type: multipart/alternative; boundary="${boundaryAlt}"`,
    "",
    alt,
    ...parts,
    `--${boundaryMixed}--`,
    "",
  ].join("\r\n");
}

class Conn {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private buf = "";
  private dec = new TextDecoder();
  readonly transcript: string[] = [];
  constructor(public socket: SocketLike) {
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
  }
  release(): void {
    this.reader.releaseLock();
    this.writer.releaseLock();
  }
  async reply(): Promise<{ code: number; lines: string[] }> {
    const lines: string[] = [];
    for (;;) {
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) === -1) {
        const { value, done } = await this.reader.read();
        if (done) throw new Error("SMTP connection closed unexpectedly");
        this.buf += this.dec.decode(value, { stream: true });
      }
      const line = this.buf.slice(0, nl).replace(/\r$/, "");
      this.buf = this.buf.slice(nl + 1);
      lines.push(line);
      this.transcript.push("S: " + line);
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) return { code: Number(line.slice(0, 3)), lines };
    }
  }
  async send(line: string, redact = false): Promise<void> {
    this.transcript.push("C: " + (redact ? "[redacted]" : line));
    await this.writer.write(enc.encode(line + "\r\n"));
  }
  async raw(data: string): Promise<void> {
    await this.writer.write(enc.encode(data));
  }
  async expect(codes: number[], what: string): Promise<{ code: number; lines: string[] }> {
    const r = await this.reply();
    if (!codes.includes(r.code)) throw new Error(`SMTP ${what} failed: ${r.lines.join(" | ")}`);
    return r;
  }
}

export async function sendSmtp(cfg: SmtpConfig, msg: MailMessage, connect: Connect): Promise<void> {
  if (!addressOk(msg.to) || !addressOk(cfg.from)) throw new Error("Invalid email address");
  const helo = cfg.heloName ?? cfg.from.split("@")[1];
  let socket = connect({ hostname: cfg.host, port: cfg.port }, { secureTransport: cfg.secure });
  let c = new Conn(socket);
  try {
    await c.expect([220], "greeting");
    await c.send(`EHLO ${helo}`);
    await c.expect([250], "EHLO");
    if (cfg.secure === "starttls") {
      await c.send("STARTTLS");
      await c.expect([220], "STARTTLS");
      c.release();
      socket = socket.startTls!();
      c = new Conn(socket);
      await c.send(`EHLO ${helo}`);
      await c.expect([250], "EHLO after STARTTLS");
    }
    await c.send("AUTH LOGIN");
    await c.expect([334], "AUTH");
    await c.send(b64(cfg.user), true);
    await c.expect([334], "AUTH user");
    await c.send(b64(cfg.pass), true);
    await c.expect([235], "AUTH password");
    await c.send(`MAIL FROM:<${cfg.from}>`);
    await c.expect([250], "MAIL FROM");
    await c.send(`RCPT TO:<${msg.to}>`);
    await c.expect([250, 251], "RCPT TO");
    await c.send("DATA");
    await c.expect([354], "DATA");
    const body = buildMime(cfg, msg).replace(/\r\n\./g, "\r\n.."); // dot-stuffing
    await c.raw(body + (body.endsWith("\r\n") ? "" : "\r\n") + ".\r\n");
    await c.expect([250], "message");
    await c.send("QUIT");
    await c.reply().catch(() => undefined);
  } finally {
    await socket.close().catch(() => undefined);
  }
}
