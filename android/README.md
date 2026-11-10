# Waiting Room Device Android app

This is a minimal Android WebView app for displaying the deployed Waiting Room TV or tablet interface.

## Behavior

- Opens the selected interface at `https://waiting-room.jbeyer.workers.dev/tv` or `/tablet`.
- Preserves the existing pairing-code flow and device cookie in WebView storage.
- TV mode uses landscape orientation and immersive fullscreen UI flags.
- Tablet mode allows the device's normal orientation and system UI.
- Long-press anywhere in the WebView to open native settings and switch modes.
- On first launch, Android TV devices default to TV mode and other devices default to tablet mode.
- The detected device type is shown in settings for reference; manual mode selection remains available.
- The selected mode is stored in Android preferences and survives app restarts.
- Allows normal Android exit/navigation; it is not a kiosk or boot-launch app.
- Restricts in-app navigation to the deployed Waiting Room host.
- Declares an Android TV/Leanback launcher category and TV banner so the app appears in TV launchers.
- Includes an explicit launcher icon for TV launchers that do not derive an icon from the banner.

## Build later

Android SDK and JDK 17 are required. The Gradle wrapper has not been generated in this initial
source-only version. Once Gradle is available, generate or add the wrapper and run:

```bash
./gradlew assembleDebug
```

The debug APK will be written under `app/build/outputs/apk/debug/`.

The app has intentionally not been built, installed, or tested yet.
