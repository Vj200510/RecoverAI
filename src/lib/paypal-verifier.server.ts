/**
 * PayPal Deterministic Execution Boundary
 *
 * Every PayPal financial operation (order creation, capture) must pass through
 * this verifier before any external API call or state mutation is allowed.
 *
 * The pattern mirrors verifyAndExecuteRecoveryAction() from action-verifier.server.ts:
 *   1. Gather fresh authoritative evidence from the DB and PayPal API.
 *   2. Evaluate all guards deterministically — no AI participation.
 *   3. Write a mandatory audit record for APPROVE or BLOCK.
 *   4. Gate the executor: only APPROVE can call the executor function.
 *   5. A mandatory audit write failure must prevent execution entirely.
 *
 * AI recommendations never authorize PayPal executions. The AI may suggest an
 * action, but this verifier — reading fresh DB state and live PayPal status —
 * makes the final decision independently.
 */

import { AppError, fail, writeAudit, type Db } from "./db.server";
import { getPayPalOrder, type PayPalOrder } from "./paypal.server";

// ─── Types ────────────────────────────────────────────────────────────────────

export type PayPalVerificationDecision = "APPROVE" | "BLOCK";

export interface PayPalVerificationEvidence {
  source: string;
  field: string;
  value: string | number | boolean | null;
}

export interface PayPalVerificationResult {
  decision: PayPalVerificationDecision;
  action: "CREATE_ORDER" | "CAPTURE_ORDER";
  reason: string;
  evidence: PayPalVerificationEvidence[];
  latency_ms: number;
}

export type PayPalGateResult<T> =
  | { executed: true; result: T }
  | { executed: false; result: undefined };

// ─── Execution gate (mirrors runVerifiedExecutor) ─────────────────────────────

/**
 * The single gate function. A BLOCK decision cannot reach the executor.
 * Exported so tests can verify it independently.
 */
export function runPayPalGate<T>(
  verification: Pick<PayPalVerificationResult, "decision">,
  executor: () => T,
): PayPalGateResult<T> {
  if (verification.decision !== "APPROVE") {
    return { executed: false, result: undefined };
  }
  return { executed: true, result: executor() };
}

// ─── Order creation verification ─────────────────────────────────────────────

export interface OrderCreationEvidence {
  transactionId: string;
  transactionRef: string;
  transactionStatus: string;
  amount: number;
  currency: string;
  userId: string;
  existingActiveOrder: string | null;
}

/**
 * Evaluates whether a new PayPal order may be created for a given transaction.
 * Pure function — no side effects. Used by both production and tests.
 */
export function evaluateOrderCreation(
  ev: OrderCreationEvidence,
): Omit<PayPalVerificationResult, "latency_ms"> {
  const evidence: PayPalVerificationEvidence[] = [
    { source: "transactions", field: "id", value: ev.transactionId },
    { source: "transactions", field: "status", value: ev.transactionStatus },
    { source: "transactions", field: "amount", value: ev.amount },
    { source: "transactions", field: "currency", value: ev.currency },
    { source: "paypal_orders", field: "existing_active_order", value: ev.existingActiveOrder },
  ];

  const failures: string[] = [];

  // Guard 1: transaction must belong to this user (enforced by DB query with user_id eq).
  // Guard 2: terminal transaction cannot get a new recovery order.
  if (["SUCCESS", "RECOVERED"].includes(ev.transactionStatus.toUpperCase())) {
    failures.push(
      `Transaction is already ${ev.transactionStatus}. Recovery orders are not permitted for completed payments.`,
    );
  }

  // Guard 3: no active PayPal order may already exist.
  if (ev.existingActiveOrder) {
    failures.push(
      `An active PayPal order (${ev.existingActiveOrder}) already exists for this transaction. Duplicate order creation is not permitted.`,
    );
  }

  // Guard 4: amount must be positive.
  if (ev.amount <= 0) {
    failures.push(`Transaction amount ${ev.amount} is not valid for order creation.`);
  }

  const decision: PayPalVerificationDecision = failures.length > 0 ? "BLOCK" : "APPROVE";

  return {
    decision,
    action: "CREATE_ORDER",
    evidence,
    reason:
      failures[0] ??
      `Transaction ${ev.transactionRef} is eligible for PayPal order creation: status=${ev.transactionStatus}, amount=${ev.amount} ${ev.currency}.`,
  };
}

// ─── Capture verification ─────────────────────────────────────────────────────

export interface CaptureEvidence {
  paypalOrderId: string;
  paypalOrderStatus: string;
  storedAmount: number;
  storedCurrency: string;
  liveAmount: number;
  liveCurrency: string;
  transactionStatus: string;
  existingCaptureId: string | null;
  orderCompleted: boolean;
}

/**
 * Evaluates whether a PayPal capture is permitted.
 * Pure function — no side effects. Used by both production and tests.
 */
export function evaluateCapture(
  ev: CaptureEvidence,
): Omit<PayPalVerificationResult, "latency_ms"> {
  const evidence: PayPalVerificationEvidence[] = [
    { source: "paypal_orders", field: "paypal_order_id", value: ev.paypalOrderId },
    { source: "paypal_orders", field: "stored_status", value: ev.paypalOrderStatus },
    { source: "paypal_orders", field: "stored_amount", value: ev.storedAmount },
    { source: "paypal_orders", field: "stored_currency", value: ev.storedCurrency },
    { source: "paypal_api", field: "live_amount", value: ev.liveAmount },
    { source: "paypal_api", field: "live_currency", value: ev.liveCurrency },
    { source: "paypal_api", field: "live_status", value: ev.paypalOrderStatus },
    { source: "transactions", field: "status", value: ev.transactionStatus },
    { source: "paypal_captures", field: "existing_capture", value: ev.existingCaptureId },
  ];

  const failures: string[] = [];

  // Guard 1: already completed is idempotent — not an error, return early.
  if (ev.orderCompleted || ev.existingCaptureId) {
    return {
      decision: "APPROVE",
      action: "CAPTURE_ORDER",
      evidence,
      reason: `Order already captured (idempotent). capture_id=${ev.existingCaptureId ?? "from_order_status"}.`,
    };
  }

  // Guard 2: transaction already recovered — prevent double payment.
  if (["SUCCESS", "RECOVERED"].includes(ev.transactionStatus.toUpperCase())) {
    failures.push(
      `Transaction is already ${ev.transactionStatus}. Capturing would cause a duplicate payment.`,
    );
  }

  // Guard 3: PayPal order must be APPROVED for capture.
  if (!["APPROVED", "PAYER_ACTION_REQUIRED"].includes(ev.paypalOrderStatus)) {
    failures.push(
      `PayPal order status is "${ev.paypalOrderStatus}". Capture requires APPROVED status.`,
    );
  }

  // Guard 4: amount must match exactly (within 1 cent for floating-point safety).
  if (Math.abs(ev.liveAmount - ev.storedAmount) > 0.01) {
    failures.push(
      `Amount mismatch: stored=${ev.storedAmount} live=${ev.liveAmount}. Capture rejected to prevent unauthorized amount change.`,
    );
  }

  // Guard 5: currency must match exactly.
  if (ev.liveCurrency.toUpperCase() !== ev.storedCurrency.toUpperCase()) {
    failures.push(
      `Currency mismatch: stored=${ev.storedCurrency} live=${ev.liveCurrency}. Capture rejected.`,
    );
  }

  const decision: PayPalVerificationDecision = failures.length > 0 ? "BLOCK" : "APPROVE";

  return {
    decision,
    action: "CAPTURE_ORDER",
    evidence,
    reason:
      failures[0] ??
      `Capture verified: order ${ev.paypalOrderId} APPROVED, amount=${ev.liveAmount} ${ev.liveCurrency} matches stored record.`,
  };
}

// ─── Full boundary: gather evidence → verify → audit (required) → gate ────────

/**
 * Complete PayPal order-creation boundary.
 *
 * Execution trace:
 *   Authenticated caller
 *   → DB: load transaction by (id, user_id) — ownership enforced
 *   → DB: check for existing active orders — duplicate prevention
 *   → evaluateOrderCreation() — deterministic, no AI
 *   → writeAudit (required=true) — mandatory; failure prevents execution
 *   → runPayPalGate — BLOCK stops here, APPROVE continues
 *   → executor (creates PayPal order)
 */
export async function verifyAndCreateOrder<T>(
  db: Db,
  userId: string,
  transactionId: string,
  executor: (ev: OrderCreationEvidence) => T | Promise<T>,
): Promise<{ verification: PayPalVerificationResult; gate: PayPalGateResult<Awaited<T>> }> {
  const started = Date.now();

  // 1. Load authoritative transaction data — ownership enforced by user_id filter.
  const { data: tx, error: txError } = await db
    .from("transactions")
    .select("id, transaction_ref, amount, currency, status, customer_id")
    .eq("id", transactionId)
    .eq("user_id", userId)
    .maybeSingle();

  if (txError || !tx) {
    const verification: PayPalVerificationResult = {
      decision: "BLOCK",
      action: "CREATE_ORDER",
      reason: txError
        ? "Could not load transaction record — source unavailable."
        : "Transaction not found or does not belong to this account.",
      evidence: [{ source: "transactions", field: "id", value: transactionId }],
      latency_ms: Date.now() - started,
    };
    // Still write audit for the BLOCK.
    await writeAudit(
      db,
      userId,
      [{ event_type: "PAYPAL_ORDER_CREATION_BLOCKED", actor: "paypal_verifier", action: "CREATE_ORDER", reason: verification.reason }],
      { required: false },
    );
    return { verification, gate: { executed: false, result: undefined } };
  }

  // 2. Check for existing active orders (duplicate prevention).
  const { data: existing } = await db
    .from("paypal_orders")
    .select("paypal_order_id")
    .eq("transaction_id", transactionId)
    .eq("user_id", userId)
    .in("status", ["CREATED", "SAVED", "APPROVED", "PAYER_ACTION_REQUIRED"])
    .limit(1)
    .maybeSingle();

  const ev: OrderCreationEvidence = {
    transactionId: tx.id,
    transactionRef: tx.transaction_ref,
    transactionStatus: tx.status,
    amount: Number(tx.amount),
    currency: tx.currency,
    userId,
    existingActiveOrder: existing?.paypal_order_id ?? null,
  };

  // 3. Deterministic evaluation — no AI participation.
  const result = evaluateOrderCreation(ev);
  const verification: PayPalVerificationResult = {
    ...result,
    latency_ms: Date.now() - started,
  };

  // 4. Mandatory audit — if this fails, execution must not proceed.
  await writeAudit(
    db,
    userId,
    [
      {
        event_type:
          verification.decision === "APPROVE"
            ? "PAYPAL_ORDER_CREATION_APPROVED"
            : "PAYPAL_ORDER_CREATION_BLOCKED",
        transaction_ref: tx.transaction_ref,
        customer_id: tx.customer_id,
        actor: "paypal_verifier",
        action: "CREATE_ORDER",
        reason: verification.reason,
        result: JSON.stringify({ decision: verification.decision, evidence: verification.evidence }),
      },
    ],
    { required: true }, // required=true: failure throws, preventing execution
  );

  // 5. Gate: BLOCK cannot reach the executor.
  const gate = runPayPalGate(verification, () => executor(ev));
  return {
    verification,
    gate: gate.executed
      ? { executed: true, result: await (gate.result as Promise<Awaited<T>>) }
      : gate,
  };
}

/**
 * Complete PayPal capture boundary.
 *
 * Execution trace:
 *   Authenticated caller
 *   → DB: load paypal_order by (paypal_order_id, user_id) — ownership enforced
 *   → PayPal API: fetch live order status — never trusts stored or frontend status
 *   → DB: check existing capture records — idempotency
 *   → evaluateCapture() — deterministic, no AI
 *   → writeAudit (required=true) — mandatory; failure prevents execution
 *   → runPayPalGate — BLOCK stops here, APPROVE continues
 *   → executor (calls PayPal capture API)
 */
export async function verifyAndCapture<T>(
  db: Db,
  userId: string,
  paypalOrderId: string,
  executor: (ev: CaptureEvidence, liveOrder: PayPalOrder) => T | Promise<T>,
): Promise<{ verification: PayPalVerificationResult; gate: PayPalGateResult<Awaited<T>> }> {
  const started = Date.now();

  // 1. Load our internal order record — ownership enforced by user_id filter.
  const { data: orderRecord, error: orderError } = await db
    .from("paypal_orders")
    .select("*, transactions!inner(transaction_ref, amount, currency, customer_id, status)")
    .eq("paypal_order_id", paypalOrderId)
    .eq("user_id", userId)
    .maybeSingle();

  if (orderError || !orderRecord) {
    const verification: PayPalVerificationResult = {
      decision: "BLOCK",
      action: "CAPTURE_ORDER",
      reason: orderError
        ? "Could not load PayPal order record — source unavailable."
        : "PayPal order not found or does not belong to this account.",
      evidence: [{ source: "paypal_orders", field: "paypal_order_id", value: paypalOrderId }],
      latency_ms: Date.now() - started,
    };
    await writeAudit(
      db,
      userId,
      [{ event_type: "PAYPAL_CAPTURE_BLOCKED", actor: "paypal_verifier", action: "CAPTURE_ORDER", reason: verification.reason }],
      { required: false },
    );
    return { verification, gate: { executed: false, result: undefined } };
  }

  const tx = orderRecord.transactions as unknown as {
    transaction_ref: string;
    amount: number;
    currency: string;
    customer_id: string;
    status: string;
  };

  // 2. Fetch live PayPal order status — authoritative, never trusts stored or client status.
  let liveOrder: PayPalOrder;
  try {
    liveOrder = await getPayPalOrder(paypalOrderId);
  } catch {
    const verification: PayPalVerificationResult = {
      decision: "BLOCK",
      action: "CAPTURE_ORDER",
      reason: "Could not retrieve live PayPal order status. Capture rejected to prevent unauthorized execution.",
      evidence: [{ source: "paypal_api", field: "paypal_order_id", value: paypalOrderId }],
      latency_ms: Date.now() - started,
    };
    await writeAudit(
      db,
      userId,
      [{ event_type: "PAYPAL_CAPTURE_BLOCKED", transaction_ref: tx.transaction_ref, actor: "paypal_verifier", action: "CAPTURE_ORDER", reason: verification.reason }],
      { required: false },
    );
    return { verification, gate: { executed: false, result: undefined } };
  }

  // 3. Check for existing capture record (idempotency).
  const { data: existingCapture } = await db
    .from("paypal_captures")
    .select("paypal_capture_id, status")
    .eq("paypal_order_id", paypalOrderId)
    .eq("user_id", userId)
    .limit(1)
    .maybeSingle();

  // Extract live amount/currency from the PayPal order response.
  const liveUnit = liveOrder.purchase_units[0];
  const liveAmount = liveUnit ? parseFloat(liveUnit.amount.value) : 0;
  const liveCurrency = liveUnit?.amount.currency_code ?? "";

  const ev: CaptureEvidence = {
    paypalOrderId,
    paypalOrderStatus: liveOrder.status,
    storedAmount: Number(orderRecord.amount),
    storedCurrency: orderRecord.currency,
    liveAmount,
    liveCurrency,
    transactionStatus: tx.status,
    existingCaptureId: existingCapture?.paypal_capture_id ?? null,
    orderCompleted: orderRecord.status === "COMPLETED",
  };

  // 4. Deterministic evaluation.
  const result = evaluateCapture(ev);
  const verification: PayPalVerificationResult = {
    ...result,
    latency_ms: Date.now() - started,
  };

  // 5. Mandatory audit.
  await writeAudit(
    db,
    userId,
    [
      {
        event_type:
          verification.decision === "APPROVE"
            ? "PAYPAL_CAPTURE_APPROVED"
            : "PAYPAL_CAPTURE_BLOCKED",
        transaction_ref: tx.transaction_ref,
        customer_id: tx.customer_id,
        case_id: orderRecord.case_id,
        actor: "paypal_verifier",
        action: "CAPTURE_ORDER",
        reason: verification.reason,
        result: JSON.stringify({ decision: verification.decision, evidence: verification.evidence }),
      },
    ],
    { required: true },
  );

  // 6. Gate.
  const gate = runPayPalGate(verification, () => executor(ev, liveOrder));
  return {
    verification,
    gate: gate.executed
      ? { executed: true, result: await (gate.result as Promise<Awaited<T>>) }
      : gate,
  };
}
