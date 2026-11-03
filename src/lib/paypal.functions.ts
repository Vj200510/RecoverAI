/**
 * PayPal server functions — exposed to the client via TanStack Start.
 *
 * These are additive and do not modify any existing recoverai.functions.ts entries.
 * All functions use requireSupabaseAuth so every call is user-authenticated with RLS.
 * PayPal credentials (CLIENT_ID, CLIENT_SECRET) stay server-side only.
 */

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// ─── Connectivity check ───────────────────────────────────────────────────────

export const checkPayPalStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { checkPayPalConnectivity } = await import("./paypal.server");
    return checkPayPalConnectivity();
  });

// ─── Dashboard stats ──────────────────────────────────────────────────────────

export const getPayPalStats = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { loadPayPalStats } = await import("./paypal-recovery.server");
    return loadPayPalStats(context.supabase, context.userId);
  });

// ─── Create recovery order ────────────────────────────────────────────────────

export const createPayPalRecoveryOrder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    z.object({
      // Accept the visible transaction_ref (e.g. TXN-20260823-10001) — easier for the user
      // than copying a UUID. The server looks up the internal ID securely.
      transactionRef: z.string().min(1).max(200),
      baseUrl: z.string().url().max(200),
    }),
  )
  .handler(async ({ data, context }) => {
    const { createRecoveryOrder } = await import("./paypal-recovery.server");
    const { fail } = await import("./db.server");

    // Look up the internal UUID from the visible reference — never trust client-supplied IDs.
    const { data: tx, error } = await context.supabase
      .from("transactions")
      .select("id")
      .eq("transaction_ref", data.transactionRef)
      .eq("user_id", context.userId)
      .maybeSingle();

    if (error || !tx) {
      fail(`Transaction "${data.transactionRef}" not found. Copy the reference exactly from the Transactions page.`);
    }

    return createRecoveryOrder(context.supabase, context.userId, tx!.id, data.baseUrl);
  });

// ─── Capture approved order ───────────────────────────────────────────────────

export const capturePayPalRecoveryOrder = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(
    z.object({
      paypalOrderId: z.string().min(1).max(100),
    }),
  )
  .handler(async ({ data, context }) => {
    const { captureRecoveryOrder } = await import("./paypal-recovery.server");
    return captureRecoveryOrder(context.supabase, context.userId, data.paypalOrderId);
  });

// ─── Get live PayPal order status ─────────────────────────────────────────────

export const getPayPalOrderStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ paypalOrderId: z.string().min(1).max(100) }))
  .handler(async ({ data }) => {
    const { getPayPalOrder } = await import("./paypal.server");
    return getPayPalOrder(data.paypalOrderId);
  });
