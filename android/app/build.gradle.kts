import java.util.Properties
import java.net.URI

plugins { id("com.android.application") }
val fixtureBuild = providers.gradleProperty("aniverseFixture").orNull == "true"
val fixtureOrigins=Properties().apply{
    if(fixtureBuild)rootDir.resolve("../test/android/fixture-origins.properties").inputStream().use{load(it)}
}
fun fixtureOrigin(key:String):String{
    if(!fixtureBuild)return ""
    val value=fixtureOrigins.getProperty(key).orEmpty().trim()
    val uri=URI(value)
    require(uri.scheme=="http"&&uri.host=="10.0.2.2"&&uri.port in 1..65535&&uri.rawUserInfo==null&&
        uri.rawPath.isNullOrEmpty()&&uri.rawQuery==null&&uri.rawFragment==null){"Invalid exact fixture origin: "+key}
    return value
}
val fixtureApiOrigin=fixtureOrigin("api")
val fixtureMediaOrigin=fixtureOrigin("media")
android {
    namespace = "app.aniverse.tablet"
    compileSdk = 37
    defaultConfig {
        applicationId = "app.aniverse.tablet"
        minSdk = 35
        targetSdk = 35
        versionCode = 407
        versionName = "0.4.7"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    buildFeatures { buildConfig = true }
    signingConfigs {
        create("release") {
            val keyPath = System.getenv("ANIVERSE_ANDROID_KEYSTORE")
            if (keyPath != null) {
                storeFile = file(keyPath)
                storePassword = System.getenv("ANIVERSE_ANDROID_STORE_PASSWORD")
                keyAlias = "aniverse-tablet"
                keyPassword = System.getenv("ANIVERSE_ANDROID_KEY_PASSWORD")
            }
        }
    }
    buildTypes {
        debug {
            applicationIdSuffix = if(fixtureBuild) ".fixture" else ".debug"
            buildConfigField("String", "TEST_ORIGIN", "\""+fixtureApiOrigin+"\"")
            buildConfigField("String", "TEST_MEDIA_ORIGIN", "\""+fixtureMediaOrigin+"\"")
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            signingConfig = signingConfigs.getByName("release")
            buildConfigField("String", "TEST_ORIGIN", "\"\"")
            buildConfigField("String", "TEST_MEDIA_ORIGIN", "\"\"")
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 }
    sourceSets {
        if(fixtureBuild){
            getByName("debug").manifest.srcFile(rootDir.resolve("../test/android/config/AndroidManifest.xml"))
            getByName("debug").kotlin.directories.add(rootDir.resolve("../test/android/fixture").path)
        }
        getByName("main").assets.srcDir(rootDir.resolve("../dist/android"))
        getByName("test").kotlin.directories.add(rootDir.resolve("../test/android/unit").path)
        if(fixtureBuild){
            getByName("androidTest").kotlin.directories.add(rootDir.resolve("../test/android/instrumented").path)
            getByName("androidTest").assets.srcDir(rootDir.resolve("../test/cache/android-0.1.0/fixture-assets"))
        }
    }
    testOptions { unitTests.isReturnDefaultValues = true }
    lint { abortOnError = true; checkReleaseBuilds = true }
}
dependencies {
    constraints {
        implementation("com.google.guava:guava:33.7.2-android") { because("CVE-2026-102554: avoid vulnerable transitive Java deserialization implementations.") }
    }
    implementation("androidx.webkit:webkit:1.18.0")
    implementation("androidx.media3:media3-exoplayer:1.11.1")
    implementation("androidx.media3:media3-exoplayer-hls:1.11.1")
    implementation("androidx.media3:media3-ui:1.11.1")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
}
