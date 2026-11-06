/**
 * Script to verify Electron BrowserWindow dimensions on Windows.
 */
const { app, BrowserWindow } = require('electron');

app.whenReady().then(() => {
  const targets = [
    { w: 220, h: 80 },
    { w: 240, h: 90 },
    { w: 260, h: 100 },
    { w: 280, h: 110 }
  ];
  const results = [];
  for (const t of targets) {
    const win = new BrowserWindow({
      width: t.w,
      height: t.h,
      minWidth: 200,
      minHeight: 75,
      frame: false,
      show: false,
      resizable: true
    });
    const b = win.getBounds();
    results.push({ reqW: t.w, reqH: t.h, actW: b.width, actH: b.height });
    win.destroy();
  }
  process.stdout.write(JSON.stringify(results) + '\n');
  app.quit();
});

