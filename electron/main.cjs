const { app, BrowserWindow, shell, session } = require('electron');
const path = require('path');

const isDev = process.env.ELECTRON_DEV === '1';

/** @type {BrowserWindow | null} */
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Nig Drives',
    backgroundColor: '#0a0e14',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
    show: false,
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // Open http(s) links in the system browser (OSM attribution, etc.)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  if (isDev) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * v1.3.5: identify ourselves to the public Overpass mirrors (they reject
 * anonymous clients with 406 / 429). Only Overpass requests are touched.
 */
const OVERPASS_UA = `nig-drives/${app.getVersion()} (+https://github.com/nigelrmccoy-oss/nig-drives)`;
function identifyToOverpass() {
  const urls = [
    'https://overpass-api.de/*',
    'https://maps.mail.ru/osm/tools/overpass/*',
    'https://overpass.kumi.systems/*',
    'https://overpass.private.coffee/*',
  ];
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls }, (details, callback) => {
    callback({ requestHeaders: { ...details.requestHeaders, 'User-Agent': OVERPASS_UA } });
  });
}

app.whenReady().then(() => {
  identifyToOverpass();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
