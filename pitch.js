export const midiToHz = (midi) => 440 * 2 ** ((midi - 69) / 12);
export const hzToMidi = (hz) => 69 + 12 * Math.log2(hz / 440);

export function rms(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

// Algoritmo YIN. Devuelve la frecuencia en Hz, o null si la señal no tiene un tono claro.
export function detectPitch(buf, sampleRate, { minHz = 60, maxHz = 1600, threshold = 0.15 } = {}) {
  const tauMax = Math.min(Math.floor(sampleRate / minHz), Math.floor(buf.length / 2));
  const tauMin = Math.max(2, Math.floor(sampleRate / maxHz));
  const width = Math.min(2048, buf.length - tauMax);
  const cmnd = new Float32Array(tauMax + 1);

  let running = 0;
  cmnd[0] = 1;
  for (let tau = 1; tau <= tauMax; tau++) {
    let diff = 0;
    for (let i = 0; i < width; i++) {
      const d = buf[i] - buf[i + tau];
      diff += d * d;
    }
    running += diff;
    cmnd[tau] = running > 0 ? (diff * tau) / running : 1;
  }

  for (let tau = tauMin; tau < tauMax; tau++) {
    if (cmnd[tau] >= threshold) continue;
    while (tau + 1 < tauMax && cmnd[tau + 1] < cmnd[tau]) tau++;
    const [a, b, c] = [cmnd[tau - 1], cmnd[tau], cmnd[tau + 1]];
    const denom = a - 2 * b + c;
    const shift = denom ? (a - c) / (2 * denom) : 0;
    return sampleRate / (tau + shift);
  }
  return null;
}

// Tolera errores de octava: el micro de un móvil apenas capta la fundamental de las cuerdas graves.
export function sameNote(heardMidi, wantedMidi, toleranceSemitones = 0.6) {
  return [-12, 0, 12].some((octave) => Math.abs(heardMidi - wantedMidi + octave) <= toleranceSemitones);
}

// Comprueba en un espectro en dB (AnalyserNode) que suenan casi todas las notas de un acorde.
export function chordPresent(spectrumDb, sampleRate, midis, { rangeDb = 25 } = {}) {
  const binHz = sampleRate / (2 * spectrumDb.length);
  const lastBin = Math.min(spectrumDb.length - 2, Math.ceil(2500 / binHz));
  let loudest = -Infinity;
  for (let i = 1; i <= lastBin; i++) loudest = Math.max(loudest, spectrumDb[i]);
  const floor = loudest - rangeDb;

  // En graves un semitono ocupa poco más de un bin: se interpola la posición exacta de cada pico.
  const hasPeak = (hz) => {
    const from = Math.max(1, Math.floor(hz / binHz) - 2);
    const to = Math.min(lastBin, Math.ceil(hz / binHz) + 2);
    for (let i = from; i <= to; i++) {
      const [a, b, c] = [spectrumDb[i - 1], spectrumDb[i], spectrumDb[i + 1]];
      if (b <= floor || b < a || b < c) continue;
      const denom = a - 2 * b + c;
      const peakHz = (i + (denom ? (a - c) / (2 * denom) : 0)) * binHz;
      if (Math.abs(peakHz - hz) / hz < 0.02) return true;
    }
    return false;
  };

  // Solo las cuerdas muy graves pueden aprobar por su armónico: el móvil casi no capta su fundamental.
  // En las demás, aceptar armónicos haría que una sola cuerda grave pareciese un acorde entero.
  const sounds = (midi) => {
    const hz = midiToHz(midi);
    return hasPeak(hz) || (hz < 110 && hasPeak(hz * 2));
  };
  const distinct = [...new Set(midis)];
  return distinct.filter(sounds).length >= Math.ceil(distinct.length * 0.75);
}
