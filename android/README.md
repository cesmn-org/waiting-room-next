# Waiting Room TV Android app

This is a minimal Android WebView app for displaying the deployed Waiting Room TV page.

## Behavior

- Opens the selected interface at `https://waiting-room.jbeyer.workers.dev/tv` or `/tablet`.
- Preserves the existing pairing-code flow and device cookie in WebView storage.
- TV mode uses landscape orientation and immersive fullscreen UI flags.
- Tablet mode allows the device's normal orientation and system UI.
- Long-press anywhere in the WebView to open native settings and switch modes.
- The selected mode is stored in Android preferences and survives app restarts.
- Allows normal Android exit/navigation; it is not a kiosk or boot-launch app.
- Restricts in-app navigation to the deployed Waiting Room host.

## Build later

Android SDK and JDK 17 are required. The Gradle wrapper has not been generated in this initial
source-only version. Once Gradle is available, generate or add the wrapper and run:

```bash
./gradlew assembleDebug
```

The debug APK will be written under `app/build/outputs/apk/debug/`.

The app has intentionally not been built, installed, or tested yet.
