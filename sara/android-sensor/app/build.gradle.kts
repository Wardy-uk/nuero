plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Signing. The repo is PUBLIC, so the key never lives in it: CI decodes it from a
// GitHub secret into SARA_SENSOR_KEYSTORE. A stable key is what lets a new build
// install OVER the old one and keep the settings (including the IRK typed into the
// tablet). Without the secret the build falls back to a throwaway debug key, which
// installs fine the first time and needs an uninstall before every update after.
val keystorePath: String? = System.getenv("SARA_SENSOR_KEYSTORE")

android {
    namespace = "uk.nickward.sara.sensor"
    compileSdk = 34

    defaultConfig {
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
                storePassword = System.getenv("SARA_SENSOR_KEYSTORE_PASSWORD")
                keyAlias = "sara-sensor"
                keyPassword = System.getenv("SARA_SENSOR_KEYSTORE_PASSWORD")
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
