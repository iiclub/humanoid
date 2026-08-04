# Humanoid Control

Local-network control stack for a humanoid robot with **two 5-DOF arms**, a **pan/tilt head**, a **differential-drive base**, and one **reversible aux motor**, built on three NodeMCU (ESP8266) boards.

```
┌──────────────┐   HTTP + WebSocket    ┌──────────────┐        UDP 4210        ┌─────────────────┐
│  Browser UI  │◄─────────────────────►│ Node backend │───────────────────────►│  right_hand     │  5 servos + 1 motor
│  3D + stick  │   (laptop or tablet)  │   :3000      │◄───────────────────────│  left_hand      │  7 servos
│  simulator   │                       │              │      UDP 4211 (beat)   │  drive          │  4 motors
└──────────────┘                       └──────────────┘                        └─────────────────┘
```

The browser page is the simulator **and** the control panel: whatever you move on screen is what gets sent to the servos.

---

## 1. Quick start

```bash
cd backend
npm install
npm start
```

Open the URL it prints — e.g. `http://192.168.1.20:3000`. **The same URL works from a tablet or phone on the same WiFi**; the layout stacks and every control is touch-sized.

### Try it without hardware

In a second terminal:

```bash
node tools/sim-node.js          # fakes all three NodeMCUs
node tools/sim-node.js drive    # or just one
```

The fake nodes register exactly like the firmware does and print every angle they receive:

```
[right_hand] registered with 127.0.0.1:3000
[right_hand] servo  D1=36°  D2=153°  D3=126°  D4=90°  D5=108°
[right_hand] motor  CLOCKWISE D7=HIGH D8=LOW
[drive]      drive  L=-800 R=800
```

---

## 2. Wiring

Servo signal wires go to the pins below. **Servos must have their own 5–6 V supply** — the NodeMCU's 3V3 rail cannot drive even one. Tie the supply ground to the NodeMCU ground.

### Right-hand NodeMCU — `right_hand`

| Joint | Axis | Pin | GPIO | Channel |
|---|---|---|---|---|
| Shoulder X | front/back swing | **D1** | 5 | 0 |
| Shoulder Y | side lift | **D2** | 4 | 1 |
| Elbow | bend | **D3** | 0 | 2 |
| Wrist | rotation in Z | **D4** | 2 | 3 |
| Gripper | open/close | **D5** | 14 | 4 |

It also carries the **aux motor** — one reversible DC motor on an L298N, driven by
direction alone (no PWM), so it runs at full supply voltage or not at all:

| L298N input | Pin | GPIO | Effect when HIGH |
|---|---|---|---|
| IN1 | **D7** | 13 | clockwise — the **Up** button |
| IN2 | **D8** | 15 | anticlockwise — the **Down** button |

Both LOW = stopped. The firmware never drives both HIGH, so the bridge cannot
shoot through. Leave the ENA jumper on — enable stays high and direction alone
decides everything. Motor power comes from the L298N's own supply; only the
ground is shared with the NodeMCU.

> **D8 is GPIO15**, a strapping pin: it must read low at power-up or the board will not boot. `motorSetup()` runs first thing in `setup()` to park both inputs low, but if the L298N pulls D8 up on its own the board will boot-loop before that code ever runs. Fix with a 10 kΩ pull-down on D8, or move IN2 to another free pin in both `hand_node.ino` and `config/setup.json`.

### Left-hand NodeMCU — `left_hand` (also carries the head)

| Joint | Axis | Pin | GPIO | Channel |
|---|---|---|---|---|
| Shoulder X | front/back swing | **D1** | 5 | 0 |
| Shoulder Y | side lift | **D2** | 4 | 1 |
| Elbow | bend | **D3** | 0 | 2 |
| Wrist | rotation in Z | **D4** | 2 | 3 |
| Gripper | open/close | **D7** | 13 | 4 |
| Head pan | X | **D5** | 14 | 5 |
| Head tilt | Y | **D6** | 12 | 6 |

### Drive NodeMCU — `drive` (pin map unchanged from the original RobotCar sketch)

| Wheel | RPWM | LPWM |
|---|---|---|
| Left front | **D0** | **D1** |
| Left rear | **D2** | **D3** |
| Right front | **D4** | **D5** |
| Right rear | **D6** | **D7** |

> **Boot-pin caveat (ESP8266, applies to both sketches):** D3 (GPIO0), D4 (GPIO2) and D8 (GPIO15) are strapping pins. If a servo or driver pulls them the wrong way at power-up the board will not boot. If you get boot loops, power the servo supply *after* the NodeMCU, or add a 1 kΩ series resistor on those signal lines.

---

## 3. Flashing the firmware

Arduino IDE → Board: *NodeMCU 1.0 (ESP-12E Module)*. Only stock ESP8266-core libraries are used (`ESP8266WiFi`, `ESP8266WebServer`, `ESP8266HTTPClient`, `WiFiUdp`, `DNSServer`, `EEPROM`, `Servo`) — nothing to install.

| Sketch | Flash to | Edit before flashing |
|---|---|---|
| `firmware/hand_node/hand_node.ino` | both arm boards | `#define ROLE ROLE_RIGHT_HAND` → `ROLE_LEFT_HAND` for the second board. The aux motor block (`MOTOR_CW_PIN` / `MOTOR_CCW_PIN` / `MOTOR_INVERT`) is compiled in only under the right-hand role. |
| `firmware/drive_node/drive_node.ino` | base board | nothing (optionally `INVERT_LEFT` / `INVERT_RIGHT`) |

## 4. Getting a node onto your WiFi

Every node follows the same lifecycle, and **falls back to the access point on its own if the network disappears**:

1. **Power up with no stored WiFi** → the node opens an access point:
   `HUMANOID-RIGHT` / `HUMANOID-LEFT` / `HUMANOID-DRIVE`, password `12345678`.
2. **Join that AP** from your phone or laptop and open `http://192.168.4.1` (it is a captive portal, so it usually pops up by itself).
3. **Fill in the form**: pick your WiFi from the scanned list, type the password, and enter **this laptop's IP and ports** (shown at the top-left of the control UI, e.g. `192.168.1.20`, UDP `4211`, HTTP `3000`).
4. The node reboots, joins your WiFi, and **POSTs its own IP** to `http://<laptop>:3000/api/register`. It appears in the **Nodes** tab within a second or two.
5. From then on it sends a heartbeat every 2 s and takes UDP commands. **If the WiFi drops for more than 15 s it returns to access-point mode** and you can reconfigure it.

The backend also **broadcasts its own address** every 3 s (`SRV|ip=…|port=…`). If your laptop's DHCP lease changes, the nodes pick up the new address and re-register without you touching the portal.

The drive node additionally keeps a **manual page** at `/drive` (the original touch buttons) — useful when the laptop is not around.

---

## 5. `config/setup.json` — the calibration file

This is the single source of truth for wiring, direction and home angles. Both the backend and the UI read it.

```jsonc
{
  "id": "right_elbow",
  "node": "right_hand",   // which NodeMCU
  "channel": 2,           // servo index in that board's firmware pin table
  "pin": "D3",            // documentation / shown in the UI
  "min": 0, "max": 180,
  "initial": 0,           // HOME angle — must be 0 or 180
  "direction": 1,         // 1 = as wired, -1 = mirrored servo
  "trim": 0,              // degrees of horn-spline correction
  "speed": 150,           // deg/sec slew limit applied in the firmware
  "vizRange": [0, 135]    // only affects the 3D drawing
}
```

### How `initial` and `direction` work

The UI never speaks raw degrees. It speaks **travel, 0 → 100 %**:

* `travel = 0` → the joint sits at `initial`
* `travel = 100` → the joint has moved all the way to the other end

So a joint with `initial: 0` runs **0 → 180**, and one with `initial: 180` runs **180 → 0** — exactly the "start from where it is declared and move the other way" behaviour you asked for.

`direction: -1` then mirrors the final angle around the midpoint. That is what makes the **left arm mirror the right one** without a second set of poses: both arms use the same travel numbers, and the left board receives `180 − angle`.

Worked example, left elbow (`initial: 0`, `direction: -1`):

| travel | before direction | sent to servo |
|---|---|---|
| 0 % | 0° | **180°** |
| 50 % | 90° | **90°** |
| 100 % | 180° | **0°** |

You can flip `direction`, flip `initial`, and nudge `trim` **live** from the **Setup** tab — each change is written straight back to `config/setup.json` and re-applied to the servo.

The firmware's `SERVO_HOME[]` arrays are just these same values pre-resolved, so the arms power up in the declared pose. The backend also re-sends the full pose whenever a node registers, so a rebooted board catches up automatically.

### The `motor` block

The aux motor lives in its own top-level section, not in `joints` — it has no
angle to speak of, only a direction:

```jsonc
"motor": {
  "id": "aux_motor",
  "label": "Aux Motor (Right Hand)",
  "node": "right_hand",   // which NodeMCU — its firmware must define the same two pins
  "driver": "l298n",      // direction pins only, no PWM, so there is no speed control
  "pinCw": "D7",          // IN1: HIGH turns clockwise. The "Up" button.
  "pinCcw": "D8",         // IN2: HIGH turns anticlockwise. The "Down" button.
  "invert": false,        // true swaps the two without rewiring
  "failsafeMs": 600       // firmware stops if no command arrives inside this window
}
```

`invert` is the software equivalent of swapping the two motor leads: it flips
what goes on the wire while the UI readout and recordings keep saying what you
actually pressed. Startup validation rejects a missing or duplicated pin, an
unknown node, or a pin already claimed by a servo on the same board. Delete the
whole block and the **Motor** tab disappears from the UI on its own.

---

## 6. Using the UI

| Tab | What it does |
|---|---|
| **Arms** | One slider per joint, showing live travel % **and the exact servo angle being sent**. Quick buttons for home / 25 / 50 / 75 / end. Preset poses (wave, T-pose, reach, hands up). "Mirror right → left" drives both arms from the right-hand sliders. |
| **Head** | Drag pad — X pans, Y tilts (both on the left board, D5/D6). Also drives the **eyes** on the phone face and runs the **wake sequence** — see §7.7. |
| **Drive** | Hold-to-drive arrow pad (▲ ◀ ■ ▶ ▼), speed slider, and an analog thumb-stick that mixes into a differential pair. Keyboard: `W A S D` / arrows, space = stop. |
| **Motor** | Two hold-to-run push buttons for the aux motor: **▲ Up** turns it clockwise, **▼ Down** anticlockwise, releasing either one stops it. See §6.2. |
| **Record** | Live record & play — capture everything you do and replay it, on loop. See §6.1. |
| **Nodes** | Every board's IP, RSSI, packet counts and last-seen time. Manual IP entry, pose re-send, server-IP broadcast, plus a live packet log. |
| **Setup** | Live calibration: direction, initial, trim per joint. Download the resulting `setup.json`. |

* **3D view** — drag to orbit, pinch/wheel to zoom, auto-rotate toggle. The wheels spin when the base is driving and the head has a gaze ray so pan/tilt reads instantly.
* **Schematic** — stick figure with a circle at every joint, each labelled with **its NodeMCU pin and the angle currently being sent**, tinted by which board owns it. It doubles as the wiring diagram.
* **E-STOP** (top right) stops the base and blocks all further motion until you press it again.

Everything is rendered with plain canvas — **no CDN, no internet needed** on the robot's network.

### 6.1 Record & play

The **Record** tab is a live teach-and-repeat recorder:

1. Press **● Record**. A red **REC** badge appears in the top bar (visible from every tab).
2. Move anything — arm sliders, the head pad, preset poses, the drive D-pad or thumb-stick, from this page or from a tablet. Every command is captured with its exact timing.
3. Press **■ Stop**, then **► Play** to replay it. Tick **Loop** to repeat forever.
4. **Save** the take with a name; it persists to `config/recordings.json`. Saved routines list under the transport with **Load**, **► Loop**, and delete.

Key points:

* **Recording happens on the server**, so it captures commands from *any* connected client, and **playback keeps running even if you close the browser tab**.
* Playback re-drives the base at 4 Hz while a movement frame is active, so the drive node's 600 ms failsafe doesn't stop it mid-replay.
* **E-STOP** overrides playback instantly — the base is zeroed and joints are blocked until you release it.
* At each loop boundary the base is stopped and there's a short pause, so a looped routine resets cleanly.

REST equivalents: `POST /api/record/start|stop|clear|play|stopplay|save|load`, `DELETE /api/record/:name`, `GET /api/record`. Over WebSocket: `{type:'record', action:'start'|'stop'|'play'|…, loop, name}`.

### 6.2 The aux motor buttons

The **Motor** tab is two push buttons and nothing else, because an L298N driven
by direction alone has nothing else to offer:

| Button | Sends | On the board |
|---|---|---|
| **▲ Up** | `dir: +1` | IN1 (`D7`) HIGH, IN2 (`D8`) LOW — clockwise |
| **▼ Down** | `dir: −1` | IN1 LOW, IN2 HIGH — anticlockwise |
| *release* | `dir: 0` | both LOW — stopped |

**Hold to run, release to stop**, the same rule as the drive pad, with three
layers of stop underneath it:

* While a button is held the browser repeats the command every **250 ms**; the
  firmware stops the motor by itself if nothing arrives for **600 ms**, so a
  closed tab, a dropped packet or a dead WiFi link parks it.
* Releasing the button, dragging the pointer off it, or the window losing focus
  all send an explicit stop immediately.
* **E-STOP** zeroes the motor and blocks every further press until you release
  it — the readout says `blocked by E-STOP` while it is armed.

The readout under the buttons shows the live direction *and the pin that is
currently HIGH*, and it follows the **server's** view of the motor — so a press
from a tablet lights the button up on the laptop too. Motor presses are captured
by the recorder like everything else, and playback re-sends them at 4 Hz so a
recorded hold survives the firmware failsafe.

If **Up** turns the motor the wrong way, flip `invert` in the `motor` block of
`config/setup.json` (or `MOTOR_INVERT` in the sketch) rather than rewiring.

---

## 7. The robot face — `/face`

A second, separate page meant for a **phone propped in the robot's head**: two
big blinking eyes that listen to you, answer out loud, and take your photo on
request. It shares the server with the control UI but nothing else — no robot
joints are involved.

```
phone browser  ──HTTPS──►  backend :3443  ──HTTP──►  ollama :11434
  eyes / mic / camera        /api/face/chat            qwen2.5:1.5b
                             /api/face/photo    ──►    captures/
```

### 7.1 It has to be HTTPS

Phone browsers hand out the microphone and camera **only in a secure context**.
`http://192.168.0.107:3000/face` will load and blink at you, but the mic and
camera are simply absent — the page detects this on the tap screen and says so
rather than failing halfway through. Only `localhost` is exempt from the rule,
and your phone is not localhost.

So the server brings up a **second listener on :3443 over TLS** whenever
`certs/` contains a key pair. Plain HTTP on :3000 is untouched — the ESP8266
boards register over it and have no TLS stack worth speaking of.

**One-time setup:**

```bash
cd backend
npm run cert          # mints certs/ for every IP this laptop currently has
npm start
```

Then on the **phone**, once:

1. Open `http://<laptop-ip>:3000/rootCA.pem` and install the file it downloads.
   Android: *Settings → Security → More security settings → Encryption &
   credentials → Install a certificate → CA certificate*. Android will warn that
   the network may be monitored; that is the expected wording for any private CA.
2. Open `https://<laptop-ip>:3443/face` and tap to wake.

> **Re-run `npm run cert` whenever the laptop's IP changes.** The certificate is
> pinned to the addresses baked in at creation time, and a moved laptop means a
> name mismatch and a blocked mic. The root CA on the phone stays valid — you
> only reinstall that if you ever regenerate the CA itself.

### 7.2 Nothing on screen but eyes

The page has **no text anywhere** — no title screen, no labels, no captions. It
loads straight into the face, asleep with its eyes shut, breathing slowly. Two
tiny unlabelled dots sit at the bottom:

| Dot | Asleep | Awake |
|---|---|---|
| **Left** (hollow) | Wake — opens the eyes, goes fullscreen, starts listening | Mute / unmute. Muted closes the eyes, so "not listening" is visible without a word of text |
| **Right** (filled centre) | Take a photo — wakes first, then shoots | Take a photo |

> The wake dot cannot be designed away. No browser will start audio, a
> microphone or fullscreen without a genuine tap, so *something* has to be
> tapped once per page load. It is made as small as it can be while staying
> reliably tappable, at 15 px.

Waking also takes a **screen wake lock** and requests fullscreen and a portrait
orientation lock. All three are best-effort — refused, the page still works, it
just shows the browser chrome or lets the screen dim.

Two gestures, anywhere on the face:

| Gesture | Does |
|---|---|
| **Long-press** (600 ms) | Take a photo — same as the right dot |
| **Double-tap** | Show / hide the status overlay (what it heard, what it replied) |

Since there is no text to report a failure, **the wake dot turns red and pulses**
if the microphone or camera is unavailable, and the status overlay opens by
itself with the reason.

Voice commands beyond questions: *"take my picture"* and friends, *"stop
listening"* / *"go to sleep"* to mute, *"start listening"* to unmute.

### 7.3 How the eyes are built

Flat glowing circles do not read as eyes. Each one is layered:

| Layer | Why |
|---|---|
| `.eye` | The **aperture** — an ellipse wider than tall, `overflow: hidden` |
| `.ball` | The eyeball, *larger than the aperture*, so gaze can move without ever showing an edge |
| `.iris` | Radial base colour, a **limbal ring** (the dark rim — without it an iris reads as a printed dot), and `.fibers`, a masked `repeating-conic-gradient` giving radial striations |
| `.pupil` | Dilates with state |
| `.hi` ×2 | Two speculars. One highlight reads as plastic; two read as wet |
| `.shade` | The shadow an upper lid casts on the eyeball — the single biggest reason CSS eyes look flat |
| `.lid` ×2 | Real lids that **slide to meet in the middle**, rather than squashing the whole eye, which no eye does |

Motion detail that does the heavy lifting:

* **Blinks are asymmetric** — 80 ms shut, 140 ms open. A symmetric blink reads as a camera shutter.
* **Gaze moves in saccades**, not glides: fixate, then jump. Small drifts are common, large ones rare, and a large jump often comes with a blink — which is what a real gaze does crossing a wide angle.
* **Fixations shorten when busy** and lengthen when idle.
* Listening *dilates* the pupils, thinking *contracts* them and brings the lids halfway down, speaking gives a small pupil flutter, an error turns the iris red.

### 7.4 Talking and listening

| | |
|---|---|
| **Ears** | `webkitSpeechRecognition`, restarted automatically after every utterance |
| **Voice** | `speechSynthesis`, pitched down slightly |
| **Brain** | Ollama `qwen2.5:1.5b` with a dry, sarcastic system prompt, capped at two short sentences because every reply gets read aloud |
| **Camera** | The eyes give way to a live viewfinder, a spoken 3-2-1, a white flash, a moment to see the shot, then back to the eyes |

**Not interviewing itself** takes three separate guards, because an open mic
will happily transcribe the robot's own voice and answer it — the loop closes
within about three rounds:

1. The recogniser is **stopped for the whole time it is speaking**.
2. Speech end is detected by **polling `speechSynthesis.speaking`**, not by a
   timer sized from the text length. `onend` fires early, late or never on
   Chrome for Android, and a too-short estimate re-opened the mic mid-sentence.
3. A **350 ms settle** after that, then an **echo filter**: a transcript that is
   a substring of what was just said, or shares 60 % of its words, is dropped
   silently.

Photos land in `captures/` as `face_<timestamp>.jpg`, outside `frontend/` so
they are never served to the network. The preview is mirrored so framing works
like a mirror; the saved file is not, because mirrored text reads backwards.

### 7.5 If Ollama is not running

The chat endpoint **never fails** — a silent robot reads as a crash to whoever
is standing in front of it. When Ollama is unreachable or takes longer than
20 s, it speaks the fallback line instead:

> *"I am just born, let me first learn who that is."*

Check which one you got in the response: `"source": "ollama"` or
`"source": "fallback"`.

Overridable by environment variable: `OLLAMA_HOST`, `OLLAMA_PORT`,
`OLLAMA_MODEL`, `OLLAMA_TIMEOUT_MS`, `HTTPS_PORT`.

### 7.6 Known limits

* **Speech recognition needs internet.** Chrome streams the audio to Google's
  servers. A LAN with no uplink means no STT, however good the WiFi is.
* **Android Chrome only**, as built. iOS Safari needs the CA additionally
  trusted under *Settings → General → About → Certificate Trust Settings*, and
  its speech recognition is considerably less reliable.
* `qwen2.5:1.5b` is a small model — fast, but simple. Change `OLLAMA_MODEL` if
  you pull a bigger one.
* Continuous listening plus text-to-speech can still loop on itself in a noisy
  room, despite the mic being muted during playback.

### 7.7 Driving the eyes from the control UI

The eyes are drawn on the phone, but they are controlled from the **Head** tab
of the ordinary control UI. Nothing here touches a servo: the browser sends
display state to the server, the server holds it and mirrors it to every
connected client, and the phone — which keeps its own WebSocket open and
reconnects every 4 s — applies it. That indirection is what lets a laptop move
eyes being rendered on a different device.

| Control | Does |
|---|---|
| **Far left / Left / Centre / Right / Far right** | Aim the gaze. The active one stays lit |
| **↔ Swing** | Sine sweep side to side — it decelerates at the ends, so it reads as looking rather than as a metronome |
| **Close eyes / Open eyes** | The lids, at the current speed |
| **Idle wander** | Hands the gaze back to its own random saccades |
| **Blinking** | Toggles the idle blink loop. Off holds the lids perfectly still — an unblinking stare |
| **Eye speed** (1–100) | Drives the swing rate, the aim glide *and* the lid timing |

Aiming or swinging automatically cancels idle wander, so the random walk cannot
fight the panel for the same transform.

**Speed 1 is genuinely slow** — a 4-second lid fall and a 14-second swing, which
is what it takes to read as a machine powering down rather than as a blink. Only
the slow end was stretched; 100 still snaps the lids shut in 70 ms.

| Speed | Lids | Swing | Aim |
|---|---|---|---|
| 1 | 4.0 s | 14 s | 3.5 s |
| 50 | 2.1 s | 7.4 s | 1.8 s |
| 100 | 70 ms | 0.7 s | 90 ms |

> How far the eyes can travel is capped by how much bigger the eyeball is than
> the aperture it shows through — see the `.ball` note in `face.css`. Enlarge the
> eyes without enlarging that margin and the sweep silently shrinks to a few
> percent of the eye's width: real movement, too small to see.

### 7.8 The wake sequence

One button in the Head tab, and the only motion in this project that spans two
subsystems: it walks the head servo on **D6** from **0° to 70°**, and as it
passes the halfway point the eyes begin to open. The overlap is the whole point
— lids lifting while the head is still moving reads as waking up, and two
separate button presses could never be timed that closely by hand.

* Duration is adjustable from 2 to 90 s (the API accepts up to 3 minutes).
* The lids are given **exactly the time the head has left**, so both arrive
  together whatever duration you pick. A fixed lid duration would either beat
  the head or lag behind it.
* The trigger angle defaults to the **midpoint of whatever range it is given**,
  not a fixed number. A hardcoded angle silently never fires if it falls outside
  the endpoints, and the eyes would then only snap open at the very end.
* It runs **on the server** (`backend/src/sequence.js`), so closing the browser
  tab cannot abandon the robot mid-motion and the timing does not depend on a
  phone's animation frames.
* **E-STOP halts it immediately**, and starting a new run supersedes any in
  flight.

Note that it sets the eye speed to 1 as it goes, so the lids stay slow
afterwards until you move the slider back up.

---

## 8. Protocol reference

### HTTP (`/api`)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/register` | A node reports `{id, ip, mac, rssi, fw}` after joining WiFi |
| `GET` | `/devices` | Registry: IPs, online state, RSSI, counters |
| `POST` | `/devices/:id/ip` | Pin an IP by hand |
| `POST` | `/devices/:id/resync` | Re-send the whole pose to one board |
| `POST` | `/announce` | Broadcast the server address immediately |
| `GET` | `/state` | Pose, drive state, devices |
| `GET`/`PUT` | `/setup` | Read / replace `setup.json` |
| `PATCH` | `/setup/joints/:id` | Live-tune `direction`, `initial`, `trim`, limits |
| `POST` | `/joint` | `{id, travel}` or `{id, angle}` |
| `POST` | `/pose` | `{name}` for a preset, or `{pose: {id: travel}}` |
| `POST` | `/home` | Everything back to its declared initial angle |
| `POST` | `/drive` | `{cmd, speed}` \| `{left, right}` \| `{x, y, scale}` |
| `POST` | `/motor` | Aux motor: `{cmd: 'up'\|'down'\|'stop'}` or `{dir: 1\|-1\|0}` |
| `POST` | `/eyes` | Phone-face eyes, any subset of `{look, swing, lids, speed, blink, auto}` |
| `POST` | `/sequence/wake` | Run the head+eyes wake sequence; body may set `fromDeg` / `toDeg` / `openAtDeg` / `durationMs` |
| `POST` | `/sequence/stop` | Halt a running sequence |
| `GET` | `/sequence` | What is running, if anything |
| `POST` | `/estop` | `{on: true/false}` |
| `POST` | `/record/start` `/stop` `/clear` | Begin / end / discard a live take |
| `POST` | `/record/play` | `{loop}` — replay the current take |
| `POST` | `/record/stopplay` | Stop playback |
| `POST` | `/record/save` `/load` | `{name}` — persist / restore a routine |
| `DELETE` | `/record/:name` | Delete a saved routine |
| `GET` | `/record` | Recorder status + saved list |

### The face route (`/api/face`)

Mounted separately from `/api`, with a 12 MB body limit — a captured JPEG will
not fit inside the 512 kB that is ample for every robot command.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/chat` | `{text}` → `{reply, source}` — proxies to Ollama, falls back to the newborn line |
| `POST` | `/photo` | `{image}` base64 data URL → saved under `captures/` |
| `POST` | `/log` | `{level, msg}` — the phone's console, relayed into the server log |
| `GET` | `/status` | Which model, where Ollama is, what the fallback line says |

`/log` exists because the face page runs on a device with no inspector attached
and deliberately shows no text: without it, a wedged state is invisible.

### UDP (ASCII, `|`-separated — trivial to parse on an ESP8266 and to sniff with `nc -ul 4211`)

```
backend → node   S|seq=42|0=90|2=140     set channel 0 → 90°, channel 2 → 140°
backend → node   D|seq=42|l=900|r=-900   differential drive, −1023..1023 per side
backend → node   D|seq=42|stop=1         stop
backend → node   M|seq=42|dir=1          aux motor: +1 clockwise, −1 anticlockwise, 0 stop
backend → node   M|seq=42|dir=0|stop=1   aux motor stop
backend → node   P|seq=42                ping
backend → bcast  SRV|ip=…|port=…|http=…  "the control server lives here"

node → backend   B|id=right_hand|ip=…|rssi=-54|up=123456|fw=1.0.0   heartbeat, 2 s
node → backend   A|id=right_hand|seq=42                              ack
```

Commands for the same board are **coalesced into one datagram** and rate-limited to 25 Hz, so dragging a slider never floods an ESP8266. Stale datagrams are dropped by sequence number.

### Safety behaviour

* Drive node **stops if no command arrives for 600 ms** — a dead WiFi link parks the robot instead of running it into a wall.
* The aux motor uses the **same 600 ms failsafe**, and a malformed `M|` packet stops it rather than guessing a direction. Its two direction pins are never driven HIGH together.
* Drive PWM **ramps** instead of stepping, so a full-speed reversal cannot brown out the regulator.
* Servos are **slew-limited** in firmware to each joint's `speed` (deg/sec).
* Servos are attached with a stagger at boot so the 5 V rail survives the inrush.

---

## 9. Layout

```
humanoid-control/
├── config/
│   ├── setup.json             pins, direction, initial angles, poses, drive + motor config
│   └── recordings.json        saved record/play routines (created on first save)
├── backend/
│   ├── server.js              HTTP + HTTPS + WebSocket + UDP wiring
│   └── src/
│       ├── setup.js           load / validate / save setup.json
│       ├── joints.js          travel ⇄ servo-angle maths
│       ├── state.js           device registry + live pose + eye state
│       ├── udpLink.js         datagram encode/decode, announce, heartbeats
│       ├── controller.js      intents → coalesced, rate-limited packets
│       ├── recorder.js        live record / loop-playback engine
│       ├── sequence.js        scripted motions spanning head + eyes
│       ├── face.js            Ollama proxy, photo store, phone log relay
│       └── api.js             REST routes
├── frontend/
│   ├── index.html  css/styles.css        the control UI
│   ├── face.html   css/face.css          the robot face (phone)
│   ├── face.webmanifest                  Add to Home screen -> true fullscreen
│   └── js/  skeleton.js  view3d.js  stick.js  jointmath.js  app.js  face.js
├── firmware/
│   ├── hand_node/hand_node.ino    both arms + head (set ROLE) + aux motor on the right board
│   └── drive_node/drive_node.ino  differential base
├── certs/                     TLS for /face — GITIGNORED, run `npm run cert`
├── captures/                  photos the robot took — GITIGNORED
└── tools/
    ├── sim-node.js            virtual NodeMCUs for hardware-free testing
    └── make-cert.sh           mints certs/ for every IP this laptop has
```

---

## 10. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Node never appears in **Nodes** | Wrong laptop IP in the portal, or a firewall blocking :3000. Check the node's serial monitor at 115200 baud — it logs `[REG] … -> code`. Use **Broadcast server IP** in the Nodes tab. |
| Node online but a servo does not move | `channel` in `setup.json` must match the pin's position in the firmware's `SERVO_PIN[]` array. The Arms tab shows the channel next to each joint. |
| Joint runs the wrong way | Flip **dir** for that joint in the **Setup** tab. |
| Joint is offset by a few degrees | Adjust **trim** in the **Setup** tab (horn splines are ~7.5° apart, so trim gets you the rest of the way). |
| Board reboots when servos move | Servo supply is too weak or not sharing ground with the NodeMCU. Never power servos from the 3V3 pin. |
| Base drives backwards | Set `INVERT_LEFT` / `INVERT_RIGHT` in `drive_node.ino`. |
| **Motor** tab is missing | There is no `motor` block in `setup.json`, so the UI hides the tab. |
| Aux motor turns the wrong way | Set `"invert": true` in the `motor` block of `setup.json` (restart the backend), or `MOTOR_INVERT = true` in `hand_node.ino`. |
| Aux motor does nothing | The right-hand board must be flashed with `ROLE_RIGHT_HAND` — the motor code is compiled out under the left-hand role. Check the serial monitor: a held button should log nothing, a release should stop cleanly, and `[MOT] failsafe` means commands are not arriving. Also confirm the L298N's ENA jumper is on. |
| Aux motor stutters or stops after ~0.6 s | Commands are not reaching the board fast enough for the 600 ms failsafe. Check RSSI in the **Nodes** tab. |
| Right-hand board won't boot with the L298N attached | D8 (GPIO15) must be low at power-up. Add a 10 kΩ pull-down on D8 or move IN2 to another pin in both `hand_node.ino` and `setup.json`. |
| Base stutters | Normal if commands are dropping — the 600 ms failsafe is doing its job. Check WiFi signal (RSSI in the Nodes tab). |

Tested end to end on this machine with the virtual nodes: registration, pose resync, per-joint commands, preset poses, D-pad drive, thumb-stick vector drive and stop all reach the correct board with the correct angles. The aux motor was checked the same way — **Up** puts `D7` HIGH, **Down** puts `D8` HIGH, release drops both, the 600 ms failsafe fires when commands stop, and E-STOP blocks the buttons entirely.
