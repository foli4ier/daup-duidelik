# daup-duidelik

Producer-side data-product workbench for `duidelik.daup.co.za`. Register data
products and shepherd them through a governed lifecycle — one-liner → BRD → FSD →
QRG → Live (+ Glossary) — with an AI co-author on every document and a rigour gate
guarding every signature.

This is the **daup marketplace port** of duidelik v1: Vite + React + TypeScript,
served as a Cloudflare Worker, wired to the daup house session. It keeps duidelik's
own **Shoprite dark theme** (bundled in `src/theme/`) — it does **not** depend on
`daup-theme`.

## Local

Install dependencies, then start the Vite dev server and open the URL it prints
(usually port 5173):

```
npm install
npm run dev
```

The production build is `tsc -b` then Vite (`npm run build`); `npm run preview`
serves the `dist/` folder.

## Test

```
npm test          # vitest run — the governance engine (gates must block) + UI render
npm run typecheck # tsc -b, no emit
```

`test/core.test.ts` is the ported self-check: it proves the hard gate (no FSD until
the BRD is signed), the GATE S error contract, the stricter-wins rigour clamp,
signature immutability, and the invalidation cascade — before any UI exists.
`test/ui.test.tsx` renders the Registry and a Product across lifecycle states.

## Deploy (operator runbook)

Served as a **Cloudflare Worker** on `duidelik.daup.co.za` via **Workers Builds** —
the operator pushes `main`; CI runs the build and deploys. Agents never push or
deploy.

**One-time Cloudflare setup (operator):**
1. Create a Worker from the `foli4ier/daup-duidelik` repo (Workers Builds / Git
   integration), production branch `main`.
2. Build command `npm run build`, build output `dist/` (Vite emits there).
3. Add the custom domain `duidelik.daup.co.za` — already declared in `wrangler.json`
   (`routes[].custom_domain`), so Cloudflare provisions the route + cert on first deploy.
4. SPA routing is handled by `wrangler.json` `assets.not_found_handling =
   "single-page-application"` — any unknown path (e.g. `/d/hub`) is served `index.html`
   and the client router takes over. No `_redirects`/`_routes.json` needed.

**Deploy:** merge/push to `main` → Workers Builds runs `npm run build` and publishes
`dist/`. Verify live: `https://duidelik.daup.co.za/` loads the registry, and
`https://duidelik.daup.co.za/d/hub` returns the app shell (not a 404).

**Build-time env (Vite `VITE_*`):**
- `VITE_HOUSE_SEED_URL` — the fallback seed origin. **Optional**: the baked default
  `https://mcp.daup.co.za` lives in code (`src/hub/HubRedeem.tsx`), and the real seed
  origin is resolved at runtime from the `/d/hub` handoff hint (O3). Set this only to
  override the fallback for a specific build.
- `VITE_REQUIRE_HOUSE_SESSION` — **set to `true` for production** in `.env.production`
  (committed; it is a public flag, not a secret). The live site therefore **requires** a
  redeemed house session: a direct hit with no `/d/hub` handoff shows "open it from the
  Hub" rather than the standalone picker. Local `npm run dev` is unaffected
  (`.env.production` is build-only), so demos still run the standalone "acting as"
  fallback. To relax the live site, set it `false` in `.env.production` or the Workers
  Builds env.

**No secrets in the bundle.** The client holds no `HOUSE_SESSION_SECRET` and no model
key. The AI co-author transport (P5) is the Worker route `/ai/draft` + `/ai/score`
(`worker/index.ts`) with the model key held as a **Cloudflare secret** — never in the
static bundle.

**AI co-author (P5) — enabling it (operator):**
1. The Worker is wired: `wrangler.json` `main = worker/index.ts`, with the SPA served
   via the `ASSETS` binding; `/ai/*` runs server-side, everything else falls through to
   the static app.
2. Set the model key as a secret: `wrangler secret put AI_API_KEY` (OpenAI-compatible
   by default). Optional plain vars: `AI_API_URL`, `AI_MODEL`.
3. **No key set → the route returns 503**, the client's `aiClient` reads that as "AI
   unavailable", and the co-author shows its offline state while deterministic rigour
   runs unchanged. So the app is fully functional before the secret exists — adding the
   key simply turns the co-author on. Nothing to redeploy beyond the secret.

Do not commit `node_modules`, `dist`, or `.env*` (`.env.example` excepted).

## Architecture

- `src/core/` — the framework-agnostic governance engine (lifecycle state machine,
  GATE S signing, two-layer rigour, enums, errors, seed). Ported ~verbatim from the
  v1 app; JS→TS typing only. **This is the DB-swap seam** (STACK §5): a later server
  swap replaces persistence, not the engine.
- `src/api/persistence.ts` — the localStorage adapter, keyed by `placeId`
  (`duidelik.store.v1.<placeId>`) so each place has its own shared registry.
- `src/components/`, `src/pages/` — the React UI, wrapping the Shoprite classes in
  `src/theme/components.css` (no inline restyle).
- `src/context/` — `SessionContext` (placeId/peerId/phone) and `StoreContext`.

## SSO (house session)

duidelik never runs the OTP door and never holds `HOUSE_SESSION_SECRET`. It only
**receives** a session: the Hub hands off to `/d/hub?...&houseRedeem=hr_...`, the app
redeems it against the seed, and derives identity (`peerId`/`phone`/`placeId`). Role
(for the PO-only BRD sign gate) is **not** a session claim — duidelik owns a
per-place role roster. The seed origin is runtime-configurable (read from the `/d/hub`
handoff, falling back to the baked `mcp.daup.co.za`). See `docs/DAUP-PORT-PLAN.md`
§4–§5. **The SSO receiving side (P3) is wired**: `/d/hub` → `src/hub/HubRedeem.tsx` →
`src/api/houseSession.ts` (redeem, fail-closed, reject tainted/`token`/`role`
payloads), the per-place role roster in `src/core/roster.ts` (first redeemer bootstraps
PO; the BRD sign gate reads the roster, not the session), and the placeId-scoped store
(`duidelik.store.v1.<placeId>`). Phases built & verified: **P0–P3 + P5**. P4 is deploy
(operator push + Workers Builds). **P5 (AI co-author) is wired**: the Worker route
`/ai/draft` + `/ai/score` (`worker/index.ts`) holds the model key as a Cloudflare
secret and relays co-author drafts + rigour-score refinements; the client transport is
`src/api/aiTransport.ts`, injected as `window.duidelikModelCall` in `main.tsx`. With no
`AI_API_KEY` secret set the route returns 503 and the co-author degrades to its offline
state (deterministic rigour unaffected) — set the secret to turn it on.

## Data

The registry currently lives in the browser (memory + localStorage) behind the typed
adapter in `src/api/persistence.ts`. Swap that file for HTTP calls when the server
data layer is ready; the engine and UI are unchanged.
