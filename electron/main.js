const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('path');

// Une seule instance (évite deux fenêtres écrivant dans la même base)
if (!app.requestSingleInstanceLock()) app.quit();

let win;
function createWindow() {
  win = new BrowserWindow({
    width: 1400, height: 900, minWidth: 420, minHeight: 600,
    title: 'SIGL Saisie MEG', backgroundColor: '#f4f7f6', autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, spellcheck: false }
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, '..', 'www', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.on('closed', () => { win = null; });
}
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
