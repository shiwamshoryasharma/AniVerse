use crate::handoff::HandoffError;
use std::{
    ffi::OsString,
    io,
    os::windows::{
        ffi::OsStringExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::{Path, PathBuf},
    time::Duration,
};
use windows_sys::Win32::{
    Foundation::{ERROR_INVALID_PARAMETER, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT},
    System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, WaitForSingleObject,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    },
};

pub(crate) fn wait_for_legacy_exit(
    pid: u32,
    expected: &Path,
    timeout: Duration,
) -> Result<(), HandoffError> {
    let handle = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            pid,
        )
    };
    if handle.is_null() {
        let error = io::Error::last_os_error();
        // The Electron process normally starts setup and then exits immediately.
        return if pid != 0 && error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) {
            Ok(())
        } else {
            Err(error.into())
        };
    }
    // OpenProcess returns a process handle owned exclusively by this call.
    let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
    // Another process can keep an exited Electron process object alive.
    if unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) } == WAIT_OBJECT_0 {
        return Ok(());
    }
    let mut buffer = vec![0_u16; 32_768];
    let mut len = buffer.len() as u32;
    if unsafe {
        QueryFullProcessImageNameW(handle.as_raw_handle(), 0, buffer.as_mut_ptr(), &mut len)
    } == 0
    {
        let error = io::Error::last_os_error();
        // The process can also exit between the initial check and the query.
        return if unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) } == WAIT_OBJECT_0 {
            Ok(())
        } else {
            Err(error.into())
        };
    }
    let actual = PathBuf::from(OsString::from_wide(&buffer[..len as usize])).canonicalize()?;
    if actual != expected.canonicalize()? {
        return Err(HandoffError::LegacyProcessMismatch);
    }
    let milliseconds = timeout.as_millis().min(u128::from(u32::MAX - 1)) as u32;
    match unsafe { WaitForSingleObject(handle.as_raw_handle(), milliseconds) } {
        WAIT_OBJECT_0 => Ok(()),
        WAIT_TIMEOUT => Err(HandoffError::LegacyStillRunning),
        WAIT_FAILED => Err(io::Error::last_os_error().into()),
        _ => Err(HandoffError::Invalid),
    }
}
