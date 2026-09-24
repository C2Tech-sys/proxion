# syntax=docker/dockerfile:1

# Custom Caddy build that adds the Azure DNS provider module, so Caddy can
# complete the ACME DNS-01 challenge against Azure DNS instead of needing an
# inbound-reachable port 80/443 for HTTP-01/TLS-ALPN.
FROM caddy:2-builder AS builder

RUN xcaddy build --with github.com/caddy-dns/azure

FROM caddy:2

COPY --from=builder /usr/bin/caddy /usr/bin/caddy
