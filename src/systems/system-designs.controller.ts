import { Body, Controller, Get, Param, ParseIntPipe, Patch } from '@nestjs/common';
import { Roles } from '@/auth/roles.decorator';
import { UpdateSystemDesignsDto } from './dto/system-designs.dto';
import { SystemDesignsService } from './system-designs.service';

@Controller('systems/:id/designs/manage')
export class SystemDesignsController {
  constructor(private readonly service: SystemDesignsService) {}

  @Get()
  manage(@Param('id', ParseIntPipe) id: number) { return this.service.manage(id); }

  @Roles('admin')
  @Patch()
  update(@Param('id', ParseIntPipe) id: number, @Body() data: UpdateSystemDesignsDto) {
    return this.service.update(id, data);
  }
}
