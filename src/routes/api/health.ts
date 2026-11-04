/**
 * GET /api/health
 *
 * Returns application health for Render health checks and monitoring.
 * Tests actual service connectivity — not just env var presence.
 * Never exposes secrets, credentials, or infrastructure details.
 */

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/health")({
  component: () => null,

  server: {
    handlers: {
      GET: async () => {
        const uptime = process.uptime();
        const env = process.env["NODE_ENV"] ?? "development";

        // ── 1. Supabase connectivity (actual DB ping, not just env check) ──────
        let supabaseStatus: "connected" | "not_configured" | "error" = "not_configured";
        const supabaseUrl = process.env["SUPABASE_URL"];
        const supabaseKey = process.env["SUPABASE_ANON_KEY"];

        if (supabaseUrl && supabaseKey) {
          try {
            // Lightweight REST ping — checks the Supabase API responds.
            // Uses a short timeout so the health endpoint responds quickly.
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 3000);
            const res = await fetch(`${supabaseUrl}/rest/v1/`, {
              headers: { apikey: supabaseKey },
              signal: controller.signal,
            }).finally(() => clearTimeout(timer));
            // 200 OK = authed, 400 = malformed but alive, 401 = wrong key but alive
            supabaseStatus =
              res.ok || res.status === 400 || res.status === 401 ? "connected" : "error";
          } catch {
            supabaseStatus = "error";
          }
        }

        // ── 2. PayPal connectivity (actual OAuth token request) ───────────────
        let paypalStatus: "sandbox_connected" | "live_connected" | "not_configured" | "error" =
          "not_configured";
        const paypalClientId = process.env["PAYPAL_CLIENT_ID"];
        const paypalSecret = process.env["PAYPAL_CLIENT_SECRET"];
        const paypalBase =
          process.env["PAYPAL_BASE_URL"] ?? "https://api-m.sandbox.paypal.com";

        if (paypalClientId && paypalSecret) {
          try {
            const { checkPayPalConnectivity } = await import("@/lib/paypal.server");
            const result = await checkPayPalConnectivity();
            if (result.connected) {
              paypalStatus = paypalBase.includes("sandbox")
                ? "sandbox_connected"
                : "live_connected";
            } else {
              paypalStatus = "error";
            }
          } catch {
            paypalStatus = "error";
          }
        }

        // ── 3. Overall status ─────────────────────────────────────────────────
        const allCriticalOk = supabaseStatus === "connected";
        const status = allCriticalOk ? "ok" : "degraded";

        return new Response(
          JSON.stringify({
            status,
            app: "RecoverAI",
            version: "1.0.0",
            environment: env,
            uptime_seconds: Math.round(uptime),
            timestamp: new Date().toISOString(),
            services: {
              supabase: supabaseStatus,
              paypal: paypalStatus,
            },
          }),
          {
            status: 200, // Always 200 so Render health check passes during startup
            headers: { "Content-Type": "application/json" },
          },
        );
      },
    },
  },
});
