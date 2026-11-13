# Anchor Android

Anchor Mobile is an Android-only native client.

## Stack

- Kotlin
- Jetpack Compose
- Foreground Service
- UsageStatsManager
- AccessibilityService
- OkHttp WebSocket

## Build

```powershell
cd apps/mobile/android
./gradlew.bat :app:assembleDebug
```

Install `app/build/outputs/apk/debug/app-debug.apk` on an Android device. On first launch, grant notification, UsageStats, overlay, and Accessibility permissions. UsageStats and Accessibility are required for behavior inference and T0 curfew execution.

The server URL defaults to `http://localhost:4000` (usable with `adb reverse tcp:4000 tcp:4000`). Change it and the upload data key anytime in the in-app settings panel — no rebuild required.
