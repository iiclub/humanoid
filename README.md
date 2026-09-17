# Humanoid Control

Local-network control stack for a humanoid robot with **two 5-DOF arms**, a **pan/tilt head**, a **differential-drive base**, a **time-limited torso lift** and a **work light**, built on three NodeMCU (ESP8266) boards.

```
┌──────────────┐   HTTP + WebSocket    ┌──────────────┐        UDP 4210        ┌─────────────────┐
│  Browser UI  │◄─────────────────────►│ Node backend │───────────────────────►│  right_hand     │  5 servos + torso
│  3D + stick  │   (laptop or tablet)  │   :3000      │◄───────────────────────│  left_hand      │  6 servos + light
│  simulator   │                       │              │      UDP 4211 (beat)   │  drive          │  4 motors
└──────────────┘                       └──────────────┘                        └─────────────────┘
```

The browser page is the simulator **and** the control panel: whatever you move on screen is what gets sent to the servos.

---

## 1. Quick start

> **Setting this up on a new machine?** See **[SETUP.md](SETUP.md)** — the ordered
> runbook covering Node version, dependencies, flashing, WiFi, and the HTTPS
> certificate setup the phone face needs. This copy ships without `node_modules`.

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
[right_hand] servo  D1=36°  D2=153°  D5=126°  D7=90°  D6=108°
[right_hand] torso  UP         D3=HIGH D4=LOW  D0=HIGH
[left_hand]  light  ON         D3=HIGH  (switched)
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
| Elbow | bend | **D5** | 14 | 2 |
| Wrist | rotation in Z | **D7** | 13 | 3 |
| Gripper | open/close | **D6** | 12 | 4 |

It also carries the **torso lift** — one reversible DC motor on an L298N that
raises and lowers the whole upper body, driven by direction alone (no PWM), so
it runs at full supply voltage or not at all:

| L298N input | Pin | GPIO | Effect when HIGH |
|---|---|---|---|
| IN1 | **D3** | 0 | lifts — the **Torso up** button |
| IN2 | **D4** | 2 | lowers — the **Torso down** button |
| ENA | **D0** | 16 | bridge enable — HIGH only while the motor should turn |

All three LOW = stopped. The firmware never drives both direction pins HIGH, so
the bridge cannot shoot through, and enable is sequenced around them: it drops
*before* the direction pins change on a stop and comes up *after* they are set
on a start, so the driver is never enabled with its inputs mid-flight. Take the
ENA jumper **off** — D0 is the enable now. Motor power comes from the L298N's
own supply; only the ground is shared with the NodeMCU.

> **D3 and D4 are strapping pins with pull-ups**, so both read HIGH for the ~50 ms between power-up and `setup()`. That is safe *for this pair*: on an L298N both inputs high drives both outputs to the same rail, which **brakes** the motor rather than turning it. A single input high would spin, so do not split the pair across a pin that boots low. Nothing may hold D3 low at boot either, or the board drops into flash mode instead of running.

> **D0 is GPIO16.** No PWM and no interrupt on this pin, which is fine for an enable line. Set `#define MOTOR_HAS_EN 0` in the sketch to leave the L298N's ENA jumper fitted instead — direction alone then decides everything.

> **There are no limit switches on this axis.** Travel is bounded by time alone: every run is capped at **4 s** (`MOTOR_MAX_RUN_MS`), and the firmware also stops if no command arrives for 4 s (`MOTOR_FAILSAFE_MS`). See §6.2.

D0 and D8 are the two pins left free on this board.

### Left-hand NodeMCU — `left_hand` (also carries the head and the light)

| Joint | Axis | Pin | GPIO | Channel |
|---|---|---|---|---|
| Shoulder X | front/back swing | **D0** | 16 | 0 |
| Shoulder Y | side lift | **D2** | 4 | 1 |
| Elbow | bend | **D5** | 14 | 2 |
| Wrist | rotation in Z | **D7** | 13 | 3 |
| Gripper | open/close | **D6** | 12 | 4 |
| Head tilt | up/down | **D4** | 2 | 5 |

**The head tilts only — there is no pan servo.** The old head-pan channel is gone
from the firmware, from `setup.json` and from the UI, so the head has one axis
and the schematic draws it with its yaw fixed at zero.

It also carries the **work light**:

| | Pin | GPIO |
|---|---|---|
| Light | **D3** | 0 |

Switched, not dimmed: the sketch drives it as a plain digital output
(`#define LIGHT_PWM 0`), so there is no brightness control. On every power-up the
firmware blinks it **three times** and then leaves it on — that happens before
the WiFi has finished joining, so those blinks are the robot's first sign of
life. Switch to a PWM-capable pin and set `LIGHT_PWM 1` (plus `"pwm": true` in
`config/setup.json`) if you later want real fades; the UI drops its talk of ramps
on its own when `pwm` is false.

> **D3 is GPIO0**, a strapping pin with a pull-up: it reads HIGH until `lightSetup()` runs, so expect a brief flash at power-up just before the blink sequence. Nothing may hold D3 **low** at boot, or the board enters flash mode instead of running your sketch — drive it through a MOSFET/transistor gate rather than anything that clamps the pin down.

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
| `firmware/hand_node/hand_node.ino` | both arm boards | `#define ROLE ROLE_RIGHT_HAND` → `ROLE_LEFT_HAND` for the second board. The torso block (`MOTOR_UP_PIN` / `MOTOR_DOWN_PIN` / `MOTOR_EN_PIN` / `MOTOR_HAS_EN` / `MOTOR_INVERT`) compiles in only under the **right**-hand role; the light block (`LIGHT_PIN` / `LIGHT_PWM`) only under the **left**-hand role. |
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

The torso lift lives in its own top-level section, not in `joints` — it has no
angle to speak of, only a direction:

```jsonc
"motor": {
  "id": "torso_lift",
  "label": "Torso Lift (Right Hand)",
  "node": "right_hand",       // which NodeMCU — its firmware must define the same pins
  "driver": "l298n",          // direction pins only, no PWM, so there is no speed control
  "pinUp": "D3",              // IN1: HIGH lifts. The "Torso up" button.
  "pinDown": "D4",            // IN2: HIGH lowers. The "Torso down" button.
  "pinEn": "D0",              // ENA: HIGH only while the motor should turn
  "invert": false,            // true swaps up and down without rewiring
  "failsafeMs": 4000,         // firmware stops if no command arrives inside this window
  "maxRunMs": 4000,           // hard cap on one continuous run, held button or not
  "autoLowerOnRelease": true  // letting go of "up" drives back down on its own
}
```

`invert` is the software equivalent of swapping the two motor leads: it flips
what goes on the wire while the UI readout and recordings keep saying what you
actually pressed. Startup validation rejects a missing or duplicated pin, an
unknown node, or a pin already claimed by a servo on the same board. Delete the
whole block and the motor half of the tab disappears from the UI on its own.

### The `light` block

```jsonc
"light": {
  "id": "work_light",
  "label": "Light (Left Hand)",
  "node": "left_hand",
  "pin": "D3",          // switched output — no brightness control
  "pwm": false,         // must match LIGHT_PWM in the sketch
  "startOn": true,      // what the server assumes after the board's power-on sequence
  "bootBlinks": 3,      // firmware constants, repeated here so the UI can describe them
  "bootFadeMs": 2500,
  "fadeMs": 600
}
```

The firmware owns the animation — these numbers are its constants written down
where the browser can read them, not settings the backend enforces. Change a
timing and you change it in `hand_node.ino` too.

`startOn` matters on reconnect: a board that reboots runs its own power-on
sequence and comes back with the light **lit**, so the server seeds its state to
match. Whatever the UI last asked for is then pushed back to the board a moment
after it registers, which is what stops a light you deliberately switched off
from turning itself back on after a brownout.

---

## 6. Using the UI

| Tab | What it does |
|---|---|
| **Actions** | Every named gesture as a button, a *type a command* box that shares the mic's intent path, and live status for the two local voice services. See §8. |
| **Dance** | Choreography from `config/dances.json`. **🎤 Live** hands the robot to whatever is playing in the room (§8.2). Ships with the FA9LA / *Rehman Dakait* entry; **⬇ Import** an `.mp3` and the robot choreographs it from the audio — name it, trim it, Create — or import a `.json` you wrote. Each button plays its bit of the track and dances to it. DJ mode for the phone face, tap tempo, **⛶ Full screen** for a phone. See §8.1. |
| **Arms** | One slider per joint, showing live travel % **and the exact servo angle being sent**. Quick buttons for home / 25 / 50 / 75 / end. Preset poses (wave, T-pose, reach, hands up). "Mirror right → left" drives both arms from the right-hand sliders. |
| **Head** | Tilt slider — up/down only, one servo on the left board (D4). There is no pan axis. Also drives the **eyes** on the phone face and runs the **wake sequence** — see §7.7. |
| **Drive** | Hold-to-drive arrow pad (▲ ◀ ■ ▶ ▼), speed slider, and an analog thumb-stick that mixes into a differential pair. Keyboard: `W A S D` / arrows, space = stop. |
| **Torso & Light** | Two hold-to-run buttons for the torso lift — **▲ Torso up** lifts while held and lowers again on release, **▼ Torso down** lowers while held and stops on release — plus **☀ on** / **☾ off** for the work light and a **↻ Replay start-up** button. See §6.2. |
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

### 6.2 The torso buttons

An L298N driven by direction alone has nothing to offer but a sign, so the torso
half of the tab is two push buttons:

| Button | Sends | On the board |
|---|---|---|
| **▲ Torso up** | `dir: +1` | IN1 (`D3`) HIGH, IN2 (`D4`) LOW, ENA (`D0`) HIGH — lifting |
| **▼ Torso down** | `dir: −1` | IN1 LOW, IN2 HIGH, ENA HIGH — lowering |
| *stop* | `dir: 0` | all three LOW |

The two are deliberately **not** symmetric:

* **▲ Torso up** lifts while you hold it, and the moment you let go it drives
  back **down** on its own until the run cap stops it. Nothing else has to be
  pressed to bring the torso back.
* **▼ Torso down** is the plain manual version: it lowers while held and stops
  on release.

#### The 4-second rule

There are no limit switches on this axis, so **time is the only thing keeping
the motor off its end stops**. Two independent limits enforce it, and whichever
bites first wins:

| | Window | What it catches |
|---|---|---|
| `MOTOR_FAILSAFE_MS` | 4 s of silence | a closed tab, a dropped packet, a dead WiFi link |
| `MOTOR_MAX_RUN_MS` | 4 s of continuous running | a button held down, however healthy the link |

Both live in the **firmware**, so they hold even if the laptop is switched off
mid-press, and even in AP mode where nothing is listening for commands at all.
Once the run cap trips, that direction is **latched out**: repeating the same
command will not restart it. Asking for stop, or for the other direction,
releases the latch — so let go and press again for another 4 s of travel.

The backend keeps its own copy of the cap. That copy protects nothing; it exists
so the readout and the recorder stop claiming the motor is running seconds after
the board has quietly parked it. The readout says
`stopped at the 4 s cap · let go and press again` when it fires.

Layered on top of all that:

* While a button is held the browser repeats the command every **250 ms**.
* Releasing, dragging the pointer off the button, the window losing focus, or
  the tab being hidden all stop it immediately — including a running auto-lower,
  which is dropped rather than continued in a background tab.
* **E-STOP** zeroes the motor and blocks every further press until you release
  it — the readout says `blocked by E-STOP` while it is armed.

The readout follows the **server's** view of the motor, so a press from a tablet
lights the button up on the laptop too. Presses are captured by the recorder
like everything else, and playback re-sends them at 4 Hz.

If **Torso up** drives the wrong way, flip `invert` in the `motor` block of
`config/setup.json` (or `MOTOR_INVERT` in the sketch) rather than rewiring.

### 6.3 The light buttons

| Button | Sends | On the board |
|---|---|---|
| **☀ Light on** | `{cmd:'on'}` | `D8` ramps up to full over 600 ms |
| **☾ Light off** | `{cmd:'off'}` | `D8` ramps down to dark over 600 ms |
| **↻ Replay start-up** | `{cmd:'sequence'}` | three blinks, then the slow 2.5 s ramp to full |

The board runs that start-up sequence **by itself on every power-up** — nothing
needs to be connected for it to happen. It is the first thing `setup()` does
after parking the servos, and it runs non-blocking, so the blinks and the ramp
play out while the radio is still trying to join the WiFi. The light is already
on before the node has registered.

The ESP8266 owns the animation; all that crosses the wire is where the light
should end up. That keeps the fade smooth regardless of what the network is
doing. Unlike the motor there is no failsafe here — a light has no reason to
turn itself off when the link goes quiet.

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

### 7.1a The voice agent is off until you turn it on

Speech recognition and the Ollama chat — the talking-head part of `/face` —
are **off by default**. A robot that starts listening the moment its screen is
tapped answers the room while somebody is still setting it up. The switch is
on the **Head** tab: **🗣 Voice agent: off / on**. It is server state,
broadcast to every client, so a phone that reconnects mid-session comes up in
the right mode.

Off: a tap wakes the page and goes fullscreen, and that is all — the
microphone stays closed, the watchdog does not re-arm the recogniser, and a
"start listening" the phone happens to overhear is ignored. On: tap the eyes
and it listens, as before. 🎤 Live dance takes the microphone either way and
hands it back afterwards. `POST /api/voice-agent { on }` does the same from a
script.

### 7.2a The ⛶ button

One button on an otherwise button-less page, bottom-right. Tapping the eyes
already requests fullscreen, but Chrome for Android grants it only from a user
gesture and can refuse a tap that is also waking the page and asking for the
microphone — so this is an unambiguous request that does nothing else. It
hides itself by CSS the moment fullscreen is actually on (`:root:fullscreen`),
and in an installed PWA where there is no browser chrome to escape. Its
pointer events are swallowed before they reach the stage, or pressing it would
also start the microphone.

### 7.2b The phone lies on its side

The phone is mounted **landscape** in the head, so that is the orientation the
page locks to — both the manifest (`"orientation": "landscape"`) and the tap
handler's `screen.orientation.lock('landscape')`. Everything in `face.css` is
sized in `vmin`, which in landscape is the *height*; left alone that gave eyes
a third of the screen tall with a void between them twice an eye wide. Rather
than re-derive every size for a second axis, the landscape rule centres the
pair with a fixed gap and scales the whole face by 1.7 — bloom, gaze travel,
iris and lids keep their proportions because they scale together. On a 16:9
screen that fills the height to about 56 % with a margin; a 20:9 phone gets
more black at the sides, which is where the head's shell is anyway.

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

---

## 8. Voice control — the 🎤 Speak button

Hold (or click) **🎤 Speak** in the top bar, say what you want, and the robot does
it. Both halves run on your machine:

```
  mic ──► browser MediaRecorder ──► POST /api/voice/transcribe
                                         │
                                         ▼
                            tools/stt-server.py  ·  faster-whisper  :8123
                                         │  "give me a hand shake"
                                         ▼
                              POST /api/voice/command
                                         │
                                         ▼
                                 Ollama  :11434  qwen2.5:1.5b
                                         │  {"action":"handshake"}
                                         ▼
                            config/actions.json ──► servos
```

**Nothing leaves this machine.** No API key, no cloud speech service. After the
first run (which downloads the Whisper weights) it works with the WiFi off —
which is the point, on a robot that lives on a bench with no uplink.

### Starting it

```bash
cd backend
npm run stt      # leave this running in its own terminal
npm start        # the control server, as usual
```

`npm run stt` loads the model **once** and holds it in memory. Loading `base.en`
takes about 18 s; doing that per button press would put five seconds of dead air
between releasing the mic and seeing any text. Held warm, a two-second command
transcribes in well under a second.

The **Actions** tab shows both services with a live status dot. If speech-to-text
is down, everything else still works — including the *Type a command* box, which
takes the same path minus the microphone.

| Variable | Default | |
|---|---|---|
| `STT_MODEL` | `base.en` | `tiny.en` is faster, `small.en` more accurate |
| `STT_PORT` | `8123` | |
| `OLLAMA_MODEL` | `qwen2.5:1.5b` | any model you have pulled |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | |

### What it can do — `config/actions.json`

The model does **not** invent joint angles. It picks one id out of a fixed list
of gestures that were written and tested by hand, which is why anything the
robot will do by voice is also a button on the **Actions** tab. A 1.5B model is
entirely capable of "give me a handshake" → `handshake`; it is not capable of
safe inverse kinematics.

Each action is a list of timed steps in travel % — the same units as the sliders
and the poses in `setup.json`:

```jsonc
{
  "id": "handshake",
  "utterances": ["shake hands", "nice to meet you", "..."],   // hints, not an exhaustive list
  "steps": [
    { "pose": { "right_shoulder_x": 55, "right_elbow": 45, "right_gripper": 100 }, "ms": 1100 },
    { "pose": { "right_gripper": 15 }, "ms": 600 },           // close the grip
    { "repeat": 3, "steps": [                                 // …and shake
      { "pose": { "right_shoulder_x": 62, "right_elbow": 55 }, "ms": 380 },
      { "pose": { "right_shoulder_x": 48, "right_elbow": 38 }, "ms": 380 }
    ] }
  ]
}
```

Steps are **held, not interpolated**: the firmware already slews each servo at
its own `SERVO_SPEED`, so re-interpolating here would fight it and stutter. `ms`
is dwell time — how long to let the joint arrive before commanding the next one.
A step can also carry `"light": true`, `"motor": "up"`, or an `"eyes"` patch.

Add a gesture by adding an object to this file and restarting the backend — or,
since the dance work landed, by pressing **↻ Reload** on the Dance tab, which
re-reads both files without dropping any node's registration. Give it a clear
one-line `description` — that text is what the model reasons over — and a
handful of `utterances`.

### 8.1 Choreography — `config/dances.json`

The **Dance** tab is the same engine pointed at a second file. Routines are
loaded into the same catalogue and tagged `kind: "dance"`, which is what gives
them their own tab without becoming a second player: one registry means starting
a dance cancels whatever gesture was mid-flight, instead of two timer chains
fighting over the same shoulder. It also puts every routine into the mic's
vocabulary for free — *"do the Rehman Dakait entry"* works from the 🎤 button.

**What ships:** one routine, the entry from *Dhurandhar* —
[FA9LA](https://www.youtube.com/watch?v=TTaRprTfW7c) by Flipperachi, 4/4 at
about **102 BPM** — hand-choreographed, ~36 s: head bowed in the dark → a slow
lift as the light comes on → a left-right scan (the *eyes* do the head turn;
there is no pan servo) → the fist-to-chest-and-point signature on the hook →
shoulder-roll swagger → the wide crown pose with the head and work light punching the
beat → an elbow pump → walk-down. Three motors per arm, nothing else. Pressing the button plays its clip
and dances to it. Buttons print nothing but the name.

Everything else you make yourself, with **⬇ Import**.

#### Import an `.mp3` → the robot choreographs it

Pick a song. A panel opens with the waveform, a **name** field, **start / end**
sliders to trim it, **▶ Preview** for the trimmed piece, and **✨ Create**. The
audio is decoded and analysed *in the browser* — the one machine in the system
with a decoder; the server is Node with no audio stack and the robot is an
ESP8266 — by `frontend/js/choreo.js`, which has no dependencies and brings its
own FFT. The file and the routine then go to the server: the routine is
appended to `config/dances.json`, the song is saved as
`frontend/audio/<id>.mp3` (gitignored — it is somebody's recording), and every
open client gets the new button in the same broadcast. About a second per
minute of audio.

**How the steps are decided.** The signal is cut into 2048-sample frames every
512 samples; each frame's spectrum gives:

| per frame | meaning | used for |
|---|---|---|
| spectral flux | how much louder the spectrum got since last frame — drums spike it | the beat grid |
| RMS | loudness | how big the move is |
| low band < 160 Hz | kick and 808 | finding the downbeat |
| dominant bin 60 Hz – 1.2 kHz | the note — **pitch** | how high the arms and head go |
| spectral centroid | brightness | tie-breaking the move choice |

Tempo is the lag at which the onset envelope best correlates with itself over
60–200 BPM, with a mild pull toward 80–140 to settle the double- and half-time
ambiguity. Beat phase is the offset that lines the grid up with the most onset
energy; the downbeat is whichever of the four positions carries the most low
end. Then the routine is written **one move per bar**: the bar's loudness
*relative to the rest of the song* picks the tier — sway / nod / drift at the
bottom, swagger / point / scratch in the middle, crown / pump / hands-up at the
top — and its **pitch rank** lifts or lowers every shoulder and the chin,
rising pitch lifting a little more. A bar whose onset peak is in the top tenth
gets an accent: the light flashes and the head snaps up. Every fourth bar the
eyes look somewhere else. No move repeats more than twice running, and the pick
is a hash of the bar and its features, so the same trim of the same song gives
the same routine every time.

**The robot is slow, and the generator knows it.** Every dwell is a whole
number of beats; no arm move is shorter than two — four above 130 BPM — because
the firmware slews each servo at 120–180 °/s and a big shoulder move needs about
a second to land. The head and the light may take one beat. **Only three
motors per arm are used — shoulder_x, shoulder_y, elbow.** Wrists and grippers
are never touched by a dance; the generator does not write them and the import
sanitiser strips them.
It never emits `drive`, and the server strips `drive` from anything imported —
a routine that arrived over the network does not get to roll the robot across
the floor. Hand-edit the file if you want that and know why.

Each generated step carries a comment — `bar 7 · crown · energy 0.91 pitch 0.62
· ACCENT` — so the routine is readable in `dances.json` afterwards and any bar
you dislike can be changed by hand and reloaded.

#### Import a `.json` → a routine you wrote

One routine object, or `{ "dances": [ … ] }` in the shape of `dances.json`. It is
sanitised on the way in — ids are `[a-z0-9_]`, joints clamped to 0–100, dwells
to 50–15000 ms, `drive` and any wrist/gripper key dropped — and rejected outright if its id collides with
a gesture in `actions.json`, *before* the file is written. `audio: { file,
start, end }` names the seconds it dances to; leave `file` out to use the
built-in beat. A bare string in `steps` is a comment.

```jsonc
{
  "id": "my_move", "label": "My move", "bpm": 100,
  "audio": { "start": 12.0, "end": 24.0 },    // built-in beat, since no file
  "steps": [
    "--- the drop ---",
    { "pose": { "right_shoulder_y": 72, "right_elbow": 24, "head_tilt": 28 },
      "eyes": { "fx": "dj", "bpm": 100 }, "ms": 2400 },
    { "repeat": 3, "steps": [
      { "pose": { "right_gripper": 100 }, "light": true,  "ms": 600 },
      { "pose": { "right_gripper": 0   }, "light": false, "ms": 600 }
    ] }
  ]
}
```

Joint numbers: **shoulder_y** 0 down / 65 straight out / 100 overhead ·
**shoulder_x** 0 at the side / 100 forward · **elbow** 0 straight / 100 folded ·
**head_tilt** 0 chin up / 50 level / 100 chin down. Three motors per arm; a
`wrist_z` or `gripper` key in a dance is dropped on import.

**Do they look different?** `npm run check` (from `backend/`) reads
`dances.json`, flattens every routine to its arm poses, and reports how many
of one routine's poses have a near-twin (±14 % per joint) in another. A pair
sharing more than 45 % fails. It is the "these two songs have the same steps"
complaint, caught before a demo instead of during one — and it caught one of
mine on the first run: a routine whose "arc" was, in joint numbers, another
routine's "circular arc". Nearest-neighbour on six numbers, no sequence
distance; same poses in a different *order* do not count as the same dance,
which is right for now.

**Removing one:** long-press its button, then tap it again while it says
*remove*. Its audio file goes with it. No `confirm()` — a modal would freeze the
page, and the second tap is the confirmation.

### 8.2 Live dance — the robot follows the room

**🎤 Live** on the Dance tab hands the robot to whatever is actually playing.
The phone at `/face` — the one already wedged in the robot's head, and the only
device here with a microphone pointed at the room — listens, tracks the beat,
and streams poses back over the same WebSocket the eyes use. No file, no trim,
no Create.

**Why it predicts instead of reacting.** Reacting to a beat cannot work. By the
time a kick has been heard, detected, sent over WiFi and turned into a servo
command there are perhaps 40 ms of slack — and the horn still needs 500–1000 ms
to travel. It would always be a beat late and look it. So the loop locks a
*period and a phase* and schedules into the future:

```
listen ─► onset envelope ─► period (autocorrelation, ~1 Hz)
                         └► phase  (comb, PLL-corrected each estimate)
                              └► predict beat N+1, N+2 …
                                   └► send the pose SERVO_LEAD_MS (260 ms) early
```

That lead is the whole trick: the command goes out early by roughly the time a
shoulder takes to travel, so the arm **arrives** on the beat rather than setting
off on it.

Moves come from `choreo.js` — the same library the importer uses — so a live
dance and an imported one are made of the same steps; only the source of the
beat differs.

**What the music decides.** Three features, three decisions, measured per
*beat* and ranked against the last 64 beats — the live stand-in for the offline
generator's "rank this bar against the whole song", because "loud" only means
anything relative to the rest of the track:

| Feature | How it is measured | What it decides |
|---|---|---|
| **Loudness** | low band × 1.6 + mid band | which **tier** of move — sway/nod/drift · swagger/point/elbows · crown/pump/hands_up |
| **Pitch** | harmonic product spectrum, 110–1400 Hz, in semitones | how **high** the arms and chin go, plus a nudge for a rising or falling line |
| **Brightness** | log(high band ÷ low+mid) | **which** move inside the tier: dull → compact and low, bright → open and overhead |

Ranks are percentiles, not distances from a mean — music is not normally
distributed and one enormous drop would otherwise flatten every rank after it.
The tier carries hysteresis so a rank sitting on a boundary cannot flip the
whole vocabulary every bar, and a beat whose onset peak stands above the recent
field flashes the work light.

**Two analysers, because one cannot do both jobs.** Onsets need a short window
to be sharp in time; pitch needs a long one to be sharp in frequency. A
1024-point FFT gives 23 ms resolution and 43 Hz bins — fine for drums, useless
for melody, where a semitone at 200 Hz is 12 Hz. So a second 4096-point
analyser runs alongside at 10.8 Hz per bin, and pitch comes off that through a
harmonic product spectrum: the loudest bin is *not* the note, since a voice or
a lead is a stack of harmonics and the second or third is often strongest, so
argmax jumps an octave whenever the timbre changes. Multiplying the spectrum by
itself decimated 2× and 3× lines the harmonics up on the fundamental, and
parabolic interpolation recovers a fraction of a bin.

Onset flux is weighted toward the drum end (low band × 2.2) — a vocal swell and
a kick are the same number to a flat sum, and only one of them is the beat.

Below a noise floor, or with no confident beat, the robot parks at home rather
than twitching at the air conditioning.

The FFT is the browser's own `AnalyserNode`, in native code, which is what makes
this affordable on a phone.

**Two things that are measured, not assumed.** The analysis hop is taken from
the frame timestamps rather than from `fftSize`, because the loop runs on
`requestAnimationFrame` — 60 Hz, or 120, or whatever a hot phone manages — and
assuming a rate scales every tempo by the ratio between guess and truth. And the
history window is held in *seconds*, not frames, since a frame count means nine
seconds on one phone and four on another, and four is not enough to
autocorrelate a slow tempo.

**Measured accuracy**, feeding real tracks through the analysis path at
simulated 60 / 120 / 30 Hz frame rates:

| Track | Offline BPM | Live BPM |
|---|---|---|
| built-in beat | 102 | 102–103 |
| Nagula Katta | 84 | 83–84 |
| Vaaraaniki Veyyi | 125 | 124–125 |
| Shararat | 131 | 130–131, occasionally half-time |

Tempo lands on the right grid in 8 of 12 runs and on an exact double or half in
the other 4 — never on a wrong tempo, which is the failure that would matter.
Octave ambiguity is the hard part of beat tracking: autocorrelation cannot tell
a beat from every other beat, and a snare on the off-beat looks exactly like a
kick to a peak finder. A half-tempo candidate is preferred when it is nearly as
strong, since a move that gets twice as long to travel is the better failure on
a servo robot. Beat **phase** lands within 3–49 % of a beat, typically around
20 % — on the beat, but not metronomically.

Pitch is found on **every** move in every run, and the loudness, brightness and
pitch ranks each spread across 10–94 % of their range rather than sitting near
the middle, which is what says the features are discriminating rather than
averaging out.

**Taking turns with the microphone.** Chrome for Android will hand the device to
`SpeechRecognition` and `getUserMedia` at once and then deliver silence to one of
them, so the recogniser stands down while a live dance runs and comes back
afterwards. The watchdog knows not to re-arm it. `getUserMedia` is raced against
an 8 s timeout: it does not resolve while a permission prompt is on screen, and
nobody is standing at a phone that is inside a robot's head — without the
timeout the face would wait for ever with its recogniser off, which looks exactly
like a crash. A failed start is reported back so the Dance tab's button does not
sit there claiming the robot is listening.

Starting a scripted routine, or **E-STOP**, drops live mode — a live driver and
a timer chain would fight over the same shoulder.

### The music

**Imported tracks are not normalised**, and quiet ones are inaudible next to
loud ones — two tracks that measured 6–8 dB below the rest, with 4 dB of unused
headroom, simply could not be heard on a phone speaker. If a routine sounds
silent, that is usually why; run the file through a compressor and limiter
before importing:

```bash
ffmpeg -i quiet.mp3 -af "acompressor=threshold=-18dB:ratio=3:makeup=6,alimiter=limit=0.95" \
       -c:a libmp3lame -b:a 192k loud.mp3
```

Each routine names the file and the seconds it dances to. Pressing the button
seeks there and plays; the clip ends where the trim ends and the routine's
closing step runs a beat past it in silence, which is what a walk-down should
do. One `<audio>` element per file, built when the catalogue arrives rather
than on the first press: seeking an already-loaded element is instant, where a
fresh one per press would hand you a quarter second of the robot dancing to
silence. The end of a clip is policed by `timeupdate` on the playhead, not by a
`setTimeout`, and the music stops when the *routine* stops — **■ Stop**,
**E-STOP**, or another routine taking over. It plays from **the browser that
pressed the button**, so put that device near the speaker; **🔊 Music** turns
it off for when the track is already coming out of a PA.

**Switching routines mid-play.** Starting a routine makes the server stop the
running one *first*, so every press emits a `playing: false` immediately
followed by a `playing: true`. Acting on that first message would pause the
clip the same press had just started — which showed up as
`The play() request was interrupted by a call to pause()` and, worse, as the
second dance you pressed running in silence. A press is therefore given 900 ms
to survive its own stop message; **■ Stop** and **E-STOP** call `stop()`
directly and are never held. An `AbortError` from an interrupted `play()` is
swallowed rather than reported: it means something newer took over, which is
not a failure.

**Cache-busting.** Every audio URL carries `?v=<audioStamp>`, where the stamp is
the newest mtime in `frontend/audio/`. A dance's audio keeps the same filename
when it is replaced, and the browser is told the file may be cached — so
without something in the URL that changes, a page goes on playing the copy it
fetched days ago. That is not hypothetical: replacing two tracks with louder
masters left every open client *and every fresh page load* still serving the
quiet originals. Taking the stamp from mtime rather than bumping a counter on
upload also makes it correct for files changed on disk by hand, and it survives
a restart. A changed stamp additionally drops the cached `<audio>` elements,
since an element that has already buffered will not re-fetch on its own.

**The built-in beat.** A routine with no file of its own — the shipped entry,
or an imported `.json` that names none — plays `frontend/audio/dakait-beat.mp3`,
an original instrumental synthesised by `tools/make-beat.js` (`npm run beat`)
in the shape of FA9LA: 102 BPM, D hijaz, trap kick and 808, sections laid out
where the song's are. No dependencies; renders into a `Float64Array`, writes a
WAV, ffmpeg makes the MP3. It is the one file in `frontend/audio/` that is *not*
gitignored — exactly the line between what is ours and what is not.

**DJ mode.** `"eyes": { "fx": "dj", "bpm": 102 }` puts the phone face into the
club version of itself. The face is already a light source, so the light does
the work: the bloom the eyes cast into the room **pulses on the beat**, and the
eyes and their bloom **cycle colour together** over eight beats, slow enough to
read as a wash rather than a flicker. The slit pupil keeps a small pulse on the
off-beat.

Two animations, not five. An earlier version ran a white full-screen strobe,
two counter-rotating beam rigs, a kick scale and a pupil pump at once — that is
the "animate everything that moves" anti-pattern, and a strobe at two flashes
per bar is a genuine seizure risk rather than a style choice. It is ordinary eye state, so it goes to the server and comes back to
every connected face: that is how a panel on a laptop lights up a phone wedged
in the robot's head. Every animation is written in multiples of a `--beat-ms`
custom property, so changing the tempo — the slider, **◉ Tap tempo**, or a
routine's own `bpm` — retimes the whole face at once. Generated routines switch
it on at the detected tempo and off at the end. `prefers-reduced-motion` drops the
pulse and slows the colour wash to a crawl.

**Full screen.** **⛶ Full screen** on the Dance tab puts the routine grid on the
whole phone screen — bigger targets, no tab strip, no address bar — and the
button turns into its own way out. There is a **⛶** in the top bar too, for the
whole UI. Both are requested straight out of the click handler:
`requestFullscreen` needs transient user activation, and anything that puts a
timer in front of it gets refused with nothing worth reading. The phone face at
`/face` has its own route to fullscreen — a tap, or Add to Home screen, §7.2.

### Why it refuses things

Forced-JSON decoding means a small model must always name *something*. Left
alone, `qwen2.5:1.5b` answered "what is the capital of France" with `light_on`.
On a machine with arms, that is not an acceptable failure mode, so two guards sit
between the model and the servos:

* **`none` is a real choice**, demonstrated in few-shot examples, rather than
  asking for `null`. Giving refusal its own id makes declining a normal answer.
* **A grounding gate.** The chosen action must have some vocabulary in common
  with what was actually said. The model decides *which* gesture; it does not get
  the final say on *whether* the robot moves.

The cost is honest: a command sharing no words with its action ("I'm nervous" →
`hands_up`) is refused rather than guessed at. Widening what a phrase can reach
is a matter of adding `utterances`, which is a safer knob than trusting a small
model's imagination.

Measured over 28 phrases on this machine: **20/20 commands matched correctly,
7/8 non-commands correctly refused.** The one that still fires is "I need to
point out that this is wrong" → `point_forward`. Since the mic is push-to-talk
rather than always-listening, that requires deliberately holding the button and
then saying it. Pulling a larger model (`OLLAMA_MODEL=qwen2.5:3b`) sharpens the
intent judgement if you want it tighter.

The voice bar under the top bar always shows **what it heard**, **what it
matched**, and **how** (`ollama` or `keywords`) before and while the robot moves,
so a wrong match is visible rather than mysterious. **E-STOP** halts a running
action instantly, as does **■ Stop** on the Actions tab.

---

## 9. Protocol reference

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
| `POST` | `/motor` | Torso lift: `{cmd: 'up'\|'down'\|'stop'}` or `{dir: 1\|-1\|0}` |
| `POST` | `/light` | Work light: `{cmd: 'on'\|'off'\|'sequence'}` or `{on: true\|false}` |
| `GET` | `/actions` | The gesture + dance catalogue and what is currently playing |
| `POST` | `/actions/:id/run` | Play a named gesture or dance routine |
| `POST` | `/actions/stop` | Stop whatever is running |
| `POST` | `/actions/reload` | Re-read `actions.json` + `dances.json`; a file that will not parse is rejected and the loaded set is kept |
| `POST` | `/voice-agent` | `{ on }` — switch the talking head (speech recognition + Ollama) on the phone on or off. Off by default |
| `POST` | `/live` | `{ on }` — tell the phone at `/face` to start or stop listening to the room |
| `POST` | `/dances` | One dance object → sanitised, written into `dances.json`, catalogue broadcast. Same id replaces; an id that collides with a gesture is rejected before the write |
| `DELETE` | `/dances/:id` | Remove a dance and its `audio/<id>.*` |
| `POST` | `/dances/:id/audio` | Raw audio body, `X-Filename` for the extension (whitelisted) → `frontend/audio/<id>.<ext>`; broadcasts the new `audioStamp` |
| `POST` | `/voice/transcribe` | Raw audio body in, `{text}` out — local Whisper |
| `POST` | `/voice/command` | `{text, run}` → resolves to an action and plays it |
| `GET` | `/voice/health` | Whether the STT server and Ollama are reachable |
| `POST` | `/eyes` | Phone-face eyes, any subset of `{look, swing, lids, speed, blink, auto, fx, bpm}` — `fx: 'dj'` is the dance mode, `bpm` is what it pulses to |
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
backend → node   M|seq=42|dir=1          torso lift: +1 up, −1 down, 0 stop
backend → node   M|seq=42|dir=0|stop=1   torso lift stop
backend → node   L|seq=42|on=1           work light on (0 off)
backend → node   L|seq=42|run=1          replay the power-on light sequence
backend → node   P|seq=42                ping
backend → bcast  SRV|ip=…|port=…|http=…  "the control server lives here"

node → backend   B|id=right_hand|ip=…|rssi=-54|up=123456|fw=1.0.0   heartbeat, 2 s
node → backend   A|id=right_hand|seq=42                              ack
```

Commands for the same board are **coalesced into one datagram** and rate-limited to 25 Hz, so dragging a slider never floods an ESP8266. Stale datagrams are dropped by sequence number.

### Safety behaviour

* Drive node **stops if no command arrives for 600 ms** — a dead WiFi link parks the robot instead of running it into a wall.
* The torso lift has a **4 s silence failsafe** *and* a **4 s hard cap on one continuous run**, and a malformed `M|` packet stops it rather than guessing a direction. Its two direction pins are never driven HIGH together, and the enable pin is sequenced around them.
* `L|` has no failsafe: a light has no reason to switch itself off when the link goes quiet.
* Drive PWM **ramps** instead of stepping, so a full-speed reversal cannot brown out the regulator.
* Servos are **slew-limited** in firmware to each joint's `speed` (deg/sec).
* Servos are attached with a stagger at boot so the 5 V rail survives the inrush.

---

## 10. Layout

```
humanoid-control/
├── config/
│   ├── setup.json             pins, direction, initial angles, poses, drive + motor config
│   ├── actions.json           named gestures — what the voice control chooses between
│   ├── dances.json            choreography — the entry, plus whatever ⬇ Import has added
│   └── recordings.json        saved record/play routines (created on first save)
├── backend/
│   ├── server.js              HTTP + HTTPS + WebSocket + UDP wiring
│   └── src/
│       ├── setup.js           load / validate / save setup.json
│       ├── joints.js          travel ⇄ servo-angle maths
│       ├── state.js           device registry + live pose + eye state
│       ├── udpLink.js         datagram encode/decode, announce, heartbeats
│       ├── controller.js      intents → coalesced, rate-limited packets
│       ├── actions.js         gesture + dance player: timed steps, keep-alives, reload, dance add/remove + sanitiser
│       ├── recorder.js        live record / loop-playback engine
│       ├── sequence.js        scripted motions spanning head + eyes
│       ├── face.js            Ollama proxy, photo store, phone log relay
│       └── api.js             REST routes
├── frontend/
│   ├── index.html  css/styles.css        the control UI
│   ├── face.html   css/face.css          the robot face (phone)
│   ├── face.webmanifest                  Add to Home screen -> true fullscreen
│   ├── audio/dakait-beat.mp3             the built-in beat (tools/make-beat.js); imported songs land next to it, GITIGNORED
│   └── js/  skeleton.js  view3d.js  stick.js  jointmath.js  app.js  face.js
│        ├── choreo.js                     mp3 → steps: FFT, onset/tempo/pitch analysis, the move library
│        └── livedance.js                  the same moves, driven live off the phone's microphone
├── firmware/
│   ├── hand_node/hand_node.ino    both arms + head (set ROLE) + torso lift and light on the right board
│   └── drive_node/drive_node.ino  differential base
├── certs/                     TLS for /face — GITIGNORED, run `npm run cert`
├── captures/                  photos the robot took — GITIGNORED
└── tools/
    ├── sim-node.js            virtual NodeMCUs for hardware-free testing
    ├── make-beat.js           synthesises the built-in beat — no deps, deterministic
    ├── check-dances.js        fails if two routines share too many arm poses
    └── make-cert.sh           mints certs/ for every IP this laptop has
```

---

## 11. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Node never appears in **Nodes** | Wrong laptop IP in the portal, or a firewall blocking :3000. Check the node's serial monitor at 115200 baud — it logs `[REG] … -> code`. Use **Broadcast server IP** in the Nodes tab. |
| Node online but a servo does not move | `channel` in `setup.json` must match the pin's position in the firmware's `SERVO_PIN[]` array. The Arms tab shows the channel next to each joint. |
| Joint runs the wrong way | Flip **dir** for that joint in the **Setup** tab. |
| Joint is offset by a few degrees | Adjust **trim** in the **Setup** tab (horn splines are ~7.5° apart, so trim gets you the rest of the way). |
| Board reboots when servos move | Servo supply is too weak or not sharing ground with the NodeMCU. Never power servos from the 3V3 pin. |
| Base drives backwards | Set `INVERT_LEFT` / `INVERT_RIGHT` in `drive_node.ino`. |
| **Torso & Light** tab is missing | There is neither a `motor` nor a `light` block in `setup.json`, so the UI hides the tab. Each half hides on its own too. |
| Torso drives the wrong way | Set `"invert": true` in the `motor` block of `setup.json` (restart the backend), or `MOTOR_INVERT = true` in `hand_node.ino`. |
| Torso does nothing | The right-hand board must be flashed with `ROLE_RIGHT_HAND` — the motor code is compiled out under the left-hand role. Take the L298N's **ENA jumper off** (the enable is `D0`), or set `MOTOR_HAS_EN 0` and leave the jumper on. Serial shows `[TORSO] failsafe` when commands are not arriving. |
| Torso stops after exactly 4 s | Working as designed — that is `MOTOR_MAX_RUN_MS`. Release the button and press again for another 4 s. Raise it in **both** `hand_node.ino` and `setup.json` if the axis genuinely needs longer travel. |
| Torso stutters or stops early | Commands are not reaching the board inside the 4 s failsafe. Check RSSI in the **Nodes** tab. Serial logs `[TORSO] failsafe`. |
| 🎤 Speak says "speech-to-text server is not running" | Start it: `cd backend && npm run stt`. The *Type a command* box on the Actions tab works without it. |
| First `npm run stt` hangs for a minute | It is downloading the Whisper weights (~140 MB for `base.en`). Only happens once; after that it is cached in `~/.cache`. |
| `faster-whisper is not installed for this interpreter` | The `python3` on your PATH is not the one with it. Run `python3 -m pip install faster-whisper`, or point the script at the right interpreter. |
| Voice matches nothing, Ollama shows red | `ollama serve` is not running, or the model is not pulled: `ollama pull qwen2.5:1.5b`. With Ollama down the keyword matcher still handles the phrasings listed in `actions.json`. |
| A command is understood by a person but refused | Add the phrasing to that action's `utterances` in `config/actions.json` and restart the backend — the grounding gate needs some shared vocabulary. See §8. |
| Mic button does nothing | The browser blocks `getUserMedia` outside a secure context. `localhost` counts as secure; a plain `http://192.168.x.x` from another device does not — use the HTTPS listener (`npm run cert`, then `https://<ip>:3443`). |
| Left board won't boot, or boots into flash mode | `D3` is GPIO0 and must read **high** at power-up. Whatever drives the light is clamping it low — drive it through a MOSFET/transistor gate, or move the light to a free pin (`D0`/`D8`) in both `hand_node.ino` and `setup.json`. |
| Light does not fade | It is not meant to — `LIGHT_PWM 0` drives D3 as a plain switch. Move it to a PWM-capable pin and set `LIGHT_PWM 1` plus `"pwm": true` if you want fades. |
| Light comes back on by itself after a power blip | Expected: the board runs its own start-up sequence on every boot. The server pushes the remembered state back a moment after the node re-registers, so it settles to whatever you last chose. |
| Right-hand board won't boot with the L298N attached | D8 (GPIO15) must be low at power-up. Add a 10 kΩ pull-down on D8 or move IN2 to another pin in both `hand_node.ino` and `setup.json`. |
| Base stutters | Normal if commands are dropping — the 600 ms failsafe is doing its job. Check WiFi signal (RSSI in the Nodes tab). |

Tested end to end on this machine with the virtual nodes: registration, pose resync, per-joint commands, preset poses, D-pad drive, thumb-stick vector drive and stop all reach the correct board with the correct angles. The torso lift and the light were checked the same way — **Torso up** puts `D3` and `D0` HIGH, releasing it starts the auto-lower on `D4`, a held button hits the 4 s run cap and stays latched out until the direction changes, the silence failsafe fires when commands stop, and E-STOP blocks the buttons entirely. The light runs its three-blink start-up sequence on the **left** board's `D3` at boot, and the on/off/replay buttons all reach it. Head tilt reaches `D4` on the left board; there is no pan channel left anywhere in the stack.
# humanoid
