/**
 * Bridge to the desktop shell.
 *
 * Everything here degrades gracefully: in a browser `window.pharmacyDesktop`
 * is undefined and the app falls back to normal web behaviour, so one codebase
 * serves both.
 */

export type DesktopInfo = {
  version: string;
  dataDir: string;
  logFile: string;
  port: number;
  kiosk: boolean;
  platform: string;
};

export type PrinterInfo = { name: string; displayName: string; isDefault: boolean };

type DesktopApi = {
  isDesktop: true;
  info: () => Promise<DesktopInfo>;
  print: (deviceName?: string) => Promise<{ ok: boolean; error: string | null }>;
  printers: () => Promise<PrinterInfo[]>;
  openDrawer: (opts?: { printer?: string; pin?: 2 | 5 }) => Promise<{ ok: boolean; error?: string }>;
  leaveKiosk: () => Promise<boolean>;
  enterKiosk: () => Promise<boolean>;
  exit: () => Promise<void>;
  onExitRequested: (handler: () => void) => () => void;
};

declare global {
  interface Window {
    pharmacyDesktop?: DesktopApi;
  }
}

export const desktop: DesktopApi | undefined =
  typeof window !== 'undefined' ? window.pharmacyDesktop : undefined;

export const isDesktop = !!desktop;

/** Printer chosen in Settings, kept on this machine rather than in the database. */
const PRINTER_KEY = 'pharmacypos.printer';
const DRAWER_KEY = 'pharmacypos.drawer';

export function getPrinter(): string {
  return localStorage.getItem(PRINTER_KEY) ?? '';
}
export function setPrinter(name: string): void {
  localStorage.setItem(PRINTER_KEY, name);
}
export function getDrawerEnabled(): boolean {
  return localStorage.getItem(DRAWER_KEY) === '1';
}
export function setDrawerEnabled(on: boolean): void {
  localStorage.setItem(DRAWER_KEY, on ? '1' : '0');
}

/**
 * Print the current page.
 *
 * On the desktop this goes straight to the till printer with no dialog —
 * twenty print dialogs an hour is the difference between a POS and a website.
 * In a browser it falls back to `window.print()`.
 */
export async function printNow(): Promise<void> {
  if (!desktop) {
    window.print();
    return;
  }
  const result = await desktop.print(getPrinter() || undefined);
  if (!result.ok) {
    // Silent printing failed — fall back rather than losing the bill.
    console.error('Silent print failed:', result.error);
    window.print();
  }
}

/** Open the cash drawer, if one is configured. Never blocks the sale. */
export async function openCashDrawer(): Promise<void> {
  if (!desktop || !getDrawerEnabled()) return;
  try {
    const res = await desktop.openDrawer({ printer: getPrinter() || undefined });
    if (!res.ok) console.error('Cash drawer:', res.error);
  } catch (err) {
    console.error('Cash drawer:', err);
  }
}
