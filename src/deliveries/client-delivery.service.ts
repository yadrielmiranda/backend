import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ClientDeliveryChoice } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from '@/prisma/prisma.service';
import { DeliveryCoverageService } from './delivery-coverage.service';
import { ClientAddress, clientCoverageSelect, clientCoverageStatus, deliveryAddressKey, estimateClientCoverage,
  isPublicSignupClient, savedClientAddress } from './client-delivery-decision';
import { ClientDeliveryAddressDto } from './dto/client-delivery.dto';
import { AddressCorrectionRequiredException, AddressLocationRequiredException } from './google-address-validation.service';
import type { DeliveryRouteAddress } from './google-routes.service';

@Injectable()
export class ClientDeliveryService {
  constructor(private readonly db: PrismaService, private readonly coverage: DeliveryCoverageService) {}

  private async account(userId: number) {
    const user = await this.db.user.findUnique({ where: { id: userId }, select: clientCoverageSelect });
    if (!user) throw new NotFoundException('Account not found.');
    return user;
  }

  async status(userId: number, estimateId?: number) {
    if (estimateId !== undefined) return estimateClientCoverage(this.db, estimateId, userId);
    return clientCoverageStatus(this.db, await this.account(userId));
  }

  async check(userId: number, dto?: ClientDeliveryAddressDto) {
    const user = await this.account(userId);
    if (!isPublicSignupClient(user)) throw new ForbiddenException();
    const savedAddress = savedClientAddress(user);
    if (dto?.onlyIfMissing && savedAddress) {
      throw new ConflictException('There is already an address in your profile. Reload to continue.');
    }
    const address: ClientAddress | null = dto ? {
      street: dto.street, addressLine2: dto.addressLine2 ?? null, city: dto.city, state: dto.state, postalCode: dto.postalCode,
    } : savedAddress;
    if (!address) throw new ConflictException('There is no complete address in your profile. Enter an address to check coverage.');
    const { street, addressLine2, city, state, postalCode } = user;
    const before = { street, addressLine2, city, state, postalCode };
    const profileAddressKey = createHash('sha256').update(JSON.stringify([userId, before])).digest('hex');
    if (dto?.expectedProfileAddressKey && dto.expectedProfileAddressKey !== profileAddressKey) {
      throw new ConflictException('Your profile address changed. Reload it and check again.');
    }
    // Keep provider calls outside the database transaction. An unavailable provider is never interpreted as out of range.
    const destination: DeliveryRouteAddress = dto?.confirmedLocation ? { ...address, confirmedLocation: dto.confirmedLocation } : address;
    const { available, revision, confirmedLocation, estimatedPrice } = await this.checkWithReview(destination, profileAddressKey);
    // Only store evidence of the map point validated by the provider. The final delivery has its own destination.
    const locationProof = confirmedLocation
      ? createHash('sha256').update(JSON.stringify([userId, confirmedLocation.lat, confirmedLocation.lng])).digest('hex') : null;
    const verificationKey = deliveryAddressKey(userId, address, revision, locationProof);
    const check = { available, locationProof, verificationKey };
    return this.db.$transaction(async tx => {
      const saved = await tx.user.updateMany({
        where: { id: userId, ...before }, data: address,
      });
      if (!saved.count) throw new ConflictException('Your profile address changed. Reload it and check again.');
      await tx.clientDeliveryCoverageCheck.upsert({
        where: { userId }, create: { userId, ...check }, update: check,
      });
      const status = await clientCoverageStatus(tx, { ...user, ...address, deliveryCoverageCheck: check }, { checkCoverage: true });
      if (!status.verificationKey) throw new ConflictException('Delivery coverage settings changed. Check your address again.');
      return { ...status, estimatedPrice };
    });
  }

  private async checkWithReview(address: DeliveryRouteAddress, profileAddressKey: string) {
    try {
      return await this.coverage.checkAddressWithRevision(address);
    } catch (error) {
      if (error instanceof AddressCorrectionRequiredException || error instanceof AddressLocationRequiredException) {
        const response = error.getResponse();
        if (typeof response === 'object') throw new BadRequestException({
          ...response, address, expectedProfileAddressKey: profileAddressKey,
        });
      }
      throw error;
    }
  }

  async acknowledge(userId: number, estimateId: number, choice: ClientDeliveryChoice, verificationKey?: string) {
    return this.db.$transaction(async tx => {
      const status = await estimateClientCoverage(tx, estimateId, userId, choice === 'DELIVERY');
      if (!status.applies) throw new BadRequestException('This estimate does not need a delivery acknowledgement.');
      if (choice === 'DELIVERY') {
        // Legacy clients may still submit this choice. A positive profile check suffices on its own.
        if (status.available !== true || verificationKey !== status.verificationKey) {
          throw new ConflictException({
            code: 'CLIENT_DELIVERY_COVERAGE_CHANGED',
            message: 'Check the current delivery address before continuing.',
          });
        }
        return { ...status, acknowledged: choice };
      }
      const data = { choice, verificationKey: null, acknowledgedAt: new Date() };
      await tx.estimateDeliveryAcknowledgement.upsert({ where: { estimateId }, create: { estimateId, ...data }, update: data });
      return { ...status, acknowledged: choice, reviewComplete: true };
    });
  }
}
