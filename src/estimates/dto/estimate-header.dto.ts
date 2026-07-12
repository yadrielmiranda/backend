import { OmitType, PartialType } from '@nestjs/mapped-types';

import { CreateEstimateDto } from './create-estimate.dto';

// crea el Estimate sin requerir piezas.
// El nombre continúa siendo obligatorio al iniciar el Estimate.
export class CreateEstimateHeaderDto extends OmitType(
  CreateEstimateDto,
  ['pieces'] as const,
) {}

// permite autosave parcial del encabezado
// sin modificar ni reemplazar las piezas.
export class UpdateEstimateHeaderDto extends PartialType(
  CreateEstimateHeaderDto,
) {}