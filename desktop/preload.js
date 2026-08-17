/**
 * The only bridge between the web app and the desktop shell.
 *
 * contextIsolation is on and nodeIntegration is off, so the page cannot reach
 * Node directly. Everything it is allowed to do is listed here, explicitly.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pharmacyDesktop', {
  /** Present only in the desktop build — the web build leaves this undefined. */
  isDesktop: true,

  /** Version, data directory, log path, kiosk state. */
  info: () => ipcRenderer.invoke('pharmacy:info'),

  /** Print the current page with no dialog. Pass a printer name or omit for default. */
  print: (deviceName) => ipcRenderer.invoke('pharmacy:print', deviceName),

  /** Printers the OS knows about. */
  printers: () => ipcRenderer.invoke('pharmacy:printers'),

  /** Send the ESC/POS kick pulse to open the cash drawer. */
  openDrawer: (opts) => ipcRenderer.invoke('pharmacy:open-drawer', opts ?? {}),

  /** Leave kiosk mode — only after the admin password has been verified. */
  leaveKiosk: () => ipcRenderer.invoke('pharmacy:leave-kiosk'),
  enterKiosk: () => ipcRenderer.invoke('pharmacy:enter-kiosk'),

  /** Close the application. The renderer must verify the admin first. */
  exit: () => ipcRenderer.invoke('pharmacy:exit'),

  /**
   * Someone pressed the escape combo or tried to close the window. The
   * renderer answers by showing the admin password prompt.
   */
  onExitRequested: (handler) => {
    const listener = () => handler();
    ipcRenderer.on('pharmacy:exit-requested', listener);
    return () => ipcRenderer.removeListener('pharmacy:exit-requested', listener);
  },
});
