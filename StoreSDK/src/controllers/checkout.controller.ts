import { Request, Response } from 'express';
import { ShopifyStorefrontService } from '../services/shopify.service';
import { StripeService } from '../services/stripe.service';
import { v4 as uuidv4 } from 'uuid';

/**
 * In-memory session store for ACP checkout sessions.
 *
 * In production, this should be replaced with a persistent store
 * (e.g. Redis, DynamoDB) to support horizontal scaling and durability.
 */
const sessionsStore: Record<string, any> = {};

export class CheckoutController {
    /**
     * POST /checkout_sessions
     *
     * Creates a new ACP checkout session. Looks up each item's real price
     * from the Shopify Storefront API to ensure the cart total is authoritative.
     */
    static async createSession(req: Request, res: Response): Promise<void> {
        try {
            const { items, fulfillment_details, capabilities } = req.body;
            console.log(`[StoreSDK] Creating session for ${items?.length} items`);

            if (!items || items.length === 0) {
                res.status(400).json({ error: { code: 'invalid_request', message: 'At least one item is required.' } });
                return;
            }

            // Fetch authoritative prices for each item from Shopify Storefront API
            let totalCents = 0;
            let currency = 'USD';
            const resolvedItems = await Promise.all(
                items.map(async (item: any) => {
                    const variantInfo = await ShopifyStorefrontService.getVariantPrice(item.id);
                    if (!variantInfo) {
                        throw new Error(`Product variant "${item.id}" not found in Shopify. Please use a valid ID from the catalog search.`);
                    }
                    const unitPriceCents = Math.round(parseFloat(variantInfo.price) * 100);
                    currency = variantInfo.currencyCode;
                    totalCents += unitPriceCents * (item.quantity || 1);
                    return {
                        id: item.id,
                        name: item.name || variantInfo.productTitle || '',
                        quantity: item.quantity || 1,
                        unit_amount: unitPriceCents,
                    };
                })
            );

            const sessionId = `cs_${uuidv4()}`;

            const session = {
                id: sessionId,
                status: 'open',
                items: resolvedItems,
                cart_total: { currency, amount: totalCents },
                // Capabilities echoed back per ACP spec: agent extensions, payment handlers
                capabilities: capabilities || {},
                created_at: new Date().toISOString(),
                expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
                fulfillment_details: fulfillment_details || null,
                // Available payment methods supported by this merchant
                payment_methods: [
                    { method: 'card', brands: ['visa', 'mastercard', 'amex'], funding_types: ['credit', 'debit'] }
                ],
                // Required fulfillment info fields (agent should collect if missing)
                required_fields: fulfillment_details ? [] : ['fulfillment_details.address', 'fulfillment_details.email'],
            };

            sessionsStore[sessionId] = session;

            // Echo the idempotency key per ACP spec
            if (req.headers['idempotency-key']) {
                res.setHeader('Idempotency-Key', req.headers['idempotency-key'] as string);
            }

            res.status(201).json(session);
        } catch (error: any) {
            console.error('[ACP] createSession error:', error);
            res.status(500).json({ error: { code: 'server_error', message: error.message } });
        }
    }

    /**
     * GET /checkout_sessions/:checkout_session_id
     *
     * Returns the authoritative current state of a checkout session.
     */
    static async getSession(req: Request, res: Response): Promise<void> {
        const id = req.params.checkout_session_id as string;
        const session = sessionsStore[id];
        if (!session) {
            res.status(404).json({ error: { code: 'not_found', message: 'Session not found' } });
            return;
        }
        res.status(200).json(session);
    }

    /**
     * POST /checkout_sessions/:checkout_session_id
     *
     * Updates the session (e.g. adds address, selects shipping option).
     * Returns the full updated session state.
     */
    static async updateSession(req: Request, res: Response): Promise<void> {
        const id = req.params.checkout_session_id as string;
        const session = sessionsStore[id];
        if (!session) {
            res.status(404).json({ error: { code: 'not_found', message: 'Session not found' } });
            return;
        }

        // Merge updates into session — ACP allows updating fulfillment details or items
        if (req.body.fulfillment_details) {
            session.fulfillment_details = req.body.fulfillment_details;
            // Once address is provided, clear it from required_fields
            session.required_fields = session.required_fields.filter(
                (f: string) => !f.startsWith('fulfillment_details')
            );
        }
        if (req.body.items) {
            session.items = req.body.items;
        }

        res.status(200).json(session);
    }

    /**
     * POST /checkout_sessions/:checkout_session_id/complete
     *
     * Finalizes the checkout by processing the payment via Stripe.
     *
     * Per ACP spec (v2026-01-30):
     *   • If Stripe returns `succeeded`        → session status = `completed`
     *   • If Stripe returns `requires_action`  → session status = `authentication_required`
     *     with `next_action` containing the 3DS redirect URL for the agent/UI.
     */
    static async completeSession(req: Request, res: Response): Promise<void> {
        const id = req.params.checkout_session_id as string;
        const { payment_data, buyer } = req.body;
        console.log(`[StoreSDK] Completing session: ${id}`);

        const session = sessionsStore[id];
        if (!session) {
            res.status(404).json({ error: { code: 'not_found', message: 'Session not found' } });
            return;
        }
        if (session.status !== 'open') {
            res.status(400).json({ error: { code: 'invalid_state', message: `Session is already ${session.status}` } });
            return;
        }

        try {
            const paymentIntent = await StripeService.processPayment(
                session.cart_total.amount,
                session.cart_total.currency.toLowerCase(),
                payment_data?.token || ''
            );

            session.buyer = buyer;

            // ── ACP: requires_action → authentication_required ──────────
            if (paymentIntent.status === 'requires_action') {
                session.status = 'authentication_required';
                session.payment_intent_id = paymentIntent.id;

                const redirectUrl =
                    (paymentIntent.next_action as any)?.redirect_to_url?.url || null;

                res.status(200).json({
                    ...session,
                    next_action: {
                        type: 'redirect',
                        url: redirectUrl,
                    },
                });
                return;
            }

            // ── ACP: succeeded → completed ──────────────────────────────
            session.status = 'completed';

            res.status(200).json({
                ...session,
                order: {
                    id: `order_${uuidv4()}`,
                    status: 'confirmed',
                    total: session.cart_total,
                    merchant_reference: paymentIntent.id,
                    receipt_url: (paymentIntent as any).latest_charge?.receipt_url || null,
                },
            });
        } catch (error: any) {
            res.status(400).json({ error: { code: 'payment_failed', message: error.message } });
        }
    }

    /**
     * POST /checkout_sessions/:checkout_session_id/confirm_authentication
     *
     * Called after the buyer completes the 3DS challenge.
     * Retrieves the PaymentIntent from Stripe and, if it is now `succeeded`,
     * marks the ACP session as `completed`.
     */
    static async confirmAuthentication(req: Request, res: Response): Promise<void> {
        const id = req.params.checkout_session_id as string;
        const session = sessionsStore[id];

        if (!session) {
            res.status(404).json({ error: { code: 'not_found', message: 'Session not found' } });
            return;
        }
        if (session.status !== 'authentication_required') {
            res.status(400).json({
                error: { code: 'invalid_state', message: `Session status is "${session.status}", expected "authentication_required".` },
            });
            return;
        }

        try {
            const paymentIntent = await StripeService.retrievePaymentIntent(session.payment_intent_id);

            if (paymentIntent.status === 'succeeded') {
                session.status = 'completed';

                res.status(200).json({
                    ...session,
                    order: {
                        id: `order_${uuidv4()}`,
                        status: 'confirmed',
                        total: session.cart_total,
                        merchant_reference: paymentIntent.id,
                        receipt_url: (paymentIntent as any).latest_charge?.receipt_url || null,
                    },
                });
            } else {
                res.status(200).json({
                    ...session,
                    payment_status: paymentIntent.status,
                    message: `Payment not yet complete. Current status: ${paymentIntent.status}`,
                });
            }
        } catch (error: any) {
            res.status(500).json({ error: { code: 'server_error', message: error.message } });
        }
    }

    /**
     * POST /checkout_sessions/:checkout_session_id/cancel
     *
     * Cancels an open session. Returns 405 if already completed.
     */
    static async cancelSession(req: Request, res: Response): Promise<void> {
        const id = req.params.checkout_session_id as string;
        const session = sessionsStore[id];
        if (!session) {
            res.status(404).json({ error: { code: 'not_found', message: 'Session not found' } });
            return;
        }
        if (session.status === 'completed') {
            res.status(405).json({ error: { code: 'not_cancelable', message: 'Completed sessions cannot be canceled' } });
            return;
        }

        session.status = 'canceled';
        res.status(200).json(session);
    }
}

