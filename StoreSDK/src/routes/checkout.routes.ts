import { Router } from 'express';
import { CheckoutController } from '../controllers/checkout.controller';

const router = Router();

router.post('/', CheckoutController.createSession);
router.get('/:checkout_session_id', CheckoutController.getSession);
router.post('/:checkout_session_id', CheckoutController.updateSession);
router.post('/:checkout_session_id/complete', CheckoutController.completeSession);
router.post('/:checkout_session_id/confirm_authentication', CheckoutController.confirmAuthentication);
router.post('/:checkout_session_id/cancel', CheckoutController.cancelSession);

export default router;

