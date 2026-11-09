package org.cesmn.waitingroom.tv

import android.content.Context

class AppSettings(context: Context) {
    private val preferences = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    var mode: Mode
        get() = Mode.fromValue(preferences.getString(KEY_MODE, null))
        set(value) {
            preferences.edit().putString(KEY_MODE, value.value).apply()
        }

    enum class Mode(val value: String, val path: String) {
        TV("tv", "/tv"),
        TABLET("tablet", "/tablet");

        companion object {
            fun fromValue(value: String?): Mode =
                entries.firstOrNull { it.value == value } ?: TV
        }
    }

    companion object {
        private const val PREFERENCES_NAME = "waiting_room_settings"
        private const val KEY_MODE = "mode"
    }
}
