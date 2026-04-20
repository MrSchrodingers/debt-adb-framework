# WhatsApp Intents and Deep Links

## Open Chat by Phone Number
```bash
# Opens WhatsApp chat (creates if doesn't exist)
adb shell am start -a android.intent.action.VIEW -d "https://wa.me/5511999999999"

# Force WhatsApp Business
adb shell am start -a android.intent.action.VIEW -d "https://wa.me/5511999999999" -p com.whatsapp.w4b

# With pre-filled message
adb shell am start -a android.intent.action.VIEW -d "https://wa.me/5511999999999?text=Hello%20World"
```

## Share Content to WhatsApp
```bash
# Share text
adb shell am start -a android.intent.action.SEND -t "text/plain" -p com.whatsapp --es android.intent.extra.TEXT "Message here"

# Share image
adb shell am start -a android.intent.action.SEND -t "image/jpeg" -p com.whatsapp --eu android.intent.extra.STREAM "file:///sdcard/image.jpg"
```

## WhatsApp Internal Activities
| Activity | Purpose |
|----------|---------|
| `com.whatsapp.Main` | Main launcher |
| `com.whatsapp.HomeActivity` | Home screen |
| `com.whatsapp.Conversation` | Chat view |
| `com.whatsapp.VoipActivity` | Voice/video call |
| `com.whatsapp.camera.CameraActivity` | Camera |
| `com.whatsapp.StatusActivity` | Status view |
| `com.whatsapp.SettingsAccount` | Account settings |

## WA Business Specific
| Activity | Purpose |
|----------|---------|
| `com.whatsapp.Main` | Main launcher (same class) |
| `com.whatsapp.BusinessProfileActivity` | Business profile |
| `com.whatsapp.CatalogDetailActivity` | Product catalog |

## Broadcast Receivers
| Receiver | Event |
|----------|-------|
| `com.whatsapp.messaging.MessageService` | Incoming message |
| `com.whatsapp.VoipNotificationManager` | Incoming call |

## Number Format
Always use international format without + or spaces:
- Brazil: `55` + DDD + number (e.g., `5511999999999`)
- US: `1` + area code + number (e.g., `14155552671`)
