import java.util.Properties
import javax.inject.Inject
import org.gradle.process.ExecOperations
import org.gradle.work.DisableCachingByDefault

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

@DisableCachingByDefault(because = "The pinned downloads already have a shared local cache")
abstract class PrepareVoiceAssets : DefaultTask() {
    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val script: RegularFileProperty

    @get:Internal
    abstract val downloadCache: DirectoryProperty

    @get:OutputDirectory
    abstract val assets: DirectoryProperty

    @get:OutputFile
    abstract val aar: RegularFileProperty

    @get:Inject
    abstract val execOperations: ExecOperations

    @TaskAction
    fun prepare() {
        val python = if (System.getProperty("os.name").startsWith("Windows")) "python" else "python3"
        execOperations.exec {
            commandLine(
                python,
                script.get().asFile,
                downloadCache.get().asFile,
                assets.get().asFile,
                aar.get().asFile,
            )
        }
    }
}

val prepareVoiceAssets = tasks.register<PrepareVoiceAssets>("prepareVoiceAssets") {
    script.set(layout.projectDirectory.file("prepare-voice-assets.py"))
    downloadCache.fileValue(gradle.gradleUserHomeDir.resolve("caches/cloudcli-android-voice"))
    aar.set(layout.buildDirectory.file("voice-libs/sherpa-onnx-2.0.2.aar"))
}

// Release signing lives outside the repository:
//   ${CLOUDCLI_ANDROID_SIGNING_DIR:-$HOME/.cloudcli/android-signing}/signing.properties
// HOME (not user.home) is authoritative: the JVM user.home can differ from the session HOME.
val userHome: String = System.getenv("HOME") ?: System.getProperty("user.home")
val signingDir: File = File(
    System.getenv("CLOUDCLI_ANDROID_SIGNING_DIR") ?: File(userHome, ".cloudcli/android-signing").path,
)
val signingPropsFile = File(signingDir, "signing.properties")
val signingProps = Properties().apply {
    if (signingPropsFile.isFile) signingPropsFile.inputStream().use { load(it) }
}
val releaseStoreFile: File? = signingProps.getProperty("storeFile")?.let { configured ->
    val file = File(configured)
    if (file.isAbsolute) file else File(signingDir, configured)
}

android {
    namespace = "ai.cloudcli.android"
    compileSdk = 36
    buildToolsVersion = "36.0.0"

    defaultConfig {
        applicationId = "ai.cloudcli.android"
        minSdk = 26
        targetSdk = 36
        // 0.1.0 (code 1) shipped the first real-device build; 0.1.3 must install over 0.1.2 (code 3).
        versionCode = 4
        versionName = "0.1.3"
    }

    signingConfigs {
        if (releaseStoreFile?.isFile == true) {
            create("release") {
                storeFile = releaseStoreFile
                storeType = signingProps.getProperty("storeType", "PKCS12")
                keyAlias = signingProps.getProperty("keyAlias")
                storePassword = signingProps.getProperty("storePassword")
                keyPassword = signingProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            isShrinkResources = false
            signingConfigs.findByName("release")?.let { signingConfig = it }
        }
    }

    buildFeatures {
        buildConfig = true
    }

    androidResources {
        // AssetManager can map the large model files directly from the APK.
        noCompress += listOf("onnx", "bin")
    }

    packaging {
        jniLibs.useLegacyPackaging = false
    }

    // Release lint vitals are skipped so a release build does not need the lint artifacts;
    // `lintDebug` is the enforced lint gate and is run by scripts/build-android-release.sh.
    lint {
        checkReleaseBuilds = false
        abortOnError = true
        warningsAsErrors = false
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

androidComponents.onVariants { variant ->
    variant.sources.assets?.addGeneratedSourceDirectory(prepareVoiceAssets, PrepareVoiceAssets::assets)
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation(files(prepareVoiceAssets.flatMap { it.aar }).builtBy(prepareVoiceAssets))

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20180813")
}
