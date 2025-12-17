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
  zoom: 22,
  maxZoom: 29,
  constrainResolution: false,
  smoothResolutionConstraint: true
});

// --------------------------------------------------
// GeoTIFF source factory
// --------------------------------------------------

function createGeoTIFFSource(url) {
  return new GeoTIFF({
    sources: [{
      url,
      bands: [1, 2, 3]
    }],
    interpolate: true,   // blur instead of seams
    nodata: 0,
    wrapX: false
  });
}

// --------------------------------------------------
// WebGLTileLayer (ONLY supported option)
// --------------------------------------------------

const reefLayer = new WebGLTileLayer({
  source: createGeoTIFFSource(timepoints[years[0]]),

  // Artifact mitigation
  transition: 0,                // no cross-fade flicker
  cacheSize: 256,               // limit GPU pressure
  useInterimTilesOnError: false // no corrupted fallbacks
});

// --------------------------------------------------
// Map
// --------------------------------------------------
import { defaults as defaultInteractions } from "https://esm.sh/ol@latest/interaction/defaults.js";

const map = new Map({
  target: "map",
  layers: [reefLayer],
  view,
  controls: defaultControls({
    zoom: false,
    rotate: false,
    attribution: false
  }),
  interactions: defaultInteractions({
    altShiftDragRotate: true,  // 🔑 enable desktop rotation
    pinchRotate: true          // keep mobile rotation
  }),
  pixelRatio: Math.min(window.devicePixelRatio || 1, 2)
});


// Black background for NoData
map.getViewport().style.background = "black";

// --------------------------------------------------
// Scalebar
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
// Timepoint selector (preserve view)
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
