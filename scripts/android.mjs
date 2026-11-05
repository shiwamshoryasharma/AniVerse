// Build APKs with a fresh shared UI; signing configuration never enters stdout or assets.
import {spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,copyFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const mode=process.argv[2]??'debug';if(!['debug','release','fixture'].includes(mode))throw Error('Choose debug, release or the explicit fixture test build.');
// Cache paths are intentionally stable: Gradle and maintained harnesses share them.
const cache=path.join(root,'test/cache/android-0.1.0');
const androidManifest=readFileSync(path.join(root,'android/app/build.gradle.kts'),'utf8');
const androidVersion=androidManifest.match(/^\s*versionName\s*=\s*"(\d+\.\d+\.\d+)"\s*$/m)?.[1];
if(!androidVersion)throw Error('Android versionName must be a numeric major.minor.patch version.');
for(const folder of ['temp','gradle-home','project-cache','android-home'])mkdirSync(path.join(cache,folder),{recursive:true});
const sdk=process.env.ANDROID_HOME??process.env.ANDROID_SDK_ROOT??path.join(process.env.LOCALAPPDATA??'','Android/Sdk');
const javaHome=process.env.JAVA_HOME??'C:/Program Files/Android/Android Studio/jbr';
const java=path.join(javaHome,'bin',process.platform==='win32'?'java.exe':'java');
if(!existsSync(java)||!existsSync(sdk))throw Error('Install Android Studio/SDK and set JAVA_HOME and ANDROID_HOME. See docs/ANDROID.md.');
const env={...process.env,JAVA_HOME:javaHome,ANDROID_HOME:sdk,GRADLE_USER_HOME:path.join(cache,'gradle-home'),ANDROID_USER_HOME:path.join(cache,'android-home'),TEMP:path.join(cache,'temp'),TMP:path.join(cache,'temp')};
if(mode==='release'){
 const filename=path.join(root,'config/android-signing.json');
 if(existsSync(filename)){
  const config=JSON.parse(readFileSync(filename,'utf8'));
  env.ANIVERSE_ANDROID_KEYSTORE=path.resolve(root,config.keystore);env.ANIVERSE_ANDROID_STORE_PASSWORD=config.storePassword;env.ANIVERSE_ANDROID_KEY_PASSWORD=config.keyPassword;
 }
 if(!env.ANIVERSE_ANDROID_KEYSTORE||!env.ANIVERSE_ANDROID_STORE_PASSWORD||!env.ANIVERSE_ANDROID_KEY_PASSWORD)throw Error('Android release signing is not configured. See docs/ANDROID.md.');
}
function run(binary,args){const result=spawnSync(binary,args,{cwd:root,env,stdio:'inherit'});if(result.error)throw result.error;if(result.status!==0)process.exit(result.status??1);}
run(process.execPath,['scripts/build-android.mjs']);
run(java,['-Dorg.gradle.appname=gradlew','-classpath',path.join(root,'android/gradle/wrapper/gradle-wrapper.jar'),'org.gradle.wrapper.GradleWrapperMain','-p',path.join(root,'android'),'--project-cache-dir',path.join(cache,'project-cache'),mode==='release'?':app:assembleRelease':':app:assembleDebug',...(mode==='fixture'?['-PaniverseFixture=true']:[]),...(mode==='release'?[':app:lintRelease']:[])]);
if(mode==='release'){
 const directory='android-'+androidVersion,filename='AniVerse-Android-'+androidVersion+'.apk';
 const output=path.join(root,'release',directory);mkdirSync(output,{recursive:true});
 copyFileSync(path.join(cache,'build/app/outputs/apk/release/app-release.apk'),path.join(output,filename));
 console.log('Signed Android APK → '+path.join('release',directory,filename));
}
