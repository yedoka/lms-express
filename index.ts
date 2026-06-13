import express from "express";
import cors from "cors";
import http from "http";
import { Server } from "socket.io";
import { redis } from "./lib/redis.js";
import { verifySocketToken } from "./lib/auth.js";
import { startNotificationSubscriber } from "./lib/notifications.js";
import { registerQuizSessionHandlers } from "./lib/quiz-session.js";

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

  const userId = await verifySocketToken(token);
  if (!userId) return next(new Error("Invalid token"));

  socket.data.userId = userId;
  next();
});

io.on("connection", (socket) => {
  const userId = socket.data.userId as string;
  socket.join(`user:${userId}`);
  console.log(`User ${userId} connected`);

  registerQuizSessionHandlers(io, socket);

  socket.on("disconnect", () => {
    console.log(`User ${userId} disconnected`);
  });
});

async function start() {
  await redis.connect();
  const pong = await redis.ping();
  console.log(`Redis connected: ${pong}`);

  startNotificationSubscriber(io);

  server.listen(PORT, () => {
    console.log(`Listening on PORT ${PORT}...`);
  });
}

start();
