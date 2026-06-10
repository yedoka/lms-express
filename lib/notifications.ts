import type { Server } from "socket.io";
import Redis from "ioredis";

const NOTIFICATION_CHANNEL = "notification:new";

export function startNotificationSubscriber(io: Server) {
  const REDIS_URL = process.env.REDIS_URL;
  if (!REDIS_URL) throw new Error("REDIS_URL is not defined");

  // Subscriber needs its own connection — ioredis clients in subscribe mode
  // cannot issue regular commands on the same connection.
  const subscriber = new Redis(REDIS_URL);

  subscriber.subscribe(NOTIFICATION_CHANNEL, (err) => {
    if (err) console.error("Failed to subscribe to notification:new", err);
    else console.log("Subscribed to notification:new channel");
  });

  subscriber.on("message", (channel, message) => {
    if (channel !== NOTIFICATION_CHANNEL) return;
    try {
      const notification = JSON.parse(message) as {
        userId: string;
        id: string;
        type: string;
        message: string;
        createdAt: string;
      };
      if (!notification.userId) return;
      const { userId, ...payload } = notification;
      io.to(`user:${userId}`).emit(NOTIFICATION_CHANNEL, payload);
    } catch (err) {
      console.error("Failed to process notification message", err);
    }
  });

  return subscriber;
}
