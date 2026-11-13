import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { AddressConfirmationReviewDto } from './dto/address-confirmation.dto';
import {
  AddressCorrectionRequiredException,
  AddressLocationRequiredException,
  GoogleAddressValidationService,
} from './google-address-validation.service';
import type { DeliveryRouteAddress } from './google-routes.service';

function publicAddress(address: DeliveryRouteAddress): DeliveryRouteAddress {
  return {
    street: address.street,
    ...(address.addressLine2 !== undefined ? { addressLine2: address.addressLine2 } : {}),
    city: address.city,
    state: address.state,
    postalCode: address.postalCode,
    ...(address.confirmedLocation ? { confirmedLocation: { ...address.confirmedLocation } } : {}),
  };
}

// The application's global JWT guard applies; this endpoint never persists data.
@Controller('address-confirmations')
export class AddressConfirmationsController {
  constructor(private readonly addresses: GoogleAddressValidationService) {}

  @Post('review')
  async review(@Body() dto: AddressConfirmationReviewDto) {
    if (dto.purpose === 'INSTALLATION' && dto.address.state.trim().toUpperCase() !== 'FL') {
      throw new BadRequestException('Installation is available only in Florida.');
    }
    try {
      const address = await this.addresses.validateDeliveryAddress(dto.address, {
        suggestCorrections: true,
        allowLocationConfirmation: true,
      });
      return { status: 'VALIDATED' as const, address: publicAddress(address) };
    } catch (error) {
      if (error instanceof AddressCorrectionRequiredException) {
        return { status: 'CONFIRM_SUGGESTION' as const, suggestedAddress: publicAddress(error.suggestedAddress) };
      }
      if (error instanceof AddressLocationRequiredException) {
        return {
          status: 'CONFIRM_LOCATION' as const,
          center: error.center,
          maxAdjustmentMeters: error.maxAdjustmentMeters,
        };
      }
      throw error;
    }
  }
}
