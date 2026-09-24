/** Thrown when the Proxmox VE API responds with a non-2xx status. */
export class PveApiError extends Error {
  readonly status: number;
  readonly errors?: Record<string, string>;

  constructor(options: { status: number; message: string; errors?: Record<string, string> }) {
    super(options.message);
    this.name = 'PveApiError';
    this.status = options.status;
    if (options.errors) this.errors = options.errors;
    Object.setPrototypeOf(this, PveApiError.prototype);
  }
}

/** Thrown when TLS fingerprint pinning fails, or a fingerprint fails to parse. */
export class PveTlsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PveTlsError';
    Object.setPrototypeOf(this, PveTlsError.prototype);
  }
}
