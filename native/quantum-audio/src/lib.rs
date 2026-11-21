pub const MAX_FRAMES: usize = 128;
pub const MAX_CHANNELS: usize = 8;
pub type Input = [[f32; MAX_FRAMES]; MAX_CHANNELS];
pub type Output = [[f32; MAX_FRAMES]; 2];

const HISTORY: usize = 128;
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
// 7.1 plane order follows FL, FR, FC, LFE, BL, BR, SL, SR.
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

/// Fixed planar processing for one output stream. The center path is immediate,
/// with bounded interaural delays and first-order head shadow on lateral paths.
pub struct Dsp {
    history: [[f32; HISTORY]; MAX_CHANNELS],
    shadow: [f32; MAX_CHANNELS],
    shelf: [f32; 2],
    cursor: usize,
    channels: usize,
    delay: [usize; 3],
    shadow_alpha: [f32; 3],
    shelf_alpha: f32,
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
            shadow: [0.0; MAX_CHANNELS],
            shelf: [0.0; 2],
            cursor: 0,
            channels: 0,
            delay: [0.00025, 0.00055, 0.00045].map(|seconds| (rate * seconds).round() as usize),
            shadow_alpha: [1_550.0, 1_100.0, 900.0].map(alpha),
            shelf_alpha: alpha(120.0),
            mix: 0.0,
            mix_step: 1.0 / (0.020 * rate),
        })
    }

    pub fn reset(&mut self) {
        self.history.fill([0.0; HISTORY]);
        self.shadow.fill(0.0);
        self.shelf.fill(0.0);
        self.cursor = 0;
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
        for frame in 0..frames {
            let delta = intensity - self.mix;
            self.mix = if delta.abs() <= self.mix_step {
                intensity
            } else {
                self.mix + delta.clamp(-self.mix_step, self.mix_step)
            };
            let (dry, wet) = match channels {
                1 => {
                    let mono = finite(input[0][frame]);
                    ([mono; 2], [clean(mono); 2])
                }
                2 => self.stereo(finite(input[0][frame]), finite(input[1][frame])),
                _ => self.multichannel(input, frame, layout),
            };
            self.cursor = (self.cursor + 1) & (HISTORY - 1);
            for ear in 0..2 {
                self.shelf[ear] += self.shelf_alpha * (wet[ear] - self.shelf[ear]);
                let enhanced = soft_limit(wet[ear] + LOW_SHELF_GAIN * self.shelf[ear]);
                output[ear][frame] = if self.mix == 0.0 {
                    dry[ear]
                } else {
                    (1.0 - self.mix) * dry[ear] + self.mix * enhanced
                };
            }
        }
        if self.mix == 0.0 {
            self.reset();
        }
        for filter in self.shadow.iter_mut().chain(&mut self.shelf) {
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
        let shadow = self.delayed_shadow(0, 0, side);
        let spatial = 0.94 * side - 0.18 * shadow;
        ([left, right], [mid + spatial, mid - spatial])
    }

    fn multichannel(
        &mut self,
        input: &Input,
        frame: usize,
        layout: &[Position],
    ) -> ([f32; 2], [f32; 2]) {
        let mut dry = [0.0; 2];
        let mut wet = [0.0; 2];
        for (channel, position) in layout.iter().enumerate() {
            let sample = clean(input[channel][frame]);
            match *position {
                Position::Center => {
                    dry[0] += CENTER * sample;
                    dry[1] += CENTER * sample;
                    wet[0] += CENTER * sample;
                    wet[1] += CENTER * sample;
                }
                Position::Lfe => {
                    // LFE stays centered and rolls off even if improperly filtered upstream.
                    self.shadow[channel] += self.shelf_alpha * (sample - self.shadow[channel]);
                    dry[0] += 0.35 * sample;
                    dry[1] += 0.35 * sample;
                    wet[0] += 0.35 * self.shadow[channel];
                    wet[1] += 0.35 * self.shadow[channel];
                }
                position => {
                    let (ear, band, near, far, downmix) = match position {
                        Position::Front(ear) => (ear, 0, 1.0, 0.11, 1.0),
                        Position::Side(ear) => (ear, 1, CENTER, 0.25, CENTER),
                        Position::Rear(ear) => (ear, 2, 0.59, 0.26, 0.50),
                        _ => unreachable!(),
                    };
                    dry[ear] += downmix * sample;
                    wet[ear] += near * sample;
                    wet[1 - ear] += far * self.delayed_shadow(channel, band, sample);
                }
            }
        }
        ([soft_limit(dry[0]), soft_limit(dry[1])], wet)
    }

    fn delayed_shadow(&mut self, plane: usize, band: usize, value: f32) -> f32 {
        let index = self.cursor.wrapping_sub(self.delay[band]) & (HISTORY - 1);
        let delayed = self.history[plane][index];
        self.history[plane][self.cursor] = value;
        self.shadow[plane] += self.shadow_alpha[band] * (delayed - self.shadow[plane]);
        self.shadow[plane]
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
