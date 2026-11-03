/**
 * PayPal Sandbox integration — server-side only.
 *
 * This module:
 *  - Manages OAuth 2.0 access-token lifecycle (client credentials flow).
 *  - Provides typed wrappers around the PayPal Orders API v2.
 *  - Provides webhook signature verification.
 *  - NEVER exposes client secret or access tokens to the browser.
 *
 * All functions throw AppError (surfaced as user-visible messages) or
 * PayPalError (includes PayPal status code) on failure.
 *
 * Official docs:
 *   https://developer.paypal.com/api/rest/
 *   https://developer.paypal.com/docs/api/orders/v2/
 */

import { AppError, fail } from "./db.server";

// ─── Config ──────────────────────────────────────────────────────────────────

function getConfig() {
  const clientId = process.env["PAYPAL_CLIENT_ID"];
  const clientSecret = process.env["PAYPAL_CLIENT_SECRET"];
  const baseUrl = process.env["PAYPAL_BASE_URL"] ?? "https://api-m.sandbox.paypal.com";

  if (!clientId || !clientSecret) {
    fail(
      "PayPal credentials are not configured. Add PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET to .env.local",
    );
  }
  return { clientId: clientId!, clientSecret: clientSecret!, baseUrl };
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class PayPalError extends AppError {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "PayPalError";
  }
}

// ─── Token cache (in-process, per worker instance) ───────────────────────────

interface TokenEntry {
  token: string;
  expiresAt: number; // epoch ms
}

let _tokenCache: TokenEntry | null = null;

/**
 * Returns a valid OAuth access token, refreshing when within 60s of expiry.
 * Tokens are cached in-process; each Nitro/Cloudflare worker instance has its own cache.
 */
async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (_tokenCache && _tokenCache.expiresAt - now > 60_000) {
    return _tokenCache.token;
  }

  const { clientId, clientSecret, baseUrl } = getConfig();
  const credentials = btoa(`${clientId}:${clientSecret}`);

  const res = await fetchWithTimeout(`${baseUrl}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    const body = await res.text();
    throw new PayPalError(
      `PayPal authentication failed (${res.status}). Check PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.`,
      res.status,
      body,
    );
  }

  const data = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };

  _tokenCache = {
    token: data.access_token,
    expiresAt: now + data.expires_in * 1000,
  };

  return _tokenCache.token;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 15_000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new PayPalError("PayPal API request timed out.", 408);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function paypalFetch<T>(
  path: string,
  method: "GET" | "POST" | "PATCH",
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  const { baseUrl } = getConfig();
  const token = await getAccessToken();

  const res = await fetchWithTimeout(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  } as RequestInit);

  if (!res.ok) {
    let details: unknown;
    try {
      details = await res.json();
    } catch {
      details = await res.text();
    }
    const message =
      typeof details === "object" && details !== null && "message" in details
        ? String((details as Record<string, unknown>)["message"])
        : `PayPal API error (${res.status})`;
    throw new PayPalError(message, res.status, details);
  }

  // 204 No Content
  if (res.status === 204) return {} as T;
  return res.json() as Promise<T>;
}

// ─── PayPal Orders API v2 types ───────────────────────────────────────────────

export interface PayPalMoney {
  currency_code: string;
  value: string;
}

export interface PayPalPurchaseUnit {
  reference_id?: string;
  description?: string;
  amount: PayPalMoney;
  payee?: { merchant_id?: string; email_address?: string };
  custom_id?: string; // Our internal transaction_ref
}

export interface PayPalOrderLink {
  href: string;
  rel: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
}

export interface PayPalOrder {
  id: string;
  status: "CREATED" | "SAVED" | "APPROVED" | "VOIDED" | "COMPLETED" | "PAYER_ACTION_REQUIRED";
  intent: string;
  purchase_units: PayPalPurchaseUnit[];
  links: PayPalOrderLink[];
  create_time?: string;
  update_time?: string;
}

export interface PayPalCapture {
  id: string;
  status: "COMPLETED" | "DECLINED" | "PARTIALLY_REFUNDED" | "PENDING" | "REFUNDED" | "FAILED";
  amount: PayPalMoney;
  final_capture: boolean;
  seller_protection?: {
    status: string;
    dispute_categories?: string[];
  };
  create_time?: string;
  update_time?: string;
}

export interface PayPalCaptureResponse {
  id: string;
  status: PayPalOrder["status"];
  purchase_units: Array<{
    reference_id?: string;
    payments?: {
      captures?: PayPalCapture[];
    };
  }>;
  links: PayPalOrderLink[];
}

// ─── Create Order ─────────────────────────────────────────────────────────────

export interface CreateOrderInput {
  transactionRef: string; // used as custom_id for idempotent lookup
  amount: number;
  currency: string;
  description: string;
  returnUrl: string;
  cancelUrl: string;
}

/**
 * Creates a PayPal order for a payment recovery attempt.
 * The customer must then approve it via the PayPal checkout UI.
 */
export async function createPayPalOrder(input: CreateOrderInput): Promise<PayPalOrder> {
  const amountStr = input.amount.toFixed(2);

  const order = await paypalFetch<PayPalOrder>("/v2/checkout/orders", "POST", {
    intent: "CAPTURE",
    purchase_units: [
      {
        reference_id: input.transactionRef,
        description: input.description,
        custom_id: input.transactionRef,
        amount: {
          currency_code: input.currency,
          value: amountStr,
        },
      },
    ],
    payment_source: {
      paypal: {
        experience_context: {
          return_url: input.returnUrl,
          cancel_url: input.cancelUrl,
          user_action: "PAY_NOW",
          brand_name: "RecoverAI",
          locale: "en-US",
          landing_page: "LOGIN",
          shipping_preference: "NO_SHIPPING",
        },
      },
    },
  });

  return order;
}

// ─── Get Order ────────────────────────────────────────────────────────────────

/**
 * Fetches the latest authoritative order status directly from PayPal.
 * Never trust a frontend-supplied status — always call this before acting.
 */
export async function getPayPalOrder(orderId: string): Promise<PayPalOrder> {
  return paypalFetch<PayPalOrder>(`/v2/checkout/orders/${orderId}`, "GET");
}

// ─── Capture Order ────────────────────────────────────────────────────────────

export interface CaptureResult {
  order: PayPalCaptureResponse;
  capture: PayPalCapture;
}

/**
 * Captures an approved PayPal order.
 *
 * Guards:
 * 1. Re-fetches the order to confirm status is APPROVED before capturing.
 * 2. Verifies amount and currency match what was originally created.
 * 3. Verifies the order has not already been captured (COMPLETED status).
 *
 * Throws PayPalError on any mismatch or API failure.
 */
export async function capturePayPalOrder(
  orderId: string,
  expectedAmount: number,
  expectedCurrency: string,
): Promise<CaptureResult> {
  // 1. Fetch fresh order state — never trust a client-supplied status.
  const current = await getPayPalOrder(orderId);

  if (current.status === "COMPLETED") {
    throw new PayPalError(
      "This PayPal order has already been captured. Duplicate capture prevented.",
      409,
    );
  }

  if (current.status === "VOIDED") {
    throw new PayPalError("This PayPal order has been voided and cannot be captured.", 422);
  }

  if (current.status !== "APPROVED") {
    throw new PayPalError(
      `Cannot capture order in status "${current.status}". Customer approval is required first.`,
      422,
    );
  }

  // 2. Verify amount and currency match what we created.
  const unit = current.purchase_units[0];
  if (!unit) throw new PayPalError("PayPal order has no purchase units.", 422);

  const actualAmount = parseFloat(unit.amount.value);
  const actualCurrency = unit.amount.currency_code.toUpperCase();
  const expectedCurrencyUpper = expectedCurrency.toUpperCase();

  if (Math.abs(actualAmount - expectedAmount) > 0.01) {
    throw new PayPalError(
      `Amount mismatch: expected ${expectedAmount.toFixed(2)} but PayPal reports ${actualAmount.toFixed(2)}. Capture rejected.`,
      422,
    );
  }

  if (actualCurrency !== expectedCurrencyUpper) {
    throw new PayPalError(
      `Currency mismatch: expected ${expectedCurrencyUpper} but PayPal reports ${actualCurrency}. Capture rejected.`,
      422,
    );
  }

  // 3. Execute capture.
  const captured = await paypalFetch<PayPalCaptureResponse>(
    `/v2/checkout/orders/${orderId}/capture`,
    "POST",
    {},
    { "PayPal-Request-Id": `capture-${orderId}` }, // idempotency key
  );

  const capture = captured.purchase_units?.[0]?.payments?.captures?.[0];
  if (!capture) {
    throw new PayPalError("PayPal capture response did not include capture details.", 502);
  }

  return { order: captured, capture };
}

// ─── Verify Webhook Signature ─────────────────────────────────────────────────

export interface WebhookVerificationInput {
  authAlgo: string;
  certUrl: string;
  transmissionId: string;
  transmissionSig: string;
  transmissionTime: string;
  webhookId: string;
  rawBody: string;
}

export interface WebhookVerificationResult {
  verified: boolean;
}

/**
 * Verifies a PayPal webhook using PayPal's own verification endpoint.
 * This is the recommended approach — more reliable than manual PKIX cert verification.
 *
 * https://developer.paypal.com/api/rest/webhooks/#link-verifywebhooksignature
 */
export async function verifyWebhookSignature(
  input: WebhookVerificationInput,
): Promise<WebhookVerificationResult> {
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(input.rawBody);
  } catch {
    return { verified: false };
  }

  try {
    const result = await paypalFetch<{ verification_status: string }>(
      "/v1/notifications/verify-webhook-signature",
      "POST",
      {
        auth_algo: input.authAlgo,
        cert_url: input.certUrl,
        transmission_id: input.transmissionId,
        transmission_sig: input.transmissionSig,
        transmission_time: input.transmissionTime,
        webhook_id: input.webhookId,
        webhook_event: parsedBody,
      },
    );
    return { verified: result.verification_status === "SUCCESS" };
  } catch (err) {
    console.error("[paypal] webhook signature verification failed", err);
    return { verified: false };
  }
}

// ─── Sandbox test helpers ─────────────────────────────────────────────────────

/** Returns true only if the current base URL is the sandbox. */
export function isSandbox(): boolean {
  const base = process.env["PAYPAL_BASE_URL"] ?? "https://api-m.sandbox.paypal.com";
  return base.includes("sandbox");
}

/**
 * Extracts the approve URL from a PayPal order's links array.
 * This is the URL the customer must visit to approve the payment.
 */
export function getApproveUrl(order: PayPalOrder): string | null {
  const link = order.links.find((l) => l.rel === "payer-action" || l.rel === "approve");
  return link?.href ?? null;
}

// ─── Connectivity check ───────────────────────────────────────────────────────

/**
 * Tests PayPal API connectivity and credential validity.
 * Returns a result object rather than throwing so callers can report status.
 */
export async function checkPayPalConnectivity(): Promise<{
  connected: boolean;
  sandbox: boolean;
  error?: string;
}> {
  try {
    await getAccessToken();
    return { connected: true, sandbox: isSandbox() };
  } catch (err) {
    return {
      connected: false,
      sandbox: isSandbox(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
