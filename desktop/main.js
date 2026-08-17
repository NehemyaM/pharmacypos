/**
 * PharmacyPOS desktop shell.
 *
 * Wraps the existing web application — nothing about the billing code changes.
 * The Express server runs as a *child* process rather than inside the main
 * process, so a server crash restarts the server instead of taking the window
 * down with it. For a shop counter, "it came back by itself" beats "call
 * somebody".
 *
 * The database lives in the OS user-data directory, never inside the installed
 * program folder, so an update can never overwrite the shop's history.
 */

const { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu } = require('electron');
const { fork } = require('node:child_process');
const { createServer } = require('node:net');
const path = require('node:path');
const fs = require('node:fs');

const isDev = !app.isPackaged;

// Where the shop's data lives. Kept out of the install directory on purpose.
const DATA_DIR = path.join(app.getPath('userData'), 'data');
fs.mkdirSync(path.join(DATA_DIR, 'backups'), { recursive: true });

const LOG_FILE = path.join(app.getPath('userData'), 'pharmacypos.log');

/** Append to a log file — the only diagnostics available on a shop PC. */
function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    /* never let logging break billing */
  }
  process.stdout.write(line);
}

/** A JWT secret that survives reinstalls, generated once per machine. */
function machineSecret() {
  const file = path.join(app.getPath('userData'), '.secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = require('node:crypto').randomBytes(48).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

/** Ask the OS for a free port rather than hoping 4000 is unused. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

let serverProcess = null;
let mainWindow = null;
let serverPort = null;
let quitting = false;

function serverEntry() {
  // Packaged: resources/app/server/dist/index.js. Dev: repo layout.
  return isDev
    ? path.join(__dirname, '..', 'server', 'dist', 'index.js')
    : path.join(process.resourcesPath, 'app', 'server', 'dist', 'index.js');
}

function startServer(port) {
  const entry = serverEntry();
  if (!fs.existsSync(entry)) {
    dialog.showErrorBox(
      'PharmacyPOS could not start',
      `The application files are incomplete — ${entry} is missing.\n\n`
      + 'Reinstall PharmacyPOS. Your data in\n' + DATA_DIR + '\nwill not be affected.',
    );
    app.exit(1);
    return null;
  }

  log('starting server', entry, 'on port', port);

  const child = fork(entry, [], {
    // ELECTRON_RUN_AS_NODE makes Electron behave as plain Node for the child.
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      PORT: String(port),
      HOST: '127.0.0.1',                       // never reachable off this machine
      PHARMACY_DB: path.join(DATA_DIR, 'pharmacy.sqlite'),
      PHARMACY_BACKUP_DIR: path.join(DATA_DIR, 'backups'),
      PHARMACY_JWT_SECRET: machineSecret(),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  child.stdout?.on('data', (d) => log('[server]', String(d).trimEnd()));
  child.stderr?.on('data', (d) => log('[server:err]', String(d).trimEnd()));

  child.on('exit', (code, signal) => {
    log('server exited', code, signal ?? '');
    if (quitting) return;
    // Watchdog: bring it straight back. A dead server means no billing.
    log('restarting server in 1s');
    setTimeout(() => {
      serverProcess = startServer(port);
      mainWindow?.webContents.reloadIgnoringCache();
    }, 1000);
  });

  return child;
}

/** Poll the health endpoint until the server answers. */
async function waitForServer(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    backgroundColor: '#f1f5f9',
    title: 'PharmacyPOS',
    icon: path.join(__dirname, 'icons', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  // No application menu in the shop; it is only a route out of the app.
  Menu.setApplicationMenu(isDev ? Menu.getApplicationMenu() : null);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (!isDev) enterKiosk();
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}/`);

  // Keep navigation inside the app: a stray link must not turn the till into
  // a web browser.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`http://127.0.0.1:${port}`)) event.preventDefault();
  });

  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    log('renderer gone:', details.reason);
    mainWindow?.reload();
  });

  mainWindow.on('close', (event) => {
    if (quitting || isDev) return;
    // Closing is only allowed through the admin exit; see preload/renderer.
    event.preventDefault();
    mainWindow.webContents.send('pharmacy:exit-requested');
  });

  return mainWindow;
}

function enterKiosk() {
  if (!mainWindow) return;
  mainWindow.setKiosk(true);
  mainWindow.setMenuBarVisibility(false);
}

function leaveKiosk() {
  if (!mainWindow) return;
  mainWindow.setKiosk(false);
  mainWindow.setMenuBarVisibility(true);
}

// ---------------------------------------------------------------------------

// One instance only. Two copies of the app on one SQLite file is asking for
// trouble; the second launch just focuses the first.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    log('PharmacyPOS starting; data dir:', DATA_DIR);

    serverPort = Number(process.env.PHARMACY_DESKTOP_PORT) || (await freePort());
    serverProcess = startServer(serverPort);

    const healthy = await waitForServer(serverPort);
    if (!healthy) {
      dialog.showErrorBox(
        'PharmacyPOS could not start',
        'The billing service did not respond.\n\nCheck the log at:\n' + LOG_FILE,
      );
      app.exit(1);
      return;
    }
    log('server healthy on', serverPort);

    createWindow(serverPort);
    registerShortcuts();

    if (!isDev) {
      // Auto-update from GitHub Releases; failures must never block billing.
      try {
        const { autoUpdater } = require('electron-updater');
        autoUpdater.logger = { info: log, warn: log, error: log, debug: () => {} };
        autoUpdater.autoDownload = true;
        autoUpdater.autoInstallOnAppQuit = true;
        autoUpdater.checkForUpdatesAndNotify().catch((e) => log('update check failed:', e.message));
      } catch (e) {
        log('updater unavailable:', e.message);
      }
    }
  });

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', () => {
    quitting = true;
    if (serverProcess) {
      log('stopping server');
      serverProcess.kill();
    }
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());
}

function registerShortcuts() {
  // The escape hatch. A wedged application must never leave the counter with
  // no way out — this prompts for the admin password in the renderer.
  globalShortcut.register('Control+Alt+Shift+X', () => {
    mainWindow?.webContents.send('pharmacy:exit-requested');
  });
  if (isDev) {
    globalShortcut.register('Control+Shift+I', () => mainWindow?.webContents.toggleDevTools());
  }
}

// ---- Renderer requests -----------------------------------------------------

ipcMain.handle('pharmacy:info', () => ({
  version: app.getVersion(),
  dataDir: DATA_DIR,
  logFile: LOG_FILE,
  port: serverPort,
  kiosk: mainWindow?.isKiosk() ?? false,
  platform: process.platform,
}));

/** Called by the renderer once the admin password has been verified. */
ipcMain.handle('pharmacy:exit', () => {
  log('admin exit confirmed');
  quitting = true;
  app.quit();
});

ipcMain.handle('pharmacy:leave-kiosk', () => {
  leaveKiosk();
  return true;
});

ipcMain.handle('pharmacy:enter-kiosk', () => {
  enterKiosk();
  return true;
});

/**
 * Print the current page without a dialog.
 *
 * The browser's print dialog is fine once; twenty times an hour at a counter it
 * is not. `silent: true` sends straight to the chosen printer.
 *
 * @param {string} [deviceName] printer name; empty uses the system default
 */
ipcMain.handle('pharmacy:print', async (_event, deviceName) => {
  if (!mainWindow) return { ok: false, error: 'No window' };
  return new Promise((resolve) => {
    mainWindow.webContents.print(
      {
        silent: true,
        printBackground: true,
        deviceName: deviceName || undefined,
        margins: { marginType: 'none' },
      },
      (ok, reason) => {
        if (!ok) log('print failed:', reason);
        resolve({ ok, error: ok ? null : reason });
      },
    );
  });
});

/** Printers the OS knows about, so Settings can offer a real list. */
ipcMain.handle('pharmacy:printers', async () => {
  if (!mainWindow) return [];
  const printers = await mainWindow.webContents.getPrintersAsync();
  return printers.map((p) => ({
    name: p.name,
    displayName: p.displayName,
    isDefault: p.isDefault,
  }));
});

/**
 * Open the cash drawer.
 *
 * A drawer has no USB port of its own — it hangs off the receipt printer's
 * RJ11 "kick" port, and opens when the printer receives ESC p m t1 t2. So the
 * pulse is written to the *printer* as a raw job.
 *
 * m=0 selects drawer pin 2, t1/t2 are on/off times in 2ms units. 25/250 is the
 * widely compatible default; a drawer that does not open is usually wired to
 * pin 5, which is m=1.
 */
ipcMain.handle('pharmacy:open-drawer', async (_event, opts = {}) => {
  const pin = opts.pin === 5 ? 1 : 0;
  const pulse = Buffer.from([0x1b, 0x70, pin, 25, 250]); // ESC p m 25 250

  try {
    if (process.platform === 'win32') {
      // Write the raw bytes to the shared printer via a temp file and COPY /B.
      const printer = opts.printer;
      if (!printer) return { ok: false, error: 'No printer configured for the drawer' };
      const tmp = path.join(app.getPath('temp'), `drawer-${Date.now()}.bin`);
      fs.writeFileSync(tmp, pulse);
      const { execFile } = require('node:child_process');
      await new Promise((resolve, reject) => {
        execFile('cmd', ['/c', 'copy', '/b', tmp, `\\\\localhost\\${printer}`],
          (err) => (err ? reject(err) : resolve()));
      });
      fs.unlinkSync(tmp);
    } else {
      // CUPS: send a raw job straight through.
      const { execFile } = require('node:child_process');
      const args = ['-o', 'raw'];
      if (opts.printer) args.push('-d', opts.printer);
      await new Promise((resolve, reject) => {
        const proc = execFile('lp', args, (err) => (err ? reject(err) : resolve()));
        proc.stdin.end(pulse);
      });
    }
    log('cash drawer pulse sent');
    return { ok: true };
  } catch (err) {
    log('drawer failed:', err.message);
    return { ok: false, error: err.message };
  }
});

module.exports = { DATA_DIR };
