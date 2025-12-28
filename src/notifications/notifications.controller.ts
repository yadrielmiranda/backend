import {
  Controller,
  Get,
  Param,
  Patch,
  Req,
  UseGuards,
  ParseIntPipe,
  Delete,
  Query,
  DefaultValuePipe,
} from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { Request } from 'express';
import type { AuthUser } from 'src/auth/types/auth-user.type';


@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) { }

  // ✅ GET /notifications?take=50&skip=0
  @Get()
  async getMyNotifications(
    @Req() req: Request,
    @Query('take') take?: string,
    @Query('skip') skip?: string,
  ) {
    const userId = (req.user as any).id;

    return this.notificationsService.getNotificationsForUser(userId, {
      take: take != null ? Number(take) : undefined,
      skip: skip != null ? Number(skip) : undefined,
    });
  }

  @Patch(':id/read')
  markAsRead(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    const user = req.user as AuthUser;
    return this.notificationsService.markAsRead(id, user.id);
  }

  @Delete('clear-all')
  deleteAllNotifications(@Req() req: Request) {
    const user = req.user as AuthUser;
    return this.notificationsService.deleteAllForUser(user.id);
  }

  @Delete(':id')
  deleteNotification(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    const user = req.user as AuthUser;
    return this.notificationsService.deleteNotification(id, user.id);
  }
}
