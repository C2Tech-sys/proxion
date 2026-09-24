# Security Policy

## Supported versions

Proxion is pre-1.0 (currently `0.x`). There is one supported line: the
latest release. Please upgrade before reporting an issue against an older
version.

| Version        | Supported          |
| -------------- | ------------------ |
| `0.x` (latest) | :white_check_mark: |
| older          | :x:                |

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Use GitHub's private vulnerability reporting instead: on the repository,
go to the **Security** tab -> **Report a vulnerability** (or use
[this link](https://github.com/C2Tech-sys/proxion/security/advisories/new)).
This opens a private conversation with the maintainers and lets us
coordinate a fix and disclosure timeline before anything is public.

Please include:

- A description of the issue and its potential impact.
- Steps to reproduce (a minimal repro is very helpful).
- The Proxion version/commit and deployment context (Docker image, local
  dev, reverse proxy setup, etc.) if relevant.

We'll acknowledge new reports as soon as we can and keep you updated as we
investigate and fix the issue.

## Scope notes

Proxion proxies to your own Proxmox VE cluster and never talks to any
third-party service. Given that, in scope: authentication/session
handling, the read-only PVE proxy's path/method restrictions, TLS
verification and fingerprint pinning, the console/terminal websocket
bridges (ticket handling, upstream handshake), and the Docker image.
Vulnerabilities in Proxmox VE itself are out of scope here -- please report
those to the Proxmox security team instead.
