# Frida Hook PoC — WhatsApp Anti-Automation Research

## Goal

Hook WhatsApp Java methods related to anti-automation and anti-tamper detection. Log every
intercepted call to a JSONL stream so we can identify call patterns that precede ban events.
The resulting dataset feeds the `BanPredictionDaemon` (Task 12.2) which preemptively opens
device circuit breakers before an actual ban is issued.

## Research Questions

1. Which anti-automation / anti-tamper methods are called before a ban screen appears?
2. Are call frequency, argument values, or call sequence predictive of an imminent ban?
3. Can we set a confidence threshold that triggers preventive back-off without false positives?

## Target Classes

| Class | Hypothesis |
|---|---|
| `com.whatsapp.security.AntiTamper` | Called when WA suspects a modified/automated client |
| `com.whatsapp.util.AutomationDetector` | Detects UI-automation patterns (accessibility events, ADB input) |
| `com.whatsapp.security.SignatureValidator` | Validates APK signature — hooks here expose when re-checks are triggered |
| `com.whatsapp.client.ClientUtils` | Utility used by several detection paths — broader signal surface |

## Prerequisites

- **Rooted Android device** (POCO C71 or equivalent)
- **Frida server** matching device arch (arm64) and Android version
  - Download: https://github.com/frida/frida/releases
  - Pick: `frida-server-<version>-android-arm64.xz`
- **Frida CLI on host**: `pip install frida-tools`
- **ADB** accessible on host

## Quick Start

### 1. Push & start frida-server on device

```bash
# Download frida-server (replace version as needed)
wget https://github.com/frida/frida/releases/download/16.7.19/frida-server-16.7.19-android-arm64.xz
xz -d frida-server-16.7.19-android-arm64.xz
mv frida-server-16.7.19-android-arm64 frida-server

# Use the automated setup script (idempotent)
./research/frida/setup-device.sh [DEVICE_SERIAL]
```

### 2. Run the hook + capture stream

```bash
# Captures to /tmp/whatsapp-hook.jsonl by default
./research/frida/runner.sh [DEVICE_SERIAL] [OUTPUT_FILE]
```

### 3. Forward events to BanPredictionDaemon

```bash
# Streams the JSONL file into the daemon's TCP socket (127.0.0.1:9871)
node research/frida/forwarder.js /tmp/whatsapp-hook.jsonl [DEVICE_SERIAL]
```

## Output Format

Each intercepted call produces one JSON line:

```json
{
  "event": "method_call",
  "class": "com.whatsapp.security.AntiTamper",
  "method": "check",
  "args": ["arg0_str", 42],
  "ts": 1714213200000,
  "serial": "9b01005930533036340030832250ac"
}
```

Fields:
- `event` — always `"method_call"` for hook events
- `class` — fully-qualified Java class name
- `method` — method name
- `args` — array of string-coerced argument values (may be `null` for non-serialisable objects)
- `ts` — Unix epoch ms on the device at call time
- `serial` — ADB device serial (injected by `runner.sh` via `--parameters`)

## Notes

- Classes that don't exist in the installed WhatsApp version are silently skipped.
- Method replacement via `implementation =` intercepts every call but does NOT restore the
  original behaviour — WhatsApp may behave differently while hooked. Use only for research
  sessions on a dedicated test device, never on an account used for production traffic.
- Use `-f com.whatsapp` (spawn mode) to hook from process start and catch early calls.
  If WA is already running, replace `-f` with the PID.
