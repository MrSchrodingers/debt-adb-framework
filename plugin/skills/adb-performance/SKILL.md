---
name: adb-performance
description: >
  This skill should be used when the user asks to "speed up phone", "phone is slow",
  "optimize phone performance", "check phone RAM", "free up memory", "phone lagging",
  "battery drain", "phone overheating", "reduce battery usage", "check battery health",
  "which apps use most battery", "phone performance", "kill background apps",
  "clear phone cache", or wants to diagnose and improve Android device performance via ADB.
---

# ADB Performance Optimizer

Diagnose and optimize Android device performance: RAM, CPU, battery, storage,
and background process management via ADB.

## Quick Diagnostics

### RAM Analysis

```bash
# Overview
adb shell cat /proc/meminfo | head -10

# Per-process memory (top consumers)
adb shell dumpsys meminfo | grep -E "^\s+[0-9].*K:" | head -20

# Specific app memory
adb shell dumpsys meminfo <package>

# Available vs total
adb shell "free -m" 2>/dev/null || adb shell cat /proc/meminfo | grep -E "MemTotal|MemAvailable"
```

### CPU Analysis

```bash
# Current CPU usage (top processes)
adb shell top -n 1 -m 15

# CPU info
adb shell cat /proc/cpuinfo | grep -E "processor|BogoMIPS"

# CPU frequency (current, min, max)
adb shell cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq 2>/dev/null
adb shell cat /sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_min_freq 2>/dev/null
adb shell cat /sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq 2>/dev/null

# Thermal status
adb shell dumpsys thermalservice | grep -E "Temperature|mThrottling"
```

### Battery Analysis

```bash
# Battery summary
adb shell dumpsys battery

# Battery stats (what's draining)
adb shell dumpsys batterystats | grep -E "Uid.*top=" | sort -t= -k2 -rn | head -15

# Wake locks (apps preventing sleep)
adb shell dumpsys power | grep -E "Wake Lock" | head -20

# Battery history (recent events)
adb shell dumpsys batterystats --history | tail -50
```

### Storage Analysis

```bash
# Disk usage
adb shell df -h /data

# Largest directories
adb shell du -sh /data/data/* 2>/dev/null | sort -rh | head -20

# App cache sizes
adb shell dumpsys diskstats | head -15

# Identify large media files
adb shell "find /sdcard -size +50M -type f 2>/dev/null" | head -20
```

## Optimization Actions

### Kill Background Processes

```bash
# Force stop a specific app
adb shell am force-stop <package>

# Kill all background processes for a user
adb shell am kill-all

# Trim memory (ask apps to release caches)
adb shell am send-trim-memory <package> RUNNING_LOW
```

### Clear App Caches

```bash
# Clear cache for specific app (preserves data)
adb shell pm clear --cache-only <package>

# Clear ALL app caches (system-wide)
adb shell pm trim-caches 999999999999

# Clear specific app data completely (DESTRUCTIVE)
# adb shell pm clear <package>
```

### Restrict Background Activity

```bash
# Deny background execution for an app
adb shell cmd appops set <package> RUN_IN_BACKGROUND deny
adb shell cmd appops set <package> RUN_ANY_IN_BACKGROUND deny

# Check current restriction
adb shell cmd appops get <package> RUN_IN_BACKGROUND

# Re-allow
adb shell cmd appops set <package> RUN_IN_BACKGROUND allow
```

### Battery Optimization

```bash
# Check battery optimization list
adb shell dumpsys deviceidle | grep -A5 "Whitelist"

# Force Doze mode (aggressive battery saving)
adb shell dumpsys deviceidle force-idle

# Exit Doze
adb shell dumpsys deviceidle unforce

# Enable battery saver
adb shell settings put global low_power 1

# Disable battery saver
adb shell settings put global low_power 0
```

### Animation Scale (perceived performance)

```bash
# Disable animations (makes phone feel faster)
adb shell settings put global window_animation_scale 0
adb shell settings put global transition_animation_scale 0
adb shell settings put global animator_duration_scale 0

# Restore default animations
adb shell settings put global window_animation_scale 1
adb shell settings put global transition_animation_scale 1
adb shell settings put global animator_duration_scale 1

# Half-speed animations (balanced)
adb shell settings put global window_animation_scale 0.5
adb shell settings put global transition_animation_scale 0.5
adb shell settings put global animator_duration_scale 0.5
```

### GPU Rendering

```bash
# Force GPU rendering (may improve scrolling)
adb shell settings put global debug.hwui.renderer skiagl

# Check current renderer
adb shell getprop debug.hwui.renderer
```

## Process Management

### List Heavy Processes

```bash
# Running processes with memory info
adb shell "dumpsys activity processes" | grep -E "^\s+\*.*:.*/" | while read line; do
  proc=$(echo "$line" | grep -oP ':\K[^/]+')
  echo "$proc"
done | sort | uniq -c | sort -rn
```

### Identify Wake Lock Offenders

```bash
# Apps holding wake locks (keeping CPU awake)
adb shell dumpsys power | grep -E "PARTIAL_WAKE_LOCK|FULL_WAKE_LOCK" | head -15

# Alarm manager (apps scheduling frequent wake-ups)
adb shell dumpsys alarm | grep -E "type=|when=" | head -30
```

### Background Process Limit

```bash
# Limit background processes (0-4, or -1 for standard)
adb shell settings put global background_process_limit 2

# Standard limit
adb shell settings put global background_process_limit -1

# Check current limit
adb shell settings get global background_process_limit
```

## Low-RAM Device Optimization (< 3GB)

For devices with limited RAM (like the POCO Serenity with 2.7GB):

1. **Remove bloatware** - Use `adb-bloatware` skill, each removed app saves RAM
2. **Disable animations** - Immediate perceived speed improvement
3. **Limit background processes** - Set to 2 max
4. **Restrict heavy apps** - Deny background for non-essential apps
5. **Clear caches regularly** - Frees storage and RAM
6. **Consider removing unused user profiles** - Each profile runs duplicate services

```bash
# Quick optimization for low-RAM devices
adb shell settings put global window_animation_scale 0.5
adb shell settings put global transition_animation_scale 0.5
adb shell settings put global animator_duration_scale 0.5
adb shell settings put global background_process_limit 2
adb shell pm trim-caches 999999999999
```

## Monitoring Script

```bash
# Quick performance snapshot
echo "=== RAM ==="
adb shell cat /proc/meminfo | grep -E "MemTotal|MemAvailable|MemFree"
echo ""
echo "=== CPU Load ==="
adb shell cat /proc/loadavg
echo ""
echo "=== Battery ==="
adb shell dumpsys battery | grep -E "level:|temperature:|status:"
echo ""
echo "=== Storage ==="
adb shell df -h /data | tail -1
echo ""
echo "=== Processes ==="
adb shell "dumpsys activity processes" | grep -c "ProcessRecord"
```

Use `/var/www/adb_tools/scripts/adb_utils.sh ram` for a quick RAM check.

## Additional Resources

- **`references/performance-benchmarks.md`** - Baseline performance numbers by device tier
