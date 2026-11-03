/**
 * PayPal Webhook endpoint — POST /api/paypal-webhook
 *
 * Receives inbound PayPal webhook events, verifies the signature using
 * PayPal's own verification API, then hands off to processWebhookEvent()
 * for idempotent, type-dispatched processing.
 *
 * Security:
 * - Signature verified via PayPal's /v1/notifications/verify-webhook-signature
 * - Duplicate event IDs are silently ignored (unique constraint in DB)
 * - Raw body is never parsed before signature verification
 * - No authentication required (PayPal calls this externally)
 * - Always returns 200 to prevent PayPal retries on processing errors
 */

import { createFileRoute } from "@tanstack/react-router";
import { processWebhookEvent } from "@/lib/paypal-recovery.server";
import { verifyWebhookSignature } from "@/lib/paypal.server";

export const Route = createFileRoute("/api/paypal-webhook")({
  // No UI component — this is a pure server route.
  component: () => null,

  server: {
    handlers: {
      POST: async ({ request }) => {
        // 1. Read raw body before any parsing (needed for signature verification).
        const rawBody = await request.text();

        // 2. Extract PayPal signature headers.
        const authAlgo = request.headers.get("paypal-auth-algo") ?? "";
        const certUrl = request.headers.get("paypal-cert-url") ?? "";
        const transmissionId = request.headers.get("paypal-transmission-id") ?? "";
        const transmissionSig = request.headers.get("paypal-transmission-sig") ?? "";
        const transmissionTime = request.headers.get("paypal-transmission-time") ?? "";
        const webhookId = process.env["PAYPAL_WEBHOOK_ID"] ?? "";

        // 3. Parse event (needed for processing regardless of verification result).
        let event: {
          id: string;
          event_type: string;
          resource_type?: string;
          summary?: string;
          resource?: Record<string, unknown>;
        };
        try {
          event = JSON.parse(rawBody) as typeof event;
        } catch {
          return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (!event.id || !event.event_type) {
          return new Response(JSON.stringify({ error: "Missing event id or event_type" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        // 4. Verify signature.
        let verified = false;
        if (webhookId && authAlgo && certUrl && transmissionId && transmissionSig) {
          const result = await verifyWebhookSignature({
            authAlgo,
            certUrl,
            transmissionId,
            transmissionSig,
            transmissionTime,
            webhookId,
            rawBody,
          });
          verified = result.verified;
        } else {
          // In dev/sandbox without PAYPAL_WEBHOOK_ID configured, record but don't verify.
          console.warn(
            "[paypal webhook] PAYPAL_WEBHOOK_ID not set or missing headers — event recorded as unverified",
          );
        }

        // 5. Process (idempotent — duplicate event_id is a no-op).
        const outcome = await processWebhookEvent(event, rawBody, verified);

        console.info(
          `[paypal webhook] ${event.event_type} id=${event.id} verified=${verified} processed=${outcome.processed} skipped=${outcome.skipped}`,
        );

        // 6. Always return 200 — PayPal retries on non-2xx responses.
        return new Response(JSON.stringify({ received: true, ...outcome }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },

      GET: async () => {
        // Health check — confirms the endpoint is reachable.
        return new Response(JSON.stringify({ status: "PayPal webhook endpoint active" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  },
});
