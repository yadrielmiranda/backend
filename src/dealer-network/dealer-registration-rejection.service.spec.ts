import { DealerRegistrationRejectionService } from './dealer-registration-rejection.service';
import { renderRegistrationResultEmail, renderRegistrationResultSms } from './dealer-registration-result-template';
import { renderWelcomeEmail } from '@/mail/welcome-email-template';

const applicant = {
  id: 84, phone: '+13055550114', email: 'applicant@example.test',
  serviceSmsAccepted: true, smsConsentedAt: new Date(), smsConsentVersion: 'test-version', smsConsentText: 'Service notice.',
};

function fixture() {
  const delivery = { requestId: applicant.id, channel: 'SMS', destination: applicant.phone,
    smsConsentVersion: applicant.smsConsentVersion, smsConsentText: applicant.smsConsentText,
    smsConsentedAt: applicant.smsConsentedAt, attempts: 0 };
  const queue = {
    createMany: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }), findMany: jest.fn().mockResolvedValue([delivery]),
  };
  const db = { dealerRegistrationRejectionDelivery: queue, smsPhoneBlock: { findUnique: jest.fn().mockResolvedValue(null) },
    smsConsentEvent: { findFirst: jest.fn().mockResolvedValue(null) } };
  const email = { canSendAccountWelcomeEmail: jest.fn().mockReturnValue(true), sendDealerRegistrationRejection: jest.fn() };
  const sms = { canSendAccountWelcomeSms: jest.fn().mockReturnValue(true),
    sendDealerRegistrationRejectionSms: jest.fn().mockResolvedValue({ status: 'ACCEPTED', providerMessageSid: 'test-id' }) };
  return { service: new DealerRegistrationRejectionService(db as never, email as never, sms as never), db, email, sms, queue, delivery };
}

describe('dealer registration outcomes', () => {
  it('sends an English approval with sign-in and a separate English rejection', () => {
    const welcome = renderWelcomeEmail({ firstName: 'Test', username: 'applicant', roleName: 'dealer', isDealerApproval: true,
      origin: 'https://portal.example.test', companyName: 'Fixture Company', supportEmail: 'support@example.test' });
    const rejected = renderRegistrationResultEmail(false, 'Fixture Company', 'https://portal.example.test');
    expect(welcome.subject).toContain('was approved');
    expect(welcome.text).toContain('https://portal.example.test/login');
    expect(welcome.html).toContain('Sign in');
    expect(rejected.text).toContain('was not approved');
    expect(rejected.html).not.toContain('/login');
    expect(renderRegistrationResultSms(true, 'https://portal.example.test')).toContain('https://portal.example.test/login');
    expect(renderRegistrationResultSms(false)).toContain('was not approved');
    expect(renderRegistrationResultSms(false)).toContain('STOP');
  });

  it('does not queue or process local email or SMS, even for an opted-in applicant', async () => {
    const f = fixture();
    f.email.canSendAccountWelcomeEmail.mockReturnValue(false);
    f.sms.canSendAccountWelcomeSms.mockReturnValue(false);
    await f.service.enqueue(applicant, f.db as never);
    await f.service.processPending();
    expect(f.queue.createMany).not.toHaveBeenCalled();
    expect(f.queue.findMany).not.toHaveBeenCalled();
    expect(f.sms.sendDealerRegistrationRejectionSms).not.toHaveBeenCalled();
    expect(f.email.sendDealerRegistrationRejection).not.toHaveBeenCalled();
  });

  it('enqueues independent, deduplicated email and SMS with the original destination and evidence', async () => {
    const f = fixture();
    await f.service.enqueue(applicant, f.db as never);
    expect(f.queue.createMany).toHaveBeenCalledWith({ skipDuplicates: true, data: [
      { requestId: applicant.id, channel: 'EMAIL', destination: applicant.email },
      { requestId: applicant.id, channel: 'SMS', destination: applicant.phone,
        smsConsentedAt: applicant.smsConsentedAt, smsConsentVersion: applicant.smsConsentVersion, smsConsentText: applicant.smsConsentText },
    ] });
  });

  it.each([{ serviceSmsAccepted: false }, { smsConsentVersion: null }, { phone: '+442079460123' }])(
    'still queues the rejection email when SMS is ineligible (%j)', async change => {
      const f = fixture();
      await f.service.enqueue({ ...applicant, ...change }, f.db as never);
      expect(f.queue.createMany.mock.calls[0][0].data.map((row: { channel: string }) => row.channel)).toEqual(['EMAIL']);
    },
  );

  it.each(['current', 'since submission'])('honors a STOP (%s) at the time of sending', async source => {
    const f = fixture();
    if (source === 'current') f.db.smsPhoneBlock.findUnique.mockResolvedValue({ createdAt: new Date() });
    else f.db.smsConsentEvent.findFirst.mockResolvedValue({ createdAt: new Date() });
    await f.service.processPending();
    expect(f.sms.sendDealerRegistrationRejectionSms).not.toHaveBeenCalled();
    expect(f.queue.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'SKIPPED', errorCode: 'SMS_PERMISSION_UNAVAILABLE' } }));
  });

  it('delivers a rejection email without looking up or creating a user', async () => {
    const f = fixture();
    f.queue.findMany.mockResolvedValue([{ ...f.delivery, channel: 'EMAIL', destination: applicant.email }]);
    f.email.sendDealerRegistrationRejection.mockResolvedValue({ status: 'ACCEPTED', providerMessageId: '<mail>' });
    await f.service.processPending();
    expect(f.email.sendDealerRegistrationRejection).toHaveBeenCalledWith(applicant.email);
    expect(f.sms.sendDealerRegistrationRejectionSms).not.toHaveBeenCalled();
    expect(f.queue.updateMany.mock.calls.at(-1)![0].data).toEqual({ status: 'ACCEPTED', errorCode: null, providerMessageId: '<mail>' });
  });

  it.each([['ACCEPTED', 'ACCEPTED'], ['RETRY', 'PENDING'], ['UNKNOWN', 'UNKNOWN'], ['FAILED', 'FAILED']])(
    'records %s from the transport as %s', async (outcome, status) => {
      const f = fixture();
      f.sms.sendDealerRegistrationRejectionSms.mockResolvedValue({ status: outcome, errorCode: 'provider-status' });
      await f.service.processPending();
      expect(f.sms.sendDealerRegistrationRejectionSms).toHaveBeenCalledWith(applicant.phone);
      const transition = f.queue.updateMany.mock.calls.at(-1)![0];
      expect(transition.data.status).toBe(status);
      expect(transition.where).toEqual({ requestId: applicant.id, channel: 'SMS', status: 'SENDING', attempts: 1 });
    },
  );
});
