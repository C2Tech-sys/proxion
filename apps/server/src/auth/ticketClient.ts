import type { Agent, Response } from 'undici';
import type { Config } from '../config.js';
import { dispatcherFetch } from '../pve/dispatcher.js';

/** PVE actually answered and rejected the credentials/ticket (401): the caller is simply wrong. */
export class TicketAuthError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TicketAuthError';
    Object.setPrototypeOf(this, TicketAuthError.prototype);
  }
}

/**
 * PVE could not be reached, or didn't give a real answer (network/TLS
 * failure, timeout, 5xx, or an unparseable/incomplete response) --
 * distinct from `TicketAuthError` so callers don't tell the user their
 * password is wrong when the problem is that PVE is down, and don't log a
 * session out over a blip that has nothing to do with its ticket.
 */
export class TicketTransportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TicketTransportError';
    Object.setPrototypeOf(this, TicketTransportError.prototype);
  }
}

export interface TicketResult {
  ticket: string;
  csrfToken: string;
  username: string;
  capabilities: unknown;
}

interface RawTicketEnvelope {
  data?: {
    ticket?: string;
    CSRFPreventionToken?: string;
    username?: string;
    cap?: unknown;
  } | null;
  message?: string;
}

/**
 * Calls PVE's `POST /access/ticket` -- the pass-through login/renewal
 * endpoint. Deliberately bypasses `PveHttp`/`PveClient` (which require
 * `Credentials` up front and unwrap the envelope differently): this is the
 * one call that happens *before* we have any credentials, and we need the
 * `cap` field the generated endpoint types don't model. Still routes through
 * the shared dispatcher (never builds its own `Agent`).
 */
async function callTicketEndpoint(
  config: Config,
  dispatcher: Agent | undefined,
  params: Record<string, string>,
): Promise<TicketResult> {
  const fetchImpl = dispatcherFetch(dispatcher);
  const body = new URLSearchParams(params);

  let response: Response;
  try {
    response = await fetchImpl(`${config.PVE_URL}/api2/json/access/ticket`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (error) {
    // Network/TLS failure, timeout, connection refused, ... -- PVE never
    // actually answered, so this is not "wrong credentials".
    throw new TicketTransportError('Failed to reach Proxmox VE', { cause: error });
  }

  // PVE answered and explicitly rejected the credentials/ticket.
  if (response.status === 401) {
    throw new TicketAuthError('Proxmox VE authentication failed');
  }

  const text = await response.text();
  let envelope: RawTicketEnvelope | undefined;
  try {
    envelope = text.length > 0 ? (JSON.parse(text) as RawTicketEnvelope) : undefined;
  } catch {
    envelope = undefined;
  }

  const data = envelope?.data;
  if (!response.ok || !data?.ticket || !data.CSRFPreventionToken || !data.username) {
    // Any other non-2xx (5xx, unexpected 4xx) or an unusable body: PVE didn't
    // give a real answer either way -- a transport-level problem, not a
    // rejected login. Never leak PVE's own error detail to the caller (it may
    // echo the attempted username/realm).
    throw new TicketTransportError(`Proxmox VE ticket endpoint returned an unusable response (status ${response.status})`);
  }

  return {
    ticket: data.ticket,
    csrfToken: data.CSRFPreventionToken,
    username: data.username,
    capabilities: data.cap,
  };
}

/** `user@realm` login: `POST /access/ticket` with `username` + `password`. */
export function requestTicket(
  config: Config,
  dispatcher: Agent | undefined,
  credentials: { username: string; password: string },
): Promise<TicketResult> {
  return callTicketEndpoint(config, dispatcher, {
    username: credentials.username,
    password: credentials.password,
  });
}

/** Ticket renewal: same endpoint, with the *current ticket* as the password. */
export function renewTicket(
  config: Config,
  dispatcher: Agent | undefined,
  session: { username: string; ticket: string },
): Promise<TicketResult> {
  return callTicketEndpoint(config, dispatcher, {
    username: session.username,
    password: session.ticket,
  });
}
