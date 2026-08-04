/* ===========================================================================
 *  HUMANOID  ·  DRIVE NODE  (NodeMCU / ESP8266)
 *
 *  Differential drive base, four BTS7960-style RPWM/LPWM channels — the pin map
 *  is exactly the one from the original RobotCar sketch:
 *
 *      Left  Front : RPWM D0   LPWM D1
 *      Left  Rear  : RPWM D2   LPWM D3
 *      Right Front : RPWM D4   LPWM D5
 *      Right Rear  : RPWM D6   LPWM D7
 *
 *  Difference from the original: instead of only hosting its own web page, it
 *  joins the user's WiFi through a captive-portal setup, registers with the
 *  control server, and takes UDP commands from it:
 *
 *      D|seq=42|l=900|r=-900     signed PWM per side, -1023..1023
 *      D|seq=42|stop=1           immediate stop
 *      P|seq=42                  ping
 *      SRV|ip=…|port=…|http=…    server announcing where it lives
 *
 *  The original touch page is still there as a manual fallback: while the node
 *  is in access-point mode, open http://192.168.4.1/drive.
 *
 *  Safety: if no drive command arrives for DRIVE_FAILSAFE_MS the motors stop.
 *  A dropped WiFi link therefore parks the robot instead of running it into a
 *  wall, and after AP_FALLBACK_MS the node returns to access-point mode.
 * ========================================================================= */

#include <ESP8266WiFi.h>
#include <ESP8266WebServer.h>
#include <ESP8266HTTPClient.h>
#include <WiFiClient.h>
#include <WiFiUdp.h>
#include <DNSServer.h>
#include <EEPROM.h>

#define FW_VERSION "1.0.0"

const char* NODE_ID  = "drive";
const char* AP_SSID  = "HUMANOID-DRIVE";
const char* AP_PASSWORD = "12345678";

// ---------------------------------------------------------------- motor map --

#define LF_RPWM D0
#define LF_LPWM D1
#define LR_RPWM D2
#define LR_LPWM D3
#define RF_RPWM D4
#define RF_LPWM D5
#define RR_RPWM D6
#define RR_LPWM D7

const int  PWM_MAX = 1023;
const int  DEFAULT_SPEED = 900;
const bool INVERT_LEFT  = false;   // flip if a side spins backwards
const bool INVERT_RIGHT = false;

const uint16_t NODE_UDP_PORT     = 4210;
const uint16_t DEFAULT_SRV_PORT  = 4211;
const uint16_t DEFAULT_HTTP_PORT = 3000;

const uint32_t WIFI_CONNECT_TIMEOUT_MS = 20000;
const uint32_t AP_FALLBACK_MS      = 15000;
const uint32_t AP_RETRY_MS         = 30000;  // background retry cadence in AP mode
const uint32_t HEARTBEAT_MS        = 2000;
const uint32_t REGISTER_RETRY_MS   = 5000;
const uint32_t REGISTER_REFRESH_MS = 30000;
const uint32_t DRIVE_FAILSAFE_MS   = 600;   // no command -> stop
const uint32_t RAMP_STEP           = 90;    // pwm units per 10 ms, soft start

// ------------------------------------------------------------- stored cfg ---

#define CFG_MAGIC 0xB0710002UL

struct Config {
  uint32_t magic;
  char     ssid[33];
  char     pass[65];
  char     server[16];
  uint16_t serverPort;
  uint16_t httpPort;
};
Config cfg;

enum Mode { MODE_AP, MODE_STA };
Mode mode = MODE_AP;

ESP8266WebServer portal(80);
DNSServer dns;
WiFiUDP udp;

int targetLeft = 0, targetRight = 0;
int curLeft = 0, curRight = 0;
uint32_t lastDriveCmd = 0;
uint32_t lastRamp = 0;
uint32_t lastHeartbeat = 0;
uint32_t lastRegisterTry = 0;
uint32_t wifiLostSince = 0;
uint32_t lastSeq = 0;
bool registered = false;
bool staRetrying = false;        // a background join attempt is in flight (AP mode)
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

// ================================================================= motors ===

void writeSide(int pwm, uint8_t rpwmA, uint8_t lpwmA, uint8_t rpwmB, uint8_t lpwmB, bool invert) {
  if (invert) pwm = -pwm;
  int fwd = pwm > 0 ? pwm : 0;
  int rev = pwm < 0 ? -pwm : 0;
  analogWrite(rpwmA, fwd);
  analogWrite(lpwmA, rev);
  analogWrite(rpwmB, fwd);
  analogWrite(lpwmB, rev);
}

void applyMotors() {
  writeSide(curLeft,  LF_RPWM, LF_LPWM, LR_RPWM, LR_LPWM, INVERT_LEFT);
  writeSide(curRight, RF_RPWM, RF_LPWM, RR_RPWM, RR_LPWM, INVERT_RIGHT);
}

void stopMotors() {
  targetLeft = targetRight = 0;
  curLeft = curRight = 0;
  applyMotors();
}

/* Ramp towards the target so a full-speed reversal does not brown out the
   regulator or snap the gearboxes. */
void motorUpdate() {
  uint32_t now = millis();
  if (now - lastRamp < 10) return;
  lastRamp = now;

  int dl = targetLeft - curLeft;
  int dr = targetRight - curRight;
  curLeft  += constrain(dl, -(int)RAMP_STEP, (int)RAMP_STEP);
  curRight += constrain(dr, -(int)RAMP_STEP, (int)RAMP_STEP);
  applyMotors();
}

void setDrive(int l, int r) {
  targetLeft  = constrain(l, -PWM_MAX, PWM_MAX);
  targetRight = constrain(r, -PWM_MAX, PWM_MAX);
  lastDriveCmd = millis();
}

// ============================================================ access point ===

String htmlShell(const String& body) {
  String p = F("<!doctype html><html><head><meta charset='utf-8'>"
               "<meta name='viewport' content='width=device-width,initial-scale=1'>"
               "<title>Humanoid drive node</title><style>"
               "body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0f131d;color:#e7edfb;margin:0;padding:22px}"
               ".card{max-width:420px;margin:0 auto;background:#151b28;border:1px solid #263047;border-radius:14px;padding:20px}"
               "h1{font-size:18px;margin:0 0 4px}.sub{color:#8d99b5;font-size:12px;margin-bottom:18px}"
               "label{display:block;font-size:12px;color:#8d99b5;margin:12px 0 5px}"
               "input,select{width:100%;padding:11px;border-radius:9px;border:1px solid #263047;background:#0c1018;color:#e7edfb;font-size:15px}"
               "button{width:100%;margin-top:18px;padding:13px;border:0;border-radius:9px;background:#8c7cf0;color:#0b0713;font-size:15px;font-weight:700}"
               "a{color:#4fd1c5}.row{display:flex;gap:10px}.row>div{flex:1}"
               "</style></head><body><div class='card'>");
  p += body;
  p += F("</div></body></html>");
  return p;
}

void handlePortalRoot() {
  int n = WiFi.scanNetworks();
  String opts;
  for (int i = 0; i < n && i < 20; i++) {
    opts += "<option value='" + WiFi.SSID(i) + "'>" + WiFi.SSID(i) + "  (" + String(WiFi.RSSI(i)) + " dBm)</option>";
  }

  String body = "<h1>drive node</h1><div class='sub'>Humanoid base &middot; fw " FW_VERSION "<br>MAC " + WiFi.macAddress() + "</div>";
  body += "<form method='POST' action='/save'>";
  body += "<label>WiFi network</label><select name='ssid'>" + opts + "</select>";
  body += "<label>WiFi password</label><input name='pass' type='password' value='" + String(cfg.pass) + "'>";
  body += "<label>Control server (laptop) IP</label><input name='server' placeholder='192.168.1.20' value='" + String(cfg.server) + "'>";
  body += "<div class='row'><div><label>UDP port</label><input name='sport' value='" + String(cfg.serverPort) + "'></div>";
  body += "<div><label>HTTP port</label><input name='hport' value='" + String(cfg.httpPort) + "'></div></div>";
  body += "<button type='submit'>Save &amp; connect</button></form>";
  body += "<p class='sub' style='margin-top:16px'><a href='/drive'>Manual driving page</a> &middot; <a href='/forget'>Forget stored WiFi</a></p>";
  portal.send(200, "text/html", htmlShell(body));
}

/* The original RobotCar page, kept as a no-laptop fallback. */
const char DRIVE_PAGE[] PROGMEM = R"=====(
<!DOCTYPE html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Manual drive</title>
<style>
body{font-family:Arial;text-align:center;background:#0f131d;color:#fff;padding-top:20px}
button{width:110px;height:80px;font-size:26px;margin:8px;border:none;border-radius:12px;background:#222c3f;color:#fff}
button:active{background:#8c7cf0}
#s{width:80%;margin-top:20px}
</style></head><body>
<h2>Humanoid base</h2>
<button ontouchstart="go('forward')" onmousedown="go('forward')" ontouchend="go('stop')" onmouseup="go('stop')">&#9650;</button><br>
<button ontouchstart="go('left')" onmousedown="go('left')" ontouchend="go('stop')" onmouseup="go('stop')">&#9664;</button>
<button onclick="go('stop')">&#9632;</button>
<button ontouchstart="go('right')" onmousedown="go('right')" ontouchend="go('stop')" onmouseup="go('stop')">&#9654;</button><br>
<button ontouchstart="go('reverse')" onmousedown="go('reverse')" ontouchend="go('stop')" onmouseup="go('stop')">&#9660;</button>
<div><input id="s" type="range" min="0" max="1023" value="900" oninput="document.getElementById('v').textContent=this.value"> <span id="v">900</span></div>
<script>
function go(c){fetch('/'+c+'?speed='+document.getElementById('s').value);}
setInterval(function(){},1000);
</script></body></html>
)=====";

void handleDrivePage() { portal.send_P(200, "text/html", DRIVE_PAGE); }

void handlePortalSave() {
  strlcpy(cfg.ssid, portal.arg("ssid").c_str(), sizeof(cfg.ssid));
  strlcpy(cfg.pass, portal.arg("pass").c_str(), sizeof(cfg.pass));
  strlcpy(cfg.server, portal.arg("server").c_str(), sizeof(cfg.server));
  cfg.serverPort = portal.arg("sport").toInt();
  cfg.httpPort = portal.arg("hport").toInt();
  if (cfg.serverPort == 0) cfg.serverPort = DEFAULT_SRV_PORT;
  if (cfg.httpPort == 0) cfg.httpPort = DEFAULT_HTTP_PORT;
  saveConfig();
  portal.send(200, "text/html", htmlShell("<h1>Saved</h1><div class='sub'>Joining <b>" + String(cfg.ssid) + "</b>. Rebooting…</div>"));
  delay(600);
  ESP.restart();
}

void handlePortalForget() {
  memset(cfg.ssid, 0, sizeof(cfg.ssid));
  memset(cfg.pass, 0, sizeof(cfg.pass));
  saveConfig();
  portal.send(200, "text/html", htmlShell("<h1>Cleared</h1><div class='sub'>Rebooting into setup mode…</div>"));
  delay(600);
  ESP.restart();
}

void attachManualRoutes() {
  auto speedArg = []() {
    int s = portal.hasArg("speed") ? portal.arg("speed").toInt() : DEFAULT_SPEED;
    return constrain(s, 0, PWM_MAX);
  };
  portal.on("/drive", handleDrivePage);
  portal.on("/forward", [speedArg]() { int s = speedArg(); setDrive(s, s);   portal.send(200, "text/plain", "OK"); });
  portal.on("/reverse", [speedArg]() { int s = speedArg(); setDrive(-s, -s); portal.send(200, "text/plain", "OK"); });
  portal.on("/left",    [speedArg]() { int s = speedArg(); setDrive(-s, s);  portal.send(200, "text/plain", "OK"); });
  portal.on("/right",   [speedArg]() { int s = speedArg(); setDrive(s, -s);  portal.send(200, "text/plain", "OK"); });
  portal.on("/stop",    []()          { stopMotors();                        portal.send(200, "text/plain", "OK"); });
  portal.on("/status",  []() {
    portal.send(200, "application/json",
                "{\"id\":\"drive\",\"mode\":\"" + String(mode == MODE_AP ? "ap" : "sta") +
                "\",\"l\":" + String(curLeft) + ",\"r\":" + String(curRight) + ",\"fw\":\"" FW_VERSION "\"}");
  });
}

void startAP() {
  mode = MODE_AP;
  registered = false;
  staRetrying = false;
  stopMotors();
  udp.stop();

  WiFi.disconnect();
  WiFi.mode(WIFI_AP_STA);
  WiFi.setAutoReconnect(false);        // retries are ours to schedule, not the SDK's
  WiFi.softAP(AP_SSID, AP_PASSWORD);
  delay(200);

  dns.setErrorReplyCode(DNSReplyCode::NoError);
  dns.start(53, "*", WiFi.softAPIP());

  portal.on("/", handlePortalRoot);
  portal.on("/save", HTTP_POST, handlePortalSave);
  portal.on("/forget", handlePortalForget);
  attachManualRoutes();
  portal.onNotFound([]() { handlePortalRoot(); });
  portal.begin();

  logf("[AP] SSID=%s  password=%s  http://%s  (manual page at /drive)",
       AP_SSID, AP_PASSWORD, WiFi.softAPIP().toString().c_str());
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
  if (!http.begin(client, url)) return;
  http.addHeader("Content-Type", "application/json");
  int code = http.POST(body);
  registered = (code == 200);
  logf("[REG] %s -> %d", url.c_str(), code);
  http.end();
}

/* Everything that has to happen once the link is actually up. Shared by the
   blocking boot path and by the non-blocking retry that runs under the portal. */
void adoptStation() {
  mode = MODE_STA;
  staRetrying = false;
  dns.stop();
  portal.stop();
  stopMotors();
  WiFi.mode(WIFI_STA);                 // drops the soft-AP, we no longer need it
  WiFi.setAutoReconnect(true);

  logf("[STA] connected, ip=%s", WiFi.localIP().toString().c_str());
  udp.begin(NODE_UDP_PORT);

  // Keep the manual page reachable on the LAN too.
  portal.on("/", handleDrivePage);
  attachManualRoutes();
  portal.begin();

  wifiLostSince = 0;
  registerWithServer();
  lastRegisterTry = millis();
}

bool startSTA() {
  dns.stop();
  portal.stop();
  stopMotors();

  WiFi.mode(WIFI_STA);
  WiFi.hostname(NODE_ID);
  WiFi.begin(cfg.ssid, cfg.pass);
  logf("[STA] joining %s …", cfg.ssid);

  uint32_t started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < WIFI_CONNECT_TIMEOUT_MS) {
    delay(250);
    Serial.print('.');
  }
  Serial.println();

  if (WiFi.status() != WL_CONNECTED) { logf("[STA] join failed"); return false; }

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
  sendToServer("B|id=" + String(NODE_ID) +
               "|ip=" + WiFi.localIP().toString() +
               "|rssi=" + String(WiFi.RSSI()) +
               "|up=" + String(millis()) +
               "|fw=" FW_VERSION);
}

void handleDrivePacket(char* payload, uint32_t seq) {
  int l = targetLeft, r = targetRight;
  bool stop = false;

  char* token = strtok(payload, "|");
  while (token) {
    char* eq = strchr(token, '=');
    if (eq) {
      *eq = 0;
      int v = atoi(eq + 1);
      if (!strcmp(token, "l")) l = v;
      else if (!strcmp(token, "r")) r = v;
      else if (!strcmp(token, "stop") && v) stop = true;
    }
    token = strtok(NULL, "|");
  }

  if (stop) { setDrive(0, 0); }
  else setDrive(l, r);

  sendToServer("A|id=" + String(NODE_ID) + "|seq=" + String(seq));
}

void handleAnnounce(char* payload) {
  char ip[16] = {0};
  uint16_t sport = cfg.serverPort, hport = cfg.httpPort;
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
    logf("[SRV] control server is %s:%u", ip, sport);
    strlcpy(cfg.server, ip, sizeof(cfg.server));
    cfg.serverPort = sport;
    cfg.httpPort = hport;
    saveConfig();
    registered = false;
  }
}

void pollUdp() {
  int size = udp.parsePacket();
  if (size <= 0) return;
  int len = udp.read(rxBuf, sizeof(rxBuf) - 1);
  if (len <= 0) return;
  rxBuf[len] = 0;

  char* bar = strchr(rxBuf, '|');
  char* rest = bar ? bar + 1 : (char*)"";
  if (bar) *bar = 0;
  const char* type = rxBuf;

  uint32_t seq = 0;
  if (!strncmp(rest, "seq=", 4)) {
    seq = strtoul(rest + 4, NULL, 10);
    char* next = strchr(rest, '|');
    rest = next ? next + 1 : (char*)"";
    if (seq && lastSeq && seq < lastSeq && (lastSeq - seq) < 500) return;
    if (seq) lastSeq = seq;
  }

  if (!strcmp(type, "D")) handleDrivePacket(rest, seq);
  else if (!strcmp(type, "SRV")) handleAnnounce(rest);
  else if (!strcmp(type, "P")) sendToServer("A|id=" + String(NODE_ID) + "|seq=" + String(seq));
}

// ==================================================================== main ===

void setup() {
  Serial.begin(115200);
  delay(50);
  Serial.println();
  logf("=== humanoid drive node  fw " FW_VERSION " ===");

  const uint8_t pins[] = { LF_RPWM, LF_LPWM, LR_RPWM, LR_LPWM, RF_RPWM, RF_LPWM, RR_RPWM, RR_LPWM };
  for (uint8_t i = 0; i < sizeof(pins); i++) pinMode(pins[i], OUTPUT);
  analogWriteRange(PWM_MAX);
  analogWriteFreq(1000);
  stopMotors();

  loadConfig();

  if (hasCredentials()) {
    if (!startSTA()) startAP();
  } else {
    logf("[CFG] no stored WiFi — starting setup portal");
    startAP();
  }
}

void loop() {
  motorUpdate();
  portal.handleClient();

  if (mode == MODE_AP) {
    dns.processNextRequest();
    apRetryTick();          // non-blocking; never takes the portal down
  } else {
    if (WiFi.status() != WL_CONNECTED) {
      stopMotors();                                  // never coast on a dead link
      if (wifiLostSince == 0) wifiLostSince = millis();
      else if (millis() - wifiLostSince > AP_FALLBACK_MS) {
        // Reboot rather than switching in place: the web server already has the
        // LAN routes bound, and a restart gives the setup portal a clean table.
        // On boot it retries the stored WiFi once, then opens the AP by itself.
        logf("[STA] WiFi gone — rebooting into access-point mode");
        stopMotors();
        delay(100);
        ESP.restart();
      }
      return;
    }
    wifiLostSince = 0;
    pollUdp();

    uint32_t now = millis();
    if (now - lastHeartbeat > HEARTBEAT_MS) { lastHeartbeat = now; sendHeartbeat(); }
    uint32_t interval = registered ? REGISTER_REFRESH_MS : REGISTER_RETRY_MS;
    if (now - lastRegisterTry > interval) { lastRegisterTry = now; registerWithServer(); }
  }

  // failsafe: commands stopped arriving -> park
  if ((targetLeft || targetRight) && millis() - lastDriveCmd > DRIVE_FAILSAFE_MS) {
    setDrive(0, 0);
    lastDriveCmd = millis();
  }
}
