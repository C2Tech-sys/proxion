import nodemailer, { type Transporter } from 'nodemailer';
import { plainTextBody, summaryHeadline } from '../format.js';
import type { NotifyChannel, NotifyMessage } from '../types.js';

export interface EmailChannelOptions {
  /** `smtp://user:pass@host:port` or `smtps://...` -- credentials live in the URL itself
   *  (nodemailer parses `smtps:`/STARTTLS and auth straight out of it). */
  smtpUrl: string;
  from: string;
  /** Comma-separated recipient list, as stored in `PROXION_NOTIFY_EMAIL_TO`. */
  to: string;
  /** Overridable for tests -- an already-built nodemailer `Transporter` (e.g. `jsonTransport`),
   *  so no test ever opens a real SMTP connection. */
  transport?: Transporter;
}

function subjectFor(message: NotifyMessage): string {
  const n = message.events.length;
  const first = message.events[0]?.title;
  if (message.kind === 'test') return `[${message.siteName}] Test notification`;
  if (n === 0) return `[${message.siteName}] ${summaryHeadline(message)}`;
  return `[${message.siteName}] ${n} alert(s): ${first}`;
}

/**
 * The email notification channel: one plain-text message per notification batch, sent via
 * nodemailer. `options.transport` lets tests inject `nodemailer.createTransport({ jsonTransport:
 * true })` (or any stub `Transporter`) -- the SMTP URL is otherwise only ever parsed by
 * nodemailer itself, never logged (see `NotifyChannel.host`).
 */
export function createEmailChannel(options: EmailChannelOptions): NotifyChannel {
  const transport = options.transport ?? nodemailer.createTransport(options.smtpUrl);
  // `smtp(s)://user:pass@host:port` -- `new URL` on it exposes `.host` without ever touching
  // `.username`/`.password`, so nothing credential-shaped is retained here.
  const host = new URL(options.smtpUrl).host;

  return {
    name: 'email',
    host,
    async send(message: NotifyMessage): Promise<void> {
      await transport.sendMail({
        from: options.from,
        to: options.to,
        subject: subjectFor(message),
        text: plainTextBody(message),
      });
    },
  };
}
