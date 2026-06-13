import type { Server } from "socket.io";
import Redis from "ioredis";

const ACTIVITY_CHANNEL = "admin:activity";
const ADMIN_ROOM = "admin";

export function startAdminActivitySubscriber(io: Server) {
  const REDIS_URL = process.env.REDIS_URL;
  if (!REDIS_URL) throw new Error("REDIS_URL is not defined");

  // Subscriber needs its own connection — a client in subscribe mode
  // cannot issue regular commands on the same connection.
  const subscriber = new Redis(REDIS_URL);

  subscriber.subscribe(ACTIVITY_CHANNEL, (err) => {
    if (err) console.error("Failed to subscribe to admin:activity", err);
    else console.log("Subscribed to admin:activity channel");
  });

  subscriber.on("message", (channel, message) => {
    if (channel !== ACTIVITY_CHANNEL) return;
    try {
      const event = JSON.parse(message) as {
        kind: string;
        label: string;
        at: string;
      };
      io.to(ADMIN_ROOM).emit(ACTIVITY_CHANNEL, event);
    } catch (err) {
      console.error("Failed to process admin activity message", err);
    }
  });

  return subscriber;
}
