const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ── Session Reset ─────────────────────────────────────────────────
if (process.env.RESET_SESSION === "true") {
  try { fs.rmSync("./wa_session", { recursive: true, force: true }); console.log("🗑️ Session cleared"); } catch (e) {}
}

// ── Settings ──────────────────────────────────────────────────────
const SETTINGS_FILE = "./settings.json";
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")); } catch { return {}; }
}
function saveSettings(data) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2));
}

// ── Middleware ────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname)));
app.use("/webhook/shopify", express.raw({ type: "application/json" }));
app.use(express.json());

// ── WhatsApp State ────────────────────────────────────────────────
let waStatus = "disconnected";
let lastQR = null;
let connectedNumber = null;
let messageLog = [];

// ── WhatsApp Client ───────────────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: "./wa_session" }),
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage",
           "--disable-accelerated-2d-canvas","--no-first-run","--no-zygote",
           "--single-process","--disable-gpu"],
  },
});

client.on("qr", async (qr) => {
  console.log("📱 QR Code ready — scan now");
  waStatus = "qr_ready"; lastQR = null;
  try {
    lastQR = await qrcode.toDataURL(qr);
    io.emit("qr", lastQR);
    io.emit("status", { status: "qr_ready" });
  } catch (e) { console.error("QR error:", e); }
});

client.on("ready", async () => {
  console.log("✅ WhatsApp Connected!");
  waStatus = "connected"; lastQR = null;
  connectedNumber = client.info?.wid?.user || "Unknown";
  io.emit("status", { status: "connected", number: connectedNumber });
});

client.on("authenticated", () => { io.emit("status", { status: "authenticated" }); });

client.on("auth_failure", () => {
  waStatus = "disconnected";
  io.emit("status", { status: "auth_failed" });
});

client.on("disconnected", () => {
  waStatus = "disconnected"; connectedNumber = null;
  io.emit("status", { status: "disconnected" });
});

// ── Incoming Messages + Auto Reply ───────────────────────────────
client.on("message", async (msg) => {
  if (msg.fromMe) return;
  const contact = await msg.getContact();
  const name = contact.pushname || msg.from.replace("@c.us", "");
  const entry = { from: name, number: msg.from, body: msg.body, time: new Date().toLocaleTimeString() };
  messageLog.unshift(entry);
  if (messageLog.length > 50) messageLog.pop();
  io.emit("new_message", entry);
  console.log(`💬 ${name}: ${msg.body}`);

  const text = msg.body.toLowerCase().trim();

  // Built-in replies
  if (text === "hello" || text === "hi" || text === "salam" || text === "assalam") {
    await msg.reply(`👋 Hello *${name}*! Welcome to our store.\n\nReply with:\n*order* – Track order\n*price* – View prices\n*location* – Our location\n*timing* – Business hours\n*help* – All commands`);
  } else if (text === "order") {
    await msg.reply("🛍️ Please send your order number (e.g. *#1234*) and we'll look it up for you!");
  } else if (text === "price") {
    await msg.reply("💰 Visit our store for the latest prices.\n\nType *help* for more commands.");
  } else if (text === "location") {
    await msg.reply("📍 We are based in Pakistan.\nContact us for the exact address.");
  } else if (text === "timing") {
    await msg.reply("🕐 *Business Hours:*\nMon – Sat: 9:00 AM – 9:00 PM\nSunday: Closed");
  } else if (text === "help") {
    await msg.reply("ℹ️ *Available Commands:*\n\n*hello* – Greet the bot\n*order* – Track your order\n*price* – View prices\n*location* – Find us\n*timing* – Business hours\n*help* – This menu\n\n_Powered by SAIM AUTO BOT_ 🤖");
  }
});

client.initialize().catch(e => console.error("Init error:", e));

// ── Send WhatsApp Helper ──────────────────────────────────────────
async function sendWA(phone, message) {
  if (waStatus !== "connected") return false;
  try {
    const num = String(phone).replace(/[^0-9]/g, "");
    const chatId = `${num}@c.us`;
    await client.sendMessage(chatId, message);
    console.log(`📤 Sent to ${num}`);
    return true;
  } catch (e) { console.error("Send WA error:", e); return false; }
}

// ── Fill Template ─────────────────────────────────────────────────
function fill(template, data) {
  return template.replace(/\{(\w+)\}/g, (_, k) => data[k] || "");
}

// ── Verify Shopify HMAC ───────────────────────────────────────────
function verifyShopify(req) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) return true;
  const hmac = req.headers["x-shopify-hmac-sha256"];
  if (!hmac) return false;
  const digest = crypto.createHmac("sha256", secret).update(req.body).digest("base64");
  try { return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac)); } catch { return false; }
}

// ─────────────────────────────────────────────────────────────────
// SHOPIFY WEBHOOKS
// ─────────────────────────────────────────────────────────────────

// 1. ORDER CREATED → Confirmation
app.post("/webhook/shopify/order-created", async (req, res) => {
  if (!verifyShopify(req)) return res.status(401).send("Unauthorized");
  res.status(200).send("OK");
  try {
    const order = JSON.parse(req.body);
    const s = loadSettings();
    const cfg = s.confirmation || {};
    if (cfg.enabled === false) return;

    const phone = order.billing_address?.phone || order.shipping_address?.phone || order.customer?.phone;
    if (!phone) return console.log("No phone on order", order.name);

    // Check payment status filter
    const ps = cfg.paymentStatuses || { paid: true, pending: true };
    if (ps[order.financial_status] === false) return;

    const template = cfg.message ||
      "Hello *{customer_name}*! 🎉\n\nYour order *#{order_number}* has been placed!\n💰 Amount: *{amount}*\n🛍️ Items: {items}\n\nThank you for shopping with us! We'll notify you when it ships. 📦";

    const message = fill(template, {
      customer_name: order.customer?.first_name || "Customer",
      order_number: order.name || order.order_number,
      amount: `${order.currency} ${order.total_price}`,
      store_name: "Our Store",
      items: order.line_items?.map(i => i.name).join(", ") || "",
    });

    const delay = (cfg.delayMinutes || 0) * 60 * 1000;
    setTimeout(() => sendWA(phone, message), delay);

    // Admin alert for new order
    const admin = s.adminNotifications || {};
    if (admin.adminPhone && admin.events?.new_order) {
      const adminMsg = `🛍️ *New Order!*\nOrder: *${order.name}*\nCustomer: ${order.customer?.first_name} ${order.customer?.last_name}\nPhone: ${phone}\nAmount: ${order.currency} ${order.total_price}\nItems: ${order.line_items?.length}`;
      setTimeout(() => sendWA(admin.adminPhone, adminMsg), delay);
    }
  } catch (e) { console.error("order-created:", e); }
});

// 2. ORDER FULFILLED → Shipping notification
app.post("/webhook/shopify/order-fulfilled", async (req, res) => {
  if (!verifyShopify(req)) return res.status(401).send("Unauthorized");
  res.status(200).send("OK");
  try {
    const order = JSON.parse(req.body);
    const s = loadSettings();
    const cfg = s.fulfillment || {};
    if (cfg.enabled === false) return;

    const phone = order.billing_address?.phone || order.shipping_address?.phone || order.customer?.phone;
    if (!phone) return;

    const fulfillment = order.fulfillments?.[0] || {};
    const template = cfg.message ||
      "Hi *{customer_name}*! 🚚\n\nYour order *#{order_number}* has been shipped!\n\n📦 Tracking: *{tracking_number}*\n🚛 Carrier: {carrier}\n\nExpected delivery: {delivery_date}\n\nThank you for your patience!";

    const message = fill(template, {
      customer_name: order.customer?.first_name || "Customer",
      order_number: order.name || order.order_number,
      tracking_number: fulfillment.tracking_number || "Will be updated soon",
      carrier: fulfillment.tracking_company || "Our courier partner",
      delivery_date: "3-5 business days",
    });

    await sendWA(phone, message);
  } catch (e) { console.error("order-fulfilled:", e); }
});

// 3. ORDER CANCELLED → Cancellation notice
app.post("/webhook/shopify/order-cancelled", async (req, res) => {
  if (!verifyShopify(req)) return res.status(401).send("Unauthorized");
  res.status(200).send("OK");
  try {
    const order = JSON.parse(req.body);
    const s = loadSettings();
    const cfg = s.cancellation || {};
    if (cfg.enabled === false) return;

    const phone = order.billing_address?.phone || order.shipping_address?.phone || order.customer?.phone;

    if (phone && cfg.notifyCustomer !== false) {
      const template = cfg.message ||
        "Hi *{customer_name}*,\n\nYour order *#{order_number}* has been cancelled.\n❌ Reason: {cancel_reason}\n💰 Refund: *{refund_amount}* will be processed in 3-5 business days.\n\nSorry for the inconvenience. Feel free to order again! 🙏";

      const message = fill(template, {
        customer_name: order.customer?.first_name || "Customer",
        order_number: order.name || order.order_number,
        cancel_reason: order.cancel_reason || "As requested",
        refund_amount: `${order.currency} ${order.total_price}`,
      });
      await sendWA(phone, message);
    }

    // Admin alert
    const admin = s.adminNotifications || {};
    if (admin.adminPhone && admin.events?.cancellation) {
      const adminMsg = `❌ *Order Cancelled*\nOrder: *${order.name}*\nCustomer: ${order.customer?.first_name} ${order.customer?.last_name}\nReason: ${order.cancel_reason || "N/A"}\nAmount: ${order.currency} ${order.total_price}`;
      await sendWA(admin.adminPhone, adminMsg);
    }
  } catch (e) { console.error("order-cancelled:", e); }
});

// 4. ABANDONED CART → Recovery messages
app.post("/webhook/shopify/cart-abandoned", async (req, res) => {
  if (!verifyShopify(req)) return res.status(401).send("Unauthorized");
  res.status(200).send("OK");
  try {
    const checkout = JSON.parse(req.body);
    const s = loadSettings();
    const cfg = s.abandonedCart || {};
    if (cfg.enabled === false) return;

    const phone = checkout.billing_address?.phone || checkout.shipping_address?.phone || checkout.customer?.phone;
    if (!phone) return;

    const data = {
      customer_name: checkout.customer?.first_name || "there",
      cart_items: checkout.line_items?.map(i => i.title).join(", ") || "your items",
      cart_total: `${checkout.currency} ${checkout.total_price}`,
      checkout_url: checkout.abandoned_checkout_url || "",
      discount_text: cfg.discountCode ? `🎁 Use code *${cfg.discountCode}* for extra discount!` : "",
    };

    const template = cfg.firstMessage ||
      "Hey *{customer_name}*! 👋\n\nYou left something in your cart 🛒\n\n📦 Items: {cart_items}\n💰 Total: *{cart_total}*\n\nComplete your order here 👇\n{checkout_url}\n\n{discount_text}";

    const delay = (cfg.firstMessageDelayMinutes || 60) * 60 * 1000;
    setTimeout(() => sendWA(phone, fill(template, data)), delay);

    // Follow-up
    const fu = cfg.followUp || {};
    if (fu.enabled !== false) {
      const fuTemplate = fu.message || "⏰ Last chance *{customer_name}*! Your cart expires soon.\n\n🔥 Complete your order: {checkout_url}";
      const fuDelay = delay + (fu.delayMinutes || 1440) * 60 * 1000;
      setTimeout(() => sendWA(phone, fill(fuTemplate, data)), fuDelay);
    }
  } catch (e) { console.error("cart-abandoned:", e); }
});

// 5. PAYMENT FAILED → Admin alert
app.post("/webhook/shopify/payment-failed", async (req, res) => {
  if (!verifyShopify(req)) return res.status(401).send("Unauthorized");
  res.status(200).send("OK");
  try {
    const order = JSON.parse(req.body);
    const s = loadSettings();
    const admin = s.adminNotifications || {};
    if (admin.adminPhone && admin.events?.failed_payment) {
      const msg = `⚠️ *Payment Failed*\nOrder: *${order.name}*\nCustomer: ${order.customer?.first_name} ${order.customer?.last_name}\nPhone: ${order.customer?.phone || "N/A"}\nAmount: ${order.currency} ${order.total_price}`;
      await sendWA(admin.adminPhone, msg);
    }
  } catch (e) { console.error("payment-failed:", e); }
});

// ─────────────────────────────────────────────────────────────────
// REST API
// ─────────────────────────────────────────────────────────────────

app.get("/api/status", (req, res) => {
  res.json({
    ok: true,
    waConnected: waStatus === "connected",
    shopifyConfigured: !!process.env.SHOPIFY_WEBHOOK_SECRET,
    phoneNumberId: connectedNumber,
    version: "2.0.0",
  });
});

app.get("/api/settings", (req, res) => {
  res.json(loadSettings());
});

app.patch("/api/settings/:section", (req, res) => {
  try {
    const settings = loadSettings();
    settings[req.params.section] = { ...(settings[req.params.section] || {}), ...req.body };
    saveSettings(settings);
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post("/api/wa/test", async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) return res.json({ ok: false, error: "phone and message required" });
  if (waStatus !== "connected") return res.json({ ok: false, error: "WhatsApp not connected. Scan QR first." });
  const ok = await sendWA(phone, message);
  res.json({ ok, error: ok ? null : "Failed to send" });
});

// ── Socket.IO ─────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("🌐 Dashboard connected");
  socket.emit("status", { status: waStatus, number: connectedNumber });
  if (lastQR && waStatus === "qr_ready") socket.emit("qr", lastQR);
  socket.emit("message_history", messageLog);
  socket.on("disconnect_wa", async () => {
    try { await client.destroy(); } catch (e) {}
    waStatus = "disconnected";
    io.emit("status", { status: "disconnected" });
  });
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 SAIM AUTO BOT v2.0 running on port ${PORT}`);
});
