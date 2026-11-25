// Run with node scripts/test-dealer-registration-mysql.cjs from the backend.
// Uses a disposable MySQL database, real HTTP sessions and the real welcome outbox.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PrismaClient } = require('@prisma/client');

process.chdir(path.resolve(__dirname, '..'));
async function verifyRegistration(db) {
  process.env.NODE_ENV = 'test';
  process.env.EMAIL_DELIVERY_ENABLED = 'false';
  process.env.SMS_DELIVERY_ENABLED = 'false';
  process.env.JWT_SECRET_KEY = randomUUID();
  require('ts-node/register/transpile-only');
  require('tsconfig-paths/register');
  const { ConfigModule } = require('@nestjs/config');
  const { ValidationPipe } = require('@nestjs/common');
  const { Reflector } = require('@nestjs/core');
  const { Test } = require('@nestjs/testing');
  const { JwtService } = require('@nestjs/jwt');
  const { JwtAuthGuard } = require('../src/auth/guards/auth/auth.guard');
  const { AuthModule } = require('../src/auth/auth.module');
  const { DeliveryCoverageService } = require('../src/deliveries/delivery-coverage.service');
  const { SessionTouchGuard } = require('../src/auth/guards/auth/session-touch.guard');
  const { RolesGuard } = require('../src/auth/guards/roles/roles.guard');
  const { ResponsePrivacyInterceptor } = require('../src/common/response-privacy.interceptor');
  const { DealerNetworkModule } = require('../src/dealer-network/dealer-network.module');
  const { PlatformTermsGuard } = require('../src/platform-terms/platform-terms.guard');
  const { PlatformTermsService } = require('../src/platform-terms/platform-terms.service');
  const { PlatformTermsModule } = require('../src/platform-terms/platform-terms.module');
  const { PrismaModule } = require('../src/prisma/prisma.module');
  const { PrismaService } = require('../src/prisma/prisma.service');

  // No scheduled workers or external mail/SMS transport run in this test module.
  const fixture = Test.createTestingModule({
    imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), PrismaModule, AuthModule, PlatformTermsModule, DealerNetworkModule],
  });
  fixture.overrideProvider(DeliveryCoverageService).useValue({ checkAddress: async () => ({ available: true }) });
  if (db) fixture.overrideProvider(PrismaService).useValue(db);
  const module = await fixture.compile();
  const app = module.createNestApplication();
  db = module.get(PrismaService);
  const reflector = module.get(Reflector);
  app.use(require('cookie-parser')());
  app.useGlobalGuards(new JwtAuthGuard(reflector), new RolesGuard(reflector), new SessionTouchGuard(db, reflector),
    new PlatformTermsGuard(reflector, module.get(PlatformTermsService)));
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, transformOptions: { enableImplicitConversion: true } }));
  app.useGlobalInterceptors(new ResponsePrivacyInterceptor());
  app.setGlobalPrefix('api');
  const pipeName = 'impact-registration-' + randomUUID();
  const socket = process.platform === 'win32' ? '//./pipe/' + pipeName : path.join(os.tmpdir(), pipeName);
  try {
    await app.listen(socket);
    const http = require('supertest')('http+unix://' + socket.replaceAll('/', '%2F'));
    await exerciseFlow(db, http, new JwtService({ secret: process.env.JWT_SECRET_KEY }));
  } finally {
    try { await app.close(); }
    finally { await db.$disconnect(); }
  }
}

async function exerciseFlow(db, http, jwt) {
  const { defaultPlan } = require('../src/payment-plans/payment-plan');
  const { resolveNewPlan } = require('../src/payment-plans/payment-schedule');
  const { InstallationPricingService } = require('../src/installation/installation-pricing.service');
  const pricing = new InstallationPricingService(db);
  async function session(account) {
    const session = await db.session.create({ data: {
      userId: account.id, refreshTokenHash: 'unused', expiresAt: new Date(Date.now() + 3600_000),
    } });
    const token = jwt.sign({ sub: account.id, sid: session.id, tokenType: 'access',
      passwordVersion: account.passwordUpdatedAt.getTime() }, { expiresIn: '1h' });
    return 'access_token=' + token;
  }

  const plan = await db.paymentPlan.create({ data: { name: 'Registration fixture', definition: defaultPlan } });
  const profile = await db.installationPriceProfile.create({ data: { name: 'Registration fixture' } });
  await db.globalParameter.upsert({ where: { key: 'SALES_TAX' }, update: { value: '0.09' }, create: { key: 'SALES_TAX', value: '0.09' } });
  const fullPrecisionRatio = '123456.789012345678901234';
  const fullPrecisionPercent = '12345678.9012345678901234';
  const dealerDefaults = { paymentPlanId: plan.id, installationPriceProfileId: profile.id, markup: fullPrecisionRatio };
  await db.role.upsert({ where: { name: 'dealer' }, update: dealerDefaults, create: { name: 'dealer', ...dealerDefaults } });
  async function seedAccount(name, username) {
    const role = await db.role.upsert({ where: { name }, update: {}, create: { name } });
    return db.user.create({ data: { username, firstName: 'Test', lastName: username, password: 'unused',
      idRole: role.id, ...(name === 'dealer' ? { dealerMode: 'EXTERNAL' } : {}) } });
  }
  const base = '/api/dealer-network';
  const invitation = base + '/invitation';
  const requests = base + '/registration-requests';
  const admins = [await seedAccount('admin', 'test.admin'), await seedAccount('admin', 'review.admin')];
  const disabledAdmin = await seedAccount('admin', 'disabled.admin');
  await db.user.update({ where: { id: disabledAdmin.id }, data: { isActive: false } });
  const deletedAdmin = await seedAccount('admin', 'deleted.admin');
  await db.user.update({ where: { id: deletedAdmin.id }, data: { deletedAt: new Date() } });
  const accountEvents = { dedupeKey: { startsWith: 'account:' } };
  async function checkAccountNotice(account, role, mode) {
    const notices = await db.notification.findMany({
      where: { dedupeKey: 'account:' + account.id + ':created:admin' }, orderBy: { recipientId: 'asc' },
    });
    assert.deepEqual(notices.map(notice => notice.recipientId), admins.map(admin => admin.id));
    for (const notice of notices) {
      const lines = ['New account created', 'Username: ' + account.username, 'Role: ' + role];
      if (mode) lines.push('Type: ' + mode);
      assert.equal(notice.message, lines.join('\n'));
    }
  }
  const [admin, secondAdmin] = await Promise.all(admins.map(session));
  const otherDealer = await seedAccount('dealer', 'other.branch');
  const otherBranch = await session(otherDealer);
  const termsText = 'Dealer registration test terms.';
  const { PLATFORM_TERMS_CONSENT } = require('../src/platform-terms/platform-terms.policy');
  const terms = await db.platformTermsVersion.create({ data: { originalName: 'Terms and Conditions',
    content: termsText, consentText: PLATFORM_TERMS_CONSENT, sizeBytes: Buffer.byteLength(termsText),
    sourceHash: createHash('sha256').update(termsText).digest('hex') } });
  await db.platformTermsState.update({ where: { id: 1 }, data: { currentVersionId: terms.id } });
  await db.platformTermsAcceptance.create({ data: { userId: otherDealer.id, versionId: terms.id, source: 'ACCOUNT' } });
  const { body: currentTerms } = await http.get('/api/platform-terms/current').expect(200);
  assert.equal(currentTerms.id, terms.id);
  const { body: program } = await http.get('/api/sms/program').expect(200);
  const roleCookies = await Promise.all(['operator', 'client', 'technician'].map(async role =>
    session(await seedAccount(role, 'test.' + role))));
  const list = cookie => http.get(requests).set('Cookie', cookie).expect(200).then(result => result.body);
  const save = (cookie, markupPercent) => http.put(invitation).set('Cookie', cookie).send({ markupPercent });
  const review = (cookie, id, approve) => http.patch(requests + '/' + id).set('Cookie', cookie).send({ approve });
  await http.get(requests).expect(401);
  await http.get(invitation).expect(401);
  await http.get(base + '/invitations/not-an-invitation').expect(404);
  for (const cookie of roleCookies) {
    await save(cookie, '10').expect(403);
    await http.get(requests).set('Cookie', cookie).expect(403);
  }

  let parentId = null, reviewer = admin;
  const levels = ['Dealer', 'Subdealer', 'Distributor'];
  for (const [index, level] of levels.entries()) {
    const submittedMarkup = ['15', '0', '8'][index];
    const approvalMarkup = [fullPrecisionPercent, '10.75', '0'][index];
    const approvalRatio = [fullPrecisionRatio, '0.1075', '0'][index];
    const memberInvitation = parentId === null ? null : base + '/members/' + parentId + '/invitation';
    if (memberInvitation) {
      const { body: directory } = await http.get(base).set('Cookie', admin).expect(200);
      assert.equal(directory.members.find(member => member.id === parentId).hasInvitationLink, false);
      await http.get(memberInvitation).set('Cookie', admin).expect(404);
    }
    const { body: initial } = await http.get(invitation).set('Cookie', reviewer).expect(200);
    assert.equal(initial.token, null);
    assert.equal(initial.level, level);
    if (!index) assert.equal(initial.markupPercent, fullPrecisionPercent);
    const { body: invite } = await save(reviewer, submittedMarkup).expect(200);
    assert(invite.token);
    assert.equal(invite.level, level);
    const { body: reopened } = await http.get(invitation).set('Cookie', reviewer).expect(200);
    assert.deepEqual(reopened, invite);
    let sharedToken = invite.token;
    if (memberInvitation) {
      const { body: directory } = await http.get(base).set('Cookie', admin).expect(200);
      assert.equal(directory.members.find(member => member.id === parentId).hasInvitationLink, true);
      assert(!JSON.stringify(directory).includes(invite.token), 'The directory should not include the token');
      await http.get(memberInvitation).expect(401);
      for (const cookie of [reviewer, otherBranch, ...roleCookies]) {
        await http.get(memberInvitation).set('Cookie', cookie).expect(403);
      }
      const { body: copied } = await http.get(memberInvitation).set('Cookie', admin).expect(200);
      assert.deepEqual(copied, { token: invite.token });
      sharedToken = copied.token;
    }
    const publicPath = base + '/invitations/' + sharedToken;
    const { body: publicInfo } = await http.get(publicPath).expect(200);
    const directInviter = index === 0 ? null : { name: 'Example ' + levels[index - 1], logoUrl: null };
    assert.deepEqual(publicInfo, { level, inviter: directInviter });
    if (level === 'Subdealer') {
      const brand = { name: 'Fixture Glass', logoUrl: '/uploads/logos/fixture-glass.png' };
      await db.branding.create({ data: { type: 'DEALER', userId: parentId, ...brand, email: 'office@example.test' } });
      const branded = await http.get(publicPath).expect(200);
      assert.deepEqual(branded.body, { level, inviter: brand });
    }
    const person = {
      ...(index === 0 ? {} : { username: 'applicant.' + index }),
      password: 'example-password', firstName: 'Example', lastName: level,
      email: 'applicant' + index + '@example.com', phone: '+1305555010' + index, street: '100 Example St',
      city: 'Miami', state: 'FL', postalCode: '33101', yearsOfExperience: index,
      platformTermsAccepted: true, platformTermsVersionId: currentTerms.id,
      serviceConsent: index === 0, promotionsConsent: index === 1, consentVersion: program.dealerRegistration.version,
      ...(index ? {} : { companyName: 'Glass Company', estimatedMonthlySales: 1234.56 }),
    };
    if (index === 0) {
      await http.post(publicPath).send({ ...person, platformTermsAccepted: false }).expect(400);
      await http.post(publicPath).send({ ...person, platformTermsVersionId: currentTerms.id + 1 }).expect(409);
      await http.post(publicPath).send({ ...person, consentVersion: '0'.repeat(64) }).expect(409);
    }
    const { body: submitted } = await http.post(publicPath).send(person).expect(201);
    const expectedUsername = person.username ?? 'Example' + level;
    assert.equal(submitted.username, expectedUsername);
    await http.post(publicPath).send(person).expect(409);
    assert.equal(await db.user.count({ where: { username: expectedUsername } }), 0);
    assert.equal(await db.notification.count({ where: { ...accountEvents, message: { contains: expectedUsername } } }), 0);
    assert.equal(await db.accountWelcomeEmail.count({ where: { email: person.email } }), 0);
    const [pending] = await list(reviewer);
    assert.equal(pending.id, submitted.id);
    assert.equal(pending.username, expectedUsername);
    assert.equal(pending.level, level);
    assert.equal(pending.markupPercent, submittedMarkup);
    assert(!Object.hasOwn(pending, 'preferredLanguage'));
    assert.equal(pending.yearsOfExperience, person.yearsOfExperience);
    assert.equal(pending.estimatedMonthlySales, index ? null : '1234.56');
    assert.equal(pending.companyName, person.companyName ?? null);
    assert(!('passwordHash' in pending) && !('password' in pending));
    assert(!Object.keys(pending).some(field => /consent|terms|accepted|sms/i.test(field)), 'Reviewer payload must omit consent and terms evidence');
    const evidence = await db.dealerRegistrationRequest.findUniqueOrThrow({ where: { id: pending.id } });
    assert.equal(evidence.termsVersionId, terms.id);
    assert.equal(evidence.serviceSmsAccepted, person.serviceConsent);
    assert.equal(evidence.promotionalSmsAccepted, person.promotionsConsent);
    const reviewerBells = await db.notification.findMany({ where: { actionUrl: '/dealers?registrationRequest=' + pending.id } });
    assert.deepEqual(reviewerBells.map(row => row.recipientId).sort(), parentId ? [parentId] : admins.map(row => row.id).sort());
    await review(reviewer, pending.id, 'false').expect(400);
    if (parentId !== null) {
      await db.user.update({ where: { id: parentId }, data: { networkSuspended: true } });
      await http.get(publicPath).expect(403);
      await http.post(publicPath).send(person).expect(403);
      await review(reviewer, pending.id, true).expect(403);
      await db.user.update({ where: { id: parentId }, data: { networkSuspended: false } });
    }
    for (const stranger of index ? [otherBranch, admin] : [otherBranch]) {
      assert(!(await list(stranger)).some(row => row.id === pending.id));
      for (const approve of [true, false]) {
        const denied = await review(stranger, pending.id, approve);
        assert([403, 404].includes(denied.status), 'Only the direct inviter may review this request');
      }
    }
    const { body: updated } = await save(reviewer, approvalMarkup).expect(200);
    assert.equal(updated.token, invite.token);
    const [updatedPending] = await list(reviewer);
    assert.equal(updatedPending.id, pending.id);
    assert.equal(updatedPending.markupPercent, approvalMarkup);
    assert(!Object.hasOwn(updatedPending, 'invite'));
    const outcomes = await Promise.all([review(reviewer, pending.id, true), review(index ? reviewer : secondAdmin, pending.id, true)]);
    const observed = JSON.stringify(outcomes.map(({ status, body }) => ({ status, body })));
    assert.equal(outcomes.filter(result => result.status === 200).length, 1, 'A concurrent approval succeeds once: ' + observed);
    assert(outcomes.some(result => [404, 409].includes(result.status)), 'The repeated approval must give a controlled response: ' + observed);
    assert.deepEqual(await list(reviewer), []);
    const account = await db.user.findUniqueOrThrow({ where: { username: expectedUsername }, include: { role: true } });
    await checkAccountNotice(account, level, 'External');
    assert.equal(account.parentDealerId, parentId);
    assert.equal(account.dealerMode, 'EXTERNAL');
    assert.equal(account.role.name, 'dealer');
    assert.equal(account.companyName, person.companyName ?? null);
    assert.equal(account.yearsOfExperience, person.yearsOfExperience);
    assert(!Object.hasOwn(account, 'preferredLanguage'));
    assert.equal(await require('bcrypt').compare(person.password, account.password), true);
    assert.equal(account.paymentPlanId, null);
    assert.equal((await resolveNewPlan(db, account.id)).planId, plan.id);
    assert.equal(account.installationPriceProfileId, null);
    assert.equal((await pricing.resolveProfileForUser(account.id)).id, profile.id);
    const ratio = parentId === null ? account.markupOverride : account.networkMarkup;
    assert.equal(ratio.toFixed(), approvalRatio);
    const approvalBell = await db.notification.findMany({ where: {
      recipientId: account.id, dedupeKey: 'dealer-registration:' + pending.id + ':approved:applicant' } });
    assert.equal(approvalBell.length, 1);
    const acceptance = await db.platformTermsAcceptance.findUniqueOrThrow({ where: { userId_versionId: { userId: account.id, versionId: terms.id } } });
    assert.equal(acceptance.acceptedAt.getTime(), evidence.termsAcceptedAt.getTime());
    const preferences = await db.smsConsent.findUnique({ where: { userId: account.id } });
    assert.equal(Boolean(preferences?.enabled), person.serviceConsent);
    assert.equal(Boolean(preferences?.promotionsEnabled), person.promotionsConsent);
    const { body: nextInvitation } = await save(reviewer, '29').expect(200);
    assert.equal(nextInvitation.token, invite.token);
    const { body: network } = await http.get(base).set('Cookie', reviewer).expect(200);
    const member = network.members.find(item => item.id === account.id);
    assert.equal(member.levelLabel, level);
    if (reviewer !== admin) assert(!Object.hasOwn(member, 'hasInvitationLink'));
    for (const field of ['companyName', 'estimatedMonthlySales', 'yearsOfExperience', 'preferredLanguage']) {
      assert(!Object.hasOwn(member, field), 'Registration details must stay out of the dealer directory: ' + field);
    }
    assert.equal(member.parentDealerId, parentId);
    assert.equal(member.taxPercent, '7');
    assert.equal(member.markupPercent, approvalMarkup, 'Changing the invitation after approval must leave the account markup intact');
    await http.post(publicPath).send(person).expect(409);
    assert.deepEqual(await list(reviewer), []);
    const declined = { ...person, username: 'declined.' + index, email: 'declined' + index + '@example.com',
      phone: '+1305555011' + index };
    await http.post(publicPath).send(declined).expect(201);
    const [next] = await list(reviewer);
    assert.equal(next.markupPercent, '29');
    await review(reviewer, next.id, false).expect(200);
    assert.equal(await db.notification.count({ where: { ...accountEvents, message: { contains: declined.username } } }), 0);
    assert.equal(await db.user.count({ where: { username: declined.username } }), 0);
    assert.equal(await db.accountWelcomeEmail.count({ where: { email: declined.email } }), 0);
    assert.deepEqual(await list(reviewer), []);
    reviewer = await session(account);
    parentId = account.id;
  }
  const denied = await save(reviewer, '10');
  assert([400, 403].includes(denied.status), 'Distributors cannot issue invitations');
  const { body: adminDirectory } = await http.get(base).set('Cookie', admin).expect(200);
  assert(!Object.hasOwn(adminDirectory.members.find(member => member.id === parentId), 'hasInvitationLink'));
  await http.get(base + '/members/' + parentId + '/invitation').set('Cookie', admin).expect(404);
  await http.get(base + '/members/' + parentId + '/invitation').set('Cookie', reviewer).expect(403);
  const { body: operatorDirectory } = await http.get(base).set('Cookie', roleCookies[0]).expect(200);
  assert(operatorDirectory.members.length > 0);
  assert(operatorDirectory.members.every(member => !Object.hasOwn(member, 'hasInvitationLink')));
  assert.equal(await db.dealerRegistrationInvite.count(), 3);
  assert.equal(await db.dealerRegistrationRequest.count(), 0);
  assert.equal(await db.accountWelcomeEmail.count(), 0);

  const newUser = (username, suffix) => ({
    username, firstName: 'Test', lastName: 'Account', password: 'example-password',
    email: username + '@example.test', phone: '+130555501' + suffix,
    street: '100 Example St', city: 'Miami', state: 'FL', postalCode: '33101',
  });
  const client = { ...newUser('public.client', '21'), platformTermsAccepted: true, platformTermsVersionId: currentTerms.id };
  const { body: registered } = await http.post('/api/auth/register').send(client).expect(201);
  await http.post('/api/auth/register').send(client).expect(409);
  await checkAccountNotice(registered, 'Client');
  const dealerRole = await db.role.findUniqueOrThrow({ where: { name: 'dealer' } });
  const earningsPlan = await db.dealerEarningsPlan.create({ data: { name: 'Fixture earnings', basis: 'DEALER_MARKUP', percent: 25 } });
  const { body: internalDealer } = await http.post('/api/users').set('Cookie', admin).send({
    ...newUser('internal.dealer', '22'), idRole: dealerRole.id, dealerMode: 'INTERNAL', dealerEarningsPlanId: earningsPlan.id,
  }).expect(201);
  await checkAccountNotice(internalDealer, 'Dealer', 'Internal');
  const { body: internalSubdealer } = await http.post(base).set('Cookie', admin).send({
    ...newUser('manual.subdealer', '23'), parentDealerId: internalDealer.id,
    markupPercent: 15, dealerMode: 'INTERNAL', subdealerEarningsMode: 'MARKUP',
  }).expect(201);
  await checkAccountNotice(internalSubdealer, 'Subdealer', 'Internal');
  const { body: technician } = await http.post('/api/users/technicians').set('Cookie', admin).send({
    username: 'new.technician', firstName: 'Test', lastName: 'Technician', password: 'example-password',
  }).expect(201);
  assert.equal(await db.notification.count({ where: { dedupeKey: 'account:' + technician.id + ':created:admin' } }), 0);
  assert.equal(await db.accountWelcomeSms.count(), 0);
  assert.equal(await db.notificationEmail.count(), 0);
  assert.equal(await db.notificationSms.count(), 0);
  assert.equal(await db.dealerRegistrationRejectionDelivery.count(), 0);
  console.log('PASS: Public, manual and invitation creation notify both active admins exactly once with the saved username, role and type. Pending requests, rejections and technicians do not trigger this notice.');
  console.log('PASS: All three levels use the invitation markup at approval and retain it after later edits. Reviewer notifications, private consents, terms, local delivery restrictions and other network settings also passed.');
}

async function main() {
  const configured = process.env.DATABASE_URL || require('dotenv').parse(fs.readFileSync('.env')).DATABASE_URL;
  const url = new URL(configured);
  assert.equal(url.protocol, 'mysql:');
  assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Local MySQL required');
  const database = 'impact_registration_' + randomUUID().replaceAll('-', '');
  url.pathname = '/information_schema';
  const manager = new PrismaClient({ datasourceUrl: url.href });
  let created = false;
  try {
    await manager.$executeRawUnsafe('CREATE DATABASE ' + database + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    created = true;
    url.pathname = '/' + database;
    process.env.DATABASE_URL = url.href;
    execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], { stdio: 'pipe' });
    await verifyRegistration();
  } finally {
    if (created) await manager.$executeRawUnsafe('DROP DATABASE ' + database);
    await manager.$disconnect();
  }
}

module.exports = { verifyRegistration };
if (require.main === module) main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
