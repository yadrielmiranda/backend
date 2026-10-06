import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { Roles } from '@/auth/roles.decorator';
import { ApplySystemMuntinsDto, UpdateSystemMuntinRuleDto } from './dto/system-muntins.dto';
import { SystemMuntinsService } from './system-muntins.service';

@Controller('systems/:id/muntins')
export class SystemMuntinsController {
  constructor(private readonly service: SystemMuntinsService) {}

  @Get()
  manage(@Param('id', ParseIntPipe) id: number) { return this.service.manage(id); }

  @Roles('admin')
  @Post('apply')
  apply(@Param('id', ParseIntPipe) id: number, @Body() body: ApplySystemMuntinsDto) {
    return this.service.apply(id, body);
  }

  @Roles('admin')
  @Patch('rules/:ruleId')
  update(@Param('id', ParseIntPipe) id: number, @Param('ruleId', ParseIntPipe) ruleId: number,
    @Body() body: UpdateSystemMuntinRuleDto) { return this.service.updateRule(id, ruleId, body); }

  @Roles('admin')
  @Delete('rules/:ruleId')
  remove(@Param('id', ParseIntPipe) id: number, @Param('ruleId', ParseIntPipe) ruleId: number) {
    return this.service.removeRule(id, ruleId);
  }
}
