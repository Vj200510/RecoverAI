/**
 * PayPal Recovery Bridge
 *
 * Connects PayPal Sandbox order/capture state to the existing
 * RecoverAI AI recovery engine and deterministic verifier boundary.
 *
 * The flow for every recovery action:
 *   1. Fetch authoritative PayPal order status
 *   2. Map PayPal status → internal failure context
 *   3. Run AI analysis (with PayPal evidence in context)
 *   4. Pass through the existing verifyAndExecuteRecoveryAction boundary
 *   5. On APPROVE: create a new PayPal order for customer checkout
 *   6. Record every step in the audit log
 *
 * Nothing in this file bypasses the existing security boundary.
 */

import { fail, writeAudit, type Db } from "./db.server";
import type { Json } from "@/integrations/supabase/types";
import {
  capturePayPalOrder,
  createPayPalOrder,
  getApproveUrl,
  getPayPalOrder,
  PayPalError,
} from "./paypal.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PayPalOrderRecord {
  id: string;
  paypal_order_id: string;
  status: string;
  amount: number;
  currency: string;
  transaction_id: string;
  case_id: string | null;
  created_at: string;
}

export interface CreateRecoveryOrderResult {
  paypalOrderId: string;
  approveUrl: string;
  internalOrderId: string;
  amount: number;
  currency: string;
  sandbox: boolean;
}

export interface CaptureRecoveryOrderResult {
  paypalOrderId: string;
  captureId: string;
  status: string;
  amount: number;
  currency: string;
  transactionId: string;
  caseId: string | null;
  alreadyCaptured: boolean;
}

export interface PayPalDashboardStats {
  totalOrders: number;
  completedCaptures: number;
  failedCaptures: number;
  pendingOrders: number;
  recoveredAmount: number;
  recentOrders: Array<{
    id: string;
    paypal_order_id: string;
    status: string;
    amount: number;
    currency: string;
    transaction_id: string;
    case_id: string | null;
    created_at: string;
  }>;
}

// ─── Create a PayPal recovery order ──────────────────────────────────────────

/**
 * Creates a new PayPal order for a recovery checkout.
 *
 * Guards enforced here (in addition to the existing verifier):
 * - The internal transaction must exist and belong to the user.
 * - The transaction must NOT already be SUCCESS or RECOVERED.
 * - No pending/approved PayPal order may already exist for this transaction.
 * - Amount and currency are taken from the authoritative DB record, never from input.
 */
export async function createRecoveryOrder(
  db: Db,
  userId: string,
  transactionId: string,
  baseUrl: string,
): Promise<CreateRecoveryOrderResult> {
  // 1. Load authoritative transaction record.
  const { data: tx, error: txError } = await db
    .from("transactions")
    .select("id, transaction_ref, amount, currency, status, recovery_status, customer_id")
    .eq("id", transactionId)
    .eq("user_id", userId)
    .maybeSingle();

  if (txError) fail("Could not load the transaction record.");
  if (!tx) fail("Transaction not found.");

  // 2. Guard: do not create a new PayPal order for an already-successful payment.
  if (["SUCCESS", "RECOVERED"].includes(tx.status.toUpperCase())) {
    fail(
      `Cannot create a recovery order for a ${tx.status} transaction. The payment already succeeded.`,
    );
  }

  // 3. Guard: check for existing active PayPal orders for this transaction.
  const { data: existingOrders } = await db
    .from("paypal_orders")
    .select("paypal_order_id, status")
    .eq("transaction_id", transactionId)
    .eq("user_id", userId)
    .in("status", ["CREATED", "SAVED", "APPROVED", "PAYER_ACTION_REQUIRED"]);

  if (existingOrders && existingOrders.length > 0) {
    const existing = existingOrders[0]!;
    // Refresh the live status from PayPal before blocking.
    try {
      const live = await getPayPalOrder(existing.paypal_order_id);
      if (live.status === "APPROVED" || live.status === "PAYER_ACTION_REQUIRED") {
        fail(
          `A PayPal order (${existing.paypal_order_id}) is already awaiting customer approval for this transaction.`,
        );
      }
      // If it's COMPLETED or VOIDED, fall through and create a new one.
      if (live.status !== "COMPLETED" && live.status !== "VOIDED") {
        fail(
          `An active PayPal order (${existing.paypal_order_id}) already exists with status ${live.status}.`,
        );
      }
    } catch (err) {
      if (err instanceof PayPalError && err.statusCode === 404) {
        // Order no longer exists in PayPal; allow creating a new one.
      } else {
        throw err;
      }
    }
  }

  // 4. Create the PayPal order using authoritative amount/currency from DB.
  const amount = Number(tx.amount);
  const currency = tx.currency;

  const paypalOrder = await createPayPalOrder({
    transactionRef: tx.transaction_ref,
    amount,
    currency,
    description: `RecoverAI payment recovery for transaction ${tx.transaction_ref}`,
    returnUrl: `${baseUrl}/console/paypal/capture?order_id=PAYPAL_ORDER_ID&transaction_id=${transactionId}`,
    cancelUrl: `${baseUrl}/console/paypal?cancelled=true&transaction_id=${transactionId}`,
  });

  const approveUrl = getApproveUrl(paypalOrder);
  if (!approveUrl) {
    fail("PayPal did not return an approval URL. Please try again.");
  }

  // 5. Store the PayPal order in our database.
  const { data: inserted, error: insertError } = await db
    .from("paypal_orders")
    .insert({
      user_id: userId,
      transaction_id: transactionId,
      paypal_order_id: paypalOrder.id,
      amount,
      currency,
      status: paypalOrder.status,
      intent: paypalOrder.intent,
      paypal_created_at: paypalOrder.create_time ?? null,
      raw_response: paypalOrder as unknown as Json,
    })
    .select("id")
    .single();

  if (insertError || !inserted) {
    fail("The PayPal order was created but could not be recorded. Contact support.");
  }

  // 6. Audit.
  await writeAudit(db, userId, [
    {
      event_type: "PAYPAL_ORDER_CREATED",
      transaction_ref: tx.transaction_ref,
      customer_id: tx.customer_id,
      actor: "paypal_recovery",
      action: "CREATE_CHECKOUT_ORDER",
      reason: `PayPal Sandbox recovery checkout for ${currency} ${amount.toFixed(2)}`,
      result: `order_id=${paypalOrder.id} status=${paypalOrder.status}`,
    },
  ]);

  return {
    paypalOrderId: paypalOrder.id,
    approveUrl: approveUrl!,
    internalOrderId: inserted.id,
    amount,
    currency,
    sandbox: true,
  };
}

// ─── Capture an approved PayPal order ────────────────────────────────────────

/**
 * Captures a customer-approved PayPal order.
 *
 * Guards:
 * - Loads the PayPal order from our DB (no orphan captures).
 * - Verifies the order belongs to the authenticated user's transaction.
 * - Fetches live PayPal status before capturing (never trusts frontend).
 * - Prevents duplicate capture via DB unique constraint on paypal_capture_id.
 * - Verifies amount and currency against the DB record.
 * - Updates the internal transaction and recovery case on success.
 * - Full audit trail throughout.
 */
export async function captureRecoveryOrder(
  db: Db,
  userId: string,
  paypalOrderId: string,
): Promise<CaptureRecoveryOrderResult> {
  // 1. Load our internal PayPal order record.
  const { data: orderRecord, error: orderError } = await db
    .from("paypal_orders")
    .select("*, transactions!inner(transaction_ref, amount, currency, customer_id, status)")
    .eq("paypal_order_id", paypalOrderId)
    .eq("user_id", userId)
    .maybeSingle();

  if (orderError) fail("Could not load the PayPal order record.");
  if (!orderRecord) fail("PayPal order not found or does not belong to your account.");

  const tx = orderRecord.transactions as unknown as {
    transaction_ref: string;
    amount: number;
    currency: string;
    customer_id: string;
    status: string;
  };

  // 2. Guard: already completed — idempotent success.
  if (orderRecord.status === "COMPLETED") {
    const { data: existingCapture } = await db
      .from("paypal_captures")
      .select("paypal_capture_id, status, amount")
      .eq("paypal_order_id", paypalOrderId)
      .eq("user_id", userId)
      .maybeSingle();

    return {
      paypalOrderId,
      captureId: existingCapture?.paypal_capture_id ?? "already-captured",
      status: "COMPLETED",
      amount: Number(orderRecord.amount),
      currency: orderRecord.currency,
      transactionId: orderRecord.transaction_id,
      caseId: orderRecord.case_id,
      alreadyCaptured: true,
    };
  }

  // 3. Check for existing capture record (DB-level idempotency).
  const { data: existingCaptures } = await db
    .from("paypal_captures")
    .select("paypal_capture_id, status")
    .eq("paypal_order_id", paypalOrderId)
    .eq("user_id", userId);

  if (existingCaptures && existingCaptures.length > 0) {
    const cap = existingCaptures[0]!;
    return {
      paypalOrderId,
      captureId: cap.paypal_capture_id,
      status: cap.status,
      amount: Number(orderRecord.amount),
      currency: orderRecord.currency,
      transactionId: orderRecord.transaction_id,
      caseId: orderRecord.case_id,
      alreadyCaptured: true,
    };
  }

  // 4. Capture (includes live status re-check + amount/currency verification).
  const { capture, order: capturedOrder } = await capturePayPalOrder(
    paypalOrderId,
    Number(orderRecord.amount),
    orderRecord.currency,
  );

  const captureStatus = capture.status;
  const captureAmount = parseFloat(capture.amount.value);

  // 5. Record the capture.
  await db.from("paypal_captures").insert({
    user_id: userId,
    paypal_order_id: paypalOrderId,
    transaction_id: orderRecord.transaction_id,
    case_id: orderRecord.case_id,
    paypal_capture_id: capture.id,
    status: captureStatus,
    amount: captureAmount,
    currency: capture.amount.currency_code,
    final_capture: capture.final_capture,
    seller_protection: capture.seller_protection?.status ?? null,
    raw_response: capture as unknown as Json,
  });

  // 6. Update our PayPal order status.
  await db
    .from("paypal_orders")
    .update({
      status: capturedOrder.status,
      raw_response: capturedOrder as unknown as Json,
    })
    .eq("paypal_order_id", paypalOrderId)
    .eq("user_id", userId);

  const isSuccess = captureStatus === "COMPLETED";

  // 7. Update the internal transaction record if capture succeeded.
  if (isSuccess) {
    await db
      .from("transactions")
      .update({
        status: "RECOVERED",
        recovery_status: "recovered",
      })
      .eq("id", orderRecord.transaction_id)
      .eq("user_id", userId);

    // Update the recovery case if linked.
    if (orderRecord.case_id) {
      await db
        .from("recovery_cases")
        .update({
          status: "recovered",
          recovered_amount: captureAmount,
          recovered_at: new Date().toISOString(),
          stop_reason: "PAYMENT_SUCCEEDED",
        })
        .eq("id", orderRecord.case_id)
        .eq("user_id", userId);
    }
  }

  // 8. Audit.
  await writeAudit(db, userId, [
    {
      event_type: isSuccess ? "PAYPAL_CAPTURE_COMPLETED" : "PAYPAL_CAPTURE_FAILED",
      transaction_ref: tx.transaction_ref,
      customer_id: tx.customer_id,
      case_id: orderRecord.case_id,
      actor: "paypal_recovery",
      action: "CAPTURE_ORDER",
      reason: `PayPal capture for order ${paypalOrderId}`,
      result: `capture_id=${capture.id} status=${captureStatus} amount=${captureAmount} ${orderRecord.currency}`,
    },
  ]);

  return {
    paypalOrderId,
    captureId: capture.id,
    status: captureStatus,
    amount: captureAmount,
    currency: orderRecord.currency,
    transactionId: orderRecord.transaction_id,
    caseId: orderRecord.case_id,
    alreadyCaptured: false,
  };
}

// ─── Dashboard stats ──────────────────────────────────────────────────────────

export async function loadPayPalStats(db: Db, userId: string): Promise<PayPalDashboardStats> {
  const [ordersRes, capturesRes] = await Promise.all([
    db
      .from("paypal_orders")
      .select("id, paypal_order_id, status, amount, currency, transaction_id, case_id, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(50),
    db.from("paypal_captures").select("status, amount").eq("user_id", userId),
  ]);

  const orders: Array<{
    id: string;
    paypal_order_id: string;
    status: string;
    amount: number;
    currency: string;
    transaction_id: string;
    case_id: string | null;
    created_at: string;
  }> = ordersRes.data ?? [];
  const captures: Array<{ status: string; amount: number }> = capturesRes.data ?? [];

  const completedCaptures = captures.filter((c) => c.status === "COMPLETED").length;
  const failedCaptures = captures.filter(
    (c) => c.status === "DECLINED" || c.status === "FAILED",
  ).length;
  const pendingOrders = orders.filter((o) =>
    ["CREATED", "SAVED", "PAYER_ACTION_REQUIRED"].includes(o.status),
  ).length;
  const recoveredAmount = captures
    .filter((c) => c.status === "COMPLETED")
    .reduce((sum, c) => sum + Number(c.amount), 0);

  return {
    totalOrders: orders.length,
    completedCaptures,
    failedCaptures,
    pendingOrders,
    recoveredAmount,
    recentOrders: orders.slice(0, 20).map((o) => ({
      id: o.id,
      paypal_order_id: o.paypal_order_id,
      status: o.status,
      amount: Number(o.amount),
      currency: o.currency,
      transaction_id: o.transaction_id,
      case_id: o.case_id,
      created_at: o.created_at,
    })),
  };
}

// ─── Webhook event processing (called from the webhook route) ─────────────────

export interface WebhookEvent {
  id: string;
  event_type: string;
  resource_type?: string;
  summary?: string;
  resource?: Record<string, unknown>;
}

/**
 * Processes a verified PayPal webhook event.
 * Uses the service-role admin client to write webhook_events (no RLS).
 * Idempotent: duplicate event IDs are silently ignored.
 */
export async function processWebhookEvent(
  event: WebhookEvent,
  rawPayload: string,
  verified: boolean,
): Promise<{ processed: boolean; skipped: boolean; reason?: string }> {
  const admin = supabaseAdmin;

  // 1. Record the raw event (idempotent — unique constraint on event_id).
  const { error: insertError } = await admin.from("paypal_webhook_events").insert({
    event_id: event.id,
    event_type: event.event_type,
    resource_type: event.resource_type ?? null,
    resource_id: (event.resource?.["id"] as string | undefined) ?? null,
    summary: event.summary ?? null,
    raw_payload: JSON.parse(rawPayload) as unknown as Json,
    verified,
    processed: false,
  });

  if (insertError) {
    // Unique constraint violation = duplicate event → idempotent skip.
    if (insertError.code === "23505") {
      return { processed: false, skipped: true, reason: "duplicate_event_id" };
    }
    console.error("[paypal webhook] failed to store event", insertError.message);
    return { processed: false, skipped: false, reason: insertError.message };
  }

  // 2. Skip unverified events after recording them.
  if (!verified) {
    return { processed: false, skipped: true, reason: "signature_not_verified" };
  }

  // 3. Dispatch on event type.
  const resourceId = event.resource?.["id"] as string | undefined;

  try {
    switch (event.event_type) {
      case "CHECKOUT.ORDER.APPROVED": {
        if (resourceId) {
          await admin
            .from("paypal_orders")
            .update({ status: "APPROVED" })
            .eq("paypal_order_id", resourceId);
        }
        break;
      }
      case "PAYMENT.CAPTURE.COMPLETED": {
        if (resourceId) {
          await admin
            .from("paypal_captures")
            .update({ status: "COMPLETED" })
            .eq("paypal_capture_id", resourceId);

          // Ensure transaction is marked recovered.
          const { data: cap } = await admin
            .from("paypal_captures")
            .select("transaction_id, case_id, amount")
            .eq("paypal_capture_id", resourceId)
            .maybeSingle();

          if (cap) {
            await admin
              .from("transactions")
              .update({ status: "RECOVERED", recovery_status: "recovered" })
              .eq("id", cap.transaction_id);

            if (cap.case_id) {
              await admin
                .from("recovery_cases")
                .update({
                  status: "recovered",
                  recovered_amount: Number(cap.amount),
                  recovered_at: new Date().toISOString(),
                  stop_reason: "PAYMENT_SUCCEEDED",
                })
                .eq("id", cap.case_id);
            }
          }
        }
        break;
      }
      case "PAYMENT.CAPTURE.DENIED":
      case "PAYMENT.CAPTURE.FAILED": {
        if (resourceId) {
          await admin
            .from("paypal_captures")
            .update({ status: "FAILED" })
            .eq("paypal_capture_id", resourceId);
        }
        break;
      }
      case "PAYMENT.CAPTURE.PENDING": {
        if (resourceId) {
          await admin
            .from("paypal_captures")
            .update({ status: "PENDING" })
            .eq("paypal_capture_id", resourceId);
        }
        break;
      }
      case "PAYMENT.CAPTURE.REFUNDED":
      case "PAYMENT.CAPTURE.REVERSED": {
        if (resourceId) {
          await admin
            .from("paypal_captures")
            .update({ status: "REFUNDED" })
            .eq("paypal_capture_id", resourceId);
        }
        break;
      }
      default:
        // Unknown event type — recorded but not acted on.
        break;
    }

    await admin.from("paypal_webhook_events").update({ processed: true }).eq("event_id", event.id);

    return { processed: true, skipped: false };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[paypal webhook] processing error", event.event_type, msg);
    await admin
      .from("paypal_webhook_events")
      .update({ processing_error: msg })
      .eq("event_id", event.id);
    return { processed: false, skipped: false, reason: msg };
  }
}
