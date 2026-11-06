<img src="assets/icon.svg" width="64" height="64" alt="">

# Guitartabs

**Nota a nota**: pega un tab en texto y la app te enseña qué tocar, una nota cada vez, y espera a que la toques. Avanzas con el botón, con un pedal Bluetooth o con el micrófono. Con **▶ Ritmo** el tab se toca solo a la velocidad que elijas, siguiendo la separación entre notas del propio tab.

Es una web estática sin dependencias: `index.html` se puede servir tal cual.

- `tab.js`: lee el tab y las afinaciones.
- `fingering.js`: sugiere la digitación y dónde colocar la mano.
- `pitch.js`: detecta en el micrófono si acaba de sonar la nota o el acorde esperados.
- `app.js`: interfaz, sonido y micrófono.

Formato opcional para el ritmo: una línea `BPM: 92` en cualquier sitio, y justo debajo de cada bloque de tab una línea `Ritmo:` con un valor por cada columna que tenga notas (acordes incluidos): `1` redonda, `2` blanca, `4` negra, `8` corchea, `16` semicorchea, con punto para alargar (`8.`) y `r` delante para silencios (`r8`). Si el número de valores no cuadra con las notas, la app lo dice y usa la separación del tab.

Tests: `npm test`. Añade `?debug` a la URL para ver lo que oye el detector.

Created in [T3 Code](https://t3.codes).
