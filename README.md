# StudioMix

Mezclador de vídeo en directo para Windows, hecho con Electron. Reúne en una
sola aplicación lo que suelen repartirse varios programas de emisión:
Preview/Program, escenas por capas, gráficos, mezcla de audio con efectos,
multistream, salida vertical, invitados remotos, chat en pantalla y control
desde el móvil, MIDI o Stream Deck. Es una implementación propia: no contiene
código ni recursos de ningún producto comercial (ver «Relación con OBS Studio»).

## Instalar

- **Instalador:** `npm run dist` genera `out/StudioMix-Setup-<versión>.exe`.
  No está firmado, así que Windows SmartScreen mostrará un aviso la primera vez
  («Más información» → «Ejecutar de todas formas») hasta que se firme con un
  certificado de firma de código.
- **Desde el código:** `npm install` y `npm start`.

FFmpeg viene incluido (`ffmpeg-static`).

## Primeros pasos

Al abrir la app vacía, una guía de 3 pasos lleva hasta el directo: añadir una
fuente, mandarla al aire y conectar el canal. El botón **Emitir** abre un panel
con los destinos (YouTube, Twitch, Facebook, Kick u otro), un campo para pegar
la clave, una prueba de velocidad de subida y una comprobación previa (imagen en
Program, audio, codificador, calidad). La emisión empieza tras una cuenta atrás
de 3 s que se puede cancelar.

## Funciones

**Producción**
- Entradas: cámara, micrófono, vídeo, imagen, audio, pantalla o ventana, color
  o degradado, títulos, escenas, **red** (SRT, RTSP, RTMP, UDP, HLS) e
  **invitados remotos**.
- Preview/Program con Cut, Auto, T-bar y transiciones: fundido, fundido a negro,
  cortinilla, deslizar, zoom, iris, luma wipe (13 patrones) y stinger.
- **Stingers con transparencia:** WebM con alfa, **MOV con alfa** (ProRes 4444,
  Animation, PNG) o una **animación HTML** con fondo transparente. El MOV se
  convierte una vez a WebM con alfa y el HTML se graba una vez al tamaño y fps
  de la salida (eliges su duración), así la transición no consume nada en
  directo. Las conversiones se guardan y se reutilizan.
- Vistas Estudio, Multiview (tally, vúmetros, reloj) y Vertical.
- 4 capas (overlays) con posiciones de pantalla completa, PiP, mitades o lado a lado.
- Escenas por capas editables sobre Preview: mover, escalar, rotar, imán con
  guías, modos de fusión, bloqueo y visibilidad.

**Gráficos**
- Rótulo inferior y moderno, título centrado, mosca, ticker, redes sociales,
  marcador deportivo con cronómetro, reloj, cuenta atrás, pantalla de espera y
  comentario del chat.
- **Listas de rótulos:** pega o carga un CSV (`Nombre | Cargo` por línea) y pasa
  de uno a otro con ◀ ▶▶ en la tarjeta, por MIDI o por la API.

**Vídeo**
- Ajuste y recorte: encaje, rotación de 90° (vídeos verticales de móvil), espejo,
  recorte visual con proporciones, zoom y encuadre.
- Filtros en GPU: chroma, color y luma key; color, gamma, tono, enfoque; LUT
  `.cube` o looks integrados; máscara de imagen; desplazamiento.
- **Quitar el fondo sin croma** con IA (MediaPipe, en la GPU). El modelo
  (≈250 KB) se descarga de Google la primera vez que se activa.
- **⚡ Optimizar:** convierte a H.264 1080p con un fotograma clave por segundo
  los vídeos que se reproducen mal (HEVC, 10 bits, 4K60…). La app lo propone sola.

**Audio**
- Por canal: ganancia, retardo, panorama, filtro de graves, supresión de ruido,
  puerta o expansor, ecualizador, compresor, limitador, monitorización, mute y
  AFV (el audio sigue al vídeo).
- **Ducking:** marca un canal como «voz» y otros como «bajar cuando hay voz»; la
  música baja sola mientras se habla.
- Master con limitador y escucha.

**Salidas**
- Multistream con una sola codificación, en GPU (NVENC, Quick Sync, AMF) o CPU.
- **Reconexión automática:** si se cae la red, la emisión reintenta sola y se
  recupera, sin detener la grabación local.
- **Salida vertical 9:16 simultánea** (TikTok, Shorts, Reels) con sus propios
  destinos y grabación. Puede reencuadrar Program o usar una entrada o escena
  propia; los rótulos colocados a un lado de la imagen 16:9 pueden quedar fuera
  del recorte, para eso está la «Capa gráfica encima» del vertical.
- Grabación MP4/MKV con pausa, **grabación ISO** (cada fuente en su archivo),
  repetición instantánea y capturas.

**Audiencia e invitados**
- **Chat de Twitch** (sin iniciar sesión) y **YouTube** (con clave de API). Clic
  en un mensaje para ponerlo en pantalla.
- **Invitados remotos** por enlace o QR desde el navegador del móvil u ordenador,
  en la misma red. Reciben la salida del programa y un **mix-minus** (oyen todo
  menos su propia voz). El servidor usa un certificado propio: el invitado acepta
  un aviso de seguridad la primera vez. Para invitados por Internet haría falta un
  servidor de retransmisión (TURN) y abrir puertos, que no se incluyen.

**Salidas a pantallas y monitores** (botón 🖥 de la barra superior)
- **Program, Preview o Multiview a pantalla completa** en cualquier monitor,
  televisor o proyector conectado, sin controles. Esc o doble clic la apaga. Si
  se desconecta un proyector, su salida vuelve sola al reconectarlo.
- **Ventanas flotantes** de cualquiera de las tres, para un solo monitor o para
  compartirlas en una videollamada.
- **Monitor en el móvil**: escanea el QR y el teléfono muestra Program, Preview
  o el multiview por WebRTC (720p, poco retardo, misma red wifi), con tally,
  sonido opcional y pantalla completa. Hasta 4 móviles a la vez. También desde
  el mando remoto con «Ver el monitor».

**Control**
- Teclado, MIDI (aprender, faders, T-bar, LEDs de tally).
- **Mando remoto en el móvil** (☰ → Mando remoto): página web con QR para cortar,
  capas, grabar y volumen, con miniaturas en vivo.
- **API HTTP/WebSocket** para Stream Deck (Bitfocus Companion, módulo «Generic
  HTTP»), macros o scripts. Desactivada por defecto, protegida con código de
  acceso y solo en la red local. Ejemplos:
  `GET http://IP:8088/api/cut?token=…`,
  `/api/preview?input=2`, `/api/overlay?layer=1`, `/api/volume?input=3&value=80`,
  `/api/state`.

**Fiabilidad**
- Autoguardado cada pocos segundos; si la app se cierra de golpe, al reabrirla
  ofrece recuperar el montaje.
- Gráficas de rendimiento en vivo (FPS, render, CPU, bitrate, nivel, memoria).
- La ventana sigue renderizando aunque esté tapada o minimizada.

## Actualizaciones automáticas

La app instalada busca actualizaciones si se configura un servidor: sube a una
carpeta web el contenido de `out/` de una versión nueva (`latest.yml`, el
instalador y su `.blockmap`) e indica esa dirección en
`%APPDATA%\StudioMix\update.json` como `{ "url": "https://servidor/carpeta/" }`
(o en la variable `STUDIOMIX_UPDATE_URL`). La actualización se descarga en
segundo plano y se instala al cerrar; nunca reinicia la app en mitad de un directo.

## Atajos

| Tecla | Acción |
| --- | --- |
| `1`–`9` / `Shift`+`1`–`9` | Entrada a Preview / directa al aire |
| `Espacio` / `Intro` | Cut / transición automática |
| `Ctrl`+`1`–`4` | Capa con la entrada de Preview |
| `B` | Negro (fundido de salida) |
| `V` | Estudio ↔ Multiview |
| `S` / `R` | Captura / guardar repetición |
| `Ctrl`+`S` / `Ctrl`+`O` | Guardar / abrir proyecto |
| Flechas / `Supr` / `Esc` | Mover o quitar la capa de escena / cerrar el panel lateral |

## Arquitectura

- `main.js`: proceso principal: ciclo de vida, ventana y canales IPC.
- `main/`: el trabajo del proceso principal, por áreas:
  - `ffmpeg.js`: códecs disponibles y argumentos de FFmpeg (funciones puras, con tests).
  - `outputs.js`: emisión, grabación, ISO y búfer de repetición.
  - `media.js`: protocolo `app://`, archivos permitidos, optimizar vídeo y modelos.
  - `netinputs.js`: entradas SRT/RTSP/RTMP/UDP/HLS.
  - `session.js`: proyectos, autoguardado y recuperación tras un cierre inesperado.
  - `system.js`, `updates.js`: métricas, test de subida y actualizaciones.
  - `screens.js`: ventanas de salida en otras pantallas.
  - `stingers.js`: convierte MOV con alfa y animaciones HTML en WebM con alfa.
  - `log.js`: registro en `%APPDATA%\StudioMix\logs\main.log` (incluye errores de la interfaz).
  - `remote.js`: servidor HTTP/WebSocket de la API y del mando (`remote/`).
  - `guests.js`: servidor HTTPS de invitados y señalización WebRTC (`guest/`).
- `renderer/js/`: `app.js` crea los servicios y arranca la interfaz;
  `actions.js` reúne las acciones (botones, teclado, MIDI, API); compositor
  (Program, Preview, multiview, vertical), efectos WebGL2, segmentación, audio
  (Web Audio + worklets de DSP), salidas, escenas, MIDI, chat, invitados y la
  interfaz (`ui-*.js`).

## Desarrollo

```bash
npm install
npm start        # abrir la app
npm run lint     # ESLint
npm test         # tests (node:test)
npm run dist     # instalador y portable en out/
```

## Relación con OBS Studio

Las escenas, los filtros, las transiciones luma wipe y stinger y el búfer de
repetición se diseñaron tras estudiar cómo los resuelve OBS Studio (GPL-2.0).
El código de StudioMix es una implementación propia: no contiene código, shaders
ni recursos de OBS.

## Limitaciones conocidas

- Sin cámara virtual (necesita un controlador nativo de Windows) ni NDI (necesita
  su SDK propietario).
- La grabación tiene una sola pista de audio.
- Invitados solo en la red local.
- El instalador no está firmado.
