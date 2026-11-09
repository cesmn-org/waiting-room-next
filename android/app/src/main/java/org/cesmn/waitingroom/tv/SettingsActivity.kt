package org.cesmn.waitingroom.tv

import android.app.Activity
import android.os.Bundle
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.TextView

class SettingsActivity : Activity() {
    private lateinit var settings: AppSettings

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        settings = AppSettings(this)

        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 48, 48, 48)
        }
        content.addView(TextView(this).apply {
            text = "Waiting Room settings"
            textSize = 24f
        })
        content.addView(TextView(this).apply {
            text = "Choose the interface this device should display."
            textSize = 16f
        })
        content.addView(TextView(this).apply {
            text = "Detected device type: ${settings.detectedDeviceType.label}"
            textSize = 16f
        })

        val modeGroup = RadioGroup(this).apply {
            orientation = RadioGroup.VERTICAL
        }
        val tvOption = RadioButton(this).apply {
            id = TV_OPTION_ID
            text = "TV interface"
            textSize = 18f
        }
        val tabletOption = RadioButton(this).apply {
            id = TABLET_OPTION_ID
            text = "Tablet interface"
            textSize = 18f
        }
        modeGroup.addView(tvOption)
        modeGroup.addView(tabletOption)
        modeGroup.check(if (settings.mode == AppSettings.Mode.TV) TV_OPTION_ID else TABLET_OPTION_ID)
        content.addView(modeGroup, LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)

        val saveButton = Button(this).apply {
            text = "Save and open"
            setOnClickListener {
                settings.mode = if (modeGroup.checkedRadioButtonId == TABLET_OPTION_ID) {
                    AppSettings.Mode.TABLET
                } else {
                    AppSettings.Mode.TV
                }
                setResult(RESULT_OK)
                finish()
            }
        }
        val saveParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        )
        saveParams.topMargin = 32
        content.addView(saveButton, saveParams)
        setContentView(content)
    }

    companion object {
        private const val TV_OPTION_ID = 1001
        private const val TABLET_OPTION_ID = 1002
    }
}
