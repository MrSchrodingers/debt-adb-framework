# POCO Serenity — Profile Backup Map
> Device: 9b01005930533036340030832250ac (POCO 25028PC03G)
> Date: 2026-04-01
> PIN: 12345 (all profiles)

## Profile → WhatsApp Number Mapping

| User ID | Profile Name   | WhatsApp Number     | WA Name               | Google Account | Backup Status |
|---------|----------------|---------------------|------------------------|----------------|---------------|
| 0       | Main Oralsin 2 | +55 43 9683-5100    | Contato \| Debt-Oralsin | ?              | PENDING       |
| 10      | Oralsin 2 1    | +55 43 9683-5095    | Contato \| Oralsin-Debt | ?              | PENDING       |
| 11      | Oralsin 2 2    | +55 43 9683-7813    | Contato \| Oralsin-Debt | ?              | PENDING       |
| 12      | Oralsin 2 3    | +55 43 9683-7844    | Contato \| Oralsin-Debt | ?              | PENDING       |

## WhatsApp Business (WABA)

All profiles have `com.whatsapp.w4b` installed but numbers not yet mapped (not configured per user statement).

## Backup Steps (per profile)

1. Switch to profile: `adb shell am switch-user <UID>`
2. Unlock: PIN 12345
3. Open WhatsApp > Menu > Configurações > Conversas > Backup de conversas
4. Tap "Fazer backup" (backup to Google Drive)
5. Wait for completion
6. Mark status as DONE

## Post-Restore Checklist

After bootloader unlock + root + MUMD enable:
1. Recreate 4 user profiles with same names
2. Install WhatsApp on each
3. Verify each number via SMS
4. Restore from Google Drive backup
5. Verify conversations restored
6. Configure Magisk DenyList for WhatsApp (hide root)
