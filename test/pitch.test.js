import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NoteDetector } from '../pitch.js';
import { HOP, PONY_LOOP, SR, addNoise, frames, midi, pluck, silence, spectrumAt, timeAt } from './helpers/guitar.js';

// Toca `events` como lo haría el móvil y devuelve cuántos pasos avanza el detector.
function play(buffer, steps) {
  const detector = new NoteDetector(SR);
  let pos = 0;
  const times = [];
  detector.arm(steps[0]);
  for (const end of frames(buffer)) {
    if (pos >= steps.length) break;
    if (detector.feed(spectrumAt(buffer, end), timeAt(buffer, end))) {
      times.push(end / SR);
      pos++;
      if (pos < steps.length) detector.arm(steps[pos]);
    }
  }
  return { pos, times };
}

function loopBuffer(interval, options = {}) {
  const buffer = silence(0.5 + PONY_LOOP.length * interval + 1.5);
  PONY_LOOP.forEach((note, i) => pluck(buffer, note.midi, 0.5 + i * interval, options));
  addNoise(buffer);
  return buffer;
}
const loopSteps = PONY_LOOP.map((note) => [note.midi]);

test('sigue el bucle con las notas sonando unas encima de otras', () => {
  for (const interval of [1.2, 0.8, 0.6, 0.45]) {
    const { pos } = play(loopBuffer(interval), loopSteps);
    assert.equal(pos, 28, `a ${interval}s por nota se quedó en ${pos + 1}`);
  }
});

test('con cuerdas apagadas también', () => {
  assert.equal(play(loopBuffer(0.8, { ring: 0.4 }), loopSteps).pos, 28);
});

test('tolera que se toque flojo', () => {
  assert.equal(play(loopBuffer(0.8, { gain: 0.25 }), loopSteps).pos, 28);
});

test('tolera una guitarra un poco desafinada', () => {
  for (const cents of [-20, 20]) {
    assert.equal(play(loopBuffer(0.8, { cents }), loopSteps).pos, 28, `${cents} cents`);
  }
});

test('avanza en cuanto suena: menos de medio segundo', () => {
  const interval = 1.2;
  const { times } = play(loopBuffer(interval), loopSteps);
  times.forEach((time, i) => {
    const delay = time - (0.5 + i * interval);
    assert.ok(delay >= 0 && delay < 0.5, `nota ${i + 1}: ${delay.toFixed(2)}s`);
  });
});

test('la nota de la captura: Do# en cuerda 2 con Fa# vibrando debajo', () => {
  const target = midi(2, 2);
  const fsharp = midi(4, 4);
  const buffer = silence(3);
  pluck(buffer, fsharp, 0.2);
  pluck(buffer, target, 1.5, { gain: 0.5 });
  addNoise(buffer);
  const { pos, times } = play(buffer, [[target]]);
  assert.equal(pos, 1);
  assert.ok(times[0] > 1.5 && times[0] < 2, `oída a ${times[0]}`);
});

test('espera si solo suena la nota anterior o una equivocada', () => {
  const target = midi(2, 2);
  const buffer = silence(4);
  for (const at of [0.2, 1, 1.8, 2.6, 3.2]) pluck(buffer, midi(4, 4), at);
  addNoise(buffer);
  assert.equal(play(buffer, [[target]]).pos, 0);
});

test('no se queda con el semitono de al lado', () => {
  for (const [played, wanted] of [[54, 55], [55, 54], [61, 60], [61, 62], [64, 63], [45, 46], [46, 45], [50, 51]]) {
    const buffer = silence(2.5);
    pluck(buffer, played, 0.3);
    pluck(buffer, played, 1.3);
    addNoise(buffer);
    assert.equal(play(buffer, [[wanted]]).pos, 0, `tocada ${played}, esperada ${wanted}`);
  }
});

test('el golpe en otra cuerda no adelanta una nota que aún vibra', () => {
  const ringing = midi(3, 0);
  const buffer = silence(3);
  pluck(buffer, ringing, 0.1);
  for (const at of [0.7, 1.2, 1.7, 2.2]) pluck(buffer, midi(5, 2), at);
  addNoise(buffer);
  const detector = new NoteDetector(SR);
  detector.arm([ringing]);
  let heardAt = null;
  // Se arma cuando la nota ya vibra, como cuando vuelve a tocar después de otras.
  for (let end = Math.round(0.5 * SR); end <= buffer.length && heardAt === null; end += HOP) {
    if (detector.feed(spectrumAt(buffer, end), timeAt(buffer, end))) heardAt = end / SR;
  }
  assert.equal(heardAt, null);
});

test('un golpe o un chasquido no cuenta como nota', () => {
  const buffer = silence(4);
  for (const at of [0.5, 1.3, 2.1, 2.9]) {
    const start = Math.round(at * SR);
    // Clic seco y un salto de nivel, como un golpe en la mesa o un corte de audio.
    buffer[start] += 0.5;
    buffer[start + 1] -= 0.5;
    for (let i = 0; i < 200; i++) buffer[start + i] += 0.15 * (1 - i / 200);
  }
  addNoise(buffer);
  assert.equal(play(buffer, loopSteps).pos, 0);
});

test('un clic con una nota equivocada sonando tampoco', () => {
  const buffer = silence(4);
  [0.1, 1.1, 2.1, 3.1].forEach((at) => pluck(buffer, 54, at));
  for (const at of [1, 2, 3]) {
    const start = Math.round(at * SR);
    buffer[start] += 0.4;
  }
  addNoise(buffer);
  assert.equal(play(buffer, [[50]]).pos, 0);
});

test('un acorde que comparte notas con el anterior pasa enseguida', () => {
  const em = [40, 47, 52, 55, 59, 64];
  const c = [48, 52, 55, 60, 64];
  const buffer = silence(3);
  em.forEach((note, k) => pluck(buffer, note, 0.2 + k * 0.012, { gain: 0.7 }));
  c.forEach((note, k) => pluck(buffer, note, 1 + k * 0.012, { gain: 0.7 }));
  addNoise(buffer);
  const { pos, times } = play(buffer, [em, c]);
  assert.equal(pos, 2);
  assert.ok(times[1] > 1 && times[1] < 1.6, `Do oído a ${times[1]}`);
});

test('repetir el mismo acorde exige volver a tocarlo', () => {
  const am = [45, 52, 57, 60, 64];
  const once = silence(3);
  am.forEach((note, k) => pluck(once, note, 0.2 + k * 0.012, { gain: 0.7 }));
  addNoise(once);
  assert.equal(play(once, [am, am]).pos, 1);

  const twice = silence(3);
  am.forEach((note, k) => pluck(twice, note, 0.2 + k * 0.012, { gain: 0.7 }));
  am.forEach((note, k) => pluck(twice, note, 1.4 + k * 0.012, { gain: 0.7 }));
  addNoise(twice);
  assert.equal(play(twice, [am, am]).pos, 2);
});

test('sin tocar no avanza, aunque haya ruido', () => {
  const buffer = silence(3);
  addNoise(buffer, 0.01);
  assert.equal(play(buffer, loopSteps).pos, 0);
});

test('una nota repetida exige volver a pulsarla', () => {
  const note = midi(4, 4);
  const once = silence(4);
  pluck(once, note, 0.2);
  addNoise(once);
  const ringingOnly = play(once, [[note], [note]]);
  assert.equal(ringingOnly.pos, 1, 'con una sola pulsación no puede pasar de la primera');

  const twice = silence(4);
  pluck(twice, note, 0.2);
  pluck(twice, note, 1.2);
  addNoise(twice);
  assert.equal(play(twice, [[note], [note]]).pos, 2);
});

test('una repetición rápida con la cuerda aún sonando también cuenta', () => {
  const steps = [midi(4, 4), midi(2, 2), midi(4, 4), midi(3, 2)];
  const buffer = silence(3.5);
  steps.forEach((note, i) => pluck(buffer, note, 0.3 + i * 0.5));
  addNoise(buffer);
  assert.equal(play(buffer, steps.map((note) => [note])).pos, 4);
});

const CHORDS = {
  G: [43, 47, 50, 55, 59, 67],
  C: [48, 52, 55, 60, 64],
  Em: [40, 47, 52, 55, 59, 64],
  Am: [45, 52, 57, 60, 64],
};

function strum(notes, at, buffer) {
  notes.forEach((note, k) => pluck(buffer, note, at + k * 0.015, { gain: 0.7 }));
}

test('reconoce el acorde que suena', () => {
  for (const [name, chord] of Object.entries(CHORDS)) {
    const buffer = silence(2);
    strum(chord, 0.3, buffer);
    addNoise(buffer);
    assert.equal(play(buffer, [chord]).pos, 1, name);
  }
});

test('rechaza otro acorde y una sola cuerda', () => {
  for (const [played, wanted] of [['C', 'Em'], ['Em', 'C'], ['Am', 'G'], ['G', 'Am']]) {
    const buffer = silence(2);
    strum(CHORDS[played], 0.3, buffer);
    addNoise(buffer);
    assert.equal(play(buffer, [CHORDS[wanted]]).pos, 0, `${played} no es ${wanted}`);
  }
  const single = silence(2);
  pluck(single, 40, 0.3);
  addNoise(single);
  assert.equal(play(single, [CHORDS.Em]).pos, 0);
});

// Reproduce el paso con la nota de referencia sonando por el altavoz durante `gate` segundos.
function playGated(buffer, midis, gate, previous) {
  const detector = new NoteDetector(SR);
  detector.arm(midis);
  if (previous !== undefined) detector.targets.forEach((target) => { target.startDb = previous; });
  for (const end of frames(buffer)) {
    if (detector.feed(spectrumAt(buffer, end), timeAt(buffer, end), end / SR >= gate)) return end / SR;
  }
  return null;
}

// Referencia corta, como la que suena en la app.
function reference(buffer, midiNote, at = 0) {
  pluck(buffer, midiNote, at, { ring: 0.07, gain: 3 });
}

test('la nota de referencia del altavoz no hace avanzar', () => {
  const buffer = silence(3);
  reference(buffer, 55);
  addNoise(buffer);
  assert.equal(playGated(buffer, [55], 0.9), null);
});

test('una pulsación encima de la referencia cuenta en cuanto esta se apaga', () => {
  const buffer = silence(3);
  reference(buffer, 55);
  pluck(buffer, 55, 0.4);
  addNoise(buffer);
  const heardAt = playGated(buffer, [55], 0.9);
  assert.ok(heardAt !== null && heardAt < 1.2, `oída a ${heardAt}`);
});

test('una pulsación después de la referencia cuenta enseguida', () => {
  const buffer = silence(3);
  reference(buffer, 61);
  pluck(buffer, 61, 1.4);
  addNoise(buffer);
  const heardAt = playGated(buffer, [61], 0.9);
  assert.ok(heardAt > 1.4 && heardAt < 1.8, `oída a ${heardAt}`);
});

test('una nota repetida que aún vibra no cuenta al acabar la referencia', () => {
  const buffer = silence(3);
  pluck(buffer, 54, 0);
  reference(buffer, 54, 0.15);
  addNoise(buffer);
  const detector = new NoteDetector(SR);
  detector.arm([54]);
  let done = false;
  for (let end = Math.round(0.14 * SR); end <= buffer.length; end += HOP) {
    done ||= detector.feed(spectrumAt(buffer, end), timeAt(buffer, end), end / SR >= 1);
  }
  assert.equal(done, false);
});
