// Thin Electron shell around the live ReefShape site - no local copy of the
// web app's HTML/JS/CSS, just a desktop window pointed at the deployed URL.
// The splat/tile data is already remote (Cloudflare R2) regardless, so this
// buys nothing by bundling assets locally, and picks up any future change to
// the live site automatically with zero re-packaging step.
//
// Electron embeds Chromium, which already has full WebXR support - nothing
// about entering VR needs any Electron-specific code. The existing "Enter
// VR" button in the page itself still requires a real user click (WebXR's
// requestSession() needs a genuine gesture, same as in a normal browser tab)
// - this window is just a replacement for "open Chrome and navigate here."

const { app, BrowserWindow } = require("electron");

const SITE_URL = "https://wogreene.github.io/ReefShape_Viewer/";

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "ReefShape VR Viewer"
  });
  win.loadURL(SITE_URL);
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
