// Transactional email. In production this uses the Cloudflare Email Service binding
// (needs the Workers Paid plan to email arbitrary recipients). Without the binding,
// messages are logged, which is what local development and tests use.

import { sendSmtp, type Attachment, type Connect, type SmtpConfig } from "./smtp";

export interface Message {
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments?: Attachment[];
}

export interface EmailBinding {
  send(msg: { from: string; to: string; subject: string; text: string; html: string }): Promise<unknown>;
}

export interface Transport {
  smtp?: SmtpConfig; // preferred: admin@alderlux.com via the domain's own mail server
  connect?: Connect;
  binding?: EmailBinding; // alternative: Cloudflare Email Service (paid plan)
  from: string;
}

export const outbox: Message[] = []; // populated when no transport is configured (dev/test)

export async function sendEmail(t: Transport, msg: Message): Promise<void> {
  if (t.smtp && t.connect) return sendSmtp(t.smtp, { ...msg, replyTo: t.smtp.from }, t.connect);
  if (t.binding) {
    await t.binding.send({ from: t.from, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
    return;
  }
  outbox.push(msg);
  console.log(`[email:dev] to=${msg.to} subject=${msg.subject} attachments=${msg.attachments?.length ?? 0}`);
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** House email: logo band on #0B0B0D, inline styles only, footer in the email's own HTML. */
export function renderEmail(opts: { productLine?: string; headline: string; paragraphs: string[]; button?: { label: string; url: string }; footer: string[] }): { html: string; text: string } {
  const p = opts.paragraphs.map((t) => `<p style="margin:0 0 16px 0;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:16px;line-height:1.65;color:#2A3746;">${esc(t)}</p>`).join("");
  const button = opts.button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px 0;"><tr><td bgcolor="#0B0B0D" style="background-color:#0B0B0D;padding:16px 40px;"><a href="${esc(opts.button.url)}" style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:#C9A86A;text-decoration:none;"><span style="color:#C9A86A;">${esc(opts.button.label)}</span></a></td></tr></table>`
    : "";
  const product = opts.productLine
    ? `<tr><td align="center" bgcolor="#0B0B0D" style="background-color:#0B0B0D;padding:0 24px 26px 24px;"><span style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.28em;color:#C9A86A;">${esc(opts.productLine)}</span></td></tr>`
    : "";
  const footer = opts.footer.map((t) => `<p style="margin:0 0 8px 0;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:12px;line-height:1.5;color:#767E88;">${esc(t)}</p>`).join("");
  const html = `<!doctype html><html><body bgcolor="#EFEAE0" style="margin:0;padding:0;background-color:#EFEAE0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#EFEAE0" style="background-color:#EFEAE0;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#FCFBF9" style="max-width:600px;width:100%;background-color:#FCFBF9;">
<tr><td style="background-color:#C9A86A;height:3px;line-height:3px;font-size:3px;"> </td></tr>
<tr><td align="center" bgcolor="#0B0B0D" style="background-color:#0B0B0D;padding:30px 24px 22px 24px;"><img src="https://cdn.prod.website-files.com/6a155eafdf3dabc290bd2b8f/6ad9b8878c2b977cc1804d0f_alderlux-email-lockup.png" width="220" height="146" alt="Alderlux" style="display:block;border:0;outline:none;text-decoration:none;width:220px;height:146px;"></td></tr>
${product}
<tr><td style="background-color:#C9A86A;height:2px;line-height:2px;font-size:2px;"> </td></tr>
<tr><td style="padding:32px 40px 8px 40px;"><h1 style="margin:0 0 20px 0;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:30px;font-weight:400;line-height:1.24;color:#1C2531;text-align:center;">${esc(opts.headline)}</h1>${p}${button}</td></tr>
<tr><td style="padding:0 40px 24px 40px;border-top:1px solid #E4E0D8;"><div style="height:16px;"></div>${footer}<p style="margin:0;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:12px;color:#767E88;">Alderlux, Bollington Road, Bollington, United Kingdom</p></td></tr>
<tr><td style="background-color:#C9A86A;height:3px;line-height:3px;font-size:3px;"> </td></tr>
</table></td></tr></table></body></html>`;
  const text = [opts.headline, "", ...opts.paragraphs, ...(opts.button ? ["", `${opts.button.label}: ${opts.button.url}`] : []), "", ...opts.footer, "Alderlux, Bollington Road, Bollington, United Kingdom"].join("\n");
  return { html, text };
}
