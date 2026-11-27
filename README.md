# darkify-vouches

Cloudflare Worker `wispy-block-c5fc` (vouches feed + `/stats`) and the GitHub Action that keeps it fed.

myvouch.es answers Cloudflare Worker IPs with HTTP 429, so the Worker can't fetch vouches itself.
`.github/workflows/sync-vouches.yml` fetches `https://myvouch.es/api/darkify/vouches/embed` hourly and
POSTs the HTML to `/ingest` (Bearer `INGEST_TOKEN`, a repo secret and a Worker secret). The Worker parses
it and stores the last good copy in KV (`VOUCHES`); `/` and `/stats` serve from there.

- Deploy the Worker: `npx wrangler deploy`
- Run a sync now: `gh workflow run sync-vouches.yml`
