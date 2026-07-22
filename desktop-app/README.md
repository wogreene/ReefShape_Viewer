# ReefShape VR Viewer (desktop launcher)

A thin Electron shell around the live [ReefShape Viewer](https://wogreene.github.io/ReefShape_Viewer/) site - opens it in its own window instead of a browser tab, so it can be launched directly (e.g. via Meta Quest Air Link) rather than through Chrome.

This does **not** contain a copy of the web app. It just points a desktop window at the live URL, so any change to the site itself (in the main repo) is picked up automatically - nothing here ever needs to be rebuilt when `js/splat-viewer.js` or anything else changes.

## Prerequisites

- [Node.js](https://nodejs.org/) (includes npm) installed on the machine building/running this.

## Test it locally

```
cd desktop-app
npm install
npm start
```

This opens the app in a normal window. Click through the password gate / map / reef picker exactly as you would in a browser tab, then click "Enter VR" as usual - WebXR still requires a real click to start a session, this doesn't change that.

## Build the Windows installer

```
npm run dist
```

Produces an NSIS installer under `desktop-app/dist/`. This is unsigned (no code-signing certificate configured), so Windows SmartScreen will show an "unknown publisher" warning the first time it's run - click "More info" -> "Run anyway" to proceed. That warning is expected for a personal/side-loaded build like this.

Once installed, launch it like any other desktop app while Air Link is active, click "Enter VR" inside the window, and it should hand off to the headset the same way any other WebXR/OpenXR content would.
