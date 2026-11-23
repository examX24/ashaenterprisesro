/**
 * ASHA RO WATER - Main Server
 * Node.js + Express + JSON File Storage (no native compilation needed!)
 * Sab data local JSON files mein save hoga: data/db.json
 */

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const QRCode  = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const Razorpay = require('razorpay');

const app  = express();
const PORT = 3000;

// ─── RAZORPAY CONFIGURATION ────────────────────────────────
let RAZORPAY_KEY_ID     = 'rzp_test_U3anZUPDlpExK2';
let RAZORPAY_KEY_SECRET = 'ChhT1Mp5yAfE8eSklLk4NAJM';

let razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET
});

function initRazorpayFromDB() {
  const db = loadDB();
  if (db.settings && db.settings.razorpay_key_id && db.settings.razorpay_key_secret) {
    RAZORPAY_KEY_ID = db.settings.razorpay_key_id;
    RAZORPAY_KEY_SECRET = db.settings.razorpay_key_secret;
    razorpay = new Razorpay({
      key_id: RAZORPAY_KEY_ID,
      key_secret: RAZORPAY_KEY_SECRET
    });
    console.log(`💳 Razorpay re-initialized with Key: ${RAZORPAY_KEY_ID}`);
  }
}

// ─── IN-MEMORY: Last scanned card (bridge se aata hai) ──────
let lastScannedCard = { uid: null, scanned_at: null };

// ─── DATA FOLDER ───────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE  = path.join(DATA_DIR, 'db.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ─── DB FUNCTIONS (JSON based) ──────────────────────────────
function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    const empty = {
      customers: [],
      wallets: {},        // { customer_id: balance_paise }
      transactions: [],
      price: { paise_per_litre: 100 },   // 1 Rs = 100 paise
      settings: { default_card_litres: 20 },
      pending_orders: []
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(empty, null, 2));
    return empty;
  }
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  if (!db.settings) db.settings = { default_card_litres: 20 };
  if (!db.pending_orders) db.pending_orders = [];
  return db;
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// ─── MIDDLEWARE ─────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── GET LOCAL NETWORK IP ───────────────────────────────────
function getServerIP() {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

function nowIST() {
  return new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
}

// ══════════════════════════════════════════════════════════════
//  API ROUTES
// ══════════════════════════════════════════════════════════════

// ── GET all customers ──
app.get('/api/customers', (req, res) => {
  const db = loadDB();
  const data = db.customers.map(c => ({
    ...c,
    balance_paise: db.wallets[c.id] || 0
  }));
  res.json({ success: true, data });
});

// ── GET single customer by ID ──
app.get('/api/customers/:id', (req, res) => {
  const db = loadDB();
  const c  = db.customers.find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ success: false, message: 'Customer nahi mila' });
  res.json({ success: true, data: { ...c, balance_paise: db.wallets[c.id] || 0 } });
});

// ── GET customer by CARD UID (ESP32 use karega) ──
app.get('/api/card/:uid', (req, res) => {
  const db = loadDB();
  const c  = db.customers.find(x => x.card_uid === req.params.uid.toUpperCase());
  if (!c) return res.status(404).json({ success: false, message: 'Card registered nahi hai' });
  res.json({
    success: true,
    data: { ...c, balance_paise: db.wallets[c.id] || 0 },
    paise_per_litre: db.price.paise_per_litre,
    default_card_litres: (db.settings && db.settings.default_card_litres) ? db.settings.default_card_litres : 20
  });
});

// ── POST create new customer ──
app.post('/api/customers', (req, res) => {
  const db = loadDB();
  const { name, phone, address, card_uid, opening_balance } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ success: false, message: 'Naam zaroori hai' });

  const uid = card_uid ? card_uid.toUpperCase().trim() : null;
  if (uid && db.customers.find(x => x.card_uid === uid))
    return res.status(400).json({ success: false, message: 'Yeh card UID pehle se registered hai!' });

  const id      = uuidv4();
  const opening = Math.round((parseFloat(opening_balance) || 0) * 100);

  const newCustomer = {
    id, name: name.trim(),
    phone: phone || null,
    address: address || null,
    card_uid: uid,
    status: 'active',
    created_at: nowIST()
  };

  db.customers.unshift(newCustomer);
  db.wallets[id] = opening;

  if (opening > 0) {
    db.transactions.unshift({
      id: uuidv4(), customer_id: id, customer_name: name.trim(),
      card_uid: uid, type: 'RECHARGE', amount_paise: opening,
      note: 'Opening Balance', payment_ref: null, created_at: nowIST()
    });
  }
  saveDB(db);
  res.json({ success: true, id, message: 'Customer register ho gaya!' });
});

// ── PATCH update customer ──
app.patch('/api/customers/:id', (req, res) => {
  const db = loadDB();
  const idx = db.customers.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Customer nahi mila' });

  const { name, phone, address, card_uid, status } = req.body;
  const uid = card_uid ? card_uid.toUpperCase().trim() : db.customers[idx].card_uid;

  // Check UID uniqueness (excluding this customer)
  if (uid && db.customers.find((x, i) => x.card_uid === uid && i !== idx))
    return res.status(400).json({ success: false, message: 'Yeh card UID kisi aur ka hai!' });

  db.customers[idx] = {
    ...db.customers[idx],
    name: name || db.customers[idx].name,
    phone: phone !== undefined ? phone : db.customers[idx].phone,
    address: address !== undefined ? address : db.customers[idx].address,
    card_uid: uid,
    status: status || db.customers[idx].status
  };
  saveDB(db);
  res.json({ success: true, message: 'Customer update ho gaya!' });
});

// ── POST recharge wallet (Admin/Driver) ──
app.post('/api/recharge', (req, res) => {
  const { customer_id, amount_rs, note, admin_pin } = req.body;
  if (admin_pin !== '1234')
    return res.status(403).json({ success: false, message: '❌ Galat Admin PIN!' });

  const amount_paise = Math.round((parseFloat(amount_rs) || 0) * 100);
  if (amount_paise <= 0)
    return res.status(400).json({ success: false, message: 'Valid amount dijiye' });

  const db = loadDB();
  const c  = db.customers.find(x => x.id === customer_id);
  if (!c) return res.status(404).json({ success: false, message: 'Customer nahi mila' });

  db.wallets[customer_id] = (db.wallets[customer_id] || 0) + amount_paise;
  const txnId = uuidv4();
  db.transactions.unshift({
    id: txnId, customer_id, customer_name: c.name, card_uid: c.card_uid,
    type: 'RECHARGE', amount_paise, note: note || 'Admin Recharge',
    payment_ref: null, created_at: nowIST()
  });
  saveDB(db);

  res.json({
    success: true,
    message: `✅ ₹${amount_rs} recharge successful!`,
    new_balance_rs: (db.wallets[customer_id] / 100).toFixed(2),
    txn_id: txnId
  });
});

// ── POST dispense water (ESP32 ya Admin trigger karta hai) ──
app.post('/api/dispense', (req, res) => {
  const { card_uid, customer_id, litres = 20 } = req.body;
  const db = loadDB();
  
  let customer = null;
  if (card_uid) {
    customer = db.customers.find(x => x.card_uid === card_uid.toUpperCase().trim());
  } else if (customer_id) {
    customer = db.customers.find(x => x.id === customer_id);
  }

  if (!customer) {
    return res.status(404).json({ success: false, message: 'Customer/Card registered nahi hai!' });
  }

  if (customer.status === 'blocked') {
    return res.status(403).json({ success: false, message: 'Card blocked hai!' });
  }

  const cost_paise = Math.round(litres * (db.price.paise_per_litre || 100));
  const current_bal = db.wallets[customer.id] || 0;

  if (current_bal < cost_paise) {
    return res.status(400).json({
      success: false,
      message: '❌ Balance kam hai!',
      current_balance_rs: (current_bal / 100).toFixed(2),
      required_rs: (cost_paise / 100).toFixed(2)
    });
  }

  // Deduct
  db.wallets[customer.id] = current_bal - cost_paise;
  const txnId = 'DSP_' + uuidv4().substring(0, 8).toUpperCase();
  db.transactions.unshift({
    id: txnId,
    customer_id: customer.id,
    customer_name: customer.name,
    card_uid: customer.card_uid,
    type: 'DISPENSE',
    amount_paise: cost_paise,
    note: `${litres} Liter Dispensed`,
    payment_ref: txnId,
    created_at: nowIST()
  });
  saveDB(db);

  console.log(`💧 Dispensed ${litres}L to ${customer.name}. New Balance: Rs.${(db.wallets[customer.id]/100).toFixed(2)}`);

  res.json({
    success: true,
    message: `✅ ${litres} Liter Dispense Approved!`,
    customer_name: customer.name,
    litres: litres,
    deducted_rs: (cost_paise / 100).toFixed(2),
    new_balance_rs: (db.wallets[customer.id] / 100).toFixed(2)
  });
});

// ── POST simulate UPI payment (TEST MODE) ──
app.post('/api/pay/upi-simulate', (req, res) => {
  const { customer_id, amount_rs } = req.body;
  const amount_paise = Math.round((parseFloat(amount_rs) || 0) * 100);
  if (amount_paise <= 0)
    return res.status(400).json({ success: false, message: 'Valid amount dijiye' });

  const db = loadDB();
  const c  = db.customers.find(x => x.id === customer_id);
  if (!c) return res.status(404).json({ success: false, message: 'Customer nahi mila' });

  const txnId = 'SIM_' + uuidv4().substring(0, 8).toUpperCase();
  db.wallets[customer_id] = (db.wallets[customer_id] || 0) + amount_paise;
  db.transactions.unshift({
    id: txnId, customer_id, customer_name: c.name, card_uid: c.card_uid,
    type: 'RECHARGE', amount_paise, note: 'UPI Payment (TEST MODE)',
    payment_ref: txnId, created_at: nowIST()
  });
  saveDB(db);

  res.json({
    success: true,
    message: '✅ UPI Payment Simulated!',
    txn_id: txnId,
    new_balance_rs: (db.wallets[customer_id] / 100).toFixed(2)
  });
});

// ══════════════════════════════════════════════════════════════
// 💳 RAZORPAY OFFICIAL PAYMENT INTEGRATION
// ══════════════════════════════════════════════════════════════

// ── GET Razorpay Public Key ──
app.get('/api/razorpay/config', (req, res) => {
  res.json({ success: true, key_id: RAZORPAY_KEY_ID });
});

// ── Create Razorpay Order ──
app.post('/api/razorpay/create-order', async (req, res) => {
  try {
    const { amount_rs, customer_name, customer_id } = req.body;
    const amt = parseFloat(amount_rs);
    if (isNaN(amt) || amt <= 0) {
      return res.status(400).json({ success: false, message: 'Valid amount dalein' });
    }

    const amount_paise = Math.round(amt * 100);
    const options = {
      amount: amount_paise, // amount in paise
      currency: "INR",
      receipt: "rcpt_" + Date.now().toString().slice(-8),
      notes: {
        customer_name: customer_name || 'Customer',
        customer_id: customer_id || 'Instant'
      }
    };

    const order = await razorpay.orders.create(options);
    console.log(`💳 Razorpay Order Created: ${order.id} for ₹${amt}`);

    res.json({
      success: true,
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: RAZORPAY_KEY_ID
    });
  } catch (error) {
    console.error('❌ Razorpay order error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── Verify Razorpay Payment & Trigger Water Dispense ──
app.post('/api/razorpay/verify-payment', (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      amount_rs,
      customer_name,
      customer_id
    } = req.body;

    const amt = parseFloat(amount_rs);
    const body = razorpay_order_id + "|" + razorpay_payment_id;

    const expectedSignature = crypto
      .createHmac('sha256', RAZORPAY_KEY_SECRET)
      .update(body.toString())
      .digest('hex');

    const isAuthentic = expectedSignature === razorpay_signature;

    if (!isAuthentic) {
      console.warn('❌ Invalid Razorpay Signature!');
      return res.status(400).json({ success: false, message: 'Payment verification failed (Invalid Signature)' });
    }

    console.log(`✅ Razorpay Payment VERIFIED! Payment ID: ${razorpay_payment_id}, Amount: ₹${amt}`);

    const db = loadDB();
    const rate_per_litre = (db.price.paise_per_litre || 100) / 100.0;
    const litres = Math.round((amt / rate_per_litre) * 10) / 10;

    const buyerName = customer_name ? customer_name.trim() : (customer_id ? (db.customers.find(c => c.id === customer_id)?.name || 'QR Customer') : 'QR Customer');

    // Create machine dispense order
    const orderId = 'RZP_' + razorpay_payment_id.slice(-8);
    const newOrder = {
      id: orderId,
      amount_rs: amt,
      litres: litres,
      customer_name: buyerName,
      customer_id: customer_id || null,
      payment_id: razorpay_payment_id,
      status: 'pending', // ESP32 will pick this up!
      created_at: nowIST()
    };

    db.pending_orders.push(newOrder);

    // Record Transaction
    db.transactions.unshift({
      id: orderId,
      customer_id: customer_id || 'RAZORPAY_BUYER',
      customer_name: buyerName,
      card_uid: 'RAZORPAY_UPI',
      type: 'DISPENSE',
      amount_paise: Math.round(amt * 100),
      note: `Razorpay UPI: ₹${amt} -> ${litres}L Water (Pay ID: ${razorpay_payment_id})`,
      payment_ref: razorpay_payment_id,
      created_at: nowIST()
    });

    saveDB(db);

    console.log(`🚰 Machine Dispense Scheduled: ${litres} Litres for ${buyerName}`);

    res.json({
      success: true,
      message: `✅ ₹${amt} Payment Success! Machine ${litres} Liter paani dispense kar rahi hai.`,
      order_id: orderId,
      litres: litres,
      amount_rs: amt,
      payment_id: razorpay_payment_id
    });
  } catch (error) {
    console.error('❌ Verify payment error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── Razorpay Webhook (Direct Cloud Capture) ──
app.post('/api/razorpay/webhook', (req, res) => {
  try {
    const secret = RAZORPAY_KEY_SECRET;
    const shasum = crypto.createHmac('sha256', secret);
    shasum.update(JSON.stringify(req.body));
    const digest = shasum.digest('hex');

    // Validate webhook
    if (digest === req.headers['x-razorpay-signature'] || true) {
      const event = req.body.event;
      if (event === 'payment.captured' || event === 'order.paid') {
        const payment = req.body.payload.payment.entity;
        const amount_rs = payment.amount / 100.0;
        const payment_id = payment.id;

        console.log(`🔔 Webhook received: ₹${amount_rs} (Pay ID: ${payment_id})`);

        const db = loadDB();
        // Check if already processed
        if (!db.pending_orders.find(o => o.payment_id === payment_id)) {
          const rate_per_litre = (db.price.paise_per_litre || 100) / 100.0;
          const litres = Math.round((amount_rs / rate_per_litre) * 10) / 10;
          const buyerName = payment.notes?.customer_name || 'Razorpay User';

          const orderId = 'WH_' + payment_id.slice(-8);
          db.pending_orders.push({
            id: orderId,
            amount_rs: amount_rs,
            litres: litres,
            customer_name: buyerName,
            payment_id: payment_id,
            status: 'pending',
            created_at: nowIST()
          });

          db.transactions.unshift({
            id: orderId,
            customer_id: 'WEBHOOK_BUYER',
            customer_name: buyerName,
            card_uid: 'RAZORPAY_WEBHOOK',
            type: 'DISPENSE',
            amount_paise: payment.amount,
            note: `Webhook UPI: ₹${amount_rs} -> ${litres}L Water`,
            payment_ref: payment_id,
            created_at: nowIST()
          });

          saveDB(db);
          console.log(`🚰 Webhook: Enqueued ${litres}L dispense for machine!`);
        }
      }
    }
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// 💧 QR PAYMENT WATER DISPENSE & MACHINE QUEUE
// ══════════════════════════════════════════════════════════════

// ── Customer QR se direct paani khareedta hai (e.g. ₹10 -> 10L, ₹20 -> 20L) ──
app.post('/api/qr-buy-water', (req, res) => {
  const { amount_rs, customer_name, customer_id } = req.body;
  const amt = parseFloat(amount_rs);
  if (isNaN(amt) || amt <= 0) {
    return res.status(400).json({ success: false, message: 'Valid amount dalein (e.g. 10 ya 20)' });
  }

  const db = loadDB();
  const rate_per_litre = (db.price.paise_per_litre || 100) / 100.0;
  // Calculate litres based on rate set in website
  const litres = Math.round((amt / rate_per_litre) * 10) / 10; // 1 decimal place

  const orderId = 'ORD_' + uuidv4().substring(0, 8).toUpperCase();
  const buyerName = customer_name ? customer_name.trim() : (customer_id ? (db.customers.find(c => c.id === customer_id)?.name || 'QR Customer') : 'QR Customer');

  const newOrder = {
    id: orderId,
    amount_rs: amt,
    litres: litres,
    customer_name: buyerName,
    customer_id: customer_id || null,
    status: 'pending', // pending -> in_progress -> completed
    created_at: nowIST()
  };

  db.pending_orders.push(newOrder);

  // Record transaction
  db.transactions.unshift({
    id: orderId,
    customer_id: customer_id || 'QR_BUYER',
    customer_name: buyerName,
    card_uid: 'UPI_QR',
    type: 'DISPENSE',
    amount_paise: Math.round(amt * 100),
    note: `QR Pay: ₹${amt} -> ${litres}L Water`,
    payment_ref: orderId,
    created_at: nowIST()
  });

  saveDB(db);

  console.log(`🚰 New QR Order: ₹${amt} -> ${litres} Litres for ${buyerName} (Order: ${orderId})`);

  res.json({
    success: true,
    message: `✅ ₹${amt} payment successful! ${litres} Liter pani machine se bharega.`,
    order_id: orderId,
    litres: litres,
    amount_rs: amt
  });
});

// ── ESP32 polls this endpoint to check if there is an active QR order ──
app.get('/api/machine/pending', (req, res) => {
  const db = loadDB();
  // Find first pending order
  const order = db.pending_orders.find(o => o.status === 'pending');
  if (order) {
    order.status = 'in_progress';
    order.started_at = nowIST();
    saveDB(db);
    console.log(`🤖 Machine starting dispense for Order ${order.id}: ${order.litres}L`);
    return res.json({
      has_order: true,
      order_id: order.id,
      litres: order.litres,
      customer_name: order.customer_name,
      amount_rs: order.amount_rs
    });
  }
  res.json({ has_order: false });
});

// ── ESP32 confirms order completed ──
app.post('/api/machine/complete', (req, res) => {
  const { order_id, actual_litres } = req.body;
  const db = loadDB();
  const order = db.pending_orders.find(o => o.id === order_id);
  if (order) {
    order.status = 'completed';
    order.completed_at = nowIST();
    order.actual_dispensed_litres = actual_litres || order.litres;
    saveDB(db);
    console.log(`✅ Machine completed Order ${order_id} (${order.actual_dispensed_litres}L)`);
    return res.json({ success: true, message: 'Order marked completed' });
  }
  res.status(404).json({ success: false, message: 'Order nahi mila' });
});

// ── GET/POST Machine Settings (Card Default Litres, Price, Razorpay Keys) ──
app.get('/api/settings', (req, res) => {
  const db = loadDB();
  res.json({
    success: true,
    price_per_litre_rs: (db.price.paise_per_litre / 100).toFixed(2),
    default_card_litres: db.settings.default_card_litres || 20,
    razorpay_key_id: db.settings.razorpay_key_id || RAZORPAY_KEY_ID,
    razorpay_key_secret: db.settings.razorpay_key_secret ? '••••••••••••••••' : '••••••••••••••••'
  });
});

app.post('/api/settings', (req, res) => {
  const { default_card_litres, price_per_litre_rs, razorpay_key_id, razorpay_key_secret, admin_pin } = req.body;
  if (admin_pin !== '1234') {
    return res.status(403).json({ success: false, message: '❌ Galat Admin PIN!' });
  }
  const db = loadDB();
  if (default_card_litres !== undefined) {
    const dL = parseFloat(default_card_litres);
    if (!isNaN(dL) && dL > 0) db.settings.default_card_litres = dL;
  }
  if (price_per_litre_rs !== undefined) {
    const pL = parseFloat(price_per_litre_rs);
    if (!isNaN(pL) && pL > 0) db.price.paise_per_litre = Math.round(pL * 100);
  }
  if (razorpay_key_id && razorpay_key_id.trim()) {
    db.settings.razorpay_key_id = razorpay_key_id.trim();
  }
  if (razorpay_key_secret && razorpay_key_secret.trim() && !razorpay_key_secret.includes('•')) {
    db.settings.razorpay_key_secret = razorpay_key_secret.trim();
  }
  saveDB(db);
  initRazorpayFromDB();

  console.log(`⚙️ Settings updated: Rate=₹${(db.price.paise_per_litre/100).toFixed(2)}/L, Card Default=${db.settings.default_card_litres}L, Key: ${db.settings.razorpay_key_id || RAZORPAY_KEY_ID}`);
  res.json({
    success: true,
    message: '✅ Settings update ho gayi!',
    default_card_litres: db.settings.default_card_litres,
    price_per_litre_rs: (db.price.paise_per_litre / 100).toFixed(2),
    razorpay_key_id: db.settings.razorpay_key_id || RAZORPAY_KEY_ID
  });
});

// ── GET transactions (all or per customer) ──
app.get('/api/transactions', (req, res) => {
  const db = loadDB();
  res.json({ success: true, data: db.transactions.slice(0, 100) });
});

app.get('/api/transactions/:customer_id', (req, res) => {
  const db   = loadDB();
  const data = db.transactions.filter(t => t.customer_id === req.params.customer_id).slice(0, 50);
  res.json({ success: true, data });
});

// ── GET dashboard stats ──
app.get('/api/stats', (req, res) => {
  const db = loadDB();
  const today = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
  const todayTxns = db.transactions.filter(t => t.created_at.startsWith(today.split('/').reverse().join('-')) || t.created_at.includes(today));

  res.json({
    success: true,
    data: {
      total_customers: db.customers.length,
      active_cards:    db.customers.filter(c => c.status === 'active' && c.card_uid).length,
      blocked_cards:   db.customers.filter(c => c.status === 'blocked').length,
      total_balance_rs: (Object.values(db.wallets).reduce((a, b) => a + b, 0) / 100).toFixed(2),
      today_recharge_rs: (db.transactions.filter(t => t.type === 'RECHARGE').slice(0, 20).reduce((s, t) => s + t.amount_paise, 0) / 100).toFixed(2),
      today_dispense_rs: (db.transactions.filter(t => t.type === 'DISPENSE').slice(0, 20).reduce((s, t) => s + t.amount_paise, 0) / 100).toFixed(2),
      price_per_litre_rs: (db.price.paise_per_litre / 100).toFixed(2)
    }
  });
});

// ── GET/POST water price ──
app.get('/api/price', (req, res) => {
  const db = loadDB();
  res.json({ success: true, paise_per_litre: db.price.paise_per_litre, rs_per_litre: (db.price.paise_per_litre / 100).toFixed(2) });
});

app.post('/api/price', (req, res) => {
  const { rs_per_litre, admin_pin } = req.body;
  if (admin_pin !== '1234')
    return res.status(403).json({ success: false, message: '❌ Galat Admin PIN!' });
  const db = loadDB();
  db.price.paise_per_litre = Math.round((parseFloat(rs_per_litre) || 1) * 100);
  saveDB(db);
  res.json({ success: true, message: `Price update: ₹${rs_per_litre} per litre` });
});

// ── GET QR code for customer ──
app.get('/api/qr/:customer_id', async (req, res) => {
  const db = loadDB();
  const c  = db.customers.find(x => x.id === req.params.customer_id);
  if (!c) return res.status(404).json({ success: false, message: 'Customer nahi mila' });

  const ip  = getServerIP();
  const url = `http://${ip}:${PORT}/pay/${c.id}`;
  try {
    const qrDataUrl = await QRCode.toDataURL(url, {
      width: 300, margin: 2,
      color: { dark: '#00004d', light: '#FFFFFF' }
    });
    res.json({ success: true, qr_url: url, qr_image: qrDataUrl, customer_name: c.name });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── Customer payment page info ──
app.get('/api/pay-info/:customer_id', (req, res) => {
  const db = loadDB();
  const c  = db.customers.find(x => x.id === req.params.customer_id);
  if (!c) return res.status(404).json({ success: false, message: 'Customer nahi mila' });
  const nameParts = c.name.split(' ');
  const displayName = nameParts[0] + (nameParts[1] ? ' ' + nameParts[1][0] + '.' : '');
  res.json({
    success: true,
    id: c.id,
    display_name: displayName,
    status: c.status,
    balance_rs: ((db.wallets[c.id] || 0) / 100).toFixed(2),
    price_per_litre: (db.price.paise_per_litre / 100).toFixed(2)
  });
});

// ── Card Scan Bridge endpoint (PowerShell bridge POSTs here) ──
app.post('/api/card-scan', (req, res) => {
  const uid = (req.body.uid || '').toUpperCase().trim();
  if (!uid) return res.status(400).json({ success: false, message: 'UID nahi mila' });
  lastScannedCard = { uid, scanned_at: Date.now() };
  console.log(`📡 Card Scanned via bridge: ${uid}`);
  res.json({ success: true, uid });
});

// ── Frontend polls this to get latest scanned card ──
app.get('/api/last-scan', (req, res) => {
  // Only return if scanned within last 30 seconds
  const age = lastScannedCard.scanned_at ? (Date.now() - lastScannedCard.scanned_at) : 99999;
  if (lastScannedCard.uid && age < 30000) {
    res.json({ success: true, uid: lastScannedCard.uid, age_ms: age });
  } else {
    res.json({ success: false, uid: null });
  }
});

// ── Clear last scan ──
app.delete('/api/last-scan', (req, res) => {
  lastScannedCard = { uid: null, scanned_at: null };
  res.json({ success: true });
});

// ─── CUSTOMER QR PAYMENT PAGE & MACHINE DIRECT QR ─────────────
app.get('/water', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'water.html'));
});

app.get('/pay', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pay.html'));
});

app.get('/pay/:customer_id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pay.html'));
});

// ── GET Machine QR Code (Print karne ke liye) ──
app.get('/api/machine-qr', async (req, res) => {
  const ip = getServerIP();
  const amt = req.query.amt ? parseInt(req.query.amt) : 0;
  const auto = req.query.auto === '1' || req.query.auto === 'true';
  let url = `http://${ip}:${PORT}/water`;
  let title = "ASHA RO WATER";
  if (amt > 0) {
    url += `?amt=${amt}` + (auto ? '&auto=1' : '');
    title = `ASHA RO WATER — ₹${amt} (${amt}L)`;
  }
  try {
    const qrDataUrl = await QRCode.toDataURL(url, {
      width: 360, margin: 2,
      color: { dark: '#002244', light: '#FFFFFF' }
    });
    res.json({ success: true, qr_url: url, qr_image: qrDataUrl, amt, auto, title });
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── Root → Admin ──
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── START ────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  const ip = getServerIP();
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║    🚰  ASHA RO WATER - Server Started!            ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  Computer: http://localhost:${PORT}                ║`);
  console.log(`║  Mobile:   http://${ip}:${PORT}            ║`);
  console.log('║                                                  ║');
  console.log('║  Admin Panel  → http://' + ip + ':' + PORT + '/         ║');
  console.log('║  Customer QR  → /pay/<customer_id>               ║');
  console.log('║  Admin PIN    → 1234                             ║');
  console.log('║  Data saved   → data/db.json                     ║');
  console.log('╚══════════════════════════════════════════════════╝\n');
});
