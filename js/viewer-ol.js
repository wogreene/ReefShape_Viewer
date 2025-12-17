// js/viewer-ol.js

import Map from "https://esm.sh/ol@latest/Map.js";
import View from "https://esm.sh/ol@latest/View.js";
import WebGLTileLayer from "https://esm.sh/ol@latest/layer/WebGLTile.js";
import GeoTIFF from "https://esm.sh/ol@latest/source/GeoTIFF.js";
import ScaleLine from "https://esm.sh/ol@latest/control/ScaleLine.js";
import { defaults as defaultControls } from "https://esm.sh/ol@latest/control/defaults.js";

// --------------------------------------------------
// Read reef ID
// --------------------------------------------------

const params = new URLSearchParams(window.location.search);
const reefId = params.get("id");
if (!reefId) {
  alert("No reef id specified");
  throw new Error("Missing reef id");
}

// --------------------------------------------------
// Load metadata
// --------------------------------------------------

const sites = await fetch("data/sites.geojson").then(r => r.json());
const feature = sites.features.find(f => f.properties.id === reefId);

if (!feature) {
  alert("Reef not found");
  throw new Error("Invalid reef id");
}

const { timepoints, bounds } = feature.properties;
const years = Object.keys(timepoints);

// --------------------------------------------------
// View
// --------------------------------------------------

const view = new View({
  projection: "EPSG:4326",
  center: [
    (bounds[0] + bounds[2]) / 2,
    (bounds[1] + bounds[3]) / 2
  ],
  zoom: 20,
  maxZoom: 30,
  constrainResolution: false
});

// --------------------------------------------------
// Layer
// --------------------------------------------------

const reefLayer = new WebGLTileLayer({
  source: new GeoTIFF({
    sources: [{ url: timepoints[years[0]], bands: [1, 2, 3] }]
  }),
  interpolate: true,
  preload: 2,
  transition: 0,
  cacheSize: 512
});

// --------------------------------------------------
// Map (no default zoom controls)
// --------------------------------------------------

const map = new Map({
  target: "map",
  layers: [reefLayer],
  view,
  controls: defaultControls({
    zoom: false,
    rotate: false,
    attribution: false
  }),
  pixelRatio: Math.min(window.devicePixelRatio || 1, 2)
});

// --------------------------------------------------
// Correct OpenLayers scalebar (styled via CSS)
// --------------------------------------------------

map.addControl(
  new ScaleLine({
    units: "metric",
    bar: true,
    steps: 4,
    text: true,
    minWidth: 120
  })
);

// --------------------------------------------------
// Timepoint selector
// --------------------------------------------------

const select = document.getElementById("timepointSelect");
years.forEach(y => {
  const opt = document.createElement("option");
  opt.value = y;
  opt.textContent = y;
  select.appendChild(opt);
});

select.addEventListener("change", () => {
  reefLayer.setSource(
    new GeoTIFF({
      sources: [{ url: timepoints[select.value], bands: [1, 2, 3] }]
    })
  );
});

// --------------------------------------------------
// Custom zoom buttons
// --------------------------------------------------

document.getElementById("zoomIn").onclick = () => {
  view.setZoom(view.getZoom() + 1);
};

document.getElementById("zoomOut").onclick = () => {
  view.setZoom(view.getZoom() - 1);
};
