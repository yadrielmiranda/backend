import { BadRequestException, Injectable } from '@nestjs/common';
import { WarehouseDeliveryService } from '@/warehouse-delivery/warehouse-delivery.service';
import { GoogleAddressValidationService } from './google-address-validation.service';
import {
  GoogleRoutesService,
  type DeliveryRouteAddress,
} from './google-routes.service';
import { estimateStandardDeliveryPrice, isWithinDeliveryCoverage } from './delivery-pricing';

@Injectable()
export class DeliveryCoverageService {
  constructor(
    private readonly warehouse: WarehouseDeliveryService,
    private readonly addressValidation: GoogleAddressValidationService,
    private readonly routes: GoogleRoutesService,
  ) {}

  async checkAddress(destination: DeliveryRouteAddress) {
    const { available } = await this.calculateCoverage(destination, false);
    return { available };
  }

  async checkAddressWithRevision(destination: DeliveryRouteAddress) {
    return this.calculateCoverage(destination, true);
  }

  private async calculateCoverage(destination: DeliveryRouteAddress, allowReview: boolean) {
    const { configuration, pricing } = await this.warehouse.find();
    if (!configuration) {
      throw new BadRequestException(
        'Delivery is currently unavailable. Please contact us for assistance.',
      );
    }

    const origin: DeliveryRouteAddress = {
      street: configuration.street,
      addressLine2: configuration.addressLine2,
      city: configuration.city,
      state: configuration.state,
      postalCode: configuration.postalCode,
    };

    const validatedDestination = allowReview
      ? await this.addressValidation.validateDeliveryAddress(destination, { suggestCorrections: true, allowLocationConfirmation: true })
      : await this.addressValidation.validateDeliveryAddress(destination);
    const route = await this.routes.calculateDrivingRoute(
      origin,
      validatedDestination,
    );

    const available = isWithinDeliveryCoverage(route.distanceMeters, configuration.maxDeliveryMiles);
    return {
      revision: configuration.revision,
      confirmedLocation: validatedDestination.confirmedLocation,
      available,
      estimatedPrice: allowReview && available ? estimateStandardDeliveryPrice(route.distanceMeters, pricing) : null,
    };
  }
}
