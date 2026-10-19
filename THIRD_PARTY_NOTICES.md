# Componentes de terceros

El código de StudioMix se distribuye con licencia MIT (ver `LICENSE`). Los
instaladores incluyen además estos componentes, cada uno con su propia licencia.

| Componente | Uso en StudioMix | Licencia |
| --- | --- | --- |
| [Electron](https://www.electronjs.org/) (incluye Chromium y Node.js) | Base de la aplicación | MIT; las licencias de Chromium van en `LICENSES.chromium.html` dentro de la instalación |
| [FFmpeg](https://ffmpeg.org/) 6.1.1, compilación «essentials» de [gyan.dev](https://www.gyan.dev/ffmpeg/builds/), vía [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) | Codificación, emisión, grabación, entradas de red | **GPL v3** (incluye x264) |
| [MediaPipe Tasks Vision](https://github.com/google-ai-edge/mediapipe) | Quitar el fondo sin croma | Apache-2.0 |
| Modelo «selfie segmenter» de MediaPipe | Quitar el fondo (se descarga de Google la primera vez que se usa; no va en el instalador) | Apache-2.0 |
| [ws](https://github.com/websockets/ws) | Servidor del mando remoto e invitados | MIT |
| [qrcode](https://github.com/soldair/node-qrcode) | Códigos QR del mando e invitados | MIT |
| [selfsigned](https://github.com/jfromaniello/selfsigned) | Certificado local para invitados | MIT |
| [electron-updater](https://github.com/electron-userland/electron-builder) | Actualizaciones automáticas | MIT |

## FFmpeg (GPL v3)

StudioMix ejecuta FFmpeg como un programa independiente (`ffmpeg.exe`); no lo
enlaza. El binario se distribuye sin modificar, junto a su licencia
(`resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg.exe.LICENSE`).

Código fuente correspondiente:

- FFmpeg 6.1.1: <https://ffmpeg.org/releases/ffmpeg-6.1.1.tar.xz>
- Configuración y dependencias de la compilación: <https://www.gyan.dev/ffmpeg/builds/>

Quien redistribuya los instaladores debe mantener disponible ese código fuente
según la GPL v3 (por ejemplo, adjuntándolo a la publicación o con un enlace
permanente) o sustituir FFmpeg por una compilación con otra licencia.
