# Setup Guide — Humanoid Control

Start-to-finish setup for a fresh machine: dependencies, firmware, WiFi,
the control server, and the HTTPS certificates the **phone face** needs.

`README.md` is the full reference for wiring, protocol and the UI. This file is
the ordered runbook — do these in order and it comes up.

> **This copy has no `node_modules`.** Step 2 installs them.

---

## 0. What you need

| | Needed for | Notes |
|---|---|---|
| **Node.js ≥ 18** | the control server | **required** — see the version warning below |
| **Arduino IDE** or **PlatformIO** | flashing the three NodeMCUs | only stock ESP8266-core libraries are used |
| **mkcert** | phone mic + camera on `/face` | `brew install mkcert` |
| **Python 3 + faster-whisper** | the 🎤 Speak button | optional — everything else works without it |
| **Ollama** | the face's conversation replies | optional — falls back to a canned line |

### ⚠️ Node version

`backend/package.json` requires `>=18`. If your shell's default `node` is older,
`npm start` fails. Check and switch:

```bash
node -v                 # must print v18 or newer
nvm use 22              # if you use nvm
```

On the machine this copy was made from, the default `node` was **v14.21.3** and
the server had to be run with nvm's **v22.22.2**. If you hit odd syntax errors
on startup, this is why — it is not a code problem.

---

## 1. Get the code

Copy or unzip the folder anywhere. No build step for the backend or frontend —
the frontend is plain static files served by the backend.

---

## 2. Install dependencies

```bash
cd backend
npm install
```

Two runtime dependencies only: `express` and `ws`.

---

## 3. Check `config/setup.json`

The single source of truth for wiring, home angles and direction — both the
backend and the UI read it. Before first run, confirm the `joints` entries match
how you actually wired the servos (`node`, `channel`, `pin`, `direction`).

The `channel` is what goes over the wire; `pin` is documentation that must agree
with the firmware's pin table. **If you change a pin here, change it in the
sketch too** — nothing cross-checks them at runtime.

Full field-by-field explanation: `README.md` §5.

---

## 4. Flash the firmware

Board: **NodeMCU 1.0 (ESP-12E Module)**. Nothing to install — the sketches use
only `ESP8266WiFi`, `ESP8266WebServer`, `ESP8266HTTPClient`, `WiFiUdp`,
`DNSServer`, `EEPROM` and `Servo`.

| Sketch | Flash to | Edit first |
|---|---|---|
| `firmware/hand_node/hand_node.ino` | both arm boards | `#define ROLE` (line 47) — `ROLE_RIGHT_HAND` for one, `ROLE_LEFT_HAND` for the other |
| `firmware/drive_node/drive_node.ino` | base board | nothing (optionally `INVERT_LEFT` / `INVERT_RIGHT`) |

One sketch serves both arms. The torso-motor block compiles in only under the
**right**-hand role; the light block only under the **left**-hand role.

### Flashing from the command line (PlatformIO)

The Arduino IDE works fine. If you prefer the CLI, this is the exact route that
was used to flash the left arm:

```bash
mkdir -p leftarm/src && cd leftarm
cat > platformio.ini <<'EOF'
[env:nodemcuv2]
platform = espressif8266
board = nodemcuv2
framework = arduino
monitor_speed = 115200
upload_speed = 115200
EOF
cp ../firmware/hand_node/hand_node.ino src/main.cpp
# edit ROLE in src/main.cpp, then:
pio run --target upload --upload-port /dev/cu.usbserial-XXXX
```

Find your port with `ls /dev/cu.*` — a NodeMCU shows up as `usbserial` or
`wchusbserial`.

> **Keep `upload_speed` at 115200.** At 921600 the upload died partway through
> with `A fatal error occurred: Timed out waiting for packet header` on a CH340
> adapter. 115200 completes in about 23 s and verifies.

> **Confirm which physical board is on the USB port before flashing.** Nothing in
> software tells you. Flashing left-hand firmware onto the right-hand board drives
> D3/D4 as servo and light lines when they are wired to the L298N torso motor.

### Left shoulder X is on D0

`left_shoulder_x` uses **D0 (GPIO16)**, not D1 — in both `config/setup.json` and
the left-hand `SERVO_PIN[]` array. GPIO16 is the odd pin on the ESP8266: it sits
in the RTC domain with no PWM or interrupt of its own. Recent ESP8266 cores drive
it from the waveform generator that `Servo` uses, so it works, but:

- If that one joint is dead while the other five move, this is the cause — an
  ESP8266-core version issue, not your wiring.
- D0 is pulled high at boot on most NodeMCU boards, so expect a twitch in the
  ~50 ms before `setup()` runs.
- D0 tied to RST for deep-sleep conflicts with using it as a servo line.

---

## 5. Get each node onto your WiFi

Every node does this the same way, and falls back to its own access point if the
network disappears.

1. Power up with no stored WiFi → the node opens an AP:
   `HUMANOID-RIGHT` / `HUMANOID-LEFT` / `HUMANOID-DRIVE`, password `12345678`.
2. Join that AP and open `http://192.168.4.1` — it is a captive portal, so it
   usually pops up on its own.
3. Fill in the form: pick your WiFi, type the password, and enter **this
   laptop's IP and ports** (shown top-left in the control UI) — UDP `4211`,
   HTTP `3000`.
4. The node reboots, joins, and POSTs its IP to `/api/register`. It shows up in
   the **Nodes** tab within a second or two.
5. From then on it heartbeats every 2 s. If WiFi drops for more than 15 s it
   returns to AP mode.

The backend also broadcasts its own address every 3 s, so a changed DHCP lease
fixes itself without touching the portal.

**All three boards and the laptop must be on the same LAN.** See §9.

---

## 6. Start the server

```bash
cd backend
npm start
```

It prints the URLs it is serving. Open the `:3000` one — the same URL works from
a tablet or phone on the same WiFi.

```
simulator UI : http://192.168.0.104:3000
robot face   : https://192.168.0.104:3443/face
phone cert   : http://192.168.0.104:3000/rootCA.pem
```

Verify the nodes came up:

```bash
curl -s http://127.0.0.1:3000/api/devices
```

Each board should read `"online": true`. A freshly booted board is recognisable
by its low `uptime`.

### Without any hardware

```bash
node tools/sim-node.js          # fakes all three NodeMCUs
node tools/sim-node.js drive    # or just one
```

The fake nodes register exactly like the firmware and print every angle they get.

---

## 7. Certificates — the phone face

**This step is only for `/face` on a phone.** The control UI on `:3000` needs
none of it.

### Why it is needed

Phone browsers hand out the **microphone and camera only in a secure context**.
A LAN address over plain `http://` is not one, so `http://<laptop-ip>:3000/face`
loads and blinks at you but has no mic and no camera. Only `localhost` is exempt,
and your phone is not localhost.

So the server brings up a **second listener on `:3443` over TLS** whenever
`certs/` holds a key pair. Plain HTTP on `:3000` is untouched — the ESP8266
boards register over it and have no TLS stack worth speaking of.

### On the laptop, once

```bash
brew install mkcert     # if you don't have it
cd backend
npm run cert            # mints certs/ for every IP this laptop currently has
npm start               # restart so it picks them up
```

`npm run cert` runs `tools/make-cert.sh`, which:

- finds every non-loopback IPv4 address this machine answers on,
- mints `certs/lan-cert.pem` + `certs/lan-key.pem` for all of them, plus
  `localhost` / `127.0.0.1`, signed by your local mkcert CA,
- copies the CA's **public** half to `certs/rootCA.pem` for the phone.

The CA's private key never leaves mkcert's own directory.

### On the phone, once

1. Open `http://<laptop-ip>:3000/rootCA.pem` and install the file it downloads.

   **Android:** *Settings → Security → More security settings → Encryption &
   credentials → Install a certificate → CA certificate*. Android warns that the
   network may be monitored — that is the standard wording for any private CA.

   **iOS:** install the profile, then *Settings → General → About → Certificate
   Trust Settings* and switch it on. iOS will not trust it until you do this
   second step.

2. Open `https://<laptop-ip>:3443/face` and tap to wake.

### Re-run the cert when the laptop's IP changes

The certificate is pinned to the addresses baked in at creation time. A moved
laptop, a new DHCP lease or a different WiFi means a name mismatch and a blocked
mic. Re-run `npm run cert` and restart the server.

**The root CA on the phone stays valid** — you only reinstall that if you ever
regenerate the CA itself.

### Certificates are secrets

`certs/lan-key.pem` is a private key. If you pass this folder to anyone else,
delete `certs/` first and let them run `npm run cert` on their own machine.

---

## 8. Voice and conversation (optional)

Both are optional. The Actions tab shows a live status dot for each, and if
speech-to-text is down the *Type a command* box takes the same path minus the mic.

```bash
cd backend
npm run stt      # leave running in its own terminal
npm start
```

`npm run stt` loads the model once and holds it warm — `base.en` takes about 18 s
to load, so doing it per button press would put seconds of dead air after every
command.

| Variable | Default | |
|---|---|---|
| `STT_MODEL` | `base.en` | `tiny.en` faster, `small.en` more accurate |
| `STT_PORT` | `8123` | |
| `OLLAMA_MODEL` | `qwen2.5:1.5b` | any model you have pulled |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | |

The model never invents joint angles — it picks one id from the fixed list in
`config/actions.json`, which is why every voice-reachable gesture is also a
button on the Actions tab.

If Ollama is unreachable the face never fails; it speaks a fallback line. Check
`"source": "ollama"` vs `"source": "fallback"` in the response.

---

## 9. Troubleshooting the setup

**`announce failed: send ENETUNREACH` or `EADDRNOTAVAIL`, nodes go offline.**
The laptop left the network the nodes are on. Check with `ipconfig getifaddr en0`
that the laptop's subnet still matches the node IPs from `/api/devices`. Get back
on the robot's WiFi and restart the server. If the laptop's IP changed, re-run
`npm run cert` too (§7).

**A node never appears in the Nodes tab.** It is not on your WiFi. Look for its
`HUMANOID-*` access point and redo §5. Confirm the laptop IP and ports you typed
into the portal match what the server prints.

**Mic or camera missing on `/face`.** You are on `http://…:3000/face` instead of
`https://…:3443/face`, or the CA is not installed and trusted on the phone (on
iOS, the Certificate Trust Settings step is easy to miss), or the cert predates
the laptop's current IP. See §7.

**Upload times out partway through.** Drop `upload_speed` to 115200. See §4.

**One joint dead, the rest fine.** If it is L Shoulder X, see the D0/GPIO16 note
in §4.

More in `README.md` §11.
