import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TUNINGS, detectTuning, noteName, parseTab, soundingMidi } from '../tab.js';

const frets = (step) => step.notes.map((n) => [n.string, n.fret]);

test('lee notas sueltas en orden, de izquierda a derecha', () => {
  const { steps, labels } = parseTab(`e|-----0-1-|
B|---1-----|
G|-0-------|
D|---------|
A|---------|
E|---------|`);
  assert.deepEqual(steps.map(frets), [[[3, 0]], [[2, 1]], [[1, 0]], [[1, 1]]]);
  assert.deepEqual(labels, ['e', 'B', 'G', 'D', 'A', 'E']);
});

test('agrupa las notas de la misma columna en un acorde', () => {
  const { steps } = parseTab(`e|-3-|
B|-0-|
G|-0-|
D|-0-|
A|-2-|
E|-3-|`);
  assert.equal(steps.length, 1);
  assert.deepEqual(frets(steps[0]), [[1, 3], [2, 0], [3, 0], [4, 0], [5, 2], [6, 3]]);
});

test('entiende trastes de dos cifras y los alinea con los de una', () => {
  const { steps } = parseTab(`e|-12-14-|
B|-10----|
G|--9----|
D|-------|
A|-------|
E|-------|`);
  assert.deepEqual(steps.map(frets), [[[1, 12], [2, 10], [3, 9]], [[1, 14]]]);
});

test('reconoce ligados, slides y bendings; el destino del bending no es un paso', () => {
  const { steps } = parseTab(`e|-0h2p0-5/7-7b9r7-|
B|-----------------|
G|-----------------|
D|-----------------|
A|-----------------|
E|-----------------|`);
  assert.deepEqual(steps.map((s) => [s.notes[0].fret, s.notes[0].technique]), [
    [0, undefined], [2, 'hammer-on'], [0, 'pull-off'], [5, undefined], [7, 'slide'], [7, 'bending'],
  ]);
});

test('ignora texto, vallas de markdown, acordes y repeticiones x4', () => {
  const { steps } = parseTab(`Aquí tienes el tab:
\`\`\`
Am      G
e|-0-----| x4
B|-1-----|
G|-2-----| 2x
D|-2-----|
A|-0-----| (x4)
E|-------|
\`\`\``);
  assert.deepEqual(steps.map(frets), [[[1, 0], [2, 1], [3, 2], [4, 2], [5, 0]]]);
});

test('tabs sin etiquetas y etiquetas de distinto ancho siguen alineados', () => {
  const bare = parseTab(`|-0-|
|-1-|
|---|
|---|
|---|
|---|`);
  assert.deepEqual(bare.steps.map(frets), [[[1, 0], [2, 1]]]);
  assert.equal(bare.labels, null);

  const flats = parseTab(`Eb|-0-|
Bb|-1-|
Gb|---|
Db|---|
Ab|---|
Eb|---|`);
  assert.deepEqual(flats.steps.map(frets), [[[1, 0], [2, 1]]]);
  assert.equal(detectTuning(flats.labels).id, 'halfdown');
});

test('da la vuelta al tab si tiene la E grave arriba', () => {
  const { steps } = parseTab(`E|-3---|
A|-----|
D|-----|
G|-----|
B|-----|
e|---0-|`);
  assert.deepEqual(steps.map(frets), [[[6, 3]], [[1, 0]]]);
});

test('sigue la sección de cada bloque y varios bloques seguidos', () => {
  const block = (n) => `e|-${n}-|\nB|---|\nG|---|\nD|---|\nA|---|\nE|---|`;
  const { steps } = parseTab(`[Intro]\n${block(1)}\n\n${block(2)}\n\n**Verso:**\n${block(3)}\n\n## Estribillo\n${block(4)}`);
  assert.deepEqual(steps.map((s) => s.section), ['Intro', 'Intro', 'Verso', 'Estribillo']);
});

test('detecta la cejilla y la afinación', () => {
  const { capo, labels } = parseTab(`Capo: 3
e|-0-|
B|---|
G|---|
D|---|
A|---|
D|---|`);
  assert.equal(capo, 3);
  assert.equal(detectTuning(labels).id, 'dropd');
  assert.equal(parseTab('Capo on 2nd fret').capo, 2);
});

test('no se inventa pasos a partir de texto normal', () => {
  assert.equal(parseTab('Hola, esto no es un tab.\n---\nNada de nada\n').steps.length, 0);
  assert.equal(parseTab('--- Verso ---\n--- Verso ---\n--- Verso ---\n--- Verso ---\n--- Verso ---\n--- Verso ---').steps.length, 0);
});

test('saca el ritmo de la separación entre notas', () => {
  const { steps } = parseTab(`e|-0-0-0---0-----0-|
B|-----------------|
G|-----------------|
D|-----------------|
A|-----------------|
E|-----------------|`);
  assert.deepEqual(steps.map((s) => s.duration), [1, 1, 2, 3, 1]);
});

test('el final de un bloque no alarga la nota aunque sobren guiones', () => {
  const block = 'e|-0-0-0----------|\nB|---|\nG|---|\nD|---|\nA|---|\nE|---|';
  const { steps } = parseTab(`${block}\n\n${block}`);
  assert.deepEqual(steps.map((s) => s.duration), [1, 1, 1, 1, 1, 1]);
});

test('un tab sin separación clara se mantiene en duraciones razonables', () => {
  const { steps } = parseTab('e|-0---------------------0-0-|\nB|---|\nG|---|\nD|---|\nA|---|\nE|---|');
  assert.ok(steps.every((s) => s.duration >= 0.5 && s.duration <= 4));
});

test('calcula el sonido real con afinación y cejilla', () => {
  const standard = TUNINGS[0];
  assert.equal(soundingMidi({ string: 6, fret: 0 }, standard), 40);
  assert.equal(soundingMidi({ string: 1, fret: 5 }, standard, 2), 71);
  assert.equal(noteName(40), 'Mi');
  assert.equal(noteName(69), 'La');
});
