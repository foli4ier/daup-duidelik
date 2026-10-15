# daup-duidelik — Operator Push & Deploy Checklist

One page, start to finish. duidelik is a **static SPA + a thin Worker** served by
Cloudflare on `duidelik.daup.co.za`. You push `main`; Cloudflare **Workers Builds**
runs the build and deploys. The app was built and verified locally through P0–P5; the
only things that are yours are the push, the Cloudflare wiring, and two secrets.

Target repo: **`foli4ier/daup-duidelik`**.

---

## 0. Before you push (sanity, ~2 min)

Run locally once to confirm the tree is green (needs Node 18+ / npm):

```
cd daup-duidelik
npm install
npm run typecheck   # tsc -b — expect no output, exit 0
npm test            # vitest — expect "31 passed"
npm run build       # tsc -b && vite build — expect dist/ written, no errors
```

If any of these fail, STOP and hand back — do not deploy a red tree.

Confirm nothing secret is staged:
```
git status            # .env, node_modules, dist must NOT appear
git check-ignore .env dist node_modules   # should echo all three (they're ignored)
```
`.env.production` **is** tracked on purpose — it holds only the public flag
`VITE_REQUIRE_HOUSE_SESSION=true` (no secret). That is correct; let it commit.

---

## 1. Push `main`

```
git add -A
git commit -m "duidelik daup port: P0–P5 (scaffold, core, UI, SSO, deploy, AI route)"
git push origin main
```

(First time only: `git remote add origin git@github.com:foli4ier/daup-duidelik.git`.)

---

## 2. Cloudflare Workers Builds — one-time setup

In the Cloudflare dashboard → **Workers & Pages → Create → Connect to Git**:

1. Repo `foli4ier/daup-duidelik`, production branch **`main`**.
2. **Build command:** `npm run build`
3. **Deploy command / output:** Wrangler reads `wrangler.json` — leave the default
   Workers Builds flow (it runs `wrangler deploy`). Build output is `dist/`.
4. `wrangler.json` already declares everything else:
   - `main: worker/index.ts` — the Worker (serves `/ai/*`, falls through to the SPA).
   - `assets.directory: ./dist`, `assets.binding: ASSETS`,
     `assets.not_found_handling: single-page-application` — static app + SPA fallback.
   - `routes[].pattern: duidelik.daup.co.za` + `custom_domain: true` — Cloudflare
     provisions the route + TLS cert on first deploy.

No `_redirects`, `_routes.json`, or extra config needed.

---

## 3. Secrets & vars (set on the Worker, never in the repo)

| Name | Type | Required? | Purpose |
|------|------|-----------|---------|
| `AI_API_KEY` | **secret** | optional | Turns the AI co-author ON. `wrangler secret put AI_API_KEY` (or dashboard → Settings → Variables → Encrypt). OpenAI-compatible key. |
| `AI_API_URL` | plain var | optional | Override the model endpoint (default `https://api.openai.com/v1/chat/completions`). |
| `AI_MODEL` | plain var | optional | Override the model (default `gpt-4o-mini`). |

**If you set no `AI_API_KEY`:** the app still works fully — the `/ai/*` route returns
503, the co-author shows its "unavailable" state, and the rigour gate runs on its
deterministic checks. Add the key later to switch the co-author on; nothing else to
redeploy.

**Do NOT set** `HOUSE_SESSION_SECRET` here — duidelik never holds it. The house
session is minted by the seed/Hub, not by this app.

---

## 4. Verify live (after the first deploy goes green)

- [ ] `https://duidelik.daup.co.za/` loads and shows the **"open it from the Hub"**
      state — NOT the registry. (Production is house-session-strict:
      `VITE_REQUIRE_HOUSE_SESSION=true`. A bare visit with no handoff is *meant* to be
      gated. If you see the registry/acting-as picker, strict mode did not bake — check
      `.env.production` committed.)
- [ ] A real Hub handoff — open duidelik from the Hub so it lands on
      `https://duidelik.daup.co.za/d/hub?...&houseRedeem=hr_...` — redeems and routes
      into that place's registry. (The redeem is single-use, ~60s TTL.)
- [ ] A deep link like `https://duidelik.daup.co.za/anything` returns the app shell,
      not a 404 (SPA fallback working).
- [ ] If `AI_API_KEY` is set: open a product, create a BRD, click the AI co-author —
      it drafts. If not set: the co-author shows "unavailable" (expected).
- [ ] First person to redeem into a place becomes **Product Owner**; confirm they can
      reach the BRD sign gate and a second (non-PO) redeemer cannot sign a BRD.

---

## 5. Rollback

Workers Builds keeps every deployment. To revert: Cloudflare dashboard → the Worker →
**Deployments** → pick the previous good one → **Rollback**. Or push a revert commit to
`main` and let Builds redeploy. The custom domain and secrets are unaffected by a
rollback.

---

## Notes / known limits (v1)

- **Sharing is logical, not yet live-concurrent.** The registry is keyed per `placeId`
  (`duidelik.store.v1.<placeId>`) but persists in the browser's localStorage, so "shared
  per place" is true per-browser until the data layer swaps to the server/DB backend
  (localised to `src/api/persistence.ts` + `src/core/store.ts`). One user per place
  behaves correctly today.
- **The AI route is OpenAI-compatible.** If your model provider differs, set `AI_API_URL`
  / `AI_MODEL`; if its request/response shape differs from the chat-completions format,
  that's a small edit to `callModel()` in `worker/index.ts` — raise it, don't guess.
- Phases built & verified locally: **P0 scaffold · P1 core (gates block) · P2 UI · P3
  house-session SSO · P4 this deploy · P5 AI route**. See `README.md` and
  `../docs/DAUP-PORT-PLAN.md` for the full rationale.
