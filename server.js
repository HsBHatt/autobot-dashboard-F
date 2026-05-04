// ─────────────────────────────────────────────
//  SAIM AUTO BOT  —  server.js
//  WhatsApp: Baileys (no browser, ~50MB RAM)
//  Hosting:  Railway / Koyeb / any free tier
// ─────────────────────────────────────────────

const express        = require('express')
const http           = require('http')
const { Server }     = require('socket.io')
const fs             = require('fs')
const path           = require('path')
const crypto         = require('crypto')

// ── Baileys imports ──────────────────────────
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')
const pino = require('pino')

// ─────────────────────────────────────────────
//  CONFIG  (set these as env vars on Railway)
// ─────────────────────────────────────────────
const PORT             = process.env.PORT            || 3000
const API_KEY          = process.env.API_KEY         || ''
const SHOPIFY_SECRET   = process.env.SHOPIFY_SECRET  || ''
const SETTINGS_FILE    = path.join(__dirname, 'settings.json')
const AUTH_DIR         = path.join(__dirname, 'auth_info')

// ─────────────────────────────────────────────
//  SETTINGS  (persisted to settings.json)
// ─────────────────────────────────────────────
let settings = {
  confirmation:       { enabled: true,  delayMinutes: 5,   message: 'Hello {customer_name}! Your order #{order_number} for {amount} has been placed. ✅', paymentStatuses: { paid: true, pending: true, cod: false } },
  fulfillment:        { enabled: true,  trigger: 'on_fulfillment', message: 'Hi {customer_name}! Your order #{order_number} has shipped! 📦 Tracking: {tracking_number}' },
  cancellation:       { enabled: true,  notifyCustomer: true, notifyAdmin: true, message: 'Hi {customer_name}, your order #{order_number} was cancelled. Reason: {cancel_reason}. Refund: {refund_amount} in 3-5 days.' },
  orderNotifications: { placed: { enabled: true, message: '' }, paid: { enabled: true, message: '' }, fulfilled: { enabled: true, message: '' }, delivered: { enabled: true, message: '' }, refunded: { enabled: true, message: '' } },
  adminNotifications: { adminPhone: '', events: { new_order: true, cancellation: true, failed_payment: false, low_stock: false, new_review: false } },
  abandonedCart:      { enabled: true,  firstMessageDelayMinutes: 60, discountCode: '', firstMessage: 'Hey {customer_name}! Your cart is waiting 🛒 {checkout_url}', followUp: { enabled: false, delayMinutes: 1440, message: 'Last chance! {checkout_url} 🔥' } }
}

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))
      settings = { ...settings, ...raw }
    }
  } catch (e) { console.warn('Could not load settings.json, using defaults') }
}

function saveSettings() {
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)) }
  catch (e) { console.error('Could not save settings:', e.message) }
}

loadSettings()

// ─────────────────────────────────────────────
//  EXPRESS + SOCKET.IO
// ─────────────────────────────────────────────
const app    = express()
const server = http.createServer(app)
const io     = new Server(server, { cors: { origin: '*' } })

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// Serve dashboard HTML from public/index.html
app.use(express.static(path.join(__dirname, 'public')))

// ─────────────────────────────────────────────
//  MIDDLEWARE  —  optional API key check
// ─────────────────────────────────────────────
function auth(req, res, next) {
  if (!API_KEY) return next()
  const key = req.headers['x-api-key'] || req.query.apiKey
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' })
  next()
}

// ─────────────────────────────────────────────
//  WHATSAPP STATE
// ─────────────────────────────────────────────
let sock           = null
let waConnected    = false
let waNumber       = ''
let msgLog         = []
let reconnectTimer = null

// ─────────────────────────────────────────────
//  TEMPLATE HELPER
// ─────────────────────────────────────────────
function fillTemplate(template, vars) {
  let out = template || ''
  for (const [k, v] of Object.entries(vars)) {
    out = out.replace(new RegExp(`{${k}}`, 'g'), v ?? '')
  }
  return out
}

// ─────────────────────────────────────────────
//  SEND WHATSAPP MESSAGE
// ─────────────────────────────────────────────
async function sendWA(phone, message) {
  if (!sock || !waConnected) throw new Error('WhatsApp not connected')
  // Normalise: +923001234567 → 923001234567@s.whatsapp.net
  const jid = phone.replace(/[^0-9]/g, '') + '@s.whatsapp.net'
  await sock.sendMessage(jid, { text: message })
  console.log(`[WA] Sent to ${jid}`)
}

// ─────────────────────────────────────────────
//  BAILEYS  —  start / reconnect
// ─────────────────────────────────────────────
async function startWA() {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true })

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version }          = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    auth:              state,
    logger:            pino({ level: 'silent' }),
    printQRInTerminal: true,
    browser:           ['SAIM AUTO BOT', 'Chrome', '1.0.0'],
    syncFullHistory:   false
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {

    if (qr) {
      console.log('[WA] QR ready — scan with WhatsApp')
      io.emit('qr', qr)
      io.emit('status', { status: 'qr_ready' })
    }

    if (connection === 'open') {
      waConnected = true
      waNumber    = sock.user?.id?.split(':')[0] || ''
      console.log('[WA] Connected as', waNumber)
      io.emit('status', { status: 'connected', number: waNumber })
    }

    if (connection === 'close') {
      waConnected = false
      waNumber    = ''
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode
      console.log('[WA] Disconnected. Code:', reason)

      if (reason === DisconnectReason.loggedOut) {
        console.log('[WA] Logged out — clearing session')
        fs.rmSync(AUTH_DIR, { recursive: true, force: true })
        io.emit('status', { status: 'auth_failed' })
        setTimeout(startWA, 3000)
      } else {
        io.emit('status', { status: 'disconnected' })
        clearTimeout(reconnectTimer)
        reconnectTimer = setTimeout(startWA, 5000)
      }
    }
  })

  // ── Incoming messages ──────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return

    for (const msg of messages) {
      if (msg.key.fromMe) continue

      const from = msg.key.remoteJid || ''
      const body = msg.message?.conversation
                || msg.message?.extendedTextMessage?.text
                || ''

      const entry = {
        from: from.replace('@s.whatsapp.net', ''),
        body,
        time: new Date().toLocaleTimeString()
      }

      msgLog.unshift(entry)
      if (msgLog.length > 50) msgLog.pop()
      io.emit('new_message', entry)

      // Auto-replies
      const lower = body.toLowerCase().trim()
      const replies = {
        'hello': '👋 Hello! Welcome to our store. How can I help you?',
        'order': '🛍️ Please send your order number to track.',
        'price': '💰 Check our latest prices at our store.',
        'help':  'ℹ️ Commands: hello, order, price, help'
      }
      if (replies[lower]) {
        await sock.sendMessage(from, { text: replies[lower] })
      }
    }
  })
}

startWA().catch(err => console.error('[WA] Start error:', err))

// ─────────────────────────────────────────────
//  SOCKET.IO  —  dashboard events
// ─────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('[IO] Dashboard connected')
  socket.emit('status', { status: waConnected ? 'connected' : 'disconnected', number: waNumber })
  socket.emit('message_history', msgLog)

  socket.on('disconnect_wa', async () => {
    try {
      await sock?.logout()
      fs.rmSync(AUTH_DIR, { recursive: true, force: true })
      waConnected = false
      waNumber    = ''
      io.emit('status', { status: 'disconnected' })
      setTimeout(startWA, 2000)
    } catch (e) { console.error('[IO] Logout error:', e.message) }
  })
})

// ─────────────────────────────────────────────
//  REST API
// ─────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true }))

app.get('/api/status', auth, (_, res) => {
  res.json({
    ok:                true,
    version:           '2.0.0',
    waConnected,
    waNumber,
    shopifyConfigured: !!SHOPIFY_SECRET
  })
})

app.get('/api/settings', auth, (_, res) => res.json(settings))

app.patch('/api/settings/:section', auth, (req, res) => {
  const { section } = req.params
  settings[section] = { ...(settings[section] || {}), ...req.body }
  saveSettings()
  res.json({ ok: true })
})

app.post('/api/wa/test', auth, async (req, res) => {
  const { phone, message } = req.body
  if (!phone || !message) return res.status(400).json({ ok: false, error: 'phone and message required' })
  try {
    await sendWA(phone, message)
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ─────────────────────────────────────────────
//  SHOPIFY WEBHOOK VERIFY
// ─────────────────────────────────────────────
function verifyShopify(req) {
  if (!SHOPIFY_SECRET) return true
  const hmac = req.headers['x-shopify-hmac-sha256']
  if (!hmac) return false
  const hash = crypto.createHmac('sha256', SHOPIFY_SECRET).update(JSON.stringify(req.body)).digest('base64')
  return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(hash))
}

// ─────────────────────────────────────────────
//  SHOPIFY  —  Order Created
// ─────────────────────────────────────────────
app.post('/webhook/shopify/order-created', async (req, res) => {
  res.sendStatus(200)
  if (!verifyShopify(req)) return

  const order = req.body
  const phone = order.shipping_address?.phone || order.billing_address?.phone || order.phone
  if (!phone) return

  const cfg = settings.confirmation
  if (!cfg?.enabled) return

  const status = order.financial_status
  if (cfg.paymentStatuses && cfg.paymentStatuses[status] === false) return

  const vars = {
    customer_name: order.shipping_address?.first_name || order.customer?.first_name || 'Customer',
    order_number:  order.order_number || order.name || '',
    amount:        `${order.currency} ${order.total_price}`,
    store_name:    order.shop_domain || 'Our Store'
  }

  const delay = (cfg.delayMinutes || 0) * 60 * 1000
  setTimeout(async () => {
    try { await sendWA(phone, fillTemplate(cfg.message, vars)) }
    catch (e) { console.error('[WH] Order confirm error:', e.message) }
  }, delay)

  const adminCfg = settings.adminNotifications
  if (adminCfg?.events?.new_order && adminCfg.adminPhone) {
    try { await sendWA(adminCfg.adminPhone, `🛒 New Order #${vars.order_number}\nCustomer: ${vars.customer_name}\nAmount: ${vars.amount}`) } catch {}
  }
})

// ─────────────────────────────────────────────
//  SHOPIFY  —  Order Fulfilled
// ─────────────────────────────────────────────
app.post('/webhook/shopify/order-fulfilled', async (req, res) => {
  res.sendStatus(200)
  if (!verifyShopify(req)) return

  const order = req.body
  const phone = order.shipping_address?.phone || order.phone
  if (!phone) return

  const cfg = settings.fulfillment
  if (!cfg?.enabled) return

  const fulfillment = order.fulfillments?.[0] || {}
  const vars = {
    customer_name:   order.shipping_address?.first_name || 'Customer',
    order_number:    order.order_number || order.name || '',
    tracking_number: fulfillment.tracking_number || 'N/A',
    carrier:         fulfillment.tracking_company || '',
    delivery_date:   ''
  }

  try { await sendWA(phone, fillTemplate(cfg.message, vars)) }
  catch (e) { console.error('[WH] Fulfillment error:', e.message) }
})

// ─────────────────────────────────────────────
//  SHOPIFY  —  Order Cancelled
// ─────────────────────────────────────────────
app.post('/webhook/shopify/order-cancelled', async (req, res) => {
  res.sendStatus(200)
  if (!verifyShopify(req)) return

  const order = req.body
  const phone = order.shipping_address?.phone || order.phone

  const cfg = settings.cancellation
  if (!cfg?.enabled) return

  const vars = {
    customer_name: order.shipping_address?.first_name || 'Customer',
    order_number:  order.order_number || order.name || '',
    cancel_reason: order.cancel_reason || 'Not specified',
    refund_amount: `${order.currency} ${order.total_price}`
  }

  if (cfg.notifyCustomer && phone) {
    try { await sendWA(phone, fillTemplate(cfg.message, vars)) } catch {}
  }

  const adminCfg = settings.adminNotifications
  if (cfg.notifyAdmin && adminCfg?.events?.cancellation && adminCfg.adminPhone) {
    try { await sendWA(adminCfg.adminPhone, `❌ Order Cancelled #${vars.order_number}\nCustomer: ${vars.customer_name}\nReason: ${vars.cancel_reason}`) } catch {}
  }
})

// ─────────────────────────────────────────────
//  SHOPIFY  —  Abandoned Cart
// ─────────────────────────────────────────────
app.post('/webhook/shopify/cart-abandoned', async (req, res) => {
  res.sendStatus(200)
  if (!verifyShopify(req)) return

  const cart = req.body
  const cfg  = settings.abandonedCart
  if (!cfg?.enabled) return

  const phone = cart.phone
  if (!phone) return

  const vars = {
    customer_name: cart.customer?.first_name || 'there',
    cart_items:    (cart.line_items || []).map(i => i.title).join(', '),
    cart_total:    `${cart.currency} ${cart.total_price}`,
    checkout_url:  cart.abandoned_checkout_url || '',
    discount_code: cfg.discountCode || ''
  }

  const delay1 = (cfg.firstMessageDelayMinutes || 60) * 60 * 1000
  setTimeout(async () => {
    try { await sendWA(phone, fillTemplate(cfg.firstMessage, vars)) }
    catch (e) { console.error('[WH] Cart recovery error:', e.message) }
  }, delay1)

  if (cfg.followUp?.enabled) {
    const delay2 = delay1 + (cfg.followUp.delayMinutes || 1440) * 60 * 1000
    setTimeout(async () => {
      try { await sendWA(phone, fillTemplate(cfg.followUp.message, vars)) }
      catch (e) { console.error('[WH] Follow-up error:', e.message) }
    }, delay2)
  }
})

// ─────────────────────────────────────────────
//  START SERVER
// ─────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🤖 SAIM AUTO BOT running on port ${PORT}`)
  console.log(`📊 Dashboard → http://localhost:${PORT}`)
  console.log(`⚡ Baileys (low memory mode — no Chrome)\n`)
})
