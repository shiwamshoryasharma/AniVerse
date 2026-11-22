pub const MAX_FRAMES: usize = 128;
pub const MAX_CHANNELS: usize = 8;
pub type Input = [[f32; MAX_FRAMES]; MAX_CHANNELS];
pub type Output = [[f32; MAX_FRAMES]; 2];

const HISTORY: usize = 128;
const ROOM_HISTORY: usize = 1024;
const LOW_SHELF_GAIN: f32 = 0.333_521_43; // 10^(2.5/20) - 1
const CENTER: f32 = std::f32::consts::FRAC_1_SQRT_2;

#[derive(Clone, Copy)]
enum Position {
    Front(usize),
    Side(usize),
    Rear(usize),
    Center,
    Lfe,
}

const FRONT: [Position; 2] = [Position::Front(0), Position::Front(1)];
const QUAD: [Position; 4] = [FRONT[0], FRONT[1], Position::Side(0), Position::Side(1)];
const SURROUND: [Position; 6] = [
    FRONT[0],
    FRONT[1],
    Position::Center,
    Position::Lfe,
    QUAD[2],
    QUAD[3],
];
// Conventional Chromium 7.1 ordering: FL, FR, FC, LFE, BL, BR, SL, SR.
const SURROUND_BACK: [Position; 8] = [
    FRONT[0],
    FRONT[1],
    Position::Center,
    Position::Lfe,
    Position::Rear(0),
    Position::Rear(1),
    Position::Side(0),
    Position::Side(1),
];

#[derive(Clone, Copy)]
struct Tap {
    whole: usize,
    fraction: f32,
}

impl Tap {
    fn new(seconds: f32, rate: f32) -> Self {
        let samples = seconds * rate;
        let whole = samples as usize;
        Self {
            whole,
            fraction: samples - whole as f32,
        }
    }

    fn read<const N: usize>(self, history: &[f32; N], cursor: usize) -> f32 {
        let index = cursor.wrapping_sub(self.whole) & (N - 1);
        let next = index.wrapping_sub(1) & (N - 1);
        history[index] + self.fraction * (history[next] - history[index])
    }
}

#[derive(Clone, Copy)]
struct Speaker {
    angle: f32,
    near: f32,
    far_low: f32,
    far_high: f32,
    shadow_hz: f32,
    pinna_seconds: f32,
    pinna_mix: f32,
}

// Generic horizontal binaural model. The head splits interaural delay and
// head shadow from short outer-ear reflections that distinguish side and rear.
// Positions are parameterized rather than taken from a listener's measured HRTF.
const SPEAKERS: [Speaker; 3] = [
    Speaker {
        angle: 30.0,
        near: 1.0,
        far_low: 0.34,
        far_high: 0.16,
        shadow_hz: 1_800.0,
        pinna_seconds: 0.0,
        pinna_mix: 0.0,
    },
    Speaker {
        angle: 90.0,
        near: 0.78,
        far_low: 0.36,
        far_high: 0.065,
        shadow_hz: 1_350.0,
        pinna_seconds: 0.000_079,
        pinna_mix: 0.14,
    },
    Speaker {
        angle: 145.0,
        near: 0.68,
        far_low: 0.30,
        far_high: 0.105,
        shadow_hz: 1_150.0,
        pinna_seconds: 0.000_109,
        pinna_mix: 0.21,
    },
];

/// The direct ear paths run on the input timeline. Only cross-ear and quiet
/// reflection cues read history, with no extra audio blocks or lookahead.
pub struct Dsp {
    history: [[f32; HISTORY]; MAX_CHANNELS],
    room: [f32; ROOM_HISTORY],
    shadow: [f32; MAX_CHANNELS],
    shelf: [f32; 2],
    cursor: usize,
    room_cursor: usize,
    channels: usize,
    delay: [Tap; 3],
    pinna: [Tap; 3],
    reflections: [Tap; 2],
    shadow_alpha: [f32; 3],
    shelf_alpha: f32,
    room_low_alpha: f32,
    room_high_alpha: f32,
    room_low: f32,
    room_high: f32,
    mix: f32,
    mix_step: f32,
}

impl Dsp {
    pub fn new(rate: f32) -> Option<Self> {
        if !(8_000.0..=192_000.0).contains(&rate) {
            return None;
        }
        let alpha = |frequency| {
            let scaled = std::f32::consts::TAU * frequency / rate;
            scaled / (1.0 + scaled)
        };
        Some(Self {
            history: [[0.0; HISTORY]; MAX_CHANNELS],
            room: [0.0; ROOM_HISTORY],
            shadow: [0.0; MAX_CHANNELS],
            shelf: [0.0; 2],
            cursor: 0,
            room_cursor: 0,
            channels: 0,
            delay: SPEAKERS.map(|speaker| {
                // Woodworth spherical-head ITD, mirrored for rear azimuths.
                let angle = speaker.angle.min(180.0 - speaker.angle).to_radians();
                Tap::new((0.085 / 343.0) * (angle + angle.sin()), rate)
            }),
            pinna: SPEAKERS.map(|speaker| Tap::new(speaker.pinna_seconds, rate)),
            reflections: [0.0026, 0.0048].map(|seconds| Tap::new(seconds, rate)),
            shadow_alpha: SPEAKERS.map(|speaker| alpha(speaker.shadow_hz)),
            shelf_alpha: alpha(120.0),
            room_low_alpha: alpha(330.0),
            room_high_alpha: alpha(3_200.0),
            room_low: 0.0,
            room_high: 0.0,
            mix: 0.0,
            mix_step: 1.0 / (0.020 * rate),
        })
    }

    pub fn reset(&mut self) {
        self.history.fill([0.0; HISTORY]);
        self.room.fill(0.0);
        self.shadow.fill(0.0);
        self.shelf.fill(0.0);
        self.cursor = 0;
        self.room_cursor = 0;
        self.room_low = 0.0;
        self.room_high = 0.0;
    }

    pub fn process(
        &mut self,
        input: &Input,
        output: &mut Output,
        frames: usize,
        channels: usize,
        intensity: f32,
    ) -> bool {
        let layout: &[Position] = match channels {
            1 | 2 => &[],
            4 => &QUAD,
            6 => &SURROUND,
            8 => &SURROUND_BACK,
            _ => return false,
        };
        if frames == 0 || frames > MAX_FRAMES {
            return false;
        }
        if channels != self.channels {
            self.reset();
            self.channels = channels;
        }
        let intensity = if intensity.is_finite() {
            intensity.clamp(0.0, 1.0)
        } else {
            0.0
        };
        if self.mix == 0.0 && intensity == 0.0 && channels <= 2 {
            for ear in 0..2 {
                let source = &input[if channels == 1 { 0 } else { ear }];
                for (destination, sample) in output[ear][..frames].iter_mut().zip(source) {
                    *destination = finite(*sample);
                }
            }
            return true;
        }
        let was_active = self.mix > 0.0 || intensity > 0.0;
        for frame in 0..frames {
            let delta = intensity - self.mix;
            self.mix = if delta.abs() <= self.mix_step {
                intensity
            } else {
                self.mix + delta.clamp(-self.mix_step, self.mix_step)
            };
            let enabled = self.mix > 0.0;
            let (dry, wet) = match channels {
                1 => {
                    let mono = finite(input[0][frame]);
                    ([mono; 2], [clean(mono); 2])
                }
                2 if enabled => self.stereo(finite(input[0][frame]), finite(input[1][frame])),
                2 => ([finite(input[0][frame]), finite(input[1][frame])], [0.0; 2]),
                _ => self.multichannel(input, frame, layout, enabled),
            };
            if !enabled {
                output[0][frame] = dry[0];
                output[1][frame] = dry[1];
                continue;
            }
            self.cursor = (self.cursor + 1) & (HISTORY - 1);
            for ear in 0..2 {
                self.shelf[ear] += self.shelf_alpha * (wet[ear] - self.shelf[ear]);
                let enhanced = soft_limit(wet[ear] + LOW_SHELF_GAIN * self.shelf[ear]);
                output[ear][frame] = (1.0 - self.mix) * dry[ear] + self.mix * enhanced;
            }
        }
        if self.mix == 0.0 && was_active {
            self.reset();
        }
        for filter in self
            .shadow
            .iter_mut()
            .chain(&mut self.shelf)
            .chain([&mut self.room_low, &mut self.room_high])
        {
            if filter.abs() < 1.0e-20 {
                *filter = 0.0;
            }
        }
        true
    }

    fn stereo(&mut self, left: f32, right: f32) -> ([f32; 2], [f32; 2]) {
        let (wet_left, wet_right) = (clean(left), clean(right));
        let mid = (wet_left + wet_right) * 0.5;
        let side = (wet_left - wet_right) * 0.5;
        let (_, crossfeed) = self.render_speaker(0, 0, side);

        // Keep reflections in the stereo difference signal. The phantom
        // center therefore reaches both ears immediately and identically.
        self.room_low += self.room_low_alpha * (side - self.room_low);
        self.room_high += self.room_high_alpha * (side - self.room_low - self.room_high);
        self.room[self.room_cursor] = self.room_high;
        let early = self.reflections[0].read(&self.room, self.room_cursor);
        let late = self.reflections[1].read(&self.room, self.room_cursor);
        self.room_cursor = (self.room_cursor + 1) & (ROOM_HISTORY - 1);
        let spatial = 1.01 * side - 0.34 * crossfeed + 0.040 * early - 0.024 * late;
        ([left, right], [mid + spatial, mid - spatial])
    }

    fn multichannel(
        &mut self,
        input: &Input,
        frame: usize,
        layout: &[Position],
        enabled: bool,
    ) -> ([f32; 2], [f32; 2]) {
        let mut dry = [0.0; 2];
        let mut wet = [0.0; 2];
        for (channel, position) in layout.iter().enumerate() {
            let sample = clean(input[channel][frame]);
            match *position {
                Position::Center => {
                    let center = CENTER * sample;
                    for ear in 0..2 {
                        dry[ear] += center;
                        wet[ear] += center;
                    }
                }
                Position::Lfe => {
                    // Restrict the effects-path LFE to the low band.
                    if enabled {
                        self.shadow[channel] += self.shelf_alpha * (sample - self.shadow[channel]);
                    }
                    for ear in 0..2 {
                        dry[ear] += 0.35 * sample;
                        wet[ear] += 0.35 * self.shadow[channel];
                    }
                }
                position => {
                    let (ear, band, downmix) = match position {
                        Position::Front(ear) => (ear, 0, 1.0),
                        Position::Side(ear) => (ear, 1, CENTER),
                        Position::Rear(ear) => (ear, 2, 0.50),
                        _ => unreachable!(),
                    };
                    dry[ear] += downmix * sample;
                    if enabled {
                        let (near, far) = self.render_speaker(channel, band, sample);
                        wet[ear] += near;
                        wet[1 - ear] += far;
                    }
                }
            }
        }
        ([soft_limit(dry[0]), soft_limit(dry[1])], wet)
    }

    fn render_speaker(&mut self, channel: usize, band: usize, value: f32) -> (f32, f32) {
        let history = &mut self.history[channel];
        history[self.cursor] = value;
        let delayed = self.delay[band].read(history, self.cursor);
        let reflected = self.pinna[band].read(history, self.cursor);
        let shadow = &mut self.shadow[channel];
        *shadow += self.shadow_alpha[band] * (delayed - *shadow);
        let speaker = SPEAKERS[band];
        let near = speaker.near * (value + speaker.pinna_mix * (reflected - value));
        let far = speaker.far_low * *shadow + speaker.far_high * (delayed - *shadow);
        (near, far)
    }
}

fn clean(value: f32) -> f32 {
    finite(value).clamp(-4.0, 4.0)
}

fn finite(value: f32) -> f32 {
    if value.is_finite() {
        value
    } else {
        0.0
    }
}

fn soft_limit(value: f32) -> f32 {
    let level = value.abs();
    if level <= 0.9 {
        value
    } else {
        let over = level - 0.9;
        (0.9 + 0.1 * over / (0.1 + over)).copysign(value)
    }
}

#[cfg(target_arch = "wasm32")]
mod abi;

#[cfg(test)]
#[path = "../../../test/quantum-audio/dsp.rs"]
mod tests;
