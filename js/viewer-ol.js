// js/viewer-ol.js

import Map from "https://esm.sh/ol@latest/Map.js";
import View from "https://esm.sh/ol@latest/View.js";
import TileLayer from "https://esm.sh/ol@latest/layer/Tile.js";
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
  zoom: 22,
  maxZoom: 30,
  constrainResolution: false
});

// --------------------------------------------------
// GeoTIFF source factory (stable, image-based)
// --------------------------------------------------

function createGeoTIFFSource(url) {
  return new GeoTIFF({
    sources: [{ url, bands: [1, 2, 3] }],
    renderMode: "image",   // 🔑 eliminates diagonal triangle artifacts
    interpolate: true,     // allow blur instead of seams
    nodata: 0
  });
}

// --------------------------------------------------
// Layer (IMAGE tiles, not WebGL)
// --------------------------------------------------

const reefLayer = new TileLayer({
  source: createGeoTIFFSource(timepoints[years[0]]),
  preload: 2,        // reduces edge seams
  transition: 0
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

// Black background for NoData areas
map.getViewport().style.background = "black";

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
// Timepoint selector (preserve view extent)
// --------------------------------------------------

const select = document.getElementById("timepointSelect");
years.forEach(y => {
  const opt = document.createElement("option");
  opt.value = y;
  opt.textContent = y;
  select.appendChild(opt);
});

select.addEventListener("change", () => {
  reefLayer.setSource(createGeoTIFFSource(timepoints[select.value]));
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
