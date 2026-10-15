// daup-duidelik — /d/hub route (DAUP-PORT-PLAN §4)
//
// The Hub links a user in with a single-use `houseRedeem` on the query string:
//   https://duidelik.daup.co.za/d/hub?emailHint=…&houseHint=…&placeIdHint=…&houseRedeem=hr_…
// This component:
//   1. reads houseRedeem (+ hints, incl. a runtime seed-origin hint, O3) from the URL;
//   2. POSTs it to {seed}/house/session/redeem via the receiving client (api/houseSession);
//   3. on success → lifts { placeId, peerId, phone, bearer, expiresAt, seedOrigin } to the
//      app, strips the query, and routes to the registry for that place;
//   4. on 401/403/any error → fails CLOSED: a "re-open from the Hub" state. duidelik
//      never mints its own session.
//
// The seed origin is RUNTIME-configurable (O3): a `seedHint`/`seed` query param wins over
// the baked VITE_HOUSE_SEED_URL default, so one Cloudflare build serves every node.

import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { redeemHouseSession, normalizeSeedOrigin } from "../api/houseSession";
import type { HouseSession } from "../context/SessionContext";

const BAKED_SEED_DEFAULT = "https://mcp.daup.co.za";

function resolveSeedOrigin(params: URLSearchParams): string {
  // O3: a runtime hint from the /d/hub handoff wins over the build-time constant.
  const hint = params.get("seedHint") || params.get("seed") || params.get("seedOrigin");
  const fromHint = normalizeSeedOrigin(hint);
  if (fromHint) return fromHint;
  const fromEnv = normalizeSeedOrigin(import.meta.env.VITE_HOUSE_SEED_URL as string | undefined);
  if (fromEnv) return fromEnv;
  return BAKED_SEED_DEFAULT;
}

type Phase = { kind: "redeeming" } | { kind: "error"; message: string };

export function HubRedeem({ onSession }: { onSession: (s: HouseSession) => void }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>({ kind: "redeeming" });
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return; // single-use redeem: never fire twice (StrictMode-safe)
    ran.current = true;

    const houseRedeem = params.get("houseRedeem");
    if (!houseRedeem) {
      setPhase({ kind: "error", message: "No redeem token in the link. Please re-open duidelik from the Hub." });
      return;
    }
    const seedOrigin = resolveSeedOrigin(params);

    (async () => {
      const res = await redeemHouseSession({ seedOrigin, houseRedeem });
      if (!res.ok) {
        // Fail CLOSED (step 4). Do not fall back to a session here — the standalone
        // fallback is for a DIRECT hit with no houseRedeem, not a FAILED redeem.
        setPhase({ kind: "error", message: res.error || "Session could not be redeemed." });
        return;
      }
      const session: HouseSession = {
        mode: "house",
        placeId: res.placeId,
        peerId: res.peerId,
        phone: res.phone,
        bearer: res.bearer,
        expiresAt: res.expiresAt,
        seedOrigin,
      };
      onSession(session);
      // Strip the (single-use, now-spent) query and route to the registry.
      navigate("/", { replace: true });
    })();
  }, [params, navigate, onSession]);

  return (
    <div className="screen du-root">
      <div className="brand-strip" />
      <div className="screen__body">
        <h1 className="wordmark">
          duidelik<span className="dot">.</span>
        </h1>
        {phase.kind === "redeeming" ? (
          <p className="lead">Signing you in from the Hub…</p>
        ) : (
          <div className="card card--dashed" style={{ maxWidth: 520, marginTop: "16px" }}>
            <div className="eyebrow eyebrow--muted" style={{ marginBottom: "8px" }}>
              Session required
            </div>
            <div className="sign-reason sign-reason--red" style={{ marginBottom: "10px" }}>
              {phase.message}
            </div>
            <div className="rigour-gate__sub">
              duidelik does not run its own sign-in — open it from the daup Hub, which issues the session.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
