// js/viewer-ol.js

import Map from "https://esm.sh/ol@latest/Map.js";
import View from "https://esm.sh/ol@latest/View.js";
import WebGLTileLayer from "https://esm.sh/ol@latest/layer/WebGLTile.js";
import GeoTIFF from "https://esm.sh/ol@latest/source/GeoTIFF.js";
import { getPointResolution } from "https://esm.sh/ol@latest/proj.js";

// --------------------------------------------------
// Read reef ID
// --------------------------------------------------

const params = new URLSearchParams(window.location.search);
const reefId = params.get("id");
if (!reefId) throw new Error("No reef id specified");

// --------------------------------------------------
// Load metadata
// --------------------------------------------------

const sites = await fetch("data/sites.geojson").then(r => r.json());
const feature = sites.features.find(f => f.properties.id === reefId);
if (!feature) throw new Error("Reef not found");

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
  zoom: 17,
  maxZoom: 28,
  constrainResolution: false
});

// --------------------------------------------------
// GeoTIFF layer (stabilized)
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

  interpolate: true,
  preload: 2,
  transition: 0,       // 🔑 disable fade animation
  cacheSize: 512       // 🔑 reduce tile churn
});

// --------------------------------------------------
// Map
// --------------------------------------------------

const map = new Map({
  target: "map",
  layers: [reefLayer],
  view,
  pixelRatio: Math.min(window.devicePixelRatio || 1, 2) // 🔑 mobile GPU safety
});

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
      sources: [
        {
          url: timepoints[select.value],
          bands: [1, 2, 3]
        }
      ]
    })
  );
});

// --------------------------------------------------
// Custom scalebar (distance + scale ratio)
// --------------------------------------------------

const barEl = document.getElementById("scalebarLine");
const textEl = document.getElementById("scalebarText");

function updateScalebar() {
  const resolution = view.getResolution();
  if (!resolution) return;

  const center = view.getCenter();
  const metersPerPixel = getPointResolution(
    view.getProjection(),
    resolution,
    center
  );

  // Choose a nice round distance
  const targetPx = 100;
  let meters = metersPerPixel * targetPx;

  const scales = [1, 2, 5, 10];
  let pow = Math.pow(10, Math.floor(Math.log10(meters)));
  let nice = scales.find(s => s * pow >= meters) || 10 * pow;
  const displayMeters = nice;
  const displayPx = displayMeters / metersPerPixel;

  barEl.style.width = `${displayPx}px`;

  const scaleRatio = Math.round(1 / (metersPerPixel * 0.001)); // approx
  const label =
    displayMeters >= 1
      ? `${displayMeters.toFixed(2)} m`
      : `${(displayMeters * 1000).toFixed(1)} mm`;

  textEl.textContent = `${label}   |   1:${scaleRatio}`;
}

view.on("change:resolution", updateScalebar);
updateScalebar();
