/**
 * GET /api/health
 *
 * Tests actual service connectivity.
 * Returns a structured status without exposing any secret values.
 *
 * Supabase status values:
 *   connected          — REST API responded with a valid schema response
 *   invalid_credentials — REST API responded 401 (anon key is wrong)
 *   not_configured     — SUPABASE_URL or SUPABASE_ANON_KEY not set
 *   unavailable        — network timeout or non-2xx/4xx response
 *
 * PayPal status values:
 *   sandbox_connected  — OAuth token obtained from sandbox
 *   live_connected     — OAuth token obtained from live API
 *   not_configured     — PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET not set
 *   error              — OAuth attempt failed
 *
 * HTTP status is always 200 so Render's health check passes during cold start.
 * Check the "status" field in the body: "ok" | "degraded".
 */

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/health")({
  component: () => null,

  server: {
    handlers: {
      GET: async () => {
        const uptime = process.uptime();
        const env = process.env["NODE_ENV"] ?? "development";

        // ── 1. Supabase — actual REST ping ────────────────────────────────────
        type SupabaseStatus =
          | "connected"
          | "invalid_credentials"
          | "not_configured"
          | "unavailable";
        let supabaseStatus: SupabaseStatus = "not_configured";

        const supabaseUrl = process.env["SUPABASE_URL"];
        const supabaseKey = process.env["SUPABASE_ANON_KEY"];

        if (supabaseUrl && supabaseKey) {
          try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 8000);
            // Use auth/v1/settings — returns HTTP 200 with the anon key.
            // The REST /rest/v1/ endpoint returns 401 even with a valid anon key
            // when no table is queried (schema cache response), causing false negatives.
            const res = await fetch(`${supabaseUrl}/auth/v1/settings`, {
              method: "GET",
              headers: { apikey: supabaseKey, Accept: "application/json" },
              signal: controller.signal,
            }).finally(() => clearTimeout(timer));

            if (res.ok) {
              supabaseStatus = "connected";
            } else if (res.status === 401) {
              supabaseStatus = "invalid_credentials";
            } else {
              supabaseStatus = "unavailable";
            }
          } catch {
            supabaseStatus = "unavailable";
          }
        }

        // ── 2. PayPal — actual OAuth attempt ─────────────────────────────────
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

        // ── 3. Overall status ─────────────────────────────────────────────────
        // "ok"      — all critical services connected
        // "degraded" — one or more services unavailable or misconfigured
        const isHealthy = supabaseStatus === "connected";
        const overallStatus = isHealthy ? "ok" : "degraded";

        return new Response(
          JSON.stringify({
            status: overallStatus,
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
            // Always HTTP 200 — Render reads body.status for health decisions.
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      },
    },
  },
});
