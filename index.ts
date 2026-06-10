import express from "express";
import cors from "cors";
import http from "http";
import { Server } from "socket.io";
import { redis } from "./lib/redis.js";

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

io.on("connection", (socket) => {
  console.log("a user connected");
});

async function start() {
  await redis.connect();
  const pong = await redis.ping();
  console.log(`Redis connected: ${pong}`);

  server.listen(PORT, () => {
    console.log(`Listening on PORT ${PORT}...`);
  });
}

start();
