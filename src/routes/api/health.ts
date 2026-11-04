/**
 * GET /api/health
 *
 * Returns application health status for Render health checks and monitoring.
 * Never exposes secrets, credentials, or internal infrastructure details.
 */

import { createFileRoute } from "@tanstack/react-router";
import { checkPayPalConnectivity } from "@/lib/paypal.server";

export const Route = createFileRoute("/api/health")({
  component: () => null,

  server: {
    handlers: {
      GET: async () => {
        const startedAt = new Date().toISOString();
        const uptime = process.uptime();

        // Check PayPal config (no credentials exposed — just connected/not)
        let paypalStatus = "not_configured";
        const hasPayPalCreds =
          !!process.env["PAYPAL_CLIENT_ID"] && !!process.env["PAYPAL_CLIENT_SECRET"];
        if (hasPayPalCreds) {
          try {
            const result = await checkPayPalConnectivity();
            paypalStatus = result.connected
              ? result.sandbox
                ? "sandbox_connected"
                : "live_connected"
              : "unreachable";
          } catch {
            paypalStatus = "error";
          }
        }

        // Check Supabase config (existence only — no values exposed)
        const supabaseConfigured =
          !!process.env["SUPABASE_URL"] && !!process.env["SUPABASE_ANON_KEY"];

        const health = {
          status: "ok",
          app: "RecoverAI",
          version: "1.0.0",
          environment: process.env["NODE_ENV"] ?? "development",
          uptime_seconds: Math.round(uptime),
          timestamp: startedAt,
          services: {
            supabase: supabaseConfigured ? "configured" : "not_configured",
            paypal: paypalStatus,
          },
        };

        return new Response(JSON.stringify(health), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  },
});
