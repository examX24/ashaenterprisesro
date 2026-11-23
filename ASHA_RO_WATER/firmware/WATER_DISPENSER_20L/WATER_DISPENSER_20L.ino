/**
 * ═════════════════════════════════════════════════════════════════
 *        🚰 ASHA RO WATER - SMART WATER DISPENSER SYSTEM
 * ═════════════════════════════════════════════════════════════════
 * 
 * Features:
 *   1. 📱 QR Code UPI Payment:
 *      Jitna rupaye pay kiya (e.g. Rs 10 ya Rs 20),
 *      website rate ke hisab se utna Litre paani turant dispense hota hai!
 * 
 *   2. 💳 RFID Card Tap Dispense:
 *      Card tap karne par Admin Dashboard se set Default Litres
 *      (e.g. 20L, 10L) dispense hota hai aur balance deduct hota hai!
 * 
 *   3. 🖥️ Live OLED Display & Buzzer:
 *      Real-time Litre progress bar, user name, balance, beep sounds.
 * 
 *   4. 🌊 ZJ-S201 Flow Sensor & 12V Relay:
 *      Pin D34 se pulse count, Pin D26 se Relay ON/OFF.
 * ═════════════════════════════════════════════════════════════════
 */

#include <SPI.h>
#include <Wire.h>
#include <MFRC522.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <WiFi.h>
#include <WiFiMulti.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

WiFiMulti wifiMulti;

// ═════════════════════════════════════════════════════════════════
// ⚙️ USER CONFIGURATION
// ═════════════════════════════════════════════════════════════════
const char* SERVER_IP     = "192.168.1.8";     // Web Server IP (Computer LAN IP)
const int   SERVER_PORT   = 3000;              // Server Port

float defaultCardLitres   = 20.0;              // Admin setting se update hoga
const float PULSES_PER_L  = 450.0;             // ZJ-S201 Sensor calibration (~450 pulses/L)
const bool  RELAY_ACTIVE_LOW = true;           // True agar LOW par relay ON hoti hai

// ═════════════════════════════════════════════════════════════════
// 📌 PIN DEFINITIONS
// ═════════════════════════════════════════════════════════════════
#define RFID_SS_PIN   5
#define RFID_RST_PIN  22

#define OLED_SDA_PIN  21
#define OLED_SCL_PIN  15
#define OLED_ADDR     0x3C

#define BUZZER_PIN    13
#define FLOW_PIN      34
#define RELAY_PIN     26

// Objects
MFRC522 rfid(RFID_SS_PIN, RFID_RST_PIN);
Adafruit_SSD1306 display(128, 64, &Wire, -1);

// Flow sensor variables
volatile unsigned long flowPulseCount = 0;
void IRAM_ATTR flowPulseISR() {
  flowPulseCount++;
}

// State tracking
bool isDispensing = false;
String lastScannedUID = "";
unsigned long lastScanTime = 0;
bool wifiConnected = false;
unsigned long lastQRPollTime = 0;

// ═════════════════════════════════════════════════════════════════
// 🔔 BUZZER & SOUND FUNCTIONS
// ═════════════════════════════════════════════════════════════════
void beep(int count, int durationMs, int freq = 1200) {
  for (int i = 0; i < count; i++) {
    tone(BUZZER_PIN, freq, durationMs);
    digitalWrite(BUZZER_PIN, HIGH);
    delay(durationMs);
    noTone(BUZZER_PIN);
    digitalWrite(BUZZER_PIN, LOW);
    if (i < count - 1) delay(70);
  }
}

// ═════════════════════════════════════════════════════════════════
// ⚡ RELAY CONTROLLER
// ═════════════════════════════════════════════════════════════════
void setMotor(bool on) {
  if (RELAY_ACTIVE_LOW) {
    digitalWrite(RELAY_PIN, on ? LOW : HIGH);
  } else {
    digitalWrite(RELAY_PIN, on ? HIGH : LOW);
  }
}

// ═════════════════════════════════════════════════════════════════
// 🖥️ OLED SCREEN HELPER
// ═════════════════════════════════════════════════════════════════
void showScreen(String title, String line1, String line2, String line3) {
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);

  display.setTextSize(1);
  display.setCursor(4, 2);
  display.println(title);
  display.drawFastHLine(0, 12, 128, SSD1306_WHITE);

  display.setCursor(0, 18);
  display.println(line1);

  display.setCursor(0, 32);
  display.println(line2);

  display.setCursor(0, 48);
  display.println(line3);

  display.display();
}

// ═════════════════════════════════════════════════════════════════
// 🌐 WIFI HELPER (Multi-Hotspot: Home Mobile + Shop Wi-Fi)
// ═════════════════════════════════════════════════════════════════
void checkWiFiConnection() {
  if (wifiMulti.run() == WL_CONNECTED) {
    wifiConnected = true;
  } else {
    wifiConnected = false;
  }
}

// ═════════════════════════════════════════════════════════════════
// 💧 DISPENSE WATER PROCESS (Dynamic Litres: 5L, 10L, 20L etc.)
// ═════════════════════════════════════════════════════════════════
void dispenseWater(String customerName, float litresToDispense) {
  isDispensing = true;
  flowPulseCount = 0;
  unsigned long targetPulses = (unsigned long)(litresToDispense * PULSES_PER_L);

  Serial.println("\n>>> STARTING WATER DISPENSING <<<");
  Serial.print("Customer: "); Serial.println(customerName);
  Serial.print("Litres Target: "); Serial.println(litresToDispense);
  Serial.print("Target Pulses: "); Serial.println(targetPulses);

  // Beep start confirmation
  beep(2, 100, 1500);

  // Turn Motor ON
  setMotor(true);
  unsigned long startTime = millis();
  unsigned long lastDisplayUpdate = 0;

  // Maximum safety timeout: 10 minutes
  unsigned long maxTimeoutMs = 10UL * 60UL * 1000UL;

  while (flowPulseCount < targetPulses) {
    // Safety timeout check
    if (millis() - startTime > maxTimeoutMs) {
      Serial.println("⚠️ Safety timeout reached! Stopping motor.");
      break;
    }

    // Update screen every 250ms
    if (millis() - lastDisplayUpdate >= 250) {
      lastDisplayUpdate = millis();
      float currentLitres = (float)flowPulseCount / PULSES_PER_L;
      int progressPercent = (int)((currentLitres / litresToDispense) * 100.0);
      if (progressPercent > 100) progressPercent = 100;

      display.clearDisplay();
      display.setTextColor(SSD1306_WHITE);

      // Title
      display.setTextSize(1);
      display.setCursor(4, 2);
      display.println("PANI BHAR RAHA HAI");
      display.drawFastHLine(0, 12, 128, SSD1306_WHITE);

      // Customer name
      display.setCursor(0, 16);
      display.print("User: ");
      display.println(customerName.substring(0, 14));

      // Litre counter (Large Text)
      display.setTextSize(2);
      display.setCursor(4, 28);
      display.print(currentLitres, 1);
      display.print("/");
      display.print(litresToDispense, 1);
      display.print("L");

      // Progress bar outline
      display.drawRect(0, 48, 128, 12, SSD1306_WHITE);
      // Progress bar fill
      int fillWidth = (progressPercent * 124) / 100;
      if (fillWidth > 0) {
        display.fillRect(2, 50, fillWidth, 8, SSD1306_WHITE);
      }

      display.display();
    }

    yield(); // keep ESP32 watchdog happy
  }

  // Turn Motor OFF
  setMotor(false);
  isDispensing = false;

  Serial.println(">>> DISPENSE COMPLETE! MOTOR OFF <<<");

  // Success screen
  display.clearDisplay();
  display.setTextSize(1);
  display.setCursor(8, 8);
  display.print(litresToDispense, 1);
  display.println(" LITER PURA HUA!");

  display.setTextSize(2);
  display.setCursor(14, 24);
  display.println("THANK YOU");

  display.setTextSize(1);
  display.setCursor(12, 48);
  display.println("Apna Jar Le Lijie");
  display.display();

  // Long success beep
  beep(1, 1000, 1800);
  delay(3500);
}

// ═════════════════════════════════════════════════════════════════
// 📱 CHECK PENDING QR ORDERS FROM SERVER
// ═════════════════════════════════════════════════════════════════
void checkPendingQROrders() {
  if (!wifiConnected || isDispensing) return;

  HTTPClient http;
  String checkUrl = "http://" + String(SERVER_IP) + ":" + String(SERVER_PORT) + "/api/machine/pending";
  http.begin(checkUrl);
  http.setTimeout(2500);

  int httpCode = http.GET();
  if (httpCode == 200) {
    String payload = http.getString();
    http.end();

    JsonDocument doc;
    DeserializationError err = deserializeJson(doc, payload);
    if (!err && doc["has_order"] == true) {
      String orderId   = doc["order_id"].as<String>();
      float orderLitres = doc["litres"].as<float>();
      String buyerName = doc["customer_name"].as<String>();
      float amtRs      = doc["amount_rs"] | 0.0;

      Serial.println("\n🎉 QR PAYMENT RECEIVED!");
      Serial.print("Order: "); Serial.println(orderId);
      Serial.print("Amount: ₹"); Serial.println(amtRs);
      Serial.print("Litres: "); Serial.println(orderLitres);

      showScreen("QR PAYMENT SUCCESS", "User: " + buyerName, "Amount: Rs." + String(amtRs, 1), "Litres: " + String(orderLitres, 1) + "L");
      beep(2, 200, 1600);
      delay(2000);

      // Dispense water for QR order
      dispenseWater(buyerName, orderLitres);

      // Notify Server Order Completed
      HTTPClient doneHttp;
      String doneUrl = "http://" + String(SERVER_IP) + ":" + String(SERVER_PORT) + "/api/machine/complete";
      doneHttp.begin(doneUrl);
      doneHttp.addHeader("Content-Type", "application/json");

      String postBody = "{\"order_id\":\"" + orderId + "\",\"actual_litres\":" + String(orderLitres, 1) + "}";
      doneHttp.POST(postBody);
      doneHttp.end();
    }
  } else {
    http.end();
  }
}

// ═════════════════════════════════════════════════════════════════
// 💳 PROCESS CARD SCAN
// ═════════════════════════════════════════════════════════════════
void handleCardScanned(String uid) {
  Serial.print("\n💳 CARD SCANNED: "); Serial.println(uid);

  // Short tap beep
  beep(1, 80, 1600);

  showScreen("CARD SCAN HUA", "UID: " + uid, "Verifying Balance...", "Please wait...");

  checkWiFiConnection();

  if (!wifiConnected) {
    // OFFLINE / STANDALONE MODE
    Serial.println("WiFi not connected. Running in Standalone Mode.");
    showScreen("STANDALONE MODE", "WiFi: Disconnected", "Starting Dispense...", String(defaultCardLitres, 0) + "L Direct Access");
    delay(1500);
    dispenseWater("Offline Card", defaultCardLitres);
    return;
  }

  // ONLINE MODE - SERVER QUERY
  HTTPClient http;
  String checkUrl = "http://" + String(SERVER_IP) + ":" + String(SERVER_PORT) + "/api/card/" + uid;
  http.begin(checkUrl);
  http.setTimeout(4000);

  int httpCode = http.GET();
  if (httpCode == 200) {
    String payload = http.getString();
    http.end();

    JsonDocument doc;
    DeserializationError err = deserializeJson(doc, payload);
    if (!err && doc["success"] == true) {
      String custName = doc["data"]["name"].as<String>();
      long balPaise = doc["data"]["balance_paise"].as<long>();
      float balRs = (float)balPaise / 100.0;
      
      // Dynamic litres & rate set by Admin in Web Dashboard
      float litresToGive = doc["default_card_litres"] | defaultCardLitres;
      defaultCardLitres = litresToGive; // sync locally

      long ratePerLitrePaise = doc["paise_per_litre"] | 100;
      long costPaise = (long)(litresToGive * ratePerLitrePaise);
      float costRs = (float)costPaise / 100.0;

      Serial.print("Customer: "); Serial.println(custName);
      Serial.print("Balance: Rs. "); Serial.println(balRs);
      Serial.print("Cost for "); Serial.print(litresToGive); Serial.print("L: Rs. "); Serial.println(costRs);

      if (balPaise >= costPaise) {
        // Sufficient Balance -> Deduct on server
        HTTPClient dspHttp;
        String dspUrl = "http://" + String(SERVER_IP) + ":" + String(SERVER_PORT) + "/api/dispense";
        dspHttp.begin(dspUrl);
        dspHttp.addHeader("Content-Type", "application/json");

        String postData = "{\"card_uid\":\"" + uid + "\",\"litres\":" + String(litresToGive, 1) + "}";
        int dspCode = dspHttp.POST(postData);
        dspHttp.end();

        if (dspCode == 200) {
          showScreen("PAYMENT SUCCESS", custName, "Bal: Rs." + String(balRs - costRs, 1), String(litresToGive, 0) + "L Approved!");
          delay(1200);
          dispenseWater(custName, litresToGive);
        } else {
          showScreen("ERROR", "Server dispense fail", "Try again", "");
          beep(3, 150, 600);
          delay(2500);
        }
      } else {
        // Insufficient balance
        showScreen("BALANCE KAM HAI!", custName, "Bal: Rs." + String(balRs, 1), "Chahiye: Rs." + String(costRs, 1));
        beep(3, 200, 800);
        delay(3500);
      }
    }
  } else {
    http.end();
    // Card not registered on server
    Serial.println("Card not found on server. Forwarding to bridge...");
    
    HTTPClient scanHttp;
    scanHttp.begin("http://" + String(SERVER_IP) + ":" + String(SERVER_PORT) + "/api/card-scan");
    scanHttp.addHeader("Content-Type", "application/json");
    scanHttp.POST("{\"uid\":\"" + uid + "\"}");
    scanHttp.end();

    showScreen("UNREGISTERED CARD", "UID: " + uid, "Web App pe Card", "Add / Link Karein");
    beep(2, 250, 700);
    delay(3000);
  }
}

// ═════════════════════════════════════════════════════════════════
// 🚀 ARDUINO SETUP
// ═════════════════════════════════════════════════════════════════
void setup() {
  Serial.begin(9600);
  delay(500);
  Serial.println("\n============================================");
  Serial.println("   ASHA RO WATER - SMART DISPENSER SYSTEM   ");
  Serial.println("============================================");

  // 1. Setup Relay (Turn OFF immediately)
  pinMode(RELAY_PIN, OUTPUT);
  setMotor(false);

  // 2. Setup Buzzer
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);

  // 3. Setup Flow Sensor (GPIO 34 Interrupt)
  pinMode(FLOW_PIN, INPUT);
  attachInterrupt(digitalPinToInterrupt(FLOW_PIN), flowPulseISR, RISING);

  // 4. Setup OLED Display
  Wire.begin(OLED_SDA_PIN, OLED_SCL_PIN);
  if (!display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) {
    Serial.println("⚠️ OLED display init error!");
  } else {
    Serial.println("✅ OLED Connected (0x3C)");
  }

  // Welcome Screen
  showScreen("ASHA RO WATER", "Smart Dispenser", "Starting System...", "Please wait...");
  beep(1, 150, 1400);
  delay(1500);

  // 5. Setup RFID (RC522)
  SPI.begin(18, 19, 23, RFID_SS_PIN);
  rfid.PCD_Init();
  delay(50);
  Serial.println("✅ RFID RC522 Initialized");

  // 6. Connect WiFi (Auto Home Mobile or Shop Wi-Fi)
  WiFi.mode(WIFI_STA);
  wifiMulti.addAP("AJAY KUSHWAHA", "77777777");            // Home Mobile Hotspot
  wifiMulti.addAP("Airtel_Asha Digital Center", "Ajay@6341#"); // Shop / Digital Center Wi-Fi

  showScreen("WIFI CONNECTING", "Searching Hotspot...", "Mobile / Shop Wi-Fi", "Please wait...");

  int wifiTries = 0;
  while (wifiMulti.run() != WL_CONNECTED && wifiTries < 20) {
    delay(400);
    Serial.print(".");
    wifiTries++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    wifiConnected = true;
    String connectedSSID = WiFi.SSID();
    Serial.println("\n✅ WiFi Connected: " + connectedSSID + " (IP: " + WiFi.localIP().toString() + ")");
    showScreen("WIFI CONNECTED", "WiFi: " + connectedSSID.substring(0, 14), "IP: " + WiFi.localIP().toString(), "System Ready!");
    beep(2, 80, 1600);
  } else {
    wifiConnected = false;
    Serial.println("\n⚠️ WiFi Timeout - Standalone Mode.");
    showScreen("STANDALONE MODE", "Hotspot Not Found", "Direct Card Access", "System Ready!");
    beep(1, 300, 1000);
  }
  delay(2000);
}

// ═════════════════════════════════════════════════════════════════
// 🔄 MAIN LOOP
// ═════════════════════════════════════════════════════════════════
void loop() {
  if (isDispensing) return;

  // Check WiFi status periodically
  checkWiFiConnection();

  // 1. Check for Pending QR Orders from Web App (every 1.5 seconds)
  if (millis() - lastQRPollTime >= 1500) {
    lastQRPollTime = millis();
    checkPendingQROrders();
  }

  // 2. Ready Screen Refresh every 1.5 second
  static unsigned long lastReadyRefresh = 0;
  if (millis() - lastReadyRefresh >= 1500) {
    lastReadyRefresh = millis();
    String netStatus = wifiConnected ? ("WiFi: " + WiFi.SSID().substring(0, 12)) : "Offline (Direct Card)";
    showScreen("ASHA RO WATER", netStatus, "Scan QR / Tap Card", "Auto Water Dispenser");
  }

  // 3. RFID Card Detection
  if (!rfid.PICC_IsNewCardPresent() || !rfid.PICC_ReadCardSerial()) {
    return;
  }

  // Read Card UID
  String uid = "";
  for (byte i = 0; i < rfid.uid.size; i++) {
    if (i > 0) uid += " ";
    if (rfid.uid.uidByte[i] < 0x10) uid += "0";
    uid += String(rfid.uid.uidByte[i], HEX);
  }
  uid.toUpperCase();

  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();

  // Debounce card scan
  unsigned long now = millis();
  if (uid == lastScannedUID && (now - lastScanTime) < 3000) {
    return;
  }
  lastScannedUID = uid;
  lastScanTime = now;

  // Process Card
  handleCardScanned(uid);
}
