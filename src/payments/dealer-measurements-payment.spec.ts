import { ForbiddenException } from '@nestjs/common';
import { PaymentStatus } from '@prisma/client';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { ROLES_KEY } from '@/auth/roles.decorator';

const admin = { id: 1, role: { name: 'admin' } } as const;

function fixture(sessionStatus = 'open', paymentStatus = 'unpaid') {
  const payment = {
    id: 30,
    type: 'INSTALLATION_DEPOSIT',
    status: PaymentStatus.PENDING as PaymentStatus,
    stripeSessionId: 'cs_deposit' as string | null,
  };
  const job: any = {
    id: 4,
    estimate: { payments: [payment] },
    dealerMeasurementsAcceptedAt: null,
  };
  const workflow = {
    findJob: jest.fn().mockResolvedValue(job),
    assertDealerMeasurementsCanBeAccepted: jest.fn(),
    acceptDealerMeasurements: jest.fn(async () => ({
      ...job,
      dealerMeasurementsAcceptedAt: new Date(),
    })),
  };
  const tx = {
    payment: {
      updateMany: jest.fn(async ({ where, data }) => {
        if (
          payment.status === PaymentStatus.PAID ||
          payment.stripeSessionId !== where.stripeSessionId
        )
          return { count: 0 };
        Object.assign(payment, data);
        return { count: 1 };
      }),
    },
  };
  const prisma: any = { ...tx, $transaction: jest.fn((work) => work(tx)) };
  const service = new PaymentsService(
    prisma,
    { get: () => 'sk_test_local_only' } as never,
    workflow as never,
    {} as never,
  );
  const sessions = {
    retrieve: jest.fn().mockResolvedValue({
      id: 'cs_deposit',
      status: sessionStatus,
      payment_status: paymentStatus,
    }),
    expire: jest
      .fn()
      .mockResolvedValue({ id: 'cs_deposit', status: 'expired' }),
  };
  (service as any).stripe = { checkout: { sessions } };
  const processPaid = jest
    .spyOn(service as any, 'processPaidCheckoutSession')
    .mockImplementation(async () => {
      payment.status = PaymentStatus.PAID;
      return true;
    });
  return { service, workflow, payment, job, sessions, tx, processPaid };
}

describe('Closing deposit checkout before accepting dealer measurements', () => {
  it('allows admins and dealers through HTTP, with ownership checked in the workflow', () => {
    expect(
      Reflect.getMetadata(
        ROLES_KEY,
        PaymentsController.prototype.acceptDealerMeasurements,
      ),
    ).toEqual(['admin', 'dealer']);
  });

  it.each(['client', 'operator'] as const)(
    'rejects %s before touching Stripe or the job',
    async (role) => {
      const f = fixture();
      await expect(
        f.service.acceptDealerMeasurements(4, { id: 7, role: { name: role } }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(f.workflow.findJob).not.toHaveBeenCalled();
      expect(f.sessions.retrieve).not.toHaveBeenCalled();
    },
  );

  it('validates ownership and project eligibility before closing a checkout', async () => {
    const f = fixture();
    f.workflow.assertDealerMeasurementsCanBeAccepted.mockImplementation(() => {
      throw new Error('Not the internal owner.');
    });
    await expect(f.service.acceptDealerMeasurements(4, admin)).rejects.toThrow(
      'Not the internal owner.',
    );
    expect(f.sessions.retrieve).not.toHaveBeenCalled();
    expect(f.tx.payment.updateMany).not.toHaveBeenCalled();
  });

  it('allows an eligible dealer through the same safe Stripe closure', async () => {
    const f = fixture();
    const actor = { id: 7, role: { name: 'dealer' } } as const;
    await f.service.acceptDealerMeasurements(4, actor);
    expect(
      f.workflow.assertDealerMeasurementsCanBeAccepted,
    ).toHaveBeenCalledWith(f.job, actor);
    expect(f.sessions.expire).toHaveBeenCalledWith('cs_deposit');
    expect(f.workflow.acceptDealerMeasurements).toHaveBeenCalledWith(4, actor);
  });

  it('expires an open session before canceling its unpaid record and authorizing', async () => {
    const f = fixture();
    await f.service.acceptDealerMeasurements(4, admin);
    expect(f.sessions.expire).toHaveBeenCalledWith('cs_deposit');
    expect(f.payment.status).toBe(PaymentStatus.CANCELED);
    expect(f.payment.stripeSessionId).toBeNull();
    expect(f.processPaid).not.toHaveBeenCalled();
    expect(f.workflow.acceptDealerMeasurements).toHaveBeenCalledWith(4, admin);
    expect(f.sessions.expire.mock.invocationCallOrder[0]).toBeLessThan(
      f.tx.payment.updateMany.mock.invocationCallOrder[0],
    );
    expect(f.tx.payment.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      f.workflow.acceptDealerMeasurements.mock.invocationCallOrder[0],
    );
  });

  it('accepts without contacting Stripe when no checkout was started', async () => {
    const f = fixture();
    f.payment.stripeSessionId = null;
    await f.service.acceptDealerMeasurements(4, admin);
    expect(f.sessions.retrieve).not.toHaveBeenCalled();
    expect(f.tx.payment.updateMany).not.toHaveBeenCalled();
    expect(f.workflow.acceptDealerMeasurements).toHaveBeenCalledTimes(1);
  });

  it('closes an already expired session', async () => {
    const f = fixture('expired');
    await f.service.acceptDealerMeasurements(4, admin);
    expect(f.sessions.expire).not.toHaveBeenCalled();
    expect(f.payment.status).toBe(PaymentStatus.CANCELED);
    expect(f.workflow.acceptDealerMeasurements).toHaveBeenCalledTimes(1);
  });

  it('processes a confirmed Stripe deposit and refuses the exception', async () => {
    const f = fixture('complete', 'paid');
    await expect(f.service.acceptDealerMeasurements(4, admin)).rejects.toThrow(
      'already confirmed this charge as paid',
    );
    expect(f.payment.status).toBe(PaymentStatus.PAID);
    expect(f.sessions.expire).not.toHaveBeenCalled();
    expect(f.tx.payment.updateMany).not.toHaveBeenCalled();
    expect(f.workflow.acceptDealerMeasurements).not.toHaveBeenCalled();
  });

  it('refuses a completed session still awaiting payment confirmation', async () => {
    const f = fixture('complete');
    await expect(f.service.acceptDealerMeasurements(4, admin)).rejects.toThrow(
      'confirmation is still pending',
    );
    expect(f.sessions.expire).not.toHaveBeenCalled();
    expect(f.tx.payment.updateMany).not.toHaveBeenCalled();
    expect(f.workflow.acceptDealerMeasurements).not.toHaveBeenCalled();
  });

  it('handles payment completing while session expiration is attempted', async () => {
    const f = fixture();
    f.sessions.expire.mockRejectedValueOnce(new Error('Already complete'));
    f.sessions.retrieve
      .mockResolvedValueOnce({
        id: 'cs_deposit',
        status: 'open',
        payment_status: 'unpaid',
      })
      .mockResolvedValueOnce({
        id: 'cs_deposit',
        status: 'complete',
        payment_status: 'paid',
      });
    await expect(f.service.acceptDealerMeasurements(4, admin)).rejects.toThrow(
      'already confirmed this charge as paid',
    );
    expect(f.payment.status).toBe(PaymentStatus.PAID);
    expect(f.tx.payment.updateMany).not.toHaveBeenCalled();
    expect(f.workflow.acceptDealerMeasurements).not.toHaveBeenCalled();
  });

  it.each(['resource_missing', 'api_connection_error'])(
    'does not waive a deposit when Stripe cannot verify closure (%s)',
    async (code) => {
      const f = fixture();
      f.sessions.retrieve.mockRejectedValueOnce(
        Object.assign(new Error(code), { code }),
      );
      await expect(
        f.service.acceptDealerMeasurements(4, admin),
      ).rejects.toThrow(code);
      expect(f.payment.stripeSessionId).toBe('cs_deposit');
      expect(f.tx.payment.updateMany).not.toHaveBeenCalled();
      expect(f.workflow.acceptDealerMeasurements).not.toHaveBeenCalled();
    },
  );

  it('returns the original acceptance without touching payments on a repeated request', async () => {
    const f = fixture();
    f.job.dealerMeasurementsAcceptedAt = new Date();
    expect(await f.service.acceptDealerMeasurements(4, admin)).toBe(f.job);
    expect(f.sessions.retrieve).not.toHaveBeenCalled();
    expect(f.workflow.acceptDealerMeasurements).not.toHaveBeenCalled();
  });
});
