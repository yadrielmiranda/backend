// src/payments/dto/create-checkout-session.dto.ts
import { IsInt, Min } from 'class-validator';

export class CreateCheckoutSessionDto {
  @IsInt()
  @Min(1)
  estimateId: number;
}
