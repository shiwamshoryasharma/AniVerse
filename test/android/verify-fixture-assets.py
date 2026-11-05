from pathlib import Path
import zipfile
root=Path(__file__).resolve().parents[2]
assets=root/'android/app/src/main/assets'
apk=root/'test/cache/android-0.1.0/build/app/outputs/apk/debug/app-debug.apk'
with zipfile.ZipFile(apk) as archive:
    for file in assets.rglob('*'):
        if file.is_file():
            assert archive.read('assets/'+file.relative_to(assets).as_posix())==file.read_bytes(), 'Native asset renamed or changed: '+file.name
print('Native APK assets match source bytes')
