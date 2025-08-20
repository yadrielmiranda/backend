import { Controller, Get, Param, Patch, Req, UseGuards, ParseIntPipe, Delete } from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/guards/auth/auth.guard';
import { NotificationsService } from './notifications.service';
import { Request } from 'express';

@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
    constructor(private readonly notificationsService: NotificationsService) { }

    @Get()
    async getMyNotifications(@Req() req: Request) {
        const userId = req.user.id;
        return this.notificationsService.getNotificationsForUser(userId);
    }

    @Patch(':id/read')
    async markAsRead(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
        const userId = req.user.id;
        return this.notificationsService.markAsRead(id, userId);
    }

    @Delete('clear-all')
    async deleteAllNotifications(@Req() req: Request) {
        const userId = req.user.id;
        return this.notificationsService.deleteAllForUser(userId);
    }

    @Delete(':id')
    async deleteNotification(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
        const userId = req.user.id;
        return this.notificationsService.deleteNotification(id, userId);
    }
}