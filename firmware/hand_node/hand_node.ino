/* ===========================================================================
 *  HUMANOID  ·  ARM NODE  (NodeMCU / ESP8266)
 *
 *  One sketch, two boards. Set ROLE below before flashing each one.
 *
 *    ROLE_RIGHT_HAND : shoulderX D1, shoulderY D2, elbow D3, wristZ D4, gripper D5
 *                      + aux motor on D7/D8 (H-bridge, reversible)
 *    ROLE_LEFT_HAND  : shoulderX D1, shoulderY D2, elbow D3, wristZ D4, gripper D7,
 *                      head pan D5, head tilt D6
 *
 *  Lifecycle
 *    1. No WiFi credentials stored  ->  soft-AP + captive portal at 192.168.4.1
 *       The portal asks for: WiFi SSID, WiFi password, and the laptop's IP+port.
 *    2. Credentials stored -> joins the WiFi, POSTs its own IP to
 *       http://<laptop>:<port>/api/register, then listens for UDP servo commands.
 *    3. WiFi lost for longer than AP_FALLBACK_MS -> back to access-point mode.
 *
 *  UDP command format (port 4210), ASCII, one datagram per message:
 *      S|seq=42|0=90|2=140      set channel 0 -> 90 deg, channel 2 -> 140 deg
 *      M|seq=42|dir=1|pwm=800   aux motor: dir +1 clockwise, -1 anticlockwise, 0 stop
 *      P|seq=42                 ping (replies with A|...)
 *      SRV|ip=192.168.1.20|port=4211|http=3000     server announcing itself
 *
 *  Heartbeat back to the laptop on port 4211:
 *      B|id=right_hand|ip=...|rssi=-54|up=123456|fw=1.0.0
 *
 *  Libraries: only what ships with the ESP8266 Arduino core. No ArduinoJson.
 * ========================================================================= */

#include <ESP8266WiFi.h>
#include <ESP8266WebServer.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClient.h>
#include <WiFiUdp.h>
#include <DNSServer.h>
#include <EEPROM.h>
#include <Servo.h>

// ------------------------------------------------------------------- ROLE ---

#define ROLE_RIGHT_HAND 1
#define ROLE_LEFT_HAND  2

#define ROLE ROLE_RIGHT_HAND        // <<<<<< CHANGE THIS FOR THE SECOND BOARD

#define FW_VERSION "1.1.0"

// ---------------------------------------------------------------- pin map ---

#if ROLE == ROLE_RIGHT_HAND
  const char* NODE_ID   = "right_hand";
  const char* AP_SSID   = "HUMANOID-RIGHT";
  const uint8_t SERVO_PIN[]   = {  D1,  D2,  D3,  D4,  D5 };
  //                            shX  shY  elb  wrZ  grip
  const uint8_t SERVO_HOME[]  = {   0,   0,   0, 180,   0 };
  const uint8_t SERVO_SPEED[] = { 120, 120, 150, 180, 200 };   // deg/second

  /* Aux motor: one reversible DC motor on an L298N. D7 -> IN1, D8 -> IN2,
     driven HIGH/LOW only — no PWM, so the motor runs at full supply voltage.

     D8 is GPIO15, a strapping pin: it MUST read low at power-up or the ESP8266
     will not boot. We park both inputs low first thing in setup(), before the
     servos and the radio, but the L298N must not pull D8 up on its own. If the
     board boot-loops with the driver attached, add a 10k pull-down on D8, or
     move IN2 to another free pin here and in config/setup.json. */
  #define HAS_AUX_MOTOR 1
  const uint8_t MOTOR_CW_PIN  = D7;     // L298N IN1 — HIGH turns it clockwise
  const uint8_t MOTOR_CCW_PIN = D8;     // L298N IN2 — HIGH turns it anticlockwise
  const bool    MOTOR_INVERT  = false;  // flip if "up" turns the wrong way
#else
  const char* NODE_ID   = "left_hand";
  const char* AP_SSID   = "HUMANOID-LEFT";
  const uint8_t SERVO_PIN[]   = {  D1,  D2,  D3,  D4,  D7,  D5,  D6 };
  //                            shX  shY  elb  wrZ grip  pan tilt
  const uint8_t SERVO_HOME[]  = { 180, 180, 180,   0,   0, 180, 180 };
  const uint8_t SERVO_SPEED[] = { 120, 120, 150, 180, 200, 100, 100 };
#endif

const uint8_t SERVO_COUNT = sizeof(SERVO_PIN) / sizeof(SERVO_PIN[0]);

const char* AP_PASSWORD  = "12345678";
const uint16_t NODE_UDP_PORT     = 4210;   // we listen here
const uint16_t DEFAULT_SRV_PORT  = 4211;   // laptop listens here
const uint16_t DEFAULT_HTTP_PORT = 3000;

const uint32_t WIFI_CONNECT_TIMEOUT_MS = 20000;
const uint32_t AP_FALLBACK_MS          = 15000;  // no WiFi this long -> AP mode
const uint32_t AP_RETRY_MS             = 30000;  // background retry cadence in AP mode
const uint32_t HEARTBEAT_MS            = 2000;
const uint32_t REGISTER_RETRY_MS       = 5000;
const uint32_t REGISTER_REFRESH_MS     = 30000;

const uint16_t SERVO_PULSE_MIN = 500;      // microseconds
const uint16_t SERVO_PULSE_MAX = 2400;

#ifdef HAS_AUX_MOTOR
const uint32_t MOTOR_FAILSAFE_MS = 600;    // no command -> stop, same rule as the base
#endif

// ------------------------------------------------------------- stored cfg ---

#define CFG_MAGIC 0xB0710002UL

struct Config {
  uint32_t magic;
  char     ssid[33];
  char     pass[65];
  char     server[16];      // laptop IP, dotted quad
  uint16_t serverPort;      // UDP port the laptop listens on
  uint16_t httpPort;        // HTTP port for /api/register
};

Config cfg;

// ------------------------------------------------------------------ state ---

enum Mode { MODE_AP, MODE_STA };
Mode mode = MODE_AP;

ESP8266WebServer portal(80);
DNSServer dns;
WiFiUDP udp;

Servo servos[SERVO_COUNT];
float   servoCur[SERVO_COUNT];
uint8_t servoTarget[SERVO_COUNT];

#ifdef HAS_AUX_MOTOR
int      motorDir = 0;           // +1 clockwise, -1 anticlockwise, 0 stopped
uint32_t lastMotorCmd = 0;
#endif

uint32_t lastServoStep = 0;
uint32_t lastHeartbeat = 0;
uint32_t lastRegisterTry = 0;
uint32_t wifiLostSince = 0;
uint32_t lastSeq = 0;
bool     registered = false;

bool     staRetrying = false;     // a background join attempt is in flight (AP mode)
uint32_t staRetryStarted = 0;

char rxBuf[512];

// ============================================================== utilities ===

void logf(const char* fmt, ...) {
  char buf[220];
  va_list args;
  va_start(args, fmt);
  vsnprintf(buf, sizeof(buf), fmt, args);
  va_end(args);
  Serial.println(buf);
}

void loadConfig() {
  EEPROM.begin(sizeof(Config) + 8);
  EEPROM.get(0, cfg);
  if (cfg.magic != CFG_MAGIC) {
    memset(&cfg, 0, sizeof(cfg));
    cfg.magic = CFG_MAGIC;
    cfg.serverPort = DEFAULT_SRV_PORT;
    cfg.httpPort = DEFAULT_HTTP_PORT;
  }
  if (cfg.serverPort == 0) cfg.serverPort = DEFAULT_SRV_PORT;
  if (cfg.httpPort == 0) cfg.httpPort = DEFAULT_HTTP_PORT;
}

void saveConfig() {
  cfg.magic = CFG_MAGIC;
  EEPROM.put(0, cfg);
  EEPROM.commit();
}

bool hasCredentials() { return strlen(cfg.ssid) > 0; }

// ================================================================= servos ===

void servoSetup() {
  for (uint8_t i = 0; i < SERVO_COUNT; i++) {
    servoCur[i] = SERVO_HOME[i];
    servoTarget[i] = SERVO_HOME[i];
    servos[i].attach(SERVO_PIN[i], SERVO_PULSE_MIN, SERVO_PULSE_MAX);
    servos[i].write(SERVO_HOME[i]);
    delay(60);                     // stagger the inrush so the 5 V rail survives
  }
  lastServoStep = millis();
}

/* Slew limiter: never jump straight to the commanded angle. Protects the
   gearbox and keeps the current draw predictable on a shared supply. */
void servoUpdate() {
  uint32_t now = millis();
  float dt = (now - lastServoStep) / 1000.0f;
  if (dt < 0.015f) return;         // ~66 Hz is plenty for hobby servos
  lastServoStep = now;

  for (uint8_t i = 0; i < SERVO_COUNT; i++) {
    float target = servoTarget[i];
    float delta = target - servoCur[i];
    if (fabs(delta) < 0.3f) { servoCur[i] = target; }
    else {
      float step = SERVO_SPEED[i] * dt;
      servoCur[i] += (delta > 0 ? min(step, delta) : max(-step, delta));
    }
    servos[i].write((int)(servoCur[i] + 0.5f));
  }
}

void servoCommand(uint8_t channel, int angle) {
  if (channel >= SERVO_COUNT) return;
  if (angle < 0) angle = 0;
  if (angle > 180) angle = 180;
  servoTarget[channel] = (uint8_t)angle;
}

// ============================================================== aux motor ===
#ifdef HAS_AUX_MOTOR

/* Plain L298N direction pattern — no PWM, the motor runs at whatever the
   driver's supply gives it:

       clockwise      IN1 HIGH   IN2 LOW
       anticlockwise  IN1 LOW    IN2 HIGH
       stop           IN1 LOW    IN2 LOW

   The two inputs are never HIGH together, so the bridge cannot shoot through.
   (If you are using the L298N's ENA jumper, leave it on — enable stays high and
   direction alone decides everything.) */
void motorApply() {
  int dir = MOTOR_INVERT ? -motorDir : motorDir;
  digitalWrite(MOTOR_CW_PIN,  dir > 0 ? HIGH : LOW);
  digitalWrite(MOTOR_CCW_PIN, dir < 0 ? HIGH : LOW);
}

void motorSetup() {
  pinMode(MOTOR_CW_PIN, OUTPUT);
  pinMode(MOTOR_CCW_PIN, OUTPUT);
  digitalWrite(MOTOR_CW_PIN, LOW);      // park GPIO15 low before anything else
  digitalWrite(MOTOR_CCW_PIN, LOW);
  motorDir = 0;
}

/** dir: +1 clockwise, -1 anticlockwise, 0 stop. */
void motorSet(int dir) {
  motorDir = dir > 0 ? 1 : (dir < 0 ? -1 : 0);
  lastMotorCmd = millis();
  motorApply();
}

/* Parks the motor if the control link goes quiet — a closed browser tab, a
   dropped packet or a dead WiFi link must not leave it spinning. */
void motorUpdate() {
  if (motorDir == 0) return;
  if (millis() - lastMotorCmd > MOTOR_FAILSAFE_MS) {
    motorDir = 0;
    motorApply();
    logf("[MOT] failsafe — no command for %lu ms, stopped", (unsigned long)MOTOR_FAILSAFE_MS);
  }
}

#endif  // HAS_AUX_MOTOR

// ============================================================ access point ===

String htmlPage(const String& body) {
  String p = F("<!doctype html><html><head><meta charset='utf-8'>"
               "<meta name='viewport' content='width=device-width,initial-scale=1'>"
               "<title>Humanoid node setup</title><style>"
               "body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0f131d;color:#e7edfb;margin:0;padding:22px}"
               ".card{max-width:420px;margin:0 auto;background:#151b28;border:1px solid #263047;border-radius:14px;padding:20px}"
               "h1{font-size:18px;margin:0 0 4px}.sub{color:#8d99b5;font-size:12px;margin-bottom:18px}"
               "label{display:block;font-size:12px;color:#8d99b5;margin:12px 0 5px}"
               "input,select{width:100%;padding:11px;border-radius:9px;border:1px solid #263047;background:#0c1018;color:#e7edfb;font-size:15px}"
               "button{width:100%;margin-top:18px;padding:13px;border:0;border-radius:9px;background:#4fd1c5;color:#06210f;font-size:15px;font-weight:700}"
               "a{color:#4fd1c5}.row{display:flex;gap:10px}.row>div{flex:1}"
               "code{background:#0c1018;padding:2px 6px;border-radius:5px}"
               "</style></head><body><div class='card'>");
  p += body;
  p += F("</div></body></html>");
  return p;
}

void handlePortalRoot() {
  int n = WiFi.scanNetworks();
  String opts;
  for (int i = 0; i < n && i < 20; i++) {
    opts += "<option value='" + WiFi.SSID(i) + "'>" + WiFi.SSID(i) +
            "  (" + String(WiFi.RSSI(i)) + " dBm)</option>";
  }

  String body = "<h1>" + String(NODE_ID) + "</h1>";
  body += "<div class='sub'>Humanoid arm node &middot; fw " FW_VERSION "<br>MAC " + WiFi.macAddress() + "</div>";
  body += "<form method='POST' action='/save'>";
  body += "<label>WiFi network</label><select name='ssid'>" + opts + "</select>";
  body += "<label>WiFi password</label><input name='pass' type='password' value='" + String(cfg.pass) + "'>";
  body += "<label>Control server (laptop) IP</label><input name='server' placeholder='192.168.1.20' value='" + String(cfg.server) + "'>";
  body += "<div class='row'><div><label>UDP port</label><input name='sport' value='" + String(cfg.serverPort) + "'></div>";
  body += "<div><label>HTTP port</label><input name='hport' value='" + String(cfg.httpPort) + "'></div></div>";
  body += "<button type='submit'>Save &amp; connect</button></form>";
  body += "<p class='sub' style='margin-top:16px'>The node reboots, joins your WiFi and registers itself with the control server. "
          "If the WiFi disappears it comes back here automatically. "
          "<a href='/forget'>Forget stored WiFi</a></p>";

  portal.send(200, "text/html", htmlPage(body));
}

void handlePortalSave() {
  strlcpy(cfg.ssid, portal.arg("ssid").c_str(), sizeof(cfg.ssid));
  strlcpy(cfg.pass, portal.arg("pass").c_str(), sizeof(cfg.pass));
  strlcpy(cfg.server, portal.arg("server").c_str(), sizeof(cfg.server));
  cfg.serverPort = portal.arg("sport").toInt();
  cfg.httpPort = portal.arg("hport").toInt();
  if (cfg.serverPort == 0) cfg.serverPort = DEFAULT_SRV_PORT;
  if (cfg.httpPort == 0) cfg.httpPort = DEFAULT_HTTP_PORT;
  saveConfig();

  portal.send(200, "text/html", htmlPage(
    "<h1>Saved</h1><div class='sub'>Joining <b>" + String(cfg.ssid) +
    "</b> and reporting to <code>" + String(cfg.server) + "</code>. Rebooting…</div>"));

  delay(600);
  ESP.restart();
}

void handlePortalForget() {
  memset(cfg.ssid, 0, sizeof(cfg.ssid));
  memset(cfg.pass, 0, sizeof(cfg.pass));
  saveConfig();
  portal.send(200, "text/html", htmlPage("<h1>Cleared</h1><div class='sub'>Rebooting into setup mode…</div>"));
  delay(600);
  ESP.restart();
}

void startAP() {
  mode = MODE_AP;
  registered = false;
  staRetrying = false;
  udp.stop();

  WiFi.disconnect();
  WiFi.mode(WIFI_AP_STA);              // AP_STA so the portal can still scan
  WiFi.setAutoReconnect(false);        // retries are ours to schedule, not the SDK's
  WiFi.softAP(AP_SSID, AP_PASSWORD);
  delay(200);

  dns.setErrorReplyCode(DNSReplyCode::NoError);
  dns.start(53, "*", WiFi.softAPIP()); // captive portal: any host -> us

  portal.on("/", handlePortalRoot);
  portal.on("/save", HTTP_POST, handlePortalSave);
  portal.on("/forget", handlePortalForget);
  portal.on("/status", []() {
    portal.send(200, "application/json",
                "{\"id\":\"" + String(NODE_ID) + "\",\"mode\":\"ap\",\"fw\":\"" FW_VERSION "\"}");
  });
  portal.onNotFound([]() { handlePortalRoot(); });
  portal.begin();

  logf("[AP] SSID=%s  password=%s  http://%s", AP_SSID, AP_PASSWORD,
       WiFi.softAPIP().toString().c_str());
}

// ================================================================ station ===

void registerWithServer() {
  if (strlen(cfg.server) == 0) return;

  WiFiClient client;
  HTTPClient http;
  String url = "http://" + String(cfg.server) + ":" + String(cfg.httpPort) + "/api/register";

  String body = "{\"id\":\"" + String(NODE_ID) +
                "\",\"ip\":\"" + WiFi.localIP().toString() +
                "\",\"mac\":\"" + WiFi.macAddress() +
                "\",\"rssi\":" + String(WiFi.RSSI()) +
                ",\"fw\":\"" FW_VERSION "\"}";

  http.setTimeout(3000);
  if (!http.begin(client, url)) { logf("[REG] begin failed"); return; }
  http.addHeader("Content-Type", "application/json");
  int code = http.POST(body);
  if (code == 200) {
    registered = true;
    logf("[REG] registered with %s", url.c_str());
  } else {
    registered = false;
    logf("[REG] failed (%d) -> %s", code, url.c_str());
  }
  http.end();
}

/* Everything that has to happen once the link is actually up. Shared by the
   blocking boot path and by the non-blocking retry that runs under the portal. */
void adoptStation() {
  mode = MODE_STA;
  staRetrying = false;
  dns.stop();
  portal.stop();
  WiFi.mode(WIFI_STA);                 // drops the soft-AP, we no longer need it
  WiFi.setAutoReconnect(true);

  logf("[STA] connected, ip=%s rssi=%d", WiFi.localIP().toString().c_str(), WiFi.RSSI());
  udp.begin(NODE_UDP_PORT);
  wifiLostSince = 0;
  registerWithServer();
  lastRegisterTry = millis();
}

bool startSTA() {
  dns.stop();
  portal.stop();

  WiFi.mode(WIFI_STA);
  WiFi.hostname(NODE_ID);
  WiFi.begin(cfg.ssid, cfg.pass);
  logf("[STA] joining %s …", cfg.ssid);

  uint32_t started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < WIFI_CONNECT_TIMEOUT_MS) {
    delay(250);
    servoUpdate();
#ifdef HAS_AUX_MOTOR
    motorUpdate();
#endif
    Serial.print('.');
  }
  Serial.println();

  if (WiFi.status() != WL_CONNECTED) {
    logf("[STA] could not join %s", cfg.ssid);
    return false;
  }

  adoptStation();
  return true;
}

/* Background retry while the setup portal is up.

   This used to call startSTA(), which tore the access point down and blocked
   for up to WIFI_CONNECT_TIMEOUT_MS. With unreachable credentials stored that
   meant the portal vanished for 20 s out of every 30 — long enough to kick the
   phone off before anyone could finish typing the correct password.

   Now the attempt rides on the AP_STA interface, so the portal never goes
   away, and it is skipped entirely while somebody is connected to the AP. */
void apRetryTick() {
  static uint32_t lastRetry = 0;

  if (WiFi.softAPgetStationNum() > 0) {          // somebody is configuring us
    if (staRetrying) {
      WiFi.disconnect();
      staRetrying = false;
      logf("[AP] client on the portal — WiFi retries paused");
    }
    lastRetry = millis();
    return;
  }

  if (!hasCredentials()) return;

  if (staRetrying) {
    if (WiFi.status() == WL_CONNECTED) { adoptStation(); return; }
    if (millis() - staRetryStarted > WIFI_CONNECT_TIMEOUT_MS) {
      staRetrying = false;
      WiFi.disconnect();
      logf("[AP] %s still unreachable — staying in setup mode", cfg.ssid);
    }
    return;
  }

  if (millis() - lastRetry > AP_RETRY_MS) {
    lastRetry = millis();
    staRetrying = true;
    staRetryStarted = millis();
    WiFi.hostname(NODE_ID);
    WiFi.begin(cfg.ssid, cfg.pass);
    logf("[AP] background retry of %s — portal stays up", cfg.ssid);
  }
}

void sendToServer(const String& msg) {
  if (strlen(cfg.server) == 0) return;
  IPAddress ip;
  if (!ip.fromString(cfg.server)) return;
  udp.beginPacket(ip, cfg.serverPort);
  udp.write((const uint8_t*)msg.c_str(), msg.length());
  udp.endPacket();
}

void sendHeartbeat() {
  String msg = "B|id=" + String(NODE_ID) +
               "|ip=" + WiFi.localIP().toString() +
               "|rssi=" + String(WiFi.RSSI()) +
               "|up=" + String(millis()) +
               "|fw=" FW_VERSION;
  sendToServer(msg);
}

// ------------------------------------------------------- UDP command parse --

void handleServoPacket(char* payload, uint32_t seq) {
  // payload holds the '|' separated tokens after the type
  char* token = strtok(payload, "|");
  while (token) {
    char* eq = strchr(token, '=');
    if (eq) {
      *eq = 0;
      const char* key = token;
      int value = atoi(eq + 1);
      if (key[0] >= '0' && key[0] <= '9') {
        servoCommand((uint8_t)atoi(key), value);
      }
    }
    token = strtok(NULL, "|");
  }
  String ack = "A|id=" + String(NODE_ID) + "|seq=" + String(seq);
  sendToServer(ack);
}

#ifdef HAS_AUX_MOTOR
void handleMotorPacket(char* payload, uint32_t seq) {
  int dir = 0;
  bool sawDir = false;

  char* token = strtok(payload, "|");
  while (token) {
    char* eq = strchr(token, '=');
    if (eq) {
      *eq = 0;
      int v = atoi(eq + 1);
      if (!strcmp(token, "dir")) { dir = v; sawDir = true; }
      else if (!strcmp(token, "stop") && v) { dir = 0; sawDir = true; }
    }
    token = strtok(NULL, "|");
  }

  motorSet(sawDir ? dir : 0);      // a malformed packet stops, never spins
  sendToServer("A|id=" + String(NODE_ID) + "|seq=" + String(seq));
}
#endif

void handleAnnounce(char* payload) {
  char ip[16] = {0};
  uint16_t sport = cfg.serverPort;
  uint16_t hport = cfg.httpPort;

  char* token = strtok(payload, "|");
  while (token) {
    char* eq = strchr(token, '=');
    if (eq) {
      *eq = 0;
      if (!strcmp(token, "ip")) strlcpy(ip, eq + 1, sizeof(ip));
      else if (!strcmp(token, "port")) sport = atoi(eq + 1);
      else if (!strcmp(token, "http")) hport = atoi(eq + 1);
    }
    token = strtok(NULL, "|");
  }

  if (strlen(ip) && (strcmp(ip, cfg.server) || sport != cfg.serverPort || hport != cfg.httpPort)) {
    logf("[SRV] control server moved to %s:%u (http %u)", ip, sport, hport);
    strlcpy(cfg.server, ip, sizeof(cfg.server));
    cfg.serverPort = sport;
    cfg.httpPort = hport;
    saveConfig();
    registered = false;          // re-register at the new address
  }
}

void pollUdp() {
  int size = udp.parsePacket();
  if (size <= 0) return;
  int len = udp.read(rxBuf, sizeof(rxBuf) - 1);
  if (len <= 0) return;
  rxBuf[len] = 0;

  // split "TYPE|rest…"
  char* bar = strchr(rxBuf, '|');
  char* rest = bar ? bar + 1 : (char*)"";
  if (bar) *bar = 0;
  const char* type = rxBuf;

  // pull the sequence number out of the rest (it is always first when present)
  uint32_t seq = 0;
  if (!strncmp(rest, "seq=", 4)) {
    seq = strtoul(rest + 4, NULL, 10);
    char* next = strchr(rest, '|');
    rest = next ? next + 1 : (char*)"";
    // drop stale datagrams (UDP can reorder) but allow a counter restart
    if (seq && lastSeq && seq < lastSeq && (lastSeq - seq) < 500) return;
    if (seq) lastSeq = seq;
  }

  if (!strcmp(type, "S")) handleServoPacket(rest, seq);
#ifdef HAS_AUX_MOTOR
  else if (!strcmp(type, "M")) handleMotorPacket(rest, seq);
#endif
  else if (!strcmp(type, "SRV")) handleAnnounce(rest);
  else if (!strcmp(type, "P")) sendToServer("A|id=" + String(NODE_ID) + "|seq=" + String(seq));
}

// ==================================================================== main ===

void setup() {
  Serial.begin(115200);
  delay(50);
  Serial.println();
  logf("=== humanoid %s  fw " FW_VERSION " ===", NODE_ID);

#ifdef HAS_AUX_MOTOR
  motorSetup();          // first: gets GPIO15 (D8) low before anything else runs
#endif

  loadConfig();
  servoSetup();

  if (hasCredentials()) {
    if (!startSTA()) startAP();
  } else {
    logf("[CFG] no stored WiFi — starting setup portal");
    startAP();
  }
}

void loop() {
  servoUpdate();
#ifdef HAS_AUX_MOTOR
  motorUpdate();         // runs in every mode, so the failsafe still bites in AP mode
#endif

  if (mode == MODE_AP) {
    dns.processNextRequest();
    portal.handleClient();
    apRetryTick();          // non-blocking; never takes the portal down
    return;
  }

  // ---- station mode ----
  if (WiFi.status() != WL_CONNECTED) {
    if (wifiLostSince == 0) {
      wifiLostSince = millis();
      logf("[STA] WiFi lost — will fall back to AP in %lu ms", (unsigned long)AP_FALLBACK_MS);
    } else if (millis() - wifiLostSince > AP_FALLBACK_MS) {
      logf("[STA] giving up on WiFi — back to access-point mode");
      startAP();
    }
    return;
  }
  wifiLostSince = 0;

  pollUdp();

  uint32_t now = millis();
  if (now - lastHeartbeat > HEARTBEAT_MS) {
    lastHeartbeat = now;
    sendHeartbeat();
  }

  uint32_t interval = registered ? REGISTER_REFRESH_MS : REGISTER_RETRY_MS;
  if (now - lastRegisterTry > interval) {
    lastRegisterTry = now;
    registerWithServer();
  }
}
