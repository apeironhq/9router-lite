# 9Router on Vercel (Neon or Supabase PostgreSQL)

Vercel Functions have no persistent disk, so a local SQLite file would lose
provider connections, API keys, combos and settings whenever a function is
recycled. On Vercel this copy stores everything in PostgreSQL instead. Neon is
the recommended free option; Supabase works too.

## Configure

1. Import this repository as a Next.js project in Vercel.
2. Add a database:
   - **Neon (recommended):** in the Vercel project open **Storage → Create
     Database → Neon** and connect it to the project. Vercel sets
     `DATABASE_URL` (and related variables) automatically. Neon certificates are
     publicly trusted, so the default `POSTGRES_SSL=verify` works as is.
   - **Supabase:** copy the **Transaction pooler** URI from the dashboard's
     **Connect** dialog into `POSTGRES_URL`. Supabase signs its certificates
     with its own CA: download it (Project Settings → Database → SSL
     configuration) and put the PEM text in `POSTGRES_CA_CERT`, writing line
     breaks as `\n` if the field is single-line. A Supabase management token
     (`sbp_...`) is not a connection string.
3. Set the remaining environment variables:

   | Variable | Value |
   |---|---|
   | `JWT_SECRET` | long random value (dashboard sessions) |
   | `INITIAL_PASSWORD` | first dashboard login password |
   | `API_KEY_SECRET`, `MACHINE_ID_SALT` | stable, independent random values |
   | `REQUIRE_API_KEY` | `true` — the `/v1` API is public on Vercel |
   | `TRUST_PROXY` | `true` — Vercel overwrites `X-Forwarded-For`, so login rate limiting can key on the real client IP |

4. Deploy. Tables are created in the database on first access. Existing local
   SQLite data is not copied automatically; export a backup from the old
   instance and import it through the dashboard database settings.

### Database variables

| Variable | Meaning |
|---|---|
| `POSTGRES_URL` / `DATABASE_URL` | Connection string. Either one enables PostgreSQL; without both, local runs keep SQLite and Vercel refuses to start. |
| `POSTGRES_SSL` | `verify` (default): verify the certificate. `no-verify`: encrypt without verifying (last resort). `disable`: no TLS, local PostgreSQL only. |
| `POSTGRES_CA_CERT` | PEM CA used with `verify` (needed for Supabase). |

`sslmode` and other SSL parameters inside the URL are ignored on purpose, so
`POSTGRES_SSL` is the single setting that decides. Keep database credentials in
Vercel environment variables, never in source files or `NEXT_PUBLIC_` variables.

## Verify before production

- Log in, create a provider connection and an API key, redeploy, and confirm
  they persist.
- Call `/v1/models` and a streaming `/v1/chat/completions` request with the
  API key; check provider selection, fallback, and usage statistics.
- Test OAuth token refresh for each provider account you intend to use.

## Limits on Vercel

- Functions have a finite duration (300 s by default with Fluid compute) and a
  4.5 MB request/response payload limit. Text streaming works; large inline
  images, audio or video may exceed the limit.
- Features that change the machine running the server — local CLI
  configuration, DNS/MITM, Tailscale/Cloudflare tunnels, browser-based web
  providers and managed background processes — do not run on Vercel. Providers
  that use an API key (Groq, Gemini, OpenRouter, …) work normally.
- Buffered request-detail logs may be dropped when a function is frozen; usage
  statistics are written immediately.
- Neon's free compute suspends when idle, so the first request after a quiet
  period is slower.
- Every cold start checks the schema with several round trips, so keep the
  Vercel function region next to the database (Neon `us-east-1` → Vercel
  `iad1`, the default). Across continents the first request can take ~20 s.
