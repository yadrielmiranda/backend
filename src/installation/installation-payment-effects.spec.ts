import {
  InstallationAppointmentStatus,
  InstallationJobStatus,
  InstallationPermitStatus,
  InstallationQuoteStatus,
  OrderExtraChargeStatus,
  PaymentType,
} from '@prisma/client';
import { InstallationWorkflowService } from './installation-workflow.service';

describe('Installation payment effects', () => {
  const workflow = new InstallationWorkflowService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  it('applies the deposit effect once without creating repeated quote versions', async () => {
    const tx = {
      installationJob: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({
            status: InstallationJobStatus.DEPOSIT_PAYMENT_PENDING,
          })
          .mockResolvedValueOnce({
            status: InstallationJobStatus.MEASUREMENT_SCHEDULING,
          }),
        update: jest.fn().mockResolvedValue({}),
      },
      installationQuote: {
        findFirst: jest.fn().mockResolvedValue({
          id: 20,
          jobId: 5,
          version: 1,
          status: InstallationQuoteStatus.DRAFT,
          lines: [],
        }),
        update: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockResolvedValue({}),
      },
    };
    const payment = {
      type: PaymentType.INSTALLATION_DEPOSIT,
      installationJobId: 5,
      extraChargeId: null,
    };

    await expect(workflow.markPaymentPaid(tx as never, payment)).resolves.toBe(
      true,
    );
    await expect(workflow.markPaymentPaid(tx as never, payment)).resolves.toBe(
      false,
    );

    expect(tx.installationQuote.create).toHaveBeenCalledTimes(1);
    expect(tx.installationJob.update).toHaveBeenCalledTimes(1);
  });

  it('repairs permit payment and does not regress permit processing', async () => {
    const paidAt = new Date('2026-08-06T13:00:00Z');
    const pendingPermit = {
      id: 8,
      jobId: 5,
      status: InstallationPermitStatus.PAYMENT_PENDING,
      paidAt: null,
      cityFee: null,
    };
    const tx = {
      installationJob: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({
            status: InstallationJobStatus.PERMIT_PAYMENT_PENDING,
            permit: pendingPermit,
          })
          .mockResolvedValueOnce({
            status: InstallationJobStatus.PERMIT_PROCESSING,
            permit: {
              ...pendingPermit,
              status: InstallationPermitStatus.PAID,
              paidAt,
            },
          }),
        update: jest.fn().mockResolvedValue({}),
      },
      installationPermit: {
        update: jest.fn().mockResolvedValue({
          ...pendingPermit,
          status: InstallationPermitStatus.PAID,
          paidAt,
        }),
      },
    };
    const payment = {
      type: PaymentType.PERMIT,
      installationJobId: 5,
      extraChargeId: null,
    };

    await expect(workflow.markPaymentPaid(tx as never, payment)).resolves.toBe(
      true,
    );
    await expect(workflow.markPaymentPaid(tx as never, payment)).resolves.toBe(
      false,
    );

    expect(tx.installationPermit.update).toHaveBeenCalledTimes(1);
    expect(tx.installationJob.update).toHaveBeenCalledTimes(1);
    expect(tx.installationJob.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { status: InstallationJobStatus.PERMIT_PROCESSING },
    });
  });

  it('applies the material installation effect once', async () => {
    const tx = {
      installationJob: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({
            status: InstallationJobStatus.MATERIAL_PAYMENT_PENDING,
          })
          .mockResolvedValueOnce({
            status: InstallationJobStatus.MATERIAL_PAID,
          }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const payment = {
      type: PaymentType.MATERIAL,
      installationJobId: 5,
      extraChargeId: null,
    };

    await expect(workflow.markPaymentPaid(tx as never, payment)).resolves.toBe(
      true,
    );
    await expect(workflow.markPaymentPaid(tx as never, payment)).resolves.toBe(
      false,
    );

    expect(tx.installationJob.update).toHaveBeenCalledTimes(1);
  });

  it('restores the correct installation stage once', async () => {
    const tx = {
      installationJob: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({
            status: InstallationJobStatus.INSTALLATION_PAYMENT_PENDING,
            completedAt: null,
            appointments: [{ status: InstallationAppointmentStatus.ACCEPTED }],
          })
          .mockResolvedValueOnce({
            status: InstallationJobStatus.SCHEDULED,
            completedAt: null,
            appointments: [{ status: InstallationAppointmentStatus.ACCEPTED }],
          }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const payment = {
      type: PaymentType.INSTALLATION,
      installationJobId: 5,
      extraChargeId: null,
    };

    await expect(workflow.markPaymentPaid(tx as never, payment)).resolves.toBe(
      true,
    );
    await expect(workflow.markPaymentPaid(tx as never, payment)).resolves.toBe(
      false,
    );

    expect(tx.installationJob.update).toHaveBeenCalledTimes(1);
    expect(tx.installationJob.update).toHaveBeenCalledWith({
      where: { id: 5 },
      data: { status: InstallationJobStatus.SCHEDULED },
    });
  });

  it('marks an extra charge paid once', async () => {
    const paidAt = new Date('2026-08-06T14:00:00Z');
    const tx = {
      orderExtraCharge: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({
            id: 12,
            status: OrderExtraChargeStatus.PAYMENT_DUE,
            paidAt: null,
          })
          .mockResolvedValueOnce({
            id: 12,
            status: OrderExtraChargeStatus.PAID,
            paidAt,
          }),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const payment = {
      type: PaymentType.EXTRA,
      installationJobId: 5,
      extraChargeId: 12,
    };

    await expect(workflow.markPaymentPaid(tx as never, payment)).resolves.toBe(
      true,
    );
    await expect(workflow.markPaymentPaid(tx as never, payment)).resolves.toBe(
      false,
    );

    expect(tx.orderExtraCharge.update).toHaveBeenCalledTimes(1);
  });
});
