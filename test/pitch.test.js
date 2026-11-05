import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chordPresent, detectPitch, hzToMidi, midiToHz, rms, sameNote } from '../pitch.js';

const SR = 48000;

// Cuerda sintética: varios armónicos con la fundamental débil, como la capta el micro de un móvil.
function string(midis, samples = 4096) {
  const buf = new Float32Array(samples);
  for (const midi of midis) {
    const hz = midiToHz(midi);
    for (const [harmonic, level] of [[1, 0.35], [2, 1], [3, 0.6], [4, 0.3]]) {
      for (let i = 0; i < samples; i++) buf[i] += level * Math.sin((2 * Math.PI * hz * harmonic * i) / SR) * 0.05;
    }
  }
  return buf;
}

// Espectro en dB con ventana de Blackman y FFT de 8192, como el de AnalyserNode.
function spectrum(midis) {
  const size = 8192;
  const signal = string(midis, size);
  const bins = new Float32Array(size / 2);
  const binHz = SR / size;
  for (let bin = 1; bin < Math.ceil(2600 / binHz); bin++) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < size; i++) {
      const window = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / size) + 0.08 * Math.cos((4 * Math.PI * i) / size);
      const angle = (2 * Math.PI * bin * i) / size;
      re += signal[i] * window * Math.cos(angle);
      im -= signal[i] * window * Math.sin(angle);
    }
    bins[bin] = 20 * Math.log10(Math.hypot(re, im) / size + 1e-9);
  }
  return bins;
}

test('detecta todas las cuerdas al aire, incluso con fundamental débil', () => {
  for (const midi of [36, 38, 40, 45, 50, 55, 59, 64, 76, 88]) {
    const hz = detectPitch(string([midi]), SR);
    assert.ok(hz, `sin tono para ${midi}`);
    assert.ok(sameNote(hzToMidi(hz), midi), `midi ${midi}: oído ${hzToMidi(hz).toFixed(2)}`);
  }
});

test('no confunde una nota con la de al lado', () => {
  const hz = detectPitch(string([57]), SR);
  assert.ok(sameNote(hzToMidi(hz), 57));
  assert.ok(!sameNote(hzToMidi(hz), 58));
  assert.ok(!sameNote(hzToMidi(hz), 56));
});

test('el ruido no da un tono', () => {
  const noise = Float32Array.from({ length: 4096 }, () => (Math.random() - 0.5) * 0.2);
  assert.equal(detectPitch(noise, SR), null);
});

test('sameNote admite errores de octava', () => {
  assert.ok(sameNote(52.2, 52));
  assert.ok(sameNote(52, 40));
  assert.ok(sameNote(64, 52));
  assert.ok(!sameNote(53, 40));
  assert.ok(!sameNote(59, 40));
});

test('rms', () => {
  assert.equal(rms(new Float32Array(4)), 0);
  assert.equal(rms(Float32Array.of(0.5, -0.5)), 0.5);
});

const G = [43, 47, 50, 55, 59, 67];
const C = [48, 52, 55, 60, 64];
const EM = [40, 47, 52, 55, 59, 64];
const AM = [45, 52, 57, 60, 64];

test('reconoce el acorde que suena', () => {
  for (const chord of [G, C, EM, AM]) assert.ok(chordPresent(spectrum(chord), SR, chord));
});

test('rechaza un acorde distinto', () => {
  assert.ok(!chordPresent(spectrum(C), SR, EM));
  assert.ok(!chordPresent(spectrum(EM), SR, C));
  assert.ok(!chordPresent(spectrum(AM), SR, G));
});

test('una sola cuerda no basta para aprobar un acorde', () => {
  assert.ok(!chordPresent(spectrum([40]), SR, EM));
});
