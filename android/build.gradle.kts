plugins { id("com.android.application") version "9.5.0" apply false }
allprojects { layout.buildDirectory.set(rootDir.resolve("../test/cache/android-0.1.0/build/${project.name}")) }
