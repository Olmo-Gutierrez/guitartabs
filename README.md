<img src="assets/icon.svg" width="64" height="64" alt="">

# Guitartabs

**Nota a nota**: pega un tab en texto y la app te enseña qué tocar, una nota cada vez, y espera a que la toques. Avanzas con el botón, con un pedal Bluetooth o con el micrófono. Con **▶ Ritmo** el tab se toca solo a la velocidad que elijas, siguiendo la separación entre notas del propio tab.

Es una web estática sin dependencias: `index.html` se puede servir tal cual.

- `tab.js`: lee el tab y las afinaciones.
- `fingering.js`: sugiere la digitación y dónde colocar la mano.
- `pitch.js`: detecta en el micrófono si acaba de sonar la nota o el acorde esperados.
- `app.js`: interfaz, sonido y micrófono.

Tests: `npm test`. Añade `?debug` a la URL para ver lo que oye el detector.

Created in [T3 Code](https://t3.codes).
