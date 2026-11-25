import { ConflictException, NotFoundException } from '@nestjs/common';
import { assertClientDeliveryDecision, deliveryAddressKey } from './client-delivery-decision';
import { ClientDeliveryService } from './client-delivery.service';
import { AddressCorrectionRequiredException, AddressLocationRequiredException } from './google-address-validation.service';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ClientDeliveryAddressDto } from './dto/client-delivery.dto';

const address = { street: '100 Main St', addressLine2: null, city: 'Miami', state: 'FL', postalCode: '33101' };
const checkedKey = deliveryAddressKey(3, address, 2);
const estimatedPrice = { total: '528.00', basePrice: '500.00', includedMiles: '50', additionalMiles: '5.60',
  additionalMilePrice: '5', additionalMileageCharge: '28.00' };
function setup() {
  const user = { id: 3, ...address, role: { name: 'client' }, registrationConsent: { consentText: '{"source":"REGISTRATION"}' },
    deliveryCoverageCheck: { available: true, verificationKey: checkedKey } };
  const estimate = { user, order: null, installationJob: null, payments: [],
    deliveryAcknowledgement: null as null | { choice: 'PICKUP' | 'DELIVERY'; verificationKey: string | null } };
  const db = {
    estimate: { findUnique: jest.fn().mockResolvedValue(estimate), findFirst: jest.fn() },
    user: { findUnique: jest.fn().mockResolvedValue(user), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    warehouseDeliverySettings: { findUnique: jest.fn().mockResolvedValue({ revision: 2 }) },
    clientDeliveryCoverageCheck: { upsert: jest.fn() },
    estimateDeliveryAcknowledgement: { upsert: jest.fn() },
    $transaction: jest.fn(),
  };
  db.$transaction.mockImplementation(callback => callback(db));
  const provider = { checkAddressWithRevision: jest.fn().mockResolvedValue({ available: true, revision: 2, estimatedPrice }) };
  const service = new ClientDeliveryService(db as any, provider as any);
  const canPay = () => assertClientDeliveryDecision(21, db as any);
  return { user, estimate, service, provider, db, canPay };
}

describe('public client delivery information', () => {
  it('offers address capture on every new estimate until the public client has a complete profile address', async () => {
    const { db, user, service } = setup();
    await expect(service.status(3)).resolves.toMatchObject({ canAddProfileAddress: false });
    Object.assign(user, { street: null });
    await expect(service.status(3)).resolves.toMatchObject({ canAddProfileAddress: true });
    db.estimate.findFirst.mockResolvedValue({ id: 21 });
    await expect(service.status(3)).resolves.toMatchObject({ canAddProfileAddress: true });
    expect(db.estimate.findFirst).not.toHaveBeenCalled();
    await expect(service.status(3, 21)).resolves.toMatchObject({ applies: true, acknowledged: null, canAddProfileAddress: true });
    user.role.name = 'dealer';
    await expect(service.status(3)).resolves.toMatchObject({ applies: false, canAddProfileAddress: false });
    user.role.name = 'client';
    user.registrationConsent.consentText = '{"source":"DEALER_REGISTRATION"}';
    await expect(service.status(3, 21)).resolves.toMatchObject({ applies: false, canAddProfileAddress: false });
  });

  it('keeps address capture available when pickup or an existing payment already permits checkout', async () => {
    const { user, estimate, service } = setup();
    Object.assign(user, { street: null });
    estimate.deliveryAcknowledgement = { choice: 'PICKUP', verificationKey: null };
    await expect(service.status(3, 21)).resolves.toMatchObject({
      applies: true, reviewComplete: true, canAddProfileAddress: true, acknowledged: 'PICKUP',
    });
    Object.assign(estimate, { deliveryAcknowledgement: null, payments: [{ id: 5 }] });
    await expect(service.status(3, 21)).resolves.toMatchObject({
      applies: false, reviewComplete: true, canAddProfileAddress: true,
    });
    user.street = address.street;
    await expect(service.status(3, 21)).resolves.toMatchObject({ canAddProfileAddress: false, reviewComplete: true });
  });
  it('saves a new address outside the radius and completes the address step without a price or fulfillment choice', async () => {
    const { db, service, provider, user } = setup();
    Object.assign(user, { street: null });
    const unit = { ...address, addressLine2: 'Apt 9' };
    provider.checkAddressWithRevision.mockResolvedValue({ available: false, revision: 2, estimatedPrice: null });
    await expect(service.check(3, { ...unit, onlyIfMissing: true })).resolves.toMatchObject({ applies: true, available: false, address: unit,
      reviewComplete: true, estimatedPrice: null, acknowledged: null, canAddProfileAddress: false });
    expect(provider.checkAddressWithRevision).toHaveBeenCalledWith(unit);
    expect(db.user.updateMany).toHaveBeenCalledWith({ where: { id: 3, ...address, street: null }, data: unit });
    expect(db.clientDeliveryCoverageCheck.upsert.mock.calls[0][0].create).toEqual({
      userId: 3, available: false, locationProof: null, verificationKey: deliveryAddressKey(3, unit, 2),
    });
    expect(db.estimateDeliveryAcknowledgement.upsert).not.toHaveBeenCalled();
  });

  it('returns standard pricing for a new covered address without storing a price or fulfillment decision', async () => {
    const { db, service, user } = setup();
    Object.assign(user, { street: null });
    await expect(service.check(3, { ...address, onlyIfMissing: true })).resolves.toMatchObject({ available: true, estimatedPrice, reviewComplete: true, acknowledged: null });
    expect(db.clientDeliveryCoverageCheck.upsert.mock.calls[0][0].create).toEqual({
      userId: 3, available: true, locationProof: null, verificationKey: checkedKey,
    });
    expect(db.estimateDeliveryAcknowledgement.upsert).not.toHaveBeenCalled();
    expect(await service.status(3)).not.toHaveProperty('estimatedPrice');
  });

  it('preserves the prior profile when route validation fails or the profile changed in another tab', async () => {
    const { db, service, provider } = setup();
    provider.checkAddressWithRevision.mockRejectedValueOnce(new Error('Unavailable'));
    await expect(service.check(3, address)).rejects.toThrow('Unavailable');
    expect(db.user.updateMany).not.toHaveBeenCalled();
    db.user.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.check(3, address)).rejects.toThrow(ConflictException);
    expect(db.clientDeliveryCoverageCheck.upsert).not.toHaveBeenCalled();
  });

  it('preserves an address saved by another tab before a first-address submission', async () => {
    const { db, service, provider } = setup();
    const otherAddress = { ...address, street: 'Different Street', onlyIfMissing: true };
    await expect(service.check(3, otherAddress)).rejects.toThrow(ConflictException);
    expect(provider.checkAddressWithRevision).not.toHaveBeenCalled();
    expect(db.user.updateMany).not.toHaveBeenCalled();
  });

  it('checks the current saved address instead of a stale address displayed in the browser', async () => {
    const { db, user, provider, service } = setup();
    user.street = '200 Changed In Profile St';
    await expect(service.check(3)).resolves.toMatchObject({ address: { street: user.street }, available: true, estimatedPrice, reviewComplete: true, acknowledged: null });
    expect(provider.checkAddressWithRevision).toHaveBeenCalledWith({ ...address, street: user.street });
    db.user.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.check(3)).rejects.toThrow(ConflictException);
    Object.assign(user, { street: null });
    await expect(service.check(3)).rejects.toThrow('no complete address');
  });

  it('lets the user review a saved address correction and detects a profile edit before continuing', async () => {
    const { db, user, provider, service } = setup();
    const suggested = { ...address, postalCode: '33103-1234' };
    provider.checkAddressWithRevision.mockRejectedValueOnce(new AddressCorrectionRequiredException(suggested));
    const error = await service.check(3).catch(cause => cause.getResponse());
    expect(error).toMatchObject({ code: 'ADDRESS_CONFIRMATION_REQUIRED', address, suggestedAddress: suggested,
      expectedProfileAddressKey: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(db.user.updateMany).not.toHaveBeenCalled();
    user.street = 'Changed In Another Tab';
    await expect(service.check(3, { ...suggested, expectedProfileAddressKey: error.expectedProfileAddressKey })).rejects.toThrow(ConflictException);
    expect(db.user.updateMany).not.toHaveBeenCalled();
    expect(provider.checkAddressWithRevision).toHaveBeenCalledTimes(1);
    user.street = address.street;
    await expect(service.check(3, { ...suggested, expectedProfileAddressKey: error.expectedProfileAddressKey })).resolves.toMatchObject({ address: suggested });
  });

  it('binds a confirmed pin to its verification without requiring a valid pin for payment', async () => {
    const { db, user, provider, service, canPay } = setup();
    const center = { lat: 25.78, lng: -80.19 };
    provider.checkAddressWithRevision.mockRejectedValueOnce(new AddressLocationRequiredException(center));
    const response = await service.check(3, address).catch(cause => cause.getResponse());
    expect(response).toMatchObject({ code: 'ADDRESS_LOCATION_CONFIRMATION_REQUIRED', address, center, maxAdjustmentMeters: 500 });
    expect(db.user.updateMany).not.toHaveBeenCalled();
    provider.checkAddressWithRevision.mockResolvedValueOnce({ available: true, revision: 2, confirmedLocation: center });
    const checked = await service.check(3, { ...address, confirmedLocation: center, expectedProfileAddressKey: response.expectedProfileAddressKey });
    expect(provider.checkAddressWithRevision).toHaveBeenLastCalledWith({ ...address, confirmedLocation: center });
    expect(checked.verificationKey).not.toBe(checkedKey);
    const pinCheck = db.clientDeliveryCoverageCheck.upsert.mock.calls[0][0].update;
    expect(pinCheck.locationProof).toMatch(/^[a-f0-9]{64}$/);
    Object.assign(user, { deliveryCoverageCheck: pinCheck });
    await expect(canPay()).resolves.toBeUndefined();
    expect(db.estimateDeliveryAcknowledgement.upsert).not.toHaveBeenCalled();
    const differentEstimate = await service.status(3, 22);
    expect(differentEstimate).toMatchObject({ reviewComplete: true, acknowledged: null });
    Object.assign(user, { deliveryCoverageCheck: { ...pinCheck, verificationKey: checkedKey } });
    await expect(canPay()).resolves.toBeUndefined();
    await expect(service.acknowledge(3, 21, 'DELIVERY', checkedKey)).rejects.toThrow(ConflictException);
    const movedPin = { lat: 25.7802, lng: -80.19 };
    provider.checkAddressWithRevision.mockResolvedValueOnce({ available: true, revision: 2, confirmedLocation: movedPin });
    const moved = await service.check(3, { ...address, confirmedLocation: movedPin });
    expect(moved.verificationKey).not.toBe(checked.verificationKey);
  });

  it('preserves ZIP+4 from the verification service and rejects invalid coordinates', async () => {
    const confirmed = { ...address, postalCode: '33103-1234', confirmedLocation: { lat: 25.78, lng: -80.19 } };
    const dto = plainToInstance(ClientDeliveryAddressDto, confirmed);
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.postalCode).toBe('33103-1234');
    expect(await validate(plainToInstance(ClientDeliveryAddressDto, { ...confirmed,
      confirmedLocation: { lat: 91, lng: -80.19 } }))).not.toHaveLength(0);
  });

  it('admits any complete profile address without checking the warehouse before checkout', async () => {
    const { db, user, service, canPay } = setup();
    db.warehouseDeliverySettings.findUnique.mockRejectedValue(new Error('unavailable'));
    await expect(service.status(3, 21)).resolves.toMatchObject({ available: null, acknowledged: null, reviewComplete: true });
    await expect(canPay()).resolves.toBeUndefined();
    expect(db.estimateDeliveryAcknowledgement.upsert).not.toHaveBeenCalled();
    user.deliveryCoverageCheck.available = false;
    await expect(service.status(3, 21)).resolves.toMatchObject({ acknowledged: null, reviewComplete: true });
    await expect(canPay()).resolves.toBeUndefined();
    Object.assign(user, { deliveryCoverageCheck: null });
    await expect(service.status(3)).resolves.toMatchObject({ address, available: null, verificationKey: null, reviewComplete: true });
    await expect(canPay()).resolves.toBeUndefined();
    Object.assign(user, { city: '  ' });
    await expect(canPay()).rejects.toThrow(ConflictException);
    expect(db.warehouseDeliverySettings.findUnique).not.toHaveBeenCalled();
  });

  it('accepts only an owned estimate and its current eligible destination', async () => {
    const { db, service } = setup();
    await expect(service.acknowledge(3, 21, 'DELIVERY', 'different')).rejects.toThrow(ConflictException);
    expect(db.estimateDeliveryAcknowledgement.upsert).not.toHaveBeenCalled();
    await expect(service.acknowledge(3, 21, 'DELIVERY', checkedKey)).resolves.toMatchObject({ acknowledged: 'DELIVERY' });
    expect(db.estimateDeliveryAcknowledgement.upsert).not.toHaveBeenCalled();
    expect(db.estimate.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 21, idUser: 3 } }));
    db.estimate.findUnique.mockResolvedValue(null);
    await expect(service.acknowledge(4, 21, 'PICKUP')).rejects.toThrow(NotFoundException);
  });

  it('rejects stale delivery evidence on the legacy confirmation without blocking saved addresses at payment', async () => {
    const { db, user, estimate, service, canPay } = setup();
    estimate.deliveryAcknowledgement = { choice: 'DELIVERY', verificationKey: checkedKey };
    await expect(canPay()).resolves.toBeUndefined();
    user.street = '200 Other St';
    await expect(service.acknowledge(3, 21, 'DELIVERY', checkedKey)).rejects.toThrow(ConflictException);
    await expect(canPay()).resolves.toBeUndefined();
    user.street = address.street;
    db.warehouseDeliverySettings.findUnique.mockResolvedValue({ revision: 3 });
    await expect(service.acknowledge(3, 21, 'DELIVERY', checkedKey)).rejects.toThrow(ConflictException);
    await expect(canPay()).resolves.toBeUndefined();
  });

  it('allows pickup regardless of provider availability after explicit confirmation', async () => {
    const { db, user, estimate, provider, service, canPay } = setup();
    Object.assign(user, { street: null });
    db.warehouseDeliverySettings.findUnique.mockRejectedValue(new Error('unavailable'));
    await expect(service.acknowledge(3, 21, 'PICKUP')).resolves.toMatchObject({ acknowledged: 'PICKUP', reviewComplete: true });
    estimate.deliveryAcknowledgement = { choice: 'PICKUP', verificationKey: null };
    await expect(canPay()).resolves.toBeUndefined();
    expect(provider.checkAddressWithRevision).not.toHaveBeenCalled();
    expect(db.warehouseDeliverySettings.findUnique).not.toHaveBeenCalled();
  });

  it('leaves other account types, active installations and existing orders or paid material alone', async () => {
    const { user, estimate, canPay } = setup();
    Object.assign(user, { street: null, deliveryCoverageCheck: null });
    user.role.name = 'dealer';
    await expect(canPay()).resolves.toBeUndefined();
    user.role.name = 'client';
    Object.assign(user, { registrationConsent: null });
    await expect(canPay()).resolves.toBeUndefined();
    Object.assign(user, { registrationConsent: { consentText: '{"source":"DEALER_REGISTRATION"}' } });
    await expect(canPay()).resolves.toBeUndefined();
    Object.assign(user, { registrationConsent: { consentText: '{"source":"REGISTRATION"}' } });
    Object.assign(estimate, { installationJob: { status: 'REQUESTED' } });
    await expect(canPay()).resolves.toBeUndefined();
    Object.assign(estimate, { installationJob: { status: 'CANCELED' } });
    await expect(canPay()).rejects.toThrow(ConflictException);
    Object.assign(estimate, { order: { id: 12 } });
    await expect(canPay()).resolves.toBeUndefined();
    Object.assign(estimate, { order: null, payments: [{ id: 5 }] });
    await expect(canPay()).resolves.toBeUndefined();
  });
});
