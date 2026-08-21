import { ConflictException } from '@nestjs/common';
import {
  InstallationAppointmentStatus,
  InstallationAppointmentType,
  InstallationJobStatus,
} from '@prisma/client';
import { InstallationWorkflowService } from './installation-workflow.service';

describe('Installation appointment scheduling', () => {
  const admin = { id: 1, role: { name: 'admin' } };
  const dto = {
    type: InstallationAppointmentType.INSTALLATION,
    startsAt: '2026-08-23T13:32:00.000Z',
  };
  const job = {
    id: 15,
    status: InstallationJobStatus.SCHEDULING,
    estimateId: 11,
    estimate: { idUser: 7, number: '190920' },
    appointments: [],
  };

  function setup(activeStatus: InstallationAppointmentStatus) {
    const tx = {
      installationAppointment: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 30,
            status: activeStatus,
          },
        ]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue({ id: 31 }),
      },
      installationJob: {
        update: jest.fn().mockResolvedValue({}),
      },
    };
    const prisma = {
      $transaction: jest.fn(
        async (callback: (client: typeof tx) => Promise<unknown>) =>
          callback(tx),
      ),
    };
    const notifications = {
      createAndSend: jest.fn().mockResolvedValue({}),
      createAndSendToRoles: jest.fn().mockResolvedValue([]),
    };
    const workflow = new InstallationWorkflowService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      notifications as never,
    );

    return { workflow, tx, notifications };
  }

  it.each([
    InstallationAppointmentStatus.PROPOSED,
    InstallationAppointmentStatus.ACCEPTED,
  ])(
    'blocks another proposal while the current status is %s',
    async (status) => {
      const { workflow, tx } = setup(status);
      jest.spyOn(workflow, 'findJob').mockResolvedValue(job as never);

      await expect(
        workflow.proposeAppointment(15, dto, admin as never),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(tx.installationAppointment.updateMany).not.toHaveBeenCalled();
      expect(tx.installationAppointment.create).not.toHaveBeenCalled();
      expect(tx.installationJob.update).not.toHaveBeenCalled();
    },
  );

  it('allows a replacement only after the project owner requests rescheduling', async () => {
    const { workflow, tx, notifications } = setup(
      InstallationAppointmentStatus.RESCHEDULE_REQUESTED,
    );
    jest
      .spyOn(workflow, 'findJob')
      .mockResolvedValueOnce(job as never)
      .mockResolvedValueOnce(job as never);

    await expect(
      workflow.proposeAppointment(15, dto, admin as never),
    ).resolves.toEqual(job);

    expect(tx.installationAppointment.updateMany).toHaveBeenCalledWith({
      where: {
        jobId: 15,
        type: InstallationAppointmentType.INSTALLATION,
        status: InstallationAppointmentStatus.RESCHEDULE_REQUESTED,
      },
      data: { status: InstallationAppointmentStatus.SUPERSEDED },
    });
    expect(tx.installationAppointment.create).toHaveBeenCalledTimes(1);
    expect(tx.installationJob.update).toHaveBeenCalledTimes(1);
    expect(notifications.createAndSend).toHaveBeenCalledTimes(1);
  });
});
