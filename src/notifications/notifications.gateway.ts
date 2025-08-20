import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

// Definimos los orígenes permitidos aquí, igual que en tu main.ts
const allowedOrigins = [
  'http://localhost:3000',
  'http://10.0.0.4:3000',
];

@WebSocketGateway({
  cors: {
    origin: (origin, callback) => {
      // Esta función comprueba si el origen de la conexión está en nuestra lista permitida
      if (!origin || allowedOrigins.indexOf(origin) !== -1) {
        callback(null, true); // Permitir conexión
      } else {
        callback(new Error('Origin not allowed by CORS')); // Bloquear conexión
      }
    },
    credentials: true,
  },
})
export class NotificationsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private userSocketMap = new Map<number, string>();

  handleConnection(client: Socket) {
    const userId = Number(client.handshake.query.userId);
    if (userId) {
      console.log(`[WS] Client connected: ${client.id}, UserID: ${userId}`);
      this.userSocketMap.set(userId, client.id);
    }
  }

  handleDisconnect(client: Socket) {
    const userId = Number(client.handshake.query.userId);
    if (userId && this.userSocketMap.get(userId) === client.id) {
      console.log(`[WS] Client disconnected: ${client.id}, UserID: ${userId}`);
      this.userSocketMap.delete(userId);
    }
  }

  sendNotificationToUser(userId: number, payload: any) {
    const socketId = this.userSocketMap.get(userId);
    if (socketId) {
      this.server.to(socketId).emit('new_notification', payload);
      console.log(`[WS] Sent notification to UserID: ${userId}`);
    } else {
      console.log(`[WS] User ${userId} is not connected. Notification is saved in DB.`);
    }
  }
}