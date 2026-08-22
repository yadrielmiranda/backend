import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import * as cookie from 'cookie';
import { JwtService } from '@nestjs/jwt';

type JwtPayload = { sub?: string | number };

@WebSocketGateway({
  cors: {
    origin: (origin, callback) => {
      const allowedOrigins = (process.env.FRONTEND_URL ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);

      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error('Origin not allowed by CORS'), false);
    },
    credentials: true,
  },
})
export class NotificationsGateway
  implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  constructor(private jwtService: JwtService) { }

  // ✅ PRO: múltiples sockets por usuario
  private userSockets = new Map<number, Set<string>>();

  private addSocket(userId: number, socketId: string) {
    const set = this.userSockets.get(userId) ?? new Set<string>();
    set.add(socketId);
    this.userSockets.set(userId, set);
  }

  private removeSocket(userId: number, socketId: string) {
    const set = this.userSockets.get(userId);
    if (!set) return;
    set.delete(socketId);
    if (set.size === 0) this.userSockets.delete(userId);
  }

  private async authenticate(client: Socket): Promise<number | null> {
    try {
      const rawCookie = client.handshake.headers.cookie || '';
      const parsed = cookie.parse(rawCookie);
      const token = parsed['access_token'];
      if (!token) return null;

      // ✅ verifica con el mismo secret del JwtModule (Config -> JWT_SECRET_KEY)
      const payload = await this.jwtService.verifyAsync<JwtPayload>(token, {
        ignoreExpiration: false,
      });

      const userId =
        typeof payload.sub === 'string' ? Number(payload.sub) : payload.sub;

      if (!Number.isFinite(userId)) return null;
      return userId as number;
    } catch {
      return null;
    }
  }

  async handleConnection(client: Socket) {
    const userId = await this.authenticate(client);
    if (!userId) {
      client.disconnect(true);
      return;
    }

    (client.data as any).userId = userId;

    this.addSocket(userId, client.id);
    console.log(`[WS] Connected socket=${client.id} userId=${userId}`);
  }

  handleDisconnect(client: Socket) {
    const userId = (client.data as any)?.userId as number | undefined;
    if (!userId) return;

    this.removeSocket(userId, client.id);
    console.log(`[WS] Disconnected socket=${client.id} userId=${userId}`);
  }

  sendNotificationToUser(userId: number, payload: any) {
    const sockets = this.userSockets.get(userId);
    if (!sockets || sockets.size === 0) return;

    for (const socketId of sockets) {
      this.server.to(socketId).emit('new_notification', payload);
    }
  }
}
