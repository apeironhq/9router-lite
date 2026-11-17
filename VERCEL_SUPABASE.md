# 9Router on Vercel with Supabase

This copy is a work in progress for running the AI router and dashboard on
Vercel with Supabase PostgreSQL instead of a local SQLite file. Do not deploy
it as production until the live database and API checks below pass.

## Configure

1. Import this directory as a Next.js project in Vercel.
2. Connect a Supabase project through the Vercel Marketplace, or copy the
   **Transaction pooler** URI from the Supabase dashboard's **Connect** dialog.
   Set it as the server-only `POSTGRES_URL` environment variable in Vercel.
   A Supabase management personal access token (`sbp_...`) is not a database
   connection string and must never be used as `POSTGRES_URL`.
3. Set `JWT_SECRET` to a long random value and set `INITIAL_PASSWORD` for the
   first dashboard login. Set `API_KEY_SECRET` and `MACHINE_ID_SALT` to stable,
   independent random values. Set `REQUIRE_API_KEY=true` for the public AI API.
4. Deploy. The application creates its tables in the selected PostgreSQL
   database on first access. Existing local SQLite data is not transferred
   automatically; export it from the old instance and import it through the
   dashboard database settings after deploying.

The PostgreSQL adapter activates only when `POSTGRES_URL` or `DATABASE_URL` is
set. Local development without either variable keeps the original SQLite
adapter. Keep database credentials in Vercel environment variables, never in
source files or `NEXT_PUBLIC_` variables.

## Verify before production

- Log in, create a provider connection and an API key, then reload and confirm
  they persist.
- Call `/v1/models` and a streaming `/v1/chat/completions` request with the
  API key; check provider selection, fallback, and usage statistics.
- Test importing a backup from the old SQLite instance if migration is needed.
- Test OAuth token refresh for each provider account you intend to use.

Vercel Functions have a finite request duration and a 4.5 MB request/response
payload limit. Large inline images, audio, or video payloads may exceed that
limit even though text streaming works. Features that modify the machine
running the server (local CLI configuration, DNS/MITM, Tailscale/Cloudflare
tunnels, and managed background processes) cannot run unchanged in Vercel
Functions. The Vercel startup path does not start those processes.
