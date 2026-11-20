use super::*;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::fs;

const CANDIDATE: &[u8] = b"inert AniVerse2 application for native migration tests";
const TIMEOUT: Duration = Duration::from_secs(5);

struct Fixture {
    _folder: tempfile::TempDir,
    parent: PathBuf,
    data: PathBuf,
    config: PathBuf,
    application: PathBuf,
    marker: PathBuf,
    envelope: Value,
    pins: Vec<String>,
}

impl Fixture {
    fn new() -> Self {
        let cache =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test/cache/tauri-compat/handoff");
        fs::create_dir_all(&cache).unwrap();
        let folder = tempfile::tempdir_in(cache).unwrap();
        let parent = folder.path().to_path_buf();
        let data = parent.join("legacy");
        let config = parent.join("custom config");
        let application = parent.join("AniVerse2.exe");
        let job = data.join("windows-migration/attempt-fixture");
        fs::create_dir_all(&job).unwrap();
        fs::create_dir(&config).unwrap();
        fs::write(
            config.join("streaming-sites.txt"),
            b"# original\r\nhttps://fixture.test/\r\n",
        )
        .unwrap();
        fs::write(data.join("profile.id"), "legacy fixture").unwrap();
        fs::write(&application, CANDIDATE).unwrap();
        let db = Connection::open(data.join("aniverse.db")).unwrap();
        db.execute_batch(
            "PRAGMA user_version=7; CREATE TABLE history (position INTEGER);
                          INSERT INTO history VALUES (87);",
        )
        .unwrap();
        let envelope: Value = serde_json::from_str(include_str!(
            "../fixtures/windows-native-handoff-signature.json"
        ))
        .unwrap();
        let pins = vec![envelope["pin"].as_str().unwrap().to_owned()];
        let fixture = Self {
            _folder: folder,
            parent,
            data,
            config,
            application,
            marker: job.join("electron-handoff.json"),
            envelope: envelope["offer"].clone(),
            pins,
        };
        fixture.write(&fixture.descriptor());
        fixture
    }

    fn descriptor(&self) -> Value {
        json!({
            "schema": 1, "nonce": "98eed90d-69bf-4249-8a00-633b333e5980",
            "legacyPid": 42, "legacyVersion": "9.2.4",
            "legacyExecutable": self.parent.join("AniVerse.exe"),
            "dataDir": self.data, "configDir": self.config,
            "preferences": {"aniverse.historyView":"list", "aniverse.desktop-theme":"midnight"},
            "signedRelease": self.envelope,
        })
    }

    fn write(&self, value: &Value) {
        fs::write(&self.marker, serde_json::to_vec(value).unwrap()).unwrap();
    }

    fn verify(&self) -> Result<VerifiedHandoff, HandoffError> {
        verify(
            &self.marker,
            &self.data,
            &self.application,
            "9.3.0",
            &self.pins,
        )
    }
}

#[test]
fn signed_windows_handoff_stages_sources_history_and_renderer_preferences() {
    let fixture = Fixture::new();
    use std::{
        os::windows::process::CommandExt,
        process::{Command, Stdio},
    };
    use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;
    let mut child = Command::new(std::env::current_exe().unwrap())
        .arg("--list")
        .stdout(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .unwrap();
    let legacy_pid = child.id();
    assert!(child.wait().unwrap().success());
    let mut descriptor = fixture.descriptor();
    descriptor["legacyPid"] = json!(legacy_pid);
    fixture.write(&descriptor);
    let job = fixture.verify().unwrap();
    assert_eq!(job.legacy_process().0, legacy_pid);
    assert_eq!(job.nonce().get_version_num(), 4);
    let stage = job
        .stage_after_exit(&fixture.parent, 7, TIMEOUT, TIMEOUT)
        .unwrap();
    let file = fs::read(stage.path().join("config/streaming-sites.txt")).unwrap();
    assert_eq!(
        file,
        fs::read(fixture.config.join("streaming-sites.txt")).unwrap()
    );
    let prefs: Value =
        serde_json::from_slice(&fs::read(stage.path().join("renderer-preferences.json")).unwrap())
            .unwrap();
    assert_eq!(prefs["aniverse.desktop-theme"], "midnight");
    let db = Connection::open(stage.path().join("aniverse.db")).unwrap();
    assert_eq!(
        db.query_row("SELECT position FROM history", [], |row| row
            .get::<_, i32>(0))
            .unwrap(),
        87
    );
}

#[test]
fn tampered_manifest_and_wrong_application_are_rejected() {
    let fixture = Fixture::new();
    let mut tampered = fixture.descriptor();
    tampered["signedRelease"]["manifest"] = json!("e30=");
    fixture.write(&tampered);
    assert!(matches!(fixture.verify(), Err(HandoffError::Signature)));
    fixture.write(&fixture.descriptor());
    fs::write(&fixture.application, b"wrong candidate").unwrap();
    assert!(matches!(
        fixture.verify(),
        Err(HandoffError::ApplicationHash)
    ));
}

#[test]
fn rejects_other_profile_and_unknown_desktop_settings() {
    let fixture = Fixture::new();
    let mut other = fixture.descriptor();
    other["dataDir"] = json!(fixture.parent);
    fixture.write(&other);
    assert!(matches!(fixture.verify(), Err(HandoffError::Invalid)));
    let mut invalid = fixture.descriptor();
    invalid["preferences"]["unrelated-token"] = json!("fake");
    fixture.write(&invalid);
    assert!(matches!(fixture.verify(), Err(HandoffError::Invalid)));
}

#[test]
fn only_pinned_signers_and_eligible_versions_can_stage() {
    let fixture = Fixture::new();
    assert!(matches!(
        VerifiedHandoff::open(
            &fixture.marker,
            &fixture.data,
            &fixture.application,
            "9.3.0"
        ),
        Err(HandoffError::Signature)
    ));
    assert!(matches!(
        verify(
            &fixture.marker,
            &fixture.data,
            &fixture.application,
            "9.3.1",
            &fixture.pins
        ),
        Err(HandoffError::Invalid)
    ));
    let mut downgrade = fixture.descriptor();
    downgrade["legacyVersion"] = json!("9.3.0");
    fixture.write(&downgrade);
    assert!(matches!(fixture.verify(), Err(HandoffError::Invalid)));
}

#[test]
fn checks_live_process_identity_and_refuses_to_stage_while_running() {
    let pid = std::process::id();
    let executable = std::env::current_exe().unwrap();
    let fixture = Fixture::new();
    let path = fixture.parent.join("AniVerse.exe");
    fs::write(&path, b"different executable").unwrap();
    assert!(matches!(
        crate::legacy_process::wait_for_legacy_exit(pid, &path, Duration::ZERO),
        Err(HandoffError::LegacyProcessMismatch)
    ));
    assert!(matches!(
        crate::legacy_process::wait_for_legacy_exit(pid, &executable, Duration::ZERO),
        Err(HandoffError::LegacyStillRunning)
    ));
}
