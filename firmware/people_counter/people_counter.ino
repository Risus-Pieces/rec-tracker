// Rec Tracker sensor unit: ESP32 + VL53L1X
// Counts each person who passes the sensor and reports the count and its own
// health to the Rec Tracker website. Also serves a small status page on the
// local network, which is handy on a bench or a phone hotspot.
//
// Board: ESP32 Dev Module. Library: "VL53L1X" by Pololu.
// Wiring: VCC->3V3, GND->GND, SCL->22, SDA->21. SHUT and INT unplugged.
//
// Before uploading: copy config.example.h to config.h and fill it in.

#include <Wire.h>
#include <VL53L1X.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include "config.h"   // WiFi name, website address and this unit's token
#include "certs.h"    // lets the ESP32 verify it is really talking to the website

#define FIRMWARE_VERSION "2.1.0"

// ================= SETTINGS YOU CHANGE =================
// How much closer than the empty lane something must be to count as a person.
// Raise it if you get false counts, lower it if people are missed.
const int TRIGGER_DROP_MM = 200;

// A person must block the beam for this many readings in a row (~33 ms each)
// to count, and the lane must be clear this many readings in a row before
// the next person can be counted. Filters out flickers and double counts.
const int MIN_PRESENT_READINGS = 2;
const int MIN_CLEAR_READINGS   = 4;
// =======================================================

const int MAX_RANGE_MM = 1300;   // Short mode limit; "nothing seen" reads as this
const int BLOCKED_LANE_MM = 300; // an "empty lane" shorter than this means something is in the way

// Talking to the website.
const unsigned long MIN_CHECKIN_GAP_MS = 1000;   // never report more often than this
const unsigned long RETRY_MS           = 5000;   // wait this long after a failed report
const uint16_t REPORT_TIMEOUT_MS       = 6000;   // give up on a report that gets no reply
// If nothing has reached the website for this long, rejoin WiFi from scratch...
const unsigned long OFFLINE_REJOIN_MS  = 120000;
// ...and if that doesn't help either, restart the whole unit.
const unsigned long OFFLINE_RESTART_MS = 300000;
unsigned long checkInIntervalMs        = 15000;  // the website adjusts this in each reply

VL53L1X sensor;
WebServer server(80);

// The sensor loop runs on one processor core and the website reporting on the
// other, so a slow internet request can never make the sensor miss a person.
// Everything marked volatile is shared between the two.
volatile int  baselineMm  = MAX_RANGE_MM;  // distance to the far side of the empty lane
volatile int  thresholdMm = MAX_RANGE_MM - TRIGGER_DROP_MM;
volatile int  lastMm      = MAX_RANGE_MM;
volatile long passCount   = 0;             // shown on the local page; a reset zeroes it
volatile uint32_t bootTotal = 0;           // people counted since power-on; never zeroed.
                                           // The website adds up the changes in this.
volatile bool personPresent = false;
int  presentStreak = 0;
int  clearStreak   = 0;

// Kept in memory that survives a self-restart (though not a power cut), so
// when the unit restarts itself the website sees the same running total and
// no counts are lost or counted twice.
struct SavedState {
  uint32_t magic;
  uint32_t bootId;
  uint32_t bootTotal;
  long     passCount;
};
RTC_NOINIT_ATTR SavedState saved;
const uint32_t SAVED_MAGIC = 0x52454354;

// The empty-lane distance is stored in flash, so a restart or power cut never
// re-measures it at a moment when someone might be standing in the lane.
Preferences prefs;

// Health tracking: lets the counter notice a frozen sensor and restart it.
unsigned long lastReadingMs  = 0;
unsigned long rateWindowMs   = 0;
int  readingsInWindow = 0;
volatile int  readingsPerSec   = 0;
volatile uint8_t lastStatus    = 0;
volatile long sensorRestarts   = 0;
volatile bool sensorOk         = false;
bool needsCalibration          = true;

// Commands from the website.
volatile bool     calibrateRequested = false;
volatile uint32_t calibrateCommandId = 0;
volatile uint32_t doneCommandId      = 0;   // highest command finished; reported back
uint32_t lastCommandId               = 0;   // highest command received

// Website link status, for the local page and the Serial Monitor.
volatile bool serverOk       = false;
volatile int  lastHttpCode   = 0;
volatile long recOccupancy   = -1;
uint32_t bootId              = 0;
volatile unsigned long lastServerOkMs = 0;   // when the website last accepted a report
volatile uint32_t reportFailures      = 0;   // failed reports since power-on
volatile int  lastReportError         = 0;   // the code of the most recent failure
const char* resetReason               = "unknown";

// ---------- Sensor ----------

// Starts (or restarts) the sensor in continuous mode. Returns false if it
// doesn't answer on the I2C wires.
bool startSensor() {
  sensor.setTimeout(500);
  if (!sensor.init()) return false;
  sensor.setDistanceMode(VL53L1X::Short);
  sensor.setMeasurementTimingBudget(33000);
  // Each reading takes the 33 ms budget plus a little overhead. Asking for one
  // every 33 ms makes the sensor skip every other slot (about 16 readings/s);
  // 40 ms gives a steady 25 readings/s.
  sensor.startContinuous(40);
  return true;
}

const char* statusName(uint8_t s) {
  switch (s) {
    case VL53L1X::RangeValid:                return "valid";
    case VL53L1X::SigmaFail:                 return "noisy reading";
    case VL53L1X::SignalFail:                return "nothing seen";
    case VL53L1X::RangeValidMinRangeClipped: return "valid (very close)";
    case VL53L1X::OutOfBoundsFail:           return "out of range";
    case VL53L1X::HardwareFail:              return "hardware fail";
    case VL53L1X::WrapTargetFail:            return "target too far";
    case VL53L1X::MinRangeFail:              return "too close";
    default:                                 return "other";
  }
}

// Returns true when a new reading is available and puts it in mm.
// Readings where the sensor sees nothing in range become MAX_RANGE_MM.
bool getReading(int &mm) {
  if (!sensor.dataReady()) return false;
  sensor.read(false);
  uint8_t status = sensor.ranging_data.range_status;
  lastStatus = status;
  if (status == VL53L1X::RangeValid || status == VL53L1X::RangeValidMinRangeClipped) {
    mm = min((int)sensor.ranging_data.range_mm, MAX_RANGE_MM);
  } else {
    mm = MAX_RANGE_MM;
  }
  return true;
}

void setBaseline(int mm) {
  baselineMm  = mm;
  thresholdMm = max(mm - TRIGGER_DROP_MM, 80);
}

// Loads the empty-lane distance saved by the last calibration, if there is one.
bool loadBaseline() {
  if (!prefs.begin("rectracker", true)) return false;
  int mm = prefs.getInt("baseline", 0);
  prefs.end();
  if (mm < 50 || mm > MAX_RANGE_MM) return false;
  setBaseline(mm);
  return true;
}

// Measures the empty lane for 2 seconds and sets the trigger distance.
// Keep the lane clear while this runs.
void calibrate() {
  Serial.println("Calibrating: keep the lane clear for 2 seconds...");
  long total = 0;
  int samples = 0;
  unsigned long start = millis();
  while (millis() - start < 2000) {
    int mm;
    if (getReading(mm)) { total += mm; samples++; }
    delay(1);
  }
  setBaseline(samples > 0 ? total / samples : MAX_RANGE_MM);
  if (samples > 0 && prefs.begin("rectracker", false)) {
    prefs.putInt("baseline", baselineMm);
    prefs.end();
  }
  personPresent = false;
  presentStreak = 0;
  clearStreak = 0;
  lastReadingMs = millis();   // calibration counts as activity, avoids a false restart
  Serial.printf("Empty lane: %d mm. Counting anything closer than %d mm.\n",
                (int)baselineMm, (int)thresholdMm);
  if (baselineMm < BLOCKED_LANE_MM) {
    Serial.println("That is very close: something was in front of the sensor. Clear the lane and recalibrate.");
  }
}

// Turns raw distances into counts. A person is counted once,
// at the moment they leave the beam.
void updateCounter(int mm) {
  lastMm = mm;
  if (!personPresent) {
    if (mm < thresholdMm) {
      if (++presentStreak >= MIN_PRESENT_READINGS) {
        personPresent = true;
        clearStreak = 0;
      }
    } else {
      presentStreak = 0;
    }
  } else {
    if (mm > thresholdMm + 50) {          // 50 mm buffer stops flicker at the edge
      if (++clearStreak >= MIN_CLEAR_READINGS) {
        personPresent = false;
        presentStreak = 0;
        passCount = passCount + 1;
        bootTotal = bootTotal + 1;
        saved.passCount = passCount;
        saved.bootTotal = bootTotal;
        Serial.printf("Person counted. Total: %ld\n", (long)passCount);
      }
    } else {
      clearStreak = 0;
    }
  }
}

// ---------- Reporting to the website ----------

WiFiClientSecure tls;
HTTPClient http;

void runCommand(uint32_t id, const String &type) {
  if (id <= lastCommandId) return;   // already received; the website repeats until we confirm
  lastCommandId = id;
  if (type == "calibrate") {
    Serial.println("Website asked for a recalibration.");
    calibrateCommandId = id;
    calibrateRequested = true;        // the sensor loop does it and then confirms
    return;
  }
  if (type == "reset") {
    passCount = 0;
    saved.passCount = 0;
    Serial.println("Website reset the count.");
  }
  if (id > doneCommandId) doneCommandId = id;
}

// Sends one report and handles the reply. Returns true if the website took it.
bool checkIn(uint32_t &sentTotal, uint32_t &sentAck) {
  uint32_t total = bootTotal;
  uint32_t ack = doneCommandId;

  char body[576];
  snprintf(body, sizeof(body),
           "{\"boot\":\"%08x\",\"total\":%u,\"count\":%ld,\"mm\":%d,\"baseline\":%d,\"threshold\":%d,"
           "\"present\":%s,\"rate\":%d,\"sensor_ok\":%s,\"status\":\"%s\",\"restarts\":%ld,"
           "\"uptime_s\":%u,\"rssi\":%d,\"fw\":\"" FIRMWARE_VERSION "\",\"ack\":%u,"
           "\"fails\":%u,\"err\":%d,\"reset\":\"%s\",\"heap\":%u}",
           (unsigned)bootId, (unsigned)total, (long)passCount, (int)lastMm, (int)baselineMm, (int)thresholdMm,
           personPresent ? "true" : "false", (int)readingsPerSec, sensorOk ? "true" : "false",
           statusName(lastStatus), (long)sensorRestarts,
           (unsigned)(esp_timer_get_time() / 1000000), (int)WiFi.RSSI(), (unsigned)ack,
           (unsigned)reportFailures, (int)lastReportError, resetReason, (unsigned)ESP.getFreeHeap());

  if (!http.begin(tls, String(SERVER_URL) + "/api/device/checkin")) {
    lastHttpCode = -1;
    lastReportError = -1;
    reportFailures = reportFailures + 1;
    return false;
  }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", String("Bearer ") + DEVICE_TOKEN);
  int code = http.POST(body);
  String reply = code > 0 ? http.getString() : String();
  http.end();
  lastHttpCode = code;
  if (code != 200) {
    lastReportError = code;
    reportFailures = reportFailures + 1;
    return false;
  }

  sentTotal = total;
  sentAck = ack;

  // The reply looks like:
  // {"ok":true,"occupancy":12,"interval_ms":15000,"commands":[{"id":6,"type":"calibrate"}]}
  int at = reply.indexOf("\"occupancy\":");
  if (at >= 0) recOccupancy = reply.substring(at + 12).toInt();
  at = reply.indexOf("\"interval_ms\":");
  if (at >= 0) checkInIntervalMs = constrain(reply.substring(at + 14).toInt(), 1000L, 60000L);

  int pos = reply.indexOf("\"commands\":");
  while (pos >= 0 && (pos = reply.indexOf("{\"id\":", pos)) >= 0) {
    uint32_t id = strtoul(reply.c_str() + pos + 6, nullptr, 10);
    int typeAt = reply.indexOf("\"type\":\"", pos);
    if (typeAt < 0) break;
    int typeEnd = reply.indexOf('"', typeAt + 8);
    if (typeEnd < 0) break;
    runCommand(id, reply.substring(typeAt + 8, typeEnd));
    pos = typeEnd;
  }
  return true;
}

void joinWifi() {
  if (strlen(WIFI_PASSWORD) > 0) WiFi.begin(WIFI_NAME, WIFI_PASSWORD);
  else WiFi.begin(WIFI_NAME);   // open network: no password
}

// Runs forever on the second core: keeps WiFi up and reports to the website
// on a schedule, or right away when the count changes.
void networkTask(void *) {
  bool wasConnected = false;
  bool firstReport = true;
  unsigned long lastWifiRetry = millis();
  unsigned long lastRejoinMs = millis();
  int wifiRetries = 0;
  unsigned long lastCheckInMs = 0;
  uint32_t sentTotal = bootTotal;   // after a self-restart, start from the kept total
  uint32_t sentAck = 0;

  tls.setCACert(ROOT_CERTIFICATES);
  tls.setHandshakeTimeout(10);    // seconds
  http.setReuse(true);            // keep the secure connection open between fast reports
  http.setConnectTimeout(REPORT_TIMEOUT_MS);
  http.setTimeout(REPORT_TIMEOUT_MS);

  for (;;) {
    bool connected = WiFi.status() == WL_CONNECTED;
    if (connected && !wasConnected) {
      Serial.print("WiFi connected. Local status page: http://");
      Serial.println(WiFi.localIP());
      Serial.printf("Signal strength: %d dBm (better than -70 is fine)\n", WiFi.RSSI());
      if (MDNS.begin("peoplecounter")) Serial.println("Or try: http://peoplecounter.local");
    }
    if (!connected && wasConnected) {
      Serial.println("WiFi dropped. Still counting; reconnecting...");
      serverOk = false;
      tls.stop();
    }
    if (connected) wifiRetries = 0;
    wasConnected = connected;

    if (!connected) {
      // If auto-reconnect hasn't fixed it, try again every 10 s, and once a
      // minute drop the connection completely and join from scratch.
      if (millis() - lastWifiRetry > 10000) {
        lastWifiRetry = millis();
        if (++wifiRetries % 6 == 0) {
          Serial.println("Still no WiFi. Joining from scratch...");
          WiFi.disconnect();
          joinWifi();
        } else {
          WiFi.reconnect();
        }
      }
      vTaskDelay(pdMS_TO_TICKS(250));
      continue;
    }

    // On WiFi but the website has been out of reach for a while: the network
    // may have quietly stopped passing our traffic. Rejoin it.
    if (millis() - lastServerOkMs > OFFLINE_REJOIN_MS && millis() - lastRejoinMs > OFFLINE_REJOIN_MS) {
      lastRejoinMs = millis();
      Serial.println("Website out of reach for 2 minutes. Rejoining WiFi...");
      tls.stop();
      WiFi.disconnect();
      joinWifi();
      vTaskDelay(pdMS_TO_TICKS(250));
      continue;
    }

    unsigned long since = millis() - lastCheckInMs;
    bool due = since >= (serverOk ? checkInIntervalMs : RETRY_MS);
    bool news = serverOk && since >= MIN_CHECKIN_GAP_MS &&
                (bootTotal != sentTotal || doneCommandId != sentAck);
    if (firstReport || due || news) {
      firstReport = false;
      bool ok = checkIn(sentTotal, sentAck);
      if (!ok && lastHttpCode != 401) {
        // The usual cause is a kept-open connection that has gone stale.
        // Try once more straight away on a fresh one.
        tls.stop();
        ok = checkIn(sentTotal, sentAck);
      }
      lastCheckInMs = millis();
      if (ok) lastServerOkMs = millis();
      // A connection left idle between slow reports goes stale, so only keep
      // it open while reporting fast.
      if (!ok || checkInIntervalMs > 5000) tls.stop();
      if (ok && !serverOk) Serial.println("Website link is up.");
      if (!ok && serverOk) Serial.printf("Website link lost (code %d). Still counting; will retry.\n", (int)lastHttpCode);
      if (!ok && lastHttpCode == 401) Serial.println("The website rejected DEVICE_TOKEN. Check config.h.");
      serverOk = ok;
    }
    vTaskDelay(pdMS_TO_TICKS(50));
  }
}

// ---------- Local status page ----------

const char PAGE[] PROGMEM = R"HTML(
<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>People Counter</title>
<style>
body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:24px;
background:#f4f4f2;color:#1d1d1b;text-align:center}
.card{max-width:420px;margin:0 auto;background:#fff;border-radius:16px;padding:28px;
box-shadow:0 1px 3px rgba(0,0,0,.08)}
.label{font-size:14px;color:#6b6b66;margin:0}
.count{font-size:88px;font-weight:600;margin:4px 0 8px;line-height:1}
.status{display:inline-block;padding:6px 14px;border-radius:999px;font-size:14px;margin-bottom:20px}
.clear{background:#e3f1e6;color:#21572f}.busy{background:#fbe7d6;color:#7a3a0d}
.stats{display:flex;justify-content:space-around;font-size:14px;color:#6b6b66;margin-bottom:20px}
.stats b{display:block;font-size:20px;color:#1d1d1b}
button{font-size:15px;padding:10px 16px;margin:4px;border-radius:10px;border:1px solid #ccc;
background:#fff;cursor:pointer}
.offline{color:#a33;font-size:13px;margin-top:12px;min-height:1em}
</style></head><body>
<div class="card">
  <p class="label">People counted by this unit</p>
  <div class="count" id="count">-</div>
  <div class="status clear" id="status">Connecting...</div>
  <div class="stats">
    <div><b id="mm">-</b>Live distance (mm)</div>
    <div><b id="base">-</b>Empty lane (mm)</div>
  </div>
  <div class="stats">
    <div><b id="rate">-</b>Readings/sec</div>
    <div><b id="sens">-</b>Sensor</div>
  </div>
  <div class="stats">
    <div><b id="web">-</b>Website link</div>
    <div><b id="rec">-</b>In the Rec</div>
  </div>
  <button onclick="post('/reset','Reset this unit\'s count to 0? The website count is not changed.')">Reset count</button>
  <button onclick="post('/calibrate','Make sure the lane is empty, then press OK.')">Recalibrate</button>
  <div class="offline" id="offline"></div>
</div>
<script>
async function refresh(){
  try{
    const r=await fetch('/data');const d=await r.json();
    document.getElementById('count').textContent=d.count;
    document.getElementById('mm').textContent=d.mm;
    document.getElementById('base').textContent=d.baseline;
    document.getElementById('rate').textContent=d.rate;
    document.getElementById('sens').textContent=d.sensorOk?d.status:'Not responding';
    document.getElementById('web').textContent=d.server?'Connected':'Offline ('+d.http+')';
    document.getElementById('rec').textContent=d.occupancy<0?'-':d.occupancy;
    const s=document.getElementById('status');
    s.textContent=d.present?'Someone in the lane':'Lane clear';
    s.className='status '+(d.present?'busy':'clear');
    document.getElementById('offline').textContent='';
  }catch(e){document.getElementById('offline').textContent='Lost connection to the counter';}
}
async function post(url,msg){if(confirm(msg)){await fetch(url,{method:'POST'});refresh();}}
refresh();setInterval(refresh,500);
</script></body></html>
)HTML";

void handleRoot() { server.send_P(200, "text/html", PAGE); }

void handleData() {
  char json[320];
  snprintf(json, sizeof(json),
           "{\"count\":%ld,\"mm\":%d,\"baseline\":%d,\"threshold\":%d,\"present\":%s,"
           "\"rate\":%d,\"sensorOk\":%s,\"status\":\"%s\",\"restarts\":%ld,"
           "\"server\":%s,\"http\":%d,\"occupancy\":%ld}",
           (long)passCount, (int)lastMm, (int)baselineMm, (int)thresholdMm, personPresent ? "true" : "false",
           (int)readingsPerSec, sensorOk ? "true" : "false", statusName(lastStatus), (long)sensorRestarts,
           serverOk ? "true" : "false", (int)lastHttpCode, (long)recOccupancy);
  server.send(200, "application/json", json);
}

void handleReset() {
  passCount = 0;
  saved.passCount = 0;
  Serial.println("Count reset to 0.");
  server.send(200, "text/plain", "ok");
}

void handleCalibrate() {
  calibrate();
  server.send(200, "text/plain", "ok");
}

// ---------- Main ----------

void setup() {
  Serial.begin(115200);
  delay(500);

  // Why did we start? After a self-restart or crash, carry on with the kept
  // counts. After power-on or the EN button, start a fresh running total.
  esp_reset_reason_t why = esp_reset_reason();
  bool selfRestart = false;
  switch (why) {
    case ESP_RST_POWERON:  resetReason = "power on or EN button"; break;
    case ESP_RST_SW:       resetReason = "restarted itself";      selfRestart = true; break;
    case ESP_RST_PANIC:    resetReason = "crashed";               selfRestart = true; break;
    case ESP_RST_INT_WDT:
    case ESP_RST_TASK_WDT:
    case ESP_RST_WDT:      resetReason = "froze (watchdog)";      selfRestart = true; break;
    case ESP_RST_BROWNOUT: resetReason = "power dipped";          break;
    default:               resetReason = "other";                 break;
  }
  Serial.printf("Rec Tracker sensor, firmware " FIRMWARE_VERSION ". Started because: %s\n", resetReason);
  if (selfRestart && saved.magic == SAVED_MAGIC) {
    bootId = saved.bootId;
    bootTotal = saved.bootTotal;
    passCount = saved.passCount;
  } else {
    bootId = esp_random();   // tells the website this is a fresh start, so totals begin again at 0
    saved = { SAVED_MAGIC, bootId, 0, 0 };
  }

  Wire.begin(21, 22);
  Wire.setClock(400000);
  sensorOk = startSensor();
  lastReadingMs = millis();
  lastServerOkMs = millis();
  if (loadBaseline()) {
    // Calibrated before: keep it. Pressing EN or losing power no longer
    // re-measures the lane (your hand on the button used to end up as the "lane").
    needsCalibration = false;
    Serial.printf("Using the saved empty lane: %d mm. Counting anything closer than %d mm.\n",
                  (int)baselineMm, (int)thresholdMm);
    Serial.println("If the sensor has moved, press Recalibrate on the admin page.");
  } else if (sensorOk) {
    calibrate();             // first ever start: measure now
    needsCalibration = false;
  }
  if (!sensorOk) Serial.println("Sensor not found. Check the 4 wires; it will keep trying.");

  Serial.print("ESP32 MAC address (Rice IT may ask for it): ");
  WiFi.mode(WIFI_STA);
  Serial.println(WiFi.macAddress());
  Serial.printf("Joining WiFi \"%s\"...\n", WIFI_NAME);
  WiFi.setAutoReconnect(true);
  joinWifi();

  server.on("/", handleRoot);
  server.on("/data", handleData);
  server.on("/reset", HTTP_POST, handleReset);
  server.on("/calibrate", HTTP_POST, handleCalibrate);
  server.begin();

  // The main loop runs on core 1, so put the website reporting on core 0.
  xTaskCreatePinnedToCore(networkTask, "network", 12288, nullptr, 1, nullptr, 0);
}

void loop() {
  int mm;
  if (sensorOk || !needsCalibration) {
    if (getReading(mm)) {
      updateCounter(mm);
      lastReadingMs = millis();
      readingsInWindow++;
      sensorOk = true;
    }
  }

  // Once a second: update readings/sec and print a status line.
  if (millis() - rateWindowMs >= 1000) {
    rateWindowMs = millis();
    readingsPerSec = readingsInWindow;
    readingsInWindow = 0;
    Serial.printf("[%d readings/s] last: %d mm (%s), count: %ld, website: %s\n",
                  (int)readingsPerSec, (int)lastMm, statusName(lastStatus), (long)passCount,
                  serverOk ? "ok" : "offline");
  }

  // If the sensor goes quiet for 1 second, restart it automatically.
  if (millis() - lastReadingMs > 1000) {
    sensorOk = false;
    sensorRestarts = sensorRestarts + 1;
    Serial.println("No readings for 1 s. Restarting the sensor...");
    if (startSensor()) {
      Serial.println("Sensor restarted.");
      sensorOk = true;
      if (needsCalibration) {     // it was missing at power-on, so it has never been calibrated
        calibrate();
        needsCalibration = false;
      }
    } else {
      Serial.println("Sensor not answering. Check that all 4 wires are pushed on firmly.");
    }
    lastReadingMs = millis();   // wait another second before trying again
  }

  // A recalibration requested from the website.
  if (calibrateRequested) {
    calibrateRequested = false;
    if (sensorOk) calibrate();
    if (calibrateCommandId > doneCommandId) doneCommandId = calibrateCommandId;
  }

  server.handleClient();

  // Last resort: nothing has reached the website for 5 minutes and rejoining
  // WiFi didn't help, so restart. Counts and calibration are kept.
  unsigned long lastOk = lastServerOkMs;
  if (millis() - lastOk > OFFLINE_RESTART_MS) {
    Serial.println("Website out of reach for 5 minutes. Restarting...");
    delay(200);
    ESP.restart();
  }
}
