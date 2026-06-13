import express from "express";
import cors from "cors";
import http from "http";
import { Server } from "socket.io";
import { redis } from "./lib/redis.js";
import { verifySocketToken } from "./lib/auth.js";
import { startNotificationSubscriber } from "./lib/notifications.js";
import { startAdminActivitySubscriber } from "./lib/admin-activity.js";
import { registerQuizSessionHandlers } from "./lib/quiz-session.js";

const PRESENCE_TTL_SECONDS = 60;
const PRESENCE_REFRESH_MS = 30_000;

const PORT = process.env.PORT;
const CLIENT_URL = process.env.CLIENT_URL;

if (!PORT) {
  throw new Error("PORT is not defined in the environment variables.");
}

if (!CLIENT_URL) {
  throw new Error("CLIENT_URL is not defined in the environment variables.");
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: CLIENT_URL,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

app.use(
  cors({
    origin: CLIENT_URL,
    credentials: true,
  }),
);

app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.get("/health", (req, res) => {
  res.json({ status: "OK" });
});

io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token as string | undefined;
  if (!token) return next(new Error("Authentication required"));

  const identity = await verifySocketToken(token);
  if (!identity) return next(new Error("Invalid token"));

  socket.data.userId = identity.userId;
  socket.data.role = identity.role;
  next();
});

io.on("connection", (socket) => {
  const userId = socket.data.userId as string;
  const role = socket.data.role as string;
  socket.join(`user:${userId}`);
  if (role === "ADMIN") socket.join("admin");
  console.log(`User ${userId} connected`);

  // Presence: mark online with a TTL, refreshed on a heartbeat so a hard
  // disconnect expires naturally instead of leaving a ghost "online" key.
  const presenceKey = `presence:${userId}`;
  void redis.set(presenceKey, role, "EX", PRESENCE_TTL_SECONDS);
  const presenceTimer = setInterval(() => {
    void redis.set(presenceKey, role, "EX", PRESENCE_TTL_SECONDS);
  }, PRESENCE_REFRESH_MS);

  registerQuizSessionHandlers(io, socket);

  socket.on("disconnect", () => {
    clearInterval(presenceTimer);
    // Only clear presence if this user has no other open sockets
    void io.in(`user:${userId}`).fetchSockets().then((sockets) => {
      if (sockets.length === 0) void redis.del(presenceKey);
    });
    console.log(`User ${userId} disconnected`);
  });
});

async function start() {
  await redis.connect();
  const pong = await redis.ping();
  console.log(`Redis connected: ${pong}`);

  startNotificationSubscriber(io);
  startAdminActivitySubscriber(io);

  server.listen(PORT, () => {
    console.log(`Listening on PORT ${PORT}...`);
  });
}

start();
