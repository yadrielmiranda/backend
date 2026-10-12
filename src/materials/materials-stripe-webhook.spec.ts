import { PaymentsService } from '@/payments/payments.service';

describe('Material dispatch through the existing verified Stripe webhook', () => {
  function fixture(handled: boolean) {
    const db: any = { $transaction: jest.fn(async work => work({})) };
    const config: any = { get: (key: string) => ({ STRIPE_SECRET_KEY: 'sk_test_mock', STRIPE_WEBHOOK_SECRET: 'whsec_mock' })[key] };
    const materials: any = { handleVerifiedStripeEvent: jest.fn(async () => handled) };
    const service = new PaymentsService(db, config, {} as any, {} as any, materials);
    const stripe = (service as any).stripe;
    const event: any = { type: 'checkout.session.completed', data: { object: { id: 'cs_mock' } } };
    stripe.webhooks.constructEvent = jest.fn(() => event);
    const previousCheckout = jest.spyOn(service as any, 'processPaidCheckoutSession').mockResolvedValue(undefined);
    return { service, stripe, event, materials, previousCheckout };
  }

  it('rejects an invalid signature before calling any material payment handler', async () => {
    const f = fixture(true);
    f.stripe.webhooks.constructEvent.mockImplementation(() => { throw new Error('bad signature'); });
    await expect(f.service.handleStripeWebhook(Buffer.from('body'), 'invalid')).rejects.toThrow('Invalid Stripe signature');
    expect(f.materials.handleVerifiedStripeEvent).not.toHaveBeenCalled();
    expect(f.previousCheckout).not.toHaveBeenCalled();
  });

  it('routes verified material events without invoking estimate payment processing', async () => {
    const f = fixture(true);
    await expect(f.service.handleStripeWebhook(Buffer.from('body'), 'signature')).resolves.toEqual({ received: true });
    expect(f.materials.handleVerifiedStripeEvent).toHaveBeenCalledWith(f.event);
    expect(f.previousCheckout).not.toHaveBeenCalled();
  });

  it('preserves existing estimate checkout handling for nonmaterial events', async () => {
    const f = fixture(false);
    await f.service.handleStripeWebhook(Buffer.from('body'), 'signature');
    expect(f.previousCheckout).toHaveBeenCalledWith({}, f.event.data.object);
  });
});
