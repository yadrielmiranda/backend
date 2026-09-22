import { BadRequestException, Injectable } from '@nestjs/common';
import { WarehouseDeliveryService } from '@/warehouse-delivery/warehouse-delivery.service';
import { GoogleAddressValidationService } from './google-address-validation.service';
import {
  GoogleRoutesService,
  type DeliveryRouteAddress,
} from './google-routes.service';
import { isWithinDeliveryCoverage } from './delivery-pricing';

@Injectable()
export class DeliveryCoverageService {
  constructor(
    private readonly warehouse: WarehouseDeliveryService,
    private readonly addressValidation: GoogleAddressValidationService,
    private readonly routes: GoogleRoutesService,
  ) {}

  async checkAddress(destination: DeliveryRouteAddress) {
    const { configuration } = await this.warehouse.find();
    if (!configuration) {
      throw new BadRequestException(
        'Delivery is currently unavailable. Please contact us for assistance.',
      );
    }

    const origin: DeliveryRouteAddress = {
      street: configuration.street,
      city: configuration.city,
      state: configuration.state,
      postalCode: configuration.postalCode,
    };

    const validatedDestination =
      await this.addressValidation.validateDeliveryAddress(destination);
    const route = await this.routes.calculateDrivingRoute(
      origin,
      validatedDestination,
    );

    return {
      available: isWithinDeliveryCoverage(
        route.distanceMeters,
        configuration.maxDeliveryMiles,
      ),
    };
  }
}
