plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Signing. The repo is PUBLIC, so the key never lives in it: CI decodes it from a
// GitHub secret into SAIM_SENSOR_KEYSTORE. A stable key is what lets a new build
// install OVER the old one and keep the settings (including the IRK typed into the
// tablet). Without the secret the build falls back to a throwaway debug key, which
// installs fine the first time and needs an uninstall before every update after.
val keystorePath: String? = System.getenv("SAIM_SENSOR_KEYSTORE")

android {
    namespace = "uk.nickward.saim.sensor"
    compileSdk = 34

    defaultConfig {
        // ⚠ NOT RENAMED, and deliberately different from `namespace` above.
        // applicationId is the INSTALL IDENTITY on the study tablet. Change it and
        // Android treats this as a different app: the existing one is not upgraded
        // but installed alongside, Bluetooth/Location permissions reset, and the
        // provisioned token and room in SharedPreferences are gone — leaving a
        // silent second sensor reporting nothing. Same call as the iOS bundle id.
        applicationId = "uk.nickward.sara.sensor"
        // 8.0. The office tablet (Galaxy Tab A 10.1 2016, SM-T585) runs 8.1.
        minSdk = 26
        targetSdk = 34
        versionCode = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()
        versionName = "0.1.$versionCode"
    }

    signingConfigs {
        if (keystorePath != null) {
            create("stable") {
                storeFile = file(keystorePath)
                storePassword = System.getenv("SAIM_SENSOR_KEYSTORE_PASSWORD")
                keyAlias = "saim-sensor"
                keyPassword = System.getenv("SAIM_SENSOR_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("stable") ?: signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    lint {
        // A sideloaded single-device sensor; the unit tests are the gate, not lint.
        checkReleaseBuilds = false
        abortOnError = false
    }
}

dependencies {
    testImplementation("junit:junit:4.13.2")
}
