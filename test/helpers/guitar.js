// Guitarra y micro de móvil simulados: cuerdas que siguen sonando, ataque con ruido y graves atenuados.
export const SR = 48000;
export const FFT_SIZE = 16384;
export const HOP = Math.round(SR * 0.05);

let seed = 1;
function random() {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
}

export function silence(seconds) {
  return new Float32Array(Math.round(seconds * SR));
}

export function pluck(buffer, midi, atSeconds, { gain = 1, cents = 0, ring = 1.4 } = {}) {
  const hz = 440 * 2 ** ((midi - 69 + cents / 100) / 12);
  const start = Math.round(atSeconds * SR);
  const length = Math.min(buffer.length - start, Math.round(ring * 4 * SR));
  const pickup = 0.18;
  for (let h = 1; h <= 10 && hz * h < 6000; h++) {
    const amp = (0.05 * gain * Math.abs(Math.sin(Math.PI * h * pickup))) / h ** 0.8;
    // Micro de móvil: corta los graves por debajo de unos 150 Hz.
    const partialHz = hz * h * Math.sqrt(1 + 0.00008 * h * h);
    const mic = 1 / Math.sqrt(1 + (150 / partialHz) ** 4);
    const tau = ring / (1 + 0.35 * (h - 1));
    const phase = random() * 2 * Math.PI;
    for (let i = 0; i < length; i++) {
      buffer[start + i] += amp * mic * Math.exp(-i / SR / tau) * Math.sin((2 * Math.PI * partialHz * i) / SR + phase);
    }
  }
  const attack = Math.min(length, Math.round(SR * 0.006));
  for (let i = 0; i < attack; i++) buffer[start + i] += (random() - 0.5) * 0.04 * gain * (1 - i / attack);
}

export function addNoise(buffer, level = 0.0015) {
  for (let i = 0; i < buffer.length; i++) buffer[i] += (random() - 0.5) * level;
}

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let size = 2; size <= n; size *= 2) {
    const angle = (-2 * Math.PI) / size;
    for (let i = 0; i < n; i += size) {
      for (let k = 0; k < size / 2; k++) {
        const wr = Math.cos(angle * k);
        const wi = Math.sin(angle * k);
        const a = i + k;
        const b = a + size / 2;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

const BLACKMAN = Float64Array.from({ length: FFT_SIZE }, (_, i) => {
  const x = (2 * Math.PI * i) / FFT_SIZE;
  return 0.42 - 0.5 * Math.cos(x) + 0.08 * Math.cos(2 * x);
});

// Lo mismo que entrega AnalyserNode con smoothingTimeConstant = 0.
export function spectrumAt(buffer, endSample) {
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const start = endSample - FFT_SIZE;
  for (let i = 0; i < FFT_SIZE; i++) re[i] = (start + i >= 0 ? buffer[start + i] : 0) * BLACKMAN[i];
  fft(re, im);
  const db = new Float32Array(FFT_SIZE / 2);
  for (let i = 0; i < db.length; i++) db[i] = 20 * Math.log10(Math.hypot(re[i], im[i]) / FFT_SIZE + 1e-12);
  return db;
}

export function timeAt(buffer, endSample) {
  const out = new Float32Array(FFT_SIZE);
  const start = endSample - FFT_SIZE;
  for (let i = 0; i < FFT_SIZE; i++) out[i] = start + i >= 0 ? buffer[start + i] : 0;
  return out;
}

// Reparte el tiempo a pasos de 50 ms, como el temporizador de la app.
export function* frames(buffer) {
  for (let end = HOP; end <= buffer.length; end += HOP) yield end;
}

export const midi = (string, fret) => [64, 59, 55, 50, 45, 40][string - 1] + fret;

export const PONY_LOOP = '6.3 5.2 4.2 3.0 6.5 5.2 4.2 3.0 4.4 2.2 4.4 3.2 6.10 5.9 4.9 3.0 6.9 5.7 4.7 3.0 6.7 5.9 4.9 3.0 6.5 5.7 4.7 3.0'
  .split(' ')
  .map((token) => {
    const [string, fret] = token.split('.').map(Number);
    return { string, fret, midi: midi(string, fret) };
  });
