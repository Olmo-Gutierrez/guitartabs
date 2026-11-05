import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assignFingers, sharesFinger } from '../fingering.js';
import { parseTab } from '../tab.js';
import { PONY_LOOP } from './helpers/guitar.js';

const single = (string, fret) => ({ notes: [{ string, fret }] });
const loop = () => assignFingers(PONY_LOOP.map(({ string, fret }) => single(string, fret)));

test('al aire no lleva dedo', () => {
  const [step] = assignFingers([single(3, 0)]);
  assert.equal(step.notes[0].finger, null);
});

test('un dedo por traste dentro de la posición', () => {
  const steps = assignFingers([single(1, 1), single(1, 2), single(1, 3), single(1, 4)]);
  assert.deepEqual(steps.map((s) => s.notes[0].finger), [1, 2, 3, 4]);
  assert.ok(steps.every((s) => s.position === 1));
});

test('todos los dedos quedan entre 1 y 4 y cada nota al alcance', () => {
  for (const step of loop()) {
    for (const note of step.notes) {
      if (note.fret === 0) continue;
      assert.ok(note.finger >= 1 && note.finger <= 4);
      assert.equal(note.finger, note.fret - step.position + 1, `traste ${note.fret} en posición ${step.position}`);
    }
  }
});

test('el bucle de pony solo mueve la mano entre formas', () => {
  const steps = loop();
  const moves = steps.filter((s, i) => i > 0 && s.moved);
  assert.ok(moves.length <= 3, `se mueve ${moves.length} veces: ${steps.map((s) => s.position).join(' ')}`);
  assert.equal(steps[0].position, 2);
  steps.forEach((step, i) => {
    if (i === 0 || !step.moved) return;
    const before = steps[i - 1].notes[0].fret;
    const jump = Math.abs(step.notes[0].fret - before);
    assert.ok(before === 0 || jump > 3, `cambio en mitad de una forma, nota ${i + 1}`);
  });
});

test('una escala larga sí mueve la mano, sin estiramientos imposibles', () => {
  const steps = assignFingers([1, 2, 3, 4, 5, 6, 7, 8, 9].map((fret) => single(1, fret)));
  for (const step of steps) {
    const { fret, finger } = step.notes[0];
    assert.equal(finger, fret - step.position + 1);
    assert.ok(finger >= 1 && finger <= 4);
  }
});

test('las formas del bucle quedan en la mano de forma natural', () => {
  const fingers = loop().map((s) => s.notes[0].finger);
  // Traste 3, 2, 2: corazón en la sexta e índice pisando quinta y cuarta.
  assert.deepEqual(fingers.slice(0, 4), [2, 1, 1, null]);
  // Traste 10, 9, 9: lo mismo, sin que el meñique cruce por encima del anular.
  assert.deepEqual(fingers.slice(12, 16), [2, 1, 1, null]);
  // Traste 9, 7, 7: anular en la sexta e índice en las otras dos.
  assert.deepEqual(fingers.slice(16, 20), [3, 1, 1, null]);
  // Traste 7, 9, 9: la forma de quinta de siempre, índice y anular.
  assert.deepEqual(fingers.slice(20, 24), [1, 3, 3, null]);
});

test('no mueve la mano sin necesidad en cuerdas al aire', () => {
  const steps = assignFingers([single(1, 7), single(3, 0), single(1, 8)]);
  assert.deepEqual(steps.map((s) => s.position), [7, 7, 7]);
  assert.deepEqual(steps.map((s) => s.moved), [true, false, false]);
});

test('el acorde de Sol da su digitación habitual: un dedo no salta entre cuerdas', () => {
  const { steps } = parseTab('e|-3-|\nB|-0-|\nG|-0-|\nD|-0-|\nA|-2-|\nE|-3-|');
  assignFingers(steps);
  assert.deepEqual(steps[0].notes.map((n) => n.finger), [3, null, null, null, 1, 2]);
});

test('el mismo traste en cuerdas contiguas de un acorde sí comparte dedo', () => {
  const { steps } = parseTab('e|---|\nB|---|\nG|---|\nD|-7-|\nA|-7-|\nE|-5-|');
  assignFingers(steps);
  const [d, a, e] = steps[0].notes;
  assert.equal(d.finger, a.finger);
  assert.equal(e.finger, 1);
});

test('detecta cuando un dedo pisa dos cuerdas, solo dentro de la misma forma', () => {
  const steps = loop();
  assert.equal(sharesFinger(steps, 1, steps[1].notes[0]), true);
  assert.equal(sharesFinger(steps, 0, steps[0].notes[0]), false);
  // Traste 9 de la sexta: el traste 9 anterior está al otro lado de la cuerda al aire.
  assert.equal(steps[16].notes[0].fret, 9);
  assert.equal(sharesFinger(steps, 16, steps[16].notes[0]), false);
});

test('los pasos vacíos no rompen nada', () => {
  assert.deepEqual(assignFingers([]), []);
});
