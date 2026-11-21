use serde_json::{json, Value};
use std::{
    ffi::{OsStr, OsString},
    io::{self, BufRead, BufReader, Read, Write},
    os::windows::{
        ffi::{OsStrExt, OsStringExt},
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::{Path, PathBuf},
    ptr::{null, null_mut},
    sync::mpsc::{self, Receiver, RecvTimeoutError},
    time::{Duration, Instant},
};
use tempfile::TempDir;
use windows_sys::Win32::{
    Foundation::{SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT, WAIT_TIMEOUT},
    System::Com::CoTaskMemFree,
    System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    },
    System::Threading::{
        CreateProcessW, DeleteProcThreadAttributeList, InitializeProcThreadAttributeList,
        ResumeThread, TerminateProcess, UpdateProcThreadAttribute, WaitForSingleObject,
        CREATE_SUSPENDED, EXTENDED_STARTUPINFO_PRESENT, PROCESS_INFORMATION,
        PROC_THREAD_ATTRIBUTE_HANDLE_LIST, STARTUPINFOEXW,
    },
    UI::Shell::{
        FOLDERID_LocalAppData, FOLDERID_ProgramFiles, FOLDERID_ProgramFilesX86,
        SHGetKnownFolderPath,
    },
};

const FRAME_LIMIT: u64 = 1024 * 1024;
const IO_PAUSE: Duration = Duration::from_millis(100);

pub(super) struct Pipe {
    input: io::PipeWriter,
    messages: Receiver<Value>,
    process: OwnedHandle,
    _job: OwnedHandle,
    id: u64,
    _profile: TempDir,
}

impl Pipe {
    pub(super) fn launch(folder: &Path, url: &str) -> io::Result<Self> {
        let chrome = [
            &FOLDERID_ProgramFiles,
            &FOLDERID_ProgramFilesX86,
            &FOLDERID_LocalAppData,
        ]
        .into_iter()
        .filter_map(known_folder)
        .map(|folder| folder.join("Google/Chrome/Application/chrome.exe"))
        .find(|path| path.is_file())
        .ok_or_else(|| {
            io::Error::new(io::ErrorKind::NotFound, "Google Chrome is not installed.")
        })?;
        std::fs::create_dir_all(folder)?;
        let profile = tempfile::Builder::new()
            .prefix("chrome-cast-")
            .tempdir_in(folder)?;
        let (child_input, input) = io::pipe()?;
        let (output, child_output) = io::pipe()?;
        let inherit = [child_input.as_raw_handle(), child_output.as_raw_handle()];
        let mut profile_argument = OsString::from("--user-data-dir=");
        profile_argument.push(dunce::simplified(profile.path()));
        let pipe_argument = OsString::from(format!(
            "--remote-debugging-io-pipes={},{}",
            inherit[0] as usize, inherit[1] as usize,
        ));
        let flags = [
            chrome.as_os_str(),
            &profile_argument,
            &pipe_argument,
            OsStr::new("--remote-debugging-pipe"),
            OsStr::new("--no-first-run"),
            OsStr::new("--no-default-browser-check"),
            OsStr::new("--autoplay-policy=no-user-gesture-required"),
            OsStr::new("--new-window"),
            OsStr::new(url),
        ];
        let job = browser_job()?;
        let process = start(&chrome, &flags, &inherit, &job)?;
        drop((child_input, child_output));
        let (send, messages) = mpsc::sync_channel(32);
        std::thread::Builder::new()
            .name("aniverse-chrome-pipe".into())
            .spawn(move || {
                let mut pipe = BufReader::new(output);
                let mut bytes = Vec::new();
                loop {
                    bytes.clear();
                    let Ok(size) = (&mut pipe).take(FRAME_LIMIT + 1).read_until(0, &mut bytes)
                    else {
                        break;
                    };
                    if size == 0 || size as u64 > FRAME_LIMIT || bytes.pop() != Some(0) {
                        break;
                    }
                    let Ok(value) = serde_json::from_slice(&bytes) else {
                        break;
                    };
                    if send.send(value).is_err() {
                        break;
                    }
                }
            })
            .map_err(|error| {
                terminate(&process);
                error
            })?;
        Ok(Self {
            input,
            messages,
            process,
            _job: job,
            id: 0,
            _profile: profile,
        })
    }

    pub(super) fn send(
        &mut self,
        method: &str,
        params: Value,
        session: Option<&str>,
    ) -> io::Result<u64> {
        self.id += 1;
        let mut request = json!({"id":self.id,"method":method,"params":params});
        if let Some(session) = session {
            request["sessionId"] = json!(session);
        }
        let mut frame = serde_json::to_vec(&request).map_err(io::Error::other)?;
        if frame.len() as u64 >= FRAME_LIMIT {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        frame.push(0);
        self.input.write_all(&frame)?;
        Ok(self.id)
    }

    pub(super) fn receive(&self, deadline: Instant) -> io::Result<Option<Value>> {
        let wait = deadline
            .saturating_duration_since(Instant::now())
            .min(IO_PAUSE);
        match self.messages.recv_timeout(wait) {
            Ok(message) => Ok(Some(message)),
            Err(RecvTimeoutError::Timeout) => Ok(None),
            Err(RecvTimeoutError::Disconnected) => {
                Err(io::Error::other("The Chrome casting window closed."))
            }
        }
    }
}

impl Drop for Pipe {
    fn drop(&mut self) {
        let _ = self.send("Browser.close", json!({}), None);
        if unsafe { WaitForSingleObject(self.process.as_raw_handle(), 1800) } == WAIT_TIMEOUT {
            terminate(&self.process);
        }
    }
}

fn terminate(process: &OwnedHandle) {
    // The handle refers to the exact process started with this isolated profile.
    unsafe {
        if WaitForSingleObject(process.as_raw_handle(), 0) == WAIT_TIMEOUT {
            let _ = TerminateProcess(process.as_raw_handle(), 1);
            let _ = WaitForSingleObject(process.as_raw_handle(), 1500);
        }
    }
}

fn known_folder(id: &windows_sys::core::GUID) -> Option<PathBuf> {
    let mut folder = null_mut();
    if unsafe { SHGetKnownFolderPath(id, 0, null_mut(), &mut folder) } < 0 || folder.is_null() {
        return None;
    }
    let mut len = 0;
    unsafe {
        while *folder.add(len) != 0 {
            len += 1;
        }
        let value = OsString::from_wide(std::slice::from_raw_parts(folder, len));
        CoTaskMemFree(folder.cast());
        Some(PathBuf::from(value))
    }
}

fn browser_job() -> io::Result<OwnedHandle> {
    let job = unsafe { CreateJobObjectW(null(), null()) };
    if job.is_null() {
        return Err(io::Error::last_os_error());
    }
    let job = unsafe { OwnedHandle::from_raw_handle(job) };
    let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if unsafe {
        SetInformationJobObject(
            job.as_raw_handle(),
            JobObjectExtendedLimitInformation,
            (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of_val(&info) as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(job)
}

fn start(
    path: &Path,
    args: &[&OsStr],
    handles: &[HANDLE; 2],
    job: &OwnedHandle,
) -> io::Result<OwnedHandle> {
    let app: Vec<_> = path.as_os_str().encode_wide().chain([0]).collect();
    let mut command = quote_arguments(args)?;
    let mut size = 0;
    unsafe {
        InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut size);
    }
    if !(16..=65536).contains(&size) {
        return Err(io::Error::last_os_error());
    }
    let mut backing = vec![0usize; size.div_ceil(size_of::<usize>())];
    let list = backing.as_mut_ptr().cast();
    if unsafe { InitializeProcThreadAttributeList(list, 1, 0, &mut size) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let attribute = unsafe {
        UpdateProcThreadAttribute(
            list,
            0,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
            handles.as_ptr().cast(),
            size_of_val(handles),
            null_mut(),
            null(),
        )
    };
    let result = if attribute == 0 {
        Err(io::Error::last_os_error())
    } else {
        launch_process(&app, &mut command, handles, list, job)
    };
    unsafe {
        DeleteProcThreadAttributeList(list);
    }
    result
}

fn launch_process(
    app: &[u16],
    command: &mut [u16],
    handles: &[HANDLE; 2],
    list: windows_sys::Win32::System::Threading::LPPROC_THREAD_ATTRIBUTE_LIST,
    job: &OwnedHandle,
) -> io::Result<OwnedHandle> {
    for handle in handles {
        if unsafe { SetHandleInformation(*handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) } == 0 {
            return Err(io::Error::last_os_error());
        }
    }
    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.lpAttributeList = list;
    let mut process = PROCESS_INFORMATION::default();
    let launched = unsafe {
        CreateProcessW(
            app.as_ptr(),
            command.as_mut_ptr(),
            null(),
            null(),
            1,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED,
            null(),
            null(),
            &startup.StartupInfo,
            &mut process,
        )
    };
    if launched == 0 {
        return Err(io::Error::last_os_error());
    }
    // CreateProcessW returned two owned handles. The thread handle is not needed.
    let child = unsafe { OwnedHandle::from_raw_handle(process.hProcess) };
    let thread = unsafe { OwnedHandle::from_raw_handle(process.hThread) };
    if unsafe { AssignProcessToJobObject(job.as_raw_handle(), child.as_raw_handle()) } == 0
        || unsafe { ResumeThread(thread.as_raw_handle()) } == u32::MAX
    {
        let error = io::Error::last_os_error();
        terminate(&child);
        return Err(error);
    }
    Ok(child)
}

fn quote_arguments(args: &[&OsStr]) -> io::Result<Vec<u16>> {
    let mut line = Vec::new();
    for arg in args {
        if !line.is_empty() {
            line.push(b' ' as u16);
        }
        line.push(b'"' as u16);
        let mut slash = 0;
        for character in arg.encode_wide() {
            match character {
                0 => return Err(io::ErrorKind::InvalidInput.into()),
                92 => {
                    slash += 1;
                    continue;
                }
                34 => {
                    line.extend(std::iter::repeat_n(92, slash + 1));
                }
                _ => {}
            }
            line.extend(std::iter::repeat_n(92, slash));
            line.push(character);
            slash = 0;
        }
        line.extend(std::iter::repeat_n(92, slash * 2));
        line.push(b'"' as u16);
    }
    line.push(0);
    Ok(line)
}
