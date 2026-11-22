use super::*;

const RATE: f32 = 48_000.0;
const SILENT: Input = [[0.0; MAX_FRAMES]; MAX_CHANNELS];
fn warm(dsp: &mut Dsp, output: &mut Output, channels: usize) {
    for _ in 0..16 {
        assert!(dsp.process(&SILENT, output, MAX_FRAMES, channels, 1.0));
    }
}

#[test]
fn bypass_is_exact_for_stereo_and_accepts_variable_block_lengths() {
    let mut dsp = Dsp::new(RATE).unwrap();
    let mut input = SILENT;
    let mut output = [[0.0; MAX_FRAMES]; 2];
    for i in 0..MAX_FRAMES {
        input[0][i] = -0.5 + i as f32 * 0.008;
        input[1][i] = 0.5 - i as f32 * 0.006;
    }
    input[0][32] = 5.0;
    input[1][32] = -6.0;
    assert!(dsp.process(&input, &mut output, 73, 2, 0.0));
    assert_eq!(&input[0][..73], &output[0][..73]);
    assert_eq!(&input[1][..73], &output[1][..73]);
}

#[test]
fn low_shelf_is_bounded_and_transition_returns_to_exact_bypass() {
    let mut dsp = Dsp::new(RATE).unwrap();
    let input = [[0.1; MAX_FRAMES]; MAX_CHANNELS];
    let mut output = [[0.0; MAX_FRAMES]; 2];
    assert!(dsp.process(&input, &mut output, MAX_FRAMES, 2, 1.0));
    assert!(output[0][0] < 0.1001, "opening sample should ramp from dry");
    for _ in 0..32 {
        assert!(dsp.process(&input, &mut output, MAX_FRAMES, 2, 1.0));
    }
    assert!((0.131..=0.13336).contains(&output[0][0]));
    assert_eq!(output[0], output[1]);
    assert!(dsp.process(&input, &mut output, MAX_FRAMES, 2, 0.0));
    assert!(output[0][0] > 0.129);
    for _ in 0..16 {
        assert!(dsp.process(&input, &mut output, MAX_FRAMES, 2, 0.0));
    }
    assert_eq!(output, [input[0], input[1]]);
}

#[test]
fn stereo_left_impulse_reaches_other_ear_later_with_center_unchanged() {
    let mut dsp = Dsp::new(RATE).unwrap();
    let mut input = SILENT;
    let mut output = [[0.0; MAX_FRAMES]; 2];
    warm(&mut dsp, &mut output, 2);
    input[0][0] = 0.25;
    assert!(dsp.process(&input, &mut output, MAX_FRAMES, 2, 1.0));
    assert!(output[0][0] > 10.0 * output[1][0].abs());
    assert!(output[1][5..32].iter().any(|sample| sample.abs() > 0.001));
    let mono = [[0.12; MAX_FRAMES]; MAX_CHANNELS];
    for _ in 0..32 {
        assert!(dsp.process(&mono, &mut output, MAX_FRAMES, 2, 1.0));
    }
    assert!(output[0]
        .iter()
        .zip(output[1])
        .all(|(left, right)| (left - right).abs() < 0.000001));
}

#[test]
fn standard_multichannel_center_and_surround_keep_their_positions() {
    for channels in [4, 6, 8] {
        let mut dsp = Dsp::new(RATE).unwrap();
        let mut input = SILENT;
        let mut output = [[0.0; MAX_FRAMES]; 2];
        warm(&mut dsp, &mut output, channels);
        if channels >= 6 {
            input[2][0] = 0.4;
            assert!(dsp.process(&input, &mut output, MAX_FRAMES, channels, 1.0));
            assert_eq!(output[0], output[1]);
            assert!(output[0][0] > 0.25);
        }
        input = SILENT;
        input[if channels == 4 { 2 } else { 4 }][0] = 0.4;
        assert!(dsp.process(&input, &mut output, MAX_FRAMES, channels, 1.0));
        assert!(output[0][0] > 0.2 && output[0][0] > 5.0 * output[1][0].abs());
        assert!(output[1][10..45].iter().any(|sample| *sample > 0.004));
    }
}

#[test]
fn rejects_unsupported_formats_and_contains_nonfinite_and_peak_input() {
    assert!(Dsp::new(f32::NAN).is_none());
    assert!(Dsp::new(999_000.0).is_none());
    let mut dsp = Dsp::new(192_000.0).unwrap();
    let mut output = [[0.0; MAX_FRAMES]; 2];
    assert!(!dsp.process(&SILENT, &mut output, MAX_FRAMES + 1, 2, 0.0));
    assert!(!dsp.process(&SILENT, &mut output, MAX_FRAMES, 7, 0.0));
    let mut input = [[1.0; MAX_FRAMES]; MAX_CHANNELS];
    input[0][0] = f32::NAN;
    input[1][0] = f32::INFINITY;
    warm(&mut dsp, &mut output, 8);
    assert!(dsp.process(&input, &mut output, MAX_FRAMES, 8, 1.0));
    assert!(output
        .iter()
        .flatten()
        .all(|value| value.is_finite() && value.abs() <= 1.0));
}

#[test]
fn front_path_adds_no_delay_and_reset_discards_crossfeed_history() {
    let mut dsp = Dsp::new(RATE).unwrap();
    let mut output = [[0.0; MAX_FRAMES]; 2];
    warm(&mut dsp, &mut output, 6);
    let mut input = SILENT;
    input[0][37] = 0.35;
    input[0][MAX_FRAMES - 2] = 0.3;
    assert!(dsp.process(&input, &mut output, MAX_FRAMES, 6, 1.0));
    assert!(output
        .iter()
        .all(|channel| channel[..37].iter().all(|sample| *sample == 0.0)));
    assert!(output[0][37] > 0.34);
    assert_eq!(output[1][37], 0.0);
    dsp.reset();
    assert!(dsp.process(&SILENT, &mut output, MAX_FRAMES, 6, 1.0));
    assert_eq!(output, [[0.0; MAX_FRAMES]; 2]);
}

#[test]
fn conventional_seven_point_one_places_lateral_pairs_at_distinct_angles() {
    let mut first_far_frames = [0; 3];
    for (index, left_channel) in [0, 4, 6].into_iter().enumerate() {
        let left = surround_impulse(left_channel);
        let right = surround_impulse(left_channel + 1);
        assert_eq!(left[0], right[1]);
        assert_eq!(left[1], right[0]);
        assert!(left[0][0] > 0.1, "each near ear has a direct path");
        assert_eq!(left[1][0], 0.0);
        first_far_frames[index] = left[1]
            .iter()
            .position(|sample| sample.abs() > 0.0001)
            .unwrap();
    }
    let [front, rear, side] = first_far_frames;
    assert!((11..=13).contains(&front));
    assert!((13..=15).contains(&rear));
    assert!((29..=32).contains(&side));
    assert!(front < rear && rear < side);
}

#[test]
fn rear_and_side_channels_have_distinct_near_ear_spectral_cues() {
    fn magnitude(response: &[f32], hz: f32) -> f32 {
        let (real, imaginary) =
            response
                .iter()
                .enumerate()
                .fold((0.0, 0.0), |(real, imaginary), (frame, sample)| {
                    let phase = std::f32::consts::TAU * hz * frame as f32 / RATE;
                    let (sin, cos) = phase.sin_cos();
                    (real + sample * cos, imaginary + sample * sin)
                });
        real.hypot(imaginary)
    }

    let rear = surround_impulse(4);
    let side = surround_impulse(6);
    let rear_high_ratio = magnitude(&rear[0], 4_500.0) / magnitude(&rear[0], 1_200.0);
    let side_high_ratio = magnitude(&side[0], 4_500.0) / magnitude(&side[0], 1_200.0);
    assert!(rear_high_ratio < 0.88 * side_high_ratio);
}

fn surround_impulse(channel: usize) -> Output {
    let mut dsp = Dsp::new(RATE).unwrap();
    let mut input = SILENT;
    let mut output = [[0.0; MAX_FRAMES]; 2];
    warm(&mut dsp, &mut output, 8);
    input[channel][0] = 0.22;
    assert!(dsp.process(&input, &mut output, MAX_FRAMES, 8, 1.0));
    output
}

#[test]
fn stereo_reflections_add_quiet_depth_without_creating_a_center_signal() {
    let mut dsp = Dsp::new(RATE).unwrap();
    let mut input = SILENT;
    let mut output = [[0.0; MAX_FRAMES]; 2];
    warm(&mut dsp, &mut output, 2);
    input[0][0] = 0.24;
    input[1][0] = -0.24;
    assert!(dsp.process(&input, &mut output, MAX_FRAMES, 2, 1.0));
    assert!(output[0][0] > 0.23);
    assert!(output[0][124..128].iter().any(|sample| *sample > 0.001));

    assert!(dsp.process(&SILENT, &mut output, MAX_FRAMES, 2, 1.0));
    assert!(output[0][101..108].iter().any(|sample| *sample < -0.0005));
    assert!(output[0]
        .iter()
        .zip(output[1])
        .all(|(l, r)| (l + r).abs() < 1.0e-6));
    assert!(output[0].iter().all(|sample| sample.abs() < 0.008));
    dsp.reset();
    assert!(dsp.process(&SILENT, &mut output, MAX_FRAMES, 2, 1.0));
    assert_eq!(output, [[0.0; MAX_FRAMES]; 2]);
}

#[test]
fn changing_render_block_lengths_preserves_the_sample_timeline() {
    assert!(std::mem::size_of::<Dsp>() <= 9 * 1024);
    let mut input = SILENT;
    for (channel, plane) in input.iter_mut().enumerate() {
        for (frame, sample) in plane.iter_mut().enumerate() {
            *sample = ((frame * 17 + channel * 37) as f32 * 0.031).sin() * 0.12;
        }
    }

    for channels in [1, 2, 4, 6, 8] {
        let mut continuous = Dsp::new(RATE).unwrap();
        let mut split = Dsp::new(RATE).unwrap();
        let mut expected = [[0.0; MAX_FRAMES]; 2];
        let mut chunk = [[0.0; MAX_FRAMES]; 2];
        warm(&mut continuous, &mut expected, channels);
        warm(&mut split, &mut chunk, channels);
        assert!(continuous.process(&input, &mut expected, MAX_FRAMES, channels, 0.6));

        let mut offset = 0;
        for frames in [23, 41, 64] {
            let mut piece = SILENT;
            for channel in 0..channels {
                piece[channel][..frames].copy_from_slice(&input[channel][offset..offset + frames]);
            }
            assert!(split.process(&piece, &mut chunk, frames, channels, 0.6));
            for ear in 0..2 {
                assert_eq!(
                    &chunk[ear][..frames],
                    &expected[ear][offset..offset + frames]
                );
            }
            offset += frames;
        }
    }
}
