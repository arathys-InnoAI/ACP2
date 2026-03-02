import Stripe from 'stripe';

/**
 * StripeService
 *
 * Processes payments via Stripe PaymentIntents.
 * Follows ACP protocol — surfaces `requires_action` (3DS) back to the
 * checkout controller so it can respond with `authentication_required`.
 */

// Initialize Stripe with the secret key from environment variables
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
    apiVersion: '2025-01-27.acacia' as any,
});

export class StripeService {
    /**
     * Create and confirm a PaymentIntent.
     *
     * Returns the full PaymentIntent object so the controller can branch on
     * `status`:
     *   • `succeeded`        → payment done
     *   • `requires_action`  → 3DS / SCA challenge needed (ACP authentication_required)
     */
    static async processPayment(amount: number, currency: string, paymentToken: string) {
        try {
            console.log(`[Stripe] Initiating payment for ${amount} ${currency.toUpperCase()} with token: ${paymentToken}`);

            const paymentMethod = await stripe.paymentMethods.create({
                type: 'card',
                card: { token: paymentToken || 'tok_visa' },
            });

            console.log(`[Stripe] Created PaymentMethod: ${paymentMethod.id}`);

            // return_url is required by Stripe when confirm: true so the 3DS
            // challenge can redirect back to the agent UI after completion.
            const paymentIntent = await stripe.paymentIntents.create({
                amount,
                currency: currency.toLowerCase(),
                confirm: true,
                payment_method: paymentMethod.id,
                payment_method_types: ['card'],
                return_url: 'http://localhost:4000/payment-return',
            });

            console.log(`[Stripe] PaymentIntent ${paymentIntent.id} status: ${paymentIntent.status}`);

            return paymentIntent;
        } catch (error: any) {
            console.error('[Stripe] Payment Flow Error:', error.message);
            throw new Error(`Stripe processing failed: ${error.message}`);
        }
    }

    /**
     * Retrieve an existing PaymentIntent to check whether the 3DS challenge
     * has been completed.
     */
    static async retrievePaymentIntent(paymentIntentId: string) {
        return stripe.paymentIntents.retrieve(paymentIntentId);
    }
}
