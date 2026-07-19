import { Server as HttpServer } from 'http';
import { Server as SocketIOServer, Socket } from 'socket.io';
import config from '../config';

let io: SocketIOServer;

export const initSocket = (httpServer: HttpServer): SocketIOServer => {
  io = new SocketIOServer(httpServer, {
    cors: {
      origin: config.frontendUrl,
      methods: ['GET', 'POST'],
      credentials: true,
    },
    pingTimeout: 60000,
  });

  io.on('connection', (socket: Socket) => {
    console.log(`[Socket] Client connected: ${socket.id}`);

    // Admin joins the admin room to receive real-time new-order alerts
    socket.on('join:admin', () => {
      socket.join('admin');
      console.log(`[Socket] Client ${socket.id} joined admin room`);
    });

    socket.on('leave:admin', () => {
      socket.leave('admin');
      console.log(`[Socket] Client ${socket.id} left admin room`);
    });

    // User joins a specific order room to receive progress updates
    socket.on('join:order', (orderId: string) => {
      socket.join(`order:${orderId}`);
      console.log(`[Socket] Client ${socket.id} joined order room: ${orderId}`);
    });

    // User leaves an order room
    socket.on('leave:order', (orderId: string) => {
      socket.leave(`order:${orderId}`);
      console.log(`[Socket] Client ${socket.id} left order room: ${orderId}`);
    });

    socket.on('disconnect', (reason) => {
      console.log(`[Socket] Client disconnected: ${socket.id} — ${reason}`);
    });
  });

  return io;
};

// Getter for use in other modules (e.g., job workers)
export const getIO = (): SocketIOServer => {
  if (!io) {
    throw new Error('Socket.io not initialized. Call initSocket() first.');
  }
  return io;
};
