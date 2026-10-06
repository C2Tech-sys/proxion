import nodemailer, { type Transporter } from 'nodemailer';
import { htmlBody, plainTextBody, subjectLine } from '../format.js';
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

/**
 * The email notification channel: one message per notification batch (a designed HTML body plus a
 * plain-text alternative), sent via nodemailer. `options.transport` lets tests inject
 * `nodemailer.createTransport({ jsonTransport: true })` (or any stub `Transporter`) -- the SMTP URL
 * is otherwise only ever parsed by nodemailer itself, never logged (see `NotifyChannel.host`).
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
        subject: subjectLine(message),
        text: plainTextBody(message),
        html: htmlBody(message),
      });
    },
  };
}
