package org.cesmn.waitingroom.tv

import android.content.Context
import android.content.pm.PackageManager
import android.content.res.Configuration

class AppSettings(context: Context) {
    private val preferences = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    val detectedDeviceType: DeviceType = detectDeviceType(context)

    var mode: Mode
        get() = Mode.fromValue(preferences.getString(KEY_MODE, null))
        set(value) {
            preferences.edit().putString(KEY_MODE, value.value).apply()
        }

    init {
        if (!preferences.contains(KEY_MODE)) {
            mode = detectedDeviceType.defaultMode
        }
    }

    enum class Mode(val value: String, val path: String) {
        TV("tv", "/tv"),
        TABLET("tablet", "/tablet");

        companion object {
            fun fromValue(value: String?): Mode =
                entries.firstOrNull { it.value == value } ?: TV
        }
    }

    enum class DeviceType(val label: String, val defaultMode: Mode) {
        TV("TV", Mode.TV),
        TABLET_OR_PHONE("tablet or phone", Mode.TABLET);
    }

    companion object {
        private const val PREFERENCES_NAME = "waiting_room_settings"
        private const val KEY_MODE = "mode"

        private fun detectDeviceType(context: Context): DeviceType {
            val uiModeType = context.resources.configuration.uiMode and
                Configuration.UI_MODE_TYPE_MASK
            val reportsTelevisionMode =
                uiModeType == Configuration.UI_MODE_TYPE_TELEVISION
            val hasLeanback = context.packageManager.hasSystemFeature(
                PackageManager.FEATURE_LEANBACK,
            )

            return if (reportsTelevisionMode || hasLeanback) {
                DeviceType.TV
            } else {
                DeviceType.TABLET_OR_PHONE
            }
        }
    }
}
