plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "org.cesmn.waitingroom.tv"
    compileSdk = 35

    defaultConfig {
        applicationId = "org.cesmn.waitingroom.tv"
        minSdk = 23
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
    }
}

kotlin {
    jvmToolchain(17)
}
