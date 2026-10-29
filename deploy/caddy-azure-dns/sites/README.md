# Extra sites for this Caddy

Each `*.caddy` file here is imported by `../caddy/Caddyfile` (`import /etc/caddy/sites/*.caddy`), so
one Caddy on the mesh address can front more than Proxion. A site block can reuse the Azure DNS-01
`tls` block and the `AZURE_*` variables from `caddy.env`, and reach any container that joins this
stack's Docker network (`caddy-azure-dns_default`). Site files are host-specific and not tracked by
git (`*.caddy` is ignored here); this README keeps the directory in the tree so the bind mount exists.

After adding or changing a file: `docker compose exec caddy caddy validate --config /etc/caddy/Caddyfile`
then `docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile`.
