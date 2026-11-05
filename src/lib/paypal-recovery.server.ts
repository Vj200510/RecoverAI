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
import { verifyAndCreateOrder, verifyAndCapture } from "./paypal-verifier.server";
import type { PayPalVerificationResult } from "./paypal-verifier.server";

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
  verification: PayPalVerificationResult;
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
  verification: PayPalVerificationResult;
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
 * All execution guards are now enforced through verifyAndCreateOrder():
 * - Transaction ownership (user_id filter on DB read)
 * - Terminal transaction check (SUCCESS/RECOVERED → BLOCK)
 * - Active order duplicate check → BLOCK
 * - Mandatory audit before execution
 * - runPayPalGate: BLOCK cannot reach the PayPal API
 * - Amount/currency sourced from DB, never from client input
 */
export async function createRecoveryOrder(
  db: Db,
  userId: string,
  transactionId: string,
  baseUrl: string,
): Promise<CreateRecoveryOrderResult> {
  const { verification, gate } = await verifyAndCreateOrder(
    db,
    userId,
    transactionId,
    async (ev) => {
      // This executor only runs when verification returns APPROVE.
      const paypalOrder = await createPayPalOrder({
        transactionRef: ev.transactionRef,
        amount: ev.amount,
        currency: ev.currency,
        description: `RecoverAI payment recovery for transaction ${ev.transactionRef}`,
        returnUrl: `${baseUrl}/console/paypal`,
        cancelUrl: `${baseUrl}/console/paypal?cancelled=true`,
      });

      const approveUrl = getApproveUrl(paypalOrder);
      if (!approveUrl) fail("PayPal did not return an approval URL. Please try again.");

      // Load customer_id for audit (need full tx record).
      const { data: txFull } = await db
        .from("transactions")
        .select("customer_id, transaction_ref")
        .eq("id", ev.transactionId)
        .eq("user_id", userId)
        .single();

      const { data: inserted, error: insertError } = await db
        .from("paypal_orders")
        .insert({
          user_id: userId,
          transaction_id: ev.transactionId,
          paypal_order_id: paypalOrder.id,
          amount: ev.amount,
          currency: ev.currency,
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

      await writeAudit(db, userId, [
        {
          event_type: "PAYPAL_ORDER_CREATED",
          transaction_ref: txFull?.transaction_ref ?? ev.transactionRef,
          customer_id: txFull?.customer_id ?? null,
          actor: "paypal_recovery",
          action: "CREATE_CHECKOUT_ORDER",
          reason: `PayPal Sandbox recovery checkout for ${ev.currency} ${ev.amount.toFixed(2)}`,
          result: `order_id=${paypalOrder.id} status=${paypalOrder.status}`,
        },
      ]);

      return {
        paypalOrderId: paypalOrder.id,
        approveUrl: approveUrl!,
        internalOrderId: inserted!.id,
        amount: ev.amount,
        currency: ev.currency,
        sandbox: true,
      };
    },
  );

  if (!gate.executed) {
    fail(
      `PayPal order creation blocked by verification: ${verification.reason}`,
    );
  }

  return { ...gate.result!, verification };
}

// ─── Capture an approved PayPal order ────────────────────────────────────────

/**
 * Captures a customer-approved PayPal order.
 *
 * All execution guards are now enforced through verifyAndCapture():
 * - Order ownership (user_id filter on DB read)
 * - Live PayPal status fetched before evaluation (never trusts stored/client status)
 * - Idempotency: existing capture record → APPROVE with alreadyCaptured=true
 * - Terminal transaction check → BLOCK
 * - PayPal order must be APPROVED → else BLOCK
 * - Amount and currency must match stored record exactly → else BLOCK
 * - Mandatory audit before execution
 * - runPayPalGate: BLOCK cannot reach the PayPal capture API
 */
export async function captureRecoveryOrder(
  db: Db,
  userId: string,
  paypalOrderId: string,
): Promise<CaptureRecoveryOrderResult> {
  const { verification, gate } = await verifyAndCapture(
    db,
    userId,
    paypalOrderId,
    async (ev, liveOrder) => {
      // This executor only runs when verification returns APPROVE.

      // Idempotent return for already-captured orders.
      if (ev.orderCompleted || ev.existingCaptureId) {
        // Load order record for response fields.
        const { data: ord } = await db
          .from("paypal_orders")
          .select("transaction_id, case_id, amount, currency")
          .eq("paypal_order_id", paypalOrderId)
          .eq("user_id", userId)
          .single();

        return {
          paypalOrderId,
          captureId: ev.existingCaptureId ?? "already-captured",
          status: "COMPLETED",
          amount: ev.storedAmount,
          currency: ev.storedCurrency,
          transactionId: ord?.transaction_id ?? "",
          caseId: ord?.case_id ?? null,
          alreadyCaptured: true,
        };
      }

      // Execute the actual PayPal capture.
      const { capture, order: capturedOrder } = await capturePayPalOrder(
        paypalOrderId,
        ev.storedAmount,
        ev.storedCurrency,
      );

      const captureStatus = capture.status;
      const captureAmount = parseFloat(capture.amount.value);

      // Load order record for transaction/case IDs.
      const { data: orderRecord } = await db
        .from("paypal_orders")
        .select("transaction_id, case_id, transactions!inner(transaction_ref, customer_id)")
        .eq("paypal_order_id", paypalOrderId)
        .eq("user_id", userId)
        .single();

      const txInfo = orderRecord?.transactions as unknown as
        | { transaction_ref: string; customer_id: string }
        | undefined;

      // Record the capture.
      await db.from("paypal_captures").insert({
        user_id: userId,
        paypal_order_id: paypalOrderId,
        transaction_id: orderRecord?.transaction_id ?? "",
        case_id: orderRecord?.case_id ?? null,
        paypal_capture_id: capture.id,
        status: captureStatus,
        amount: captureAmount,
        currency: capture.amount.currency_code,
        final_capture: capture.final_capture,
        seller_protection: capture.seller_protection?.status ?? null,
        raw_response: capture as unknown as Json,
      });

      // Update the stored PayPal order status.
      await db
        .from("paypal_orders")
        .update({
          status: capturedOrder.status,
          raw_response: capturedOrder as unknown as Json,
        })
        .eq("paypal_order_id", paypalOrderId)
        .eq("user_id", userId);

      const isSuccess = captureStatus === "COMPLETED";

      if (isSuccess && orderRecord) {
        await db
          .from("transactions")
          .update({ status: "RECOVERED", recovery_status: "recovered" })
          .eq("id", orderRecord.transaction_id)
          .eq("user_id", userId);

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

      await writeAudit(db, userId, [
        {
          event_type: isSuccess ? "PAYPAL_CAPTURE_COMPLETED" : "PAYPAL_CAPTURE_FAILED",
          transaction_ref: txInfo?.transaction_ref ?? null,
          customer_id: txInfo?.customer_id ?? null,
          case_id: orderRecord?.case_id ?? null,
          actor: "paypal_recovery",
          action: "CAPTURE_ORDER",
          reason: `PayPal capture for order ${paypalOrderId}`,
          result: `capture_id=${capture.id} status=${captureStatus} amount=${captureAmount} ${ev.storedCurrency}`,
        },
      ]);

      return {
        paypalOrderId,
        captureId: capture.id,
        status: captureStatus,
        amount: captureAmount,
        currency: ev.storedCurrency,
        transactionId: orderRecord?.transaction_id ?? "",
        caseId: orderRecord?.case_id ?? null,
        alreadyCaptured: false,
      };
    },
  );

  if (!gate.executed) {
    fail(`PayPal capture blocked by verification: ${verification.reason}`);
  }

  return { ...gate.result!, verification };
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

// ─── Analyze a PayPal transaction with the AI recovery engine ─────────────────

export interface PayPalAnalysisResult {
  paypalOrderId: string;
  paypalStatus: string;
  internalTransactionId: string;
  internalCaseId: string | null;
  decisionId: string;
  decision: {
    diagnosis: string;
    recovery_probability: number;
    risk_level: string;
    recommended_action: string;
    reason: string;
    confidence: number;
    source: string;
  };
  paypalEvidence: {
    orderId: string;
    status: string;
    amount: number;
    currency: string;
    payerApproved: boolean;
  };
}

/**
 * Fetches authoritative PayPal order status, enriches the internal transaction
 * record with real PayPal evidence, then runs the AI recovery analysis.
 *
 * This is the bridge between PayPal and the AI engine:
 *   PayPal Order → Authoritative Evidence → AI Analysis → Recovery Recommendation
 *
 * The AI receives the actual PayPal status as evidence — it never invents it.
 * The deterministic verifier still controls execution after this analysis.
 */
export async function analyzePayPalTransaction(
  db: Db,
  userId: string,
  paypalOrderId: string,
  rules: import("./recovery-engine").MerchantRules,
): Promise<PayPalAnalysisResult> {
  // 1. Fetch authoritative PayPal order status — never trust stored state.
  const liveOrder = await getPayPalOrder(paypalOrderId);

  // 2. Load our internal PayPal order record to get the linked transaction.
  const { data: orderRecord, error: orderErr } = await db
    .from("paypal_orders")
    .select("transaction_id, case_id, amount, currency")
    .eq("paypal_order_id", paypalOrderId)
    .eq("user_id", userId)
    .maybeSingle();

  if (orderErr) fail("Could not load the PayPal order record.");
  if (!orderRecord) fail("PayPal order not found or does not belong to your account.");

  // 3. Update our stored order status with the live PayPal status.
  await db
    .from("paypal_orders")
    .update({ status: liveOrder.status })
    .eq("paypal_order_id", paypalOrderId)
    .eq("user_id", userId);

  // 4. Guard: do not run AI analysis on already-completed payments.
  //    A COMPLETED order means the customer paid — there is nothing to recover.
  if (liveOrder.status === "COMPLETED") {
    fail(
      `PayPal order ${paypalOrderId} is already COMPLETED. The payment succeeded — no recovery analysis is needed.`,
    );
  }

  // 5. Map authoritative PayPal order status to internal failure context.
  //    We only reach this point for non-COMPLETED orders.
  //    Mapping rationale (no status is invented — all come from the live PayPal response):
  //    CREATED / SAVED           → customer has not yet started checkout → checkout_abandoned
  //    PAYER_ACTION_REQUIRED     → PayPal needs additional customer action → authentication_failed
  //    VOIDED                    → merchant or PayPal voided the order → bank_declined
  //    APPROVED (rare edge case) → customer approved but capture pending → network_error
  const paypalStatusMap: Record<string, { failureReason: string; txStatus: string }> = {
    CREATED: { failureReason: "checkout_abandoned", txStatus: "ABANDONED" },
    SAVED: { failureReason: "checkout_abandoned", txStatus: "ABANDONED" },
    PAYER_ACTION_REQUIRED: { failureReason: "authentication_failed", txStatus: "FAILED" },
    VOIDED: { failureReason: "bank_declined", txStatus: "FAILED" },
    APPROVED: { failureReason: "network_error", txStatus: "FAILED" },
  };

  const mapped = paypalStatusMap[liveOrder.status] ?? {
    failureReason: "unknown",
    txStatus: "FAILED",
  };

  // 6. Update the internal transaction with real PayPal evidence.
  //    Only update to non-SUCCESS status — COMPLETED was already guarded above.
  await db
    .from("transactions")
    .update({
      failure_reason: mapped.failureReason,
      status: mapped.txStatus,
    })
    .eq("id", orderRecord.transaction_id)
    .eq("user_id", userId)
    // Safety: never overwrite a RECOVERED transaction via analysis
    .neq("status", "RECOVERED");

  // 7. Run the existing AI analysis pipeline with the enriched transaction.
  const { analyzeCase } = await import("./agent.server");
  let caseId = orderRecord.case_id;

  // If no case exists for this transaction, create one.
  if (!caseId) {
    const { data: existingCase } = await db
      .from("recovery_cases")
      .select("id")
      .eq("transaction_id", orderRecord.transaction_id)
      .eq("user_id", userId)
      .maybeSingle();

    caseId = existingCase?.id ?? null;

    if (!caseId) {
      // Create a recovery case for this PayPal transaction.
      const { data: newCase, error: caseErr } = await db
        .from("recovery_cases")
        .insert({
          user_id: userId,
          transaction_id: orderRecord.transaction_id,
          customer_id: (
            await db
              .from("transactions")
              .select("customer_id")
              .eq("id", orderRecord.transaction_id)
              .single()
          ).data!.customer_id,
          amount_at_risk: Number(orderRecord.amount),
          status: "open",
          retry_count: 0,
          reminder_count: 0,
          reengagement_count: 0,
          alt_method_count: 0,
        })
        .select("id")
        .single();

      if (caseErr || !newCase) fail("Could not create a recovery case for this PayPal transaction.");
      caseId = newCase!.id;

      // Link the PayPal order to the newly created case.
      await db
        .from("paypal_orders")
        .update({ case_id: caseId })
        .eq("paypal_order_id", paypalOrderId)
        .eq("user_id", userId);
    }
  }

  // 8. Run AI analysis — the AI will see the real PayPal-enriched transaction data.
  const { decisionId, decision } = await analyzeCase(db, userId, caseId!, rules);

  // 9. Write PayPal-specific audit event.
  await writeAudit(db, userId, [
    {
      event_type: "PAYPAL_AI_ANALYSIS",
      case_id: caseId,
      actor: "paypal_recovery",
      action: "ANALYZE_PAYPAL_TRANSACTION",
      reason: `PayPal order ${paypalOrderId} status=${liveOrder.status} → AI recommended ${decision.recommended_action}`,
      result: `${decision.recommended_action} @ ${decision.recovery_probability}% (${decision.source})`,
    },
  ]);

  return {
    paypalOrderId,
    paypalStatus: liveOrder.status,
    internalTransactionId: orderRecord.transaction_id,
    internalCaseId: caseId,
    decisionId,
    decision: {
      diagnosis: decision.diagnosis,
      recovery_probability: decision.recovery_probability,
      risk_level: decision.risk_level,
      recommended_action: decision.recommended_action,
      reason: decision.reason,
      confidence: decision.confidence,
      source: decision.source,
    },
    paypalEvidence: {
      orderId: liveOrder.id,
      status: liveOrder.status,
      amount: Number(orderRecord.amount),
      currency: orderRecord.currency,
      payerApproved: liveOrder.status === "APPROVED",
    },
  };
}
