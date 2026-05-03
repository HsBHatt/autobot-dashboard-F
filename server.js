const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ─── WhatsApp Status ───────────────────────────────────────────────
let waStatus = "disconnected"; // disconnected | qr_ready | connected
let lastQR = null;
let connectedNumber = null;
let messageLog = [];

// ─── WhatsApp Client ───────────────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: "./wa_session" }),
  puppeteer: {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--single-process",
      "--disable-gpu",
    ],
  },
});

client.on("qr", async (qr) => {
  console.log("📱 QR Code generated — scan with WhatsApp");
  waStatus = "qr_ready";
  try {
    lastQR = await qrcode.toDataURL(qr);
    io.emit("qr", lastQR);
    io.emit("status", { status: "qr_ready" });
  } catch (err) {
    console.error("QR generation error:", err);
  }
});

client.on("ready", async () => {
  console.log("✅ WhatsApp Connected!");
  waStatus = "connected";
  lastQR = null;
  const info = client.info;
  connectedNumber = info?.wid?.user || "Unknown";
  io.emit("status", { status: "connected", number: connectedNumber });
});

client.on("authenticated", () => {
  console.log("🔐 Authenticated");
  io.emit("status", { status: "authenticated" });
});

client.on("auth_failure", () => {
  console.log("❌ Auth failed — restart required");
  waStatus = "disconnected";
  io.emit("status", { status: "auth_failed" });
});

client.on("disconnected", () => {
  console.log("📵 WhatsApp disconnected");
  waStatus = "disconnected";
  connectedNumber = null;
  io.emit("status", { status: "disconnected" });
});

client.on("message", async (msg) => {
  const contact = await msg.getContact();
  const name = contact.pushname || msg.from;
  const entry = {
    from: name,
    number: msg.from,
    body: msg.body,
    time: new Date().toLocaleTimeString(),
  };
  messageLog.unshift(entry);
  if (messageLog.length > 50) messageLog.pop();
  io.emit("new_message", entry);
  console.log(`💬 Message from ${name}: ${msg.body}`);

  // ── Auto-reply example ──────────────────────────────────────────
  if (msg.body.toLowerCase() === "hello") {
    msg.reply("👋 Hello! Welcome to our store. How can I help you?");
  }
  if (msg.body.toLowerCase() === "order") {
    msg.reply("🛍️ To track your order, please send your order number.");
  }
});

client.initialize().catch((err) => {
  console.error("Client init error:", err);
});

// ─── Socket.IO ─────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("🌐 Dashboard connected");

  // Send current state to newly connected dashboard
  socket.emit("status", {
    status: waStatus,
    number: connectedNumber,
  });

  if (lastQR && waStatus === "qr_ready") {
    socket.emit("qr", lastQR);
  }

  socket.emit("message_history", messageLog);

  socket.on("disconnect_wa", async () => {
    await client.destroy();
    waStatus = "disconnected";
    io.emit("status", { status: "disconnected" });
  });
});

// ─── Routes ────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/api/status", (req, res) => {
  res.json({ status: waStatus, number: connectedNumber });
});

// ─── Start ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
