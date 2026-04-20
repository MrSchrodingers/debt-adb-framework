# Android KeyEvent Code Reference

## Navigation
| KeyCode | Value | Description |
|---------|-------|-------------|
| KEYCODE_HOME | 3 | Home button |
| KEYCODE_BACK | 4 | Back button |
| KEYCODE_APP_SWITCH | 187 | Recent apps |
| KEYCODE_MENU | 82 | Menu button |
| KEYCODE_SEARCH | 84 | Search |
| KEYCODE_DPAD_UP | 19 | D-pad up |
| KEYCODE_DPAD_DOWN | 20 | D-pad down |
| KEYCODE_DPAD_LEFT | 21 | D-pad left |
| KEYCODE_DPAD_RIGHT | 22 | D-pad right |
| KEYCODE_DPAD_CENTER | 23 | D-pad center/enter |
| KEYCODE_TAB | 61 | Tab |
| KEYCODE_ENTER | 66 | Enter |

## Power & Screen
| KeyCode | Value | Description |
|---------|-------|-------------|
| KEYCODE_POWER | 26 | Power toggle |
| KEYCODE_WAKEUP | 224 | Wake screen (no toggle) |
| KEYCODE_SLEEP | 223 | Sleep screen (no toggle) |
| KEYCODE_BRIGHTNESS_UP | 221 | Increase brightness |
| KEYCODE_BRIGHTNESS_DOWN | 220 | Decrease brightness |

## Volume & Media
| KeyCode | Value | Description |
|---------|-------|-------------|
| KEYCODE_VOLUME_UP | 24 | Volume up |
| KEYCODE_VOLUME_DOWN | 25 | Volume down |
| KEYCODE_VOLUME_MUTE | 164 | Mute |
| KEYCODE_MEDIA_PLAY | 126 | Play |
| KEYCODE_MEDIA_PAUSE | 127 | Pause |
| KEYCODE_MEDIA_PLAY_PAUSE | 85 | Toggle play/pause |
| KEYCODE_MEDIA_STOP | 86 | Stop |
| KEYCODE_MEDIA_NEXT | 87 | Next track |
| KEYCODE_MEDIA_PREVIOUS | 88 | Previous track |
| KEYCODE_MEDIA_REWIND | 89 | Rewind |
| KEYCODE_MEDIA_FAST_FORWARD | 90 | Fast forward |
| KEYCODE_HEADSETHOOK | 79 | Headset button |

## Text Editing
| KeyCode | Value | Description |
|---------|-------|-------------|
| KEYCODE_DEL | 67 | Backspace |
| KEYCODE_FORWARD_DEL | 112 | Forward delete |
| KEYCODE_ESCAPE | 111 | Escape |
| KEYCODE_MOVE_HOME | 122 | Move to start |
| KEYCODE_MOVE_END | 123 | Move to end |
| KEYCODE_PAGE_UP | 92 | Page up |
| KEYCODE_PAGE_DOWN | 93 | Page down |
| KEYCODE_CUT | 277 | Cut |
| KEYCODE_COPY | 278 | Copy |
| KEYCODE_PASTE | 279 | Paste |

## Special Characters
| KeyCode | Value | Character |
|---------|-------|-----------|
| KEYCODE_AT | 77 | @ |
| KEYCODE_POUND | 18 | # |
| KEYCODE_STAR | 17 | * |
| KEYCODE_PLUS | 81 | + |
| KEYCODE_MINUS | 69 | - |
| KEYCODE_EQUALS | 70 | = |
| KEYCODE_LEFT_BRACKET | 71 | [ |
| KEYCODE_RIGHT_BRACKET | 72 | ] |
| KEYCODE_BACKSLASH | 73 | \ |
| KEYCODE_SEMICOLON | 74 | ; |
| KEYCODE_APOSTROPHE | 75 | ' |
| KEYCODE_SLASH | 76 | / |
| KEYCODE_COMMA | 55 | , |
| KEYCODE_PERIOD | 56 | . |
| KEYCODE_SPACE | 62 | (space) |

## Camera
| KeyCode | Value | Description |
|---------|-------|-------------|
| KEYCODE_CAMERA | 27 | Camera button |
| KEYCODE_FOCUS | 80 | Camera focus |

## Phone
| KeyCode | Value | Description |
|---------|-------|-------------|
| KEYCODE_CALL | 5 | Answer/dial |
| KEYCODE_ENDCALL | 6 | Hang up |

## Usage Examples
```bash
# Single key
adb shell input keyevent KEYCODE_HOME

# By numeric value
adb shell input keyevent 3

# Long press
adb shell input keyevent --longpress KEYCODE_POWER

# Key combo (Ctrl+A to select all)
adb shell input keyevent --longpress 29  # KEYCODE_A with Ctrl
```
