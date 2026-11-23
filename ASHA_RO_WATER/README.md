# 🚰 ASHA RO WATER - Smart Automatic Water Dispensing System

Automatic Water Vending System with **Razorpay UPI QR Payment**, **RFID Card Access**, **OLED Display**, **Water Flow Meter**, and **ESP32 IoT Controller**.

---

## 📁 Project Structure

```
ASHA_RO_WATER/
├── server.js               # Node.js Express Server + Razorpay Gateway + Machine Queue
├── package.json            # Node.js dependencies (express, razorpay, qrcode, uuid, cors)
├── public/                 # Web Application Frontend
│   ├── index.html          # Admin Dashboard (Settings, Customers, Card Link, QR Generator)
│   └── pay.html            # Customer UPI QR Payment & Water Dispense Page
├── data/
│   └── db.json             # Database (Customers, Balances, Settings, Pending Orders)
├── firmware/
│   └── WATER_DISPENSER_20L/
│       └── WATER_DISPENSER_20L.ino   # ESP32 Arduino Production Firmware
├── MASTER_WIRING_SHEET.txt # Complete Hardware Pin-to-Pin Wiring Guide
└── README.md
```

---

## 🚀 1. GITHUB PAR UPLOAD KAISE KAREIN

Is folder mein terminal ya command prompt kholein:

```bash
# Step 1: Git repository shuru karein
git init

# Step 2: Sabhi files add karein
git add .

# Step 3: Commit karein
git commit -m "ASHA RO Water complete system with Razorpay and ESP32"

# Step 4: Apne GitHub repo ka URL jodein
# (Pehle github.com par jakar naya repository banayein, e.g. asha-ro-water)
git branch -M main
git remote add origin https://github.com/AAPKA_USERNAME/asha-ro-water.git

# Step 5: Push karein
git push -u origin main
```

---

## 🌐 2. INTERNET PAR FREE LIVE KAISE KAREIN (Render.com)

Aap bina kisi kharche ke is server ko 24/7 internet par live chala sakte hain:

1. **[render.com](https://render.com)** par jaiye aur free account banayein (GitHub se login karein).
2. **"New +" ➡️ "Web Service"** par click karein.
3. Apna GitHub repository (`asha-ro-water`) select karein.
4. Settings:
   - **Name:** `asha-ro-water`
   - **Environment:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
5. **"Deploy Web Service"** dabayein!
6. Render aapko ek **FREE 24/7 Live HTTPS Link** de dega:
   👉 `https://asha-ro-water.onrender.com`

---

## ⚙️ 3. ADMIN PANEL FEATURES (Bina Code Badle Sab Change Karein)

Admin Panel: `http://localhost:3000` (ya live link par):
- **Admin PIN:** `1234`
- **Settings Tab:**
  1. **Paani ka Rate (₹ per Litre):** Badalne par har customer se usi hisab se charge hoga.
  2. **Card Tap Limit (Litres):** 1 baar card tap karne par kitna paani dena hai (default 20L ya 10L).
  3. **Razorpay Key ID & Key Secret:** Kabhi bhi Test ya Live Key bina code badle yahan se update karein!
  4. **Customer Management:** Naye card register karein, recharge karein, block karein.
  5. **QR Generator:** Machine ka QR print karein.
