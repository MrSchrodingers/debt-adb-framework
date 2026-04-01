# Bloatware Database by Vendor

## Risk Levels
- **SAFE**: No side effects, purely cosmetic/utility apps
- **CAUTION**: May affect minor functionality, test after removal
- **DANGER**: May break core features, research before removing

## Xiaomi / MIUI / HyperOS

| Package | App | Risk | Notes |
|---------|-----|------|-------|
| com.miui.msa.global | MIUI System Ads | SAFE | Ad service, priority removal |
| com.xiaomi.mipicks | GetApps | SAFE | Alternative app store, spam notifications |
| com.xiaomi.discover | Discover | SAFE | Promotions feed |
| com.miui.analytics.go | Analytics | SAFE | Telemetry |
| com.miui.player | Mi Music | SAFE | Music player |
| com.miui.videoplayer | Mi Video | SAFE | Video player |
| com.miui.theme.lite | Themes | SAFE | Theme engine |
| com.miui.bugreport | Bug Report | SAFE | Dev tool |
| com.miui.cleaner.go | Cleaner | SAFE | Fake cleaner |
| com.miui.android.fashiongallery | Wallpaper Carousel | SAFE | Live wallpapers |
| com.miui.qr | QR Scanner | SAFE | Redundant |
| com.xiaomi.scanner | Scanner | SAFE | Redundant |
| com.xiaomi.glgm | Game Center | SAFE | Gaming service |
| com.mi.globalminusscreen | App Vault | SAFE | Swipe-left screen |
| com.miui.gallery | Gallery | CAUTION | Use Google Photos or other alternative first |
| com.miui.weather2 | Weather | SAFE | Weather app |
| com.miui.compass | Compass | SAFE | Compass |
| com.miui.notes | Notes | SAFE | Notes app |
| com.miui.screenrecorder | Screen Recorder | SAFE | Screen recorder |
| com.miui.yellowpage | YellowPages | SAFE | Caller ID |
| com.miui.global.packageinstaller | MIUI Package Installer | CAUTION | May break APK sideloading |

## Samsung / OneUI

| Package | App | Risk | Notes |
|---------|-----|------|-------|
| com.samsung.android.app.spage | Samsung Free/Bixby | SAFE | -1 screen |
| com.samsung.android.bixby.agent | Bixby Voice | SAFE | Voice assistant |
| com.samsung.android.bixby.service | Bixby Service | SAFE | Background service |
| com.samsung.android.visionintelligence | Bixby Vision | SAFE | Camera AI |
| com.samsung.android.game.gamehome | Game Hub | SAFE | Gaming |
| com.samsung.android.game.gametools | Game Tools | SAFE | Gaming overlay |
| com.samsung.android.app.tips | Tips | SAFE | Tutorial app |
| com.samsung.android.mobileservice | Samsung Account | CAUTION | May affect Samsung features |
| com.sec.android.app.sbrowser | Samsung Browser | SAFE | Browser |
| com.samsung.android.email.provider | Samsung Email | SAFE | Email client |

## Google (removable)

| Package | App | Risk | Notes |
|---------|-----|------|-------|
| com.google.android.youtube | YouTube | SAFE | |
| com.google.android.apps.youtube.music | YouTube Music | SAFE | |
| com.google.android.gm | Gmail | SAFE | |
| com.google.android.apps.docs | Drive | SAFE | |
| com.google.android.apps.maps | Maps | SAFE | |
| com.google.android.apps.tachyon | Duo/Meet | SAFE | |
| com.google.android.apps.messaging | Messages | SAFE | Unless used as default SMS |
| com.google.android.apps.photos | Photos | SAFE | |
| com.google.android.apps.photosgo | Photos Go | SAFE | |
| com.google.android.apps.searchlite | Google Go | SAFE | |
| com.google.android.apps.wellbeing | Digital Wellbeing | SAFE | Background process |
| com.google.android.apps.safetyhub | Personal Safety | SAFE | |
| com.google.android.videos | Google TV | SAFE | |
| com.google.android.apps.subscriptions.red | Google One | SAFE | |
| com.google.android.apps.nbu.files | Files | SAFE | |
| com.google.android.marvin.talkback | TalkBack | SAFE | Unless accessibility needed |
| com.google.android.apps.walletnfcrel | Wallet | SAFE | Unless using NFC payments |
| com.google.android.feedback | Feedback | SAFE | |

## Google (DO NOT REMOVE)

| Package | App | Risk | Notes |
|---------|-----|------|-------|
| com.google.android.gms | Play Services | DANGER | Breaks everything |
| com.android.vending | Play Store | DANGER | No app updates |
| com.google.android.gsf | Services Framework | DANGER | Breaks GMS |
| com.google.android.webview | WebView | DANGER | Breaks web content in all apps |
| com.google.android.inputmethod.latin | Gboard | DANGER | No keyboard |
| com.google.android.permissioncontroller | Permissions | DANGER | Security framework |
| com.google.android.ext.services | ExtServices | DANGER | Core services |

## Facebook (pre-installed)

| Package | App | Risk | Notes |
|---------|-----|------|-------|
| com.facebook.system | Facebook System | SAFE | Pre-installed, runs in background |
| com.facebook.services | Facebook Services | SAFE | Persistent service |
| com.facebook.appmanager | Facebook App Manager | SAFE | Auto-updater |
| com.facebook.katana | Facebook App | SAFE | Main app |
| com.facebook.orca | Messenger | SAFE | Chat app |
| com.instagram.android | Instagram | SAFE | |

## Carrier / OEM

| Package | App | Risk | Notes |
|---------|-----|------|-------|
| br.com.timbrasil.meutim | Meu TIM | SAFE | TIM Brasil bloat |
| com.vivo.br.myvivo | Meu Vivo | SAFE | Vivo Brasil bloat |
| com.claro.claroideia | Claro | SAFE | Claro Brasil bloat |
| com.amazon.appmanager | Amazon Apps | SAFE | Pre-installed Amazon |
| com.amazon.mShop.android.shopping | Amazon Shopping | SAFE | |
| com.android.stk | SIM Toolkit | CAUTION | Carrier SIM services |
| com.netflix.mediaclient | Netflix | SAFE | Pre-installed |
| com.spotify.music | Spotify | SAFE | Pre-installed |

## Common Safe-to-Remove Patterns

These package prefixes are generally safe bloatware:
- `com.miui.*` (except global.packageinstaller)
- `com.xiaomi.*` (except core services)
- `com.samsung.android.app.*`
- `com.facebook.*`
- `com.amazon.*`
- Carrier-specific packages (br.com.timbrasil.*, com.vivo.br.*, etc.)
