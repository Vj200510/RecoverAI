/**
 * GET /api/ready
 *
 * Readiness probe — tests actual Supabase and PayPal connectivity.
 * Returns HTTP 200 when all critical services are reachable.
 * Returns HTTP 503 when any critical service is unavailable.
 *
 * Use this for monitoring and alerts. Use /api/health as the Render
 * liveness check (always returns 200 so the process isn't killed during startup).
 *
 * Never exposes secret values — only status strings.
 */

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/ready")({
  component: () => null,

  server: {
    handlers: {
      GET: async () => {
        type ServiceStatus =
          | "connected"
          | "invalid_credentials"
          | "not_configured"
          | "unavailable";

        // ── Supabase ──────────────────────────────────────────────────────────
        let supabaseStatus: ServiceStatus = "not_configured";
        const supabaseUrl = process.env["SUPABASE_URL"];
        const supabaseKey = process.env["SUPABASE_ANON_KEY"];

        if (supabaseUrl && supabaseKey) {
          try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 8000);
            // auth/v1/settings returns HTTP 200 with a valid anon key
            const res = await fetch(`${supabaseUrl}/auth/v1/settings`, {
              headers: { apikey: supabaseKey, Accept: "application/json" },
              signal: controller.signal,
            }).finally(() => clearTimeout(timer));

            if (res.ok) supabaseStatus = "connected";
            else if (res.status === 401) supabaseStatus = "invalid_credentials";
            else supabaseStatus = "unavailable";
          } catch {
            supabaseStatus = "unavailable";
          }
        }

        // ── PayPal ────────────────────────────────────────────────────────────
        type PayPalStatus =
          | "sandbox_connected"
          | "live_connected"
          | "not_configured"
          | "error";
        let paypalStatus: PayPalStatus = "not_configured";
        const hasPayPal =
          !!process.env["PAYPAL_CLIENT_ID"] && !!process.env["PAYPAL_CLIENT_SECRET"];
        const paypalBase =
          process.env["PAYPAL_BASE_URL"] ?? "https://api-m.sandbox.paypal.com";

        if (hasPayPal) {
          try {
            const { checkPayPalConnectivity } = await import("@/lib/paypal.server");
            const result = await checkPayPalConnectivity();
            paypalStatus = result.connected
              ? paypalBase.includes("sandbox")
                ? "sandbox_connected"
                : "live_connected"
              : "error";
          } catch {
            paypalStatus = "error";
          }
        }

        // ── Readiness decision ────────────────────────────────────────────────
        const supabaseReady = supabaseStatus === "connected";
        const paypalReady =
          paypalStatus === "sandbox_connected" || paypalStatus === "live_connected";

        const ready = supabaseReady; // Supabase is critical; PayPal is required for payments only
        const httpStatus = ready ? 200 : 503;

        return new Response(
          JSON.stringify({
            ready,
            timestamp: new Date().toISOString(),
            services: {
              supabase: supabaseStatus,
              paypal: paypalStatus,
            },
            checks: {
              database: supabaseReady,
              payments: paypalReady,
            },
          }),
          {
            status: httpStatus,
            headers: { "Content-Type": "application/json" },
          },
        );
      },
    },
  },
});
