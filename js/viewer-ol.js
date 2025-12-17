// js/viewer-ol.js

import Map from "https://esm.sh/ol@latest/Map.js";
import View from "https://esm.sh/ol@latest/View.js";
import WebGLTileLayer from "https://esm.sh/ol@latest/layer/WebGLTile.js";
import GeoTIFF from "https://esm.sh/ol@latest/source/GeoTIFF.js";
import ScaleLine from "https://esm.sh/ol@latest/control/ScaleLine.js";

// --------------------------------------------------
// Read reef ID from URL
// --------------------------------------------------

const params = new URLSearchParams(window.location.search);
const reefId = params.get("id");

if (!reefId) {
  alert("No reef id specified");
  throw new Error("Missing reef id");
}

// --------------------------------------------------
// Load site metadata
// --------------------------------------------------

const sites = await fetch("data/sites.geojson").then(r => r.json());

const feature = sites.features.find(
  f => f.properties.id === reefId
);

if (!feature) {
  alert("Reef not found");
  throw new Error("Invalid reef id");
}

const { timepoints, bounds } = feature.properties;
const years = Object.keys(timepoints);

// --------------------------------------------------
// View: allow deeper zoom than native resolution
// --------------------------------------------------

const view = new View({
  projection: "EPSG:4326",

  center: [
    (bounds[0] + bounds[2]) / 2,
    (bounds[1] + bounds[3]) / 2
  ],

  zoom: 22,

  // 🔑 Allow zooming beyond native resolution
  maxZoom: 30,

  // 🔑 Do NOT constrain resolution snapping
  constrainResolution: false
});

// --------------------------------------------------
// Initial GeoTIFF layer
// --------------------------------------------------

let reefLayer = new WebGLTileLayer({
  source: new GeoTIFF({
    sources: [
      {
        url: timepoints[years[0]],
        bands: [1, 2, 3]
      }
    ]
  }),

  // 🔑 Smooth magnification when zooming past native resolution
  interpolate: true
});

// --------------------------------------------------
// Create map
// --------------------------------------------------

const map = new Map({
  target: "map",
  layers: [reefLayer],
  view: view,
  controls: [
    new ScaleLine({
      units: "metric",
      bar: true,
      steps: 4,
      text: true,
      minWidth: 140
    })
  ]
});

// --------------------------------------------------
// Populate timepoint selector
// --------------------------------------------------

const select = document.getElementById("timepointSelect");

years.forEach(y => {
  const opt = document.createElement("option");
  opt.value = y;
  opt.textContent = y;
  select.appendChild(opt);
});

// --------------------------------------------------
// Timepoint switching (preserves view)
// --------------------------------------------------

select.addEventListener("change", () => {
  const year = select.value;

  reefLayer.setSource(
    new GeoTIFF({
      sources: [
        {
          url: timepoints[year],
          bands: [1, 2, 3]
        }
      ]
    })
  );
});
