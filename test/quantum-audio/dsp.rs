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
