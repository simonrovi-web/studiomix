'use strict';

// The app window, shared by the main-process modules. Messages to the renderer
// go through `send`, which is a no-op while there is no window.

const context = {
  window: null,

  send(channel, ...args) {
    const win = context.window;
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
  },
};

module.exports = context;
