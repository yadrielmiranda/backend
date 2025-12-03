import { PartialType } from '@nestjs/swagger';
import { CreatePolicyDto } from './create-dimension-policy.dto';


export class UpdateDimensionPolicyDto extends PartialType(CreatePolicyDto) {}
