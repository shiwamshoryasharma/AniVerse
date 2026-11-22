use super::{Dsp, Input, Output, MAX_CHANNELS, MAX_FRAMES};

static mut INPUT: Input = [[0.0; MAX_FRAMES]; MAX_CHANNELS];
static mut OUTPUT: Output = [[0.0; MAX_FRAMES]; 2];
static mut DSP: Option<Dsp> = None;

#[no_mangle]
pub extern "C" fn qa_max_frames() -> u32 {
    MAX_FRAMES as u32
}

#[no_mangle]
pub extern "C" fn qa_input_ptr() -> u32 {
    (&raw mut INPUT) as u32
}

#[no_mangle]
pub extern "C" fn qa_output_ptr() -> u32 {
    (&raw mut OUTPUT) as u32
}

#[no_mangle]
pub extern "C" fn qa_init(sample_rate: f32) -> i32 {
    // The worklet owns one non-shared Wasm instance and calls each export synchronously.
    let state = Dsp::new(sample_rate);
    let valid = state.is_some();
    unsafe {
        *(&raw mut DSP) = state;
    }
    i32::from(valid)
}

#[no_mangle]
pub extern "C" fn qa_reset() -> i32 {
    // The worklet calls this between process blocks without outstanding Rust borrows.
    let Some(dsp) = (unsafe { (&mut *(&raw mut DSP)).as_mut() }) else {
        return 0;
    };
    dsp.reset();
    1
}

#[no_mangle]
pub extern "C" fn qa_process(frames: u32, channels: u32, intensity: f32) -> i32 {
    // The host writes input before the call and reads output after it. The fixed
    // linear-memory planes are disjoint and this ABI does not support shared memory.
    unsafe {
        let Some(dsp) = (&mut *(&raw mut DSP)).as_mut() else {
            return 0;
        };
        i32::from(dsp.process(
            &*(&raw const INPUT),
            &mut *(&raw mut OUTPUT),
            frames as usize,
            channels as usize,
            intensity,
        ))
    }
}
