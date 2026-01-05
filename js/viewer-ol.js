// Will Greene 12/18/2025
// js/viewer-ol.js

import OLMap from "https://esm.sh/ol@latest/Map.js";
import View from "https://esm.sh/ol@latest/View.js";
import WebGLTileLayer from "https://esm.sh/ol@latest/layer/WebGLTile.js";
import GeoTIFF from "https://esm.sh/ol@latest/source/GeoTIFF.js";
import ScaleLine from "https://esm.sh/ol@latest/control/ScaleLine.js";
import { defaults as defaultControls } from "https://esm.sh/ol@latest/control/defaults.js";
import { defaults as defaultInteractions } from "https://esm.sh/ol@latest/interaction/defaults.js";
import DragRotate from "https://esm.sh/ol@latest/interaction/DragRotate.js";
import { platformModifierKeyOnly } from "https://esm.sh/ol@latest/events/condition.js";

// NEW: GeoJSON overlay imports
import VectorLayer from "https://esm.sh/ol@latest/layer/Vector.js";
import VectorSource from "https://esm.sh/ol@latest/source/Vector.js";
import GeoJSON from "https://esm.sh/ol@latest/format/GeoJSON.js";
import Style from "https://esm.sh/ol@latest/style/Style.js";
import Stroke from "https://esm.sh/ol@latest/style/Stroke.js";
import Fill from "https://esm.sh/ol@latest/style/Fill.js";

// IMPORTANT: JS Map, not OpenLayers Map (since we renamed OLMap above)
const JSMap = globalThis.Map;

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

const { timepoints, bounds, overlays } = feature.properties;
const years = Object.keys(timepoints);

// --------------------------------------------------
// View
// --------------------------------------------------
const isApple = /Mac|iPhone|iPad|iPod/.test(navigator.platform);

const view = new View({
  projection: "EPSG:4326",
  center: [
    (bounds[0] + bounds[2]) / 2,
    (bounds[1] + bounds[3]) / 2
  ],
  zoom: 22,
  maxZoom: isApple ? 28 : 29,
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
    interpolate: true,
    nodata: 0,
    wrapX: false,
    preload: Infinity
  });
}

// --------------------------------------------------
// WebGLTileLayer (supported + stable)
// --------------------------------------------------

const reefLayer = new WebGLTileLayer({
  source: createGeoTIFFSource(timepoints[years[0]]),
  transition: 0,
  cacheSize: 256,
  useInterimTilesOnError: true,
  buffer: 3
});

// --------------------------------------------------
// Overlay layer (GeoJSON outlines)
// --------------------------------------------------

const overlayToggleWrap = document.getElementById("overlayToggleWrap");
const overlayToggle = document.getElementById("overlayToggle");

// Load species->RGB mapping
const coralPalette = await fetch("data/carribean_corals.json").then(r => r.json());

// Build a lookup: "Acropora_palmata" -> [255,128,0]
const coralColorById = new JSMap(
  (coralPalette.Labels || []).map(l => [String(l.id), l.fill])
);

// Helper: feature -> species string (tries common keys)
function getSpeciesIdFromFeature(feat) {
  const candidates = [
    "species",
    "Species",
    "label",
    "Label",
    "class",
    "Class",
    "id",
    "Id",
    "name",
    "Name"
  ];

  for (const k of candidates) {
    const v = feat.get(k);
    if (v !== undefined && v !== null && String(v).trim() !== "") {
      return String(v).trim();
    }
  }
  return null;
}

// Cache styles so we don’t recreate per feature per frame
const styleCache = new JSMap();

// Outline style by species color @ 50% opacity
function overlayStyleFn(feat) {
  const speciesId = getSpeciesIdFromFeature(feat) || "Unidentified_coral";
  const rgb =
    coralColorById.get(speciesId) ||
    coralColorById.get("Unidentified_coral") ||
    [255, 255, 255];

  const strokeRGBA = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.5)`;

  if (styleCache.has(strokeRGBA)) return styleCache.get(strokeRGBA);

  const style = new Style({
    stroke: new Stroke({
      color: strokeRGBA,
      width: 2
    }),
    fill: new Fill({
      color: "rgba(0,0,0,0)"
    })
  });

  styleCache.set(strokeRGBA, style);
  return style;
}

const overlayLayer = new VectorLayer({
  visible: false,
  source: null,
  style: overlayStyleFn
});

// IMPORTANT: use JSMap for caching sources
const overlayCache = new JSMap();

function overlayUrlFor(tp) {
  if (!overlays) return null;
  return overlays[tp] || null;
}

function getOverlaySource(url) {
  if (!url) return null;
  if (overlayCache.has(url)) return overlayCache.get(url);

  const src = new VectorSource({
    url,
    format: new GeoJSON({
      dataProjection: "EPSG:4326",
      featureProjection: "EPSG:4326"
    })
  });

  overlayCache.set(url, src);
  return src;
}

function syncOverlayUI(tp) {
  const url = overlayUrlFor(tp);

  if (!url) {
    if (overlayToggleWrap) overlayToggleWrap.style.display = "none";
    if (overlayToggle) overlayToggle.checked = false;
    overlayLayer.setVisible(false);
    overlayLayer.setSource(null);
    return;
  }

  if (overlayToggleWrap) overlayToggleWrap.style.display = "inline-flex";

  if (overlayToggle && overlayToggle.checked) {
    overlayLayer.setSource(getOverlaySource(url));
    overlayLayer.setVisible(true);
  } else {
    overlayLayer.setVisible(false);
  }
}

// --------------------------------------------------
// Map (with correct interaction setup)
// --------------------------------------------------

const map = new OLMap({
  target: "map",
  layers: [reefLayer, overlayLayer],
  view,
  controls: defaultControls({
    zoom: false,
    rotate: false,
    attribution: false
  }),
  interactions: defaultInteractions({
    altShiftDragRotate: false,
    pinchRotate: true,
    onFocusOnly: true
  }),
  pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
});

// Cmd/Ctrl + drag rotation
map.addInteraction(
  new DragRotate({
    condition: platformModifierKeyOnly
  })
);

// Black background for NoData areas
map.getViewport().style.background = "black";

// Scalebar
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

// init overlay UI for first timepoint
syncOverlayUI(years[0]);

select.addEventListener("change", () => {
  const tp = select.value;
  reefLayer.setSource(createGeoTIFFSource(timepoints[tp]));
  syncOverlayUI(tp);
});

// Toggle overlay on/off
if (overlayToggle) {
  overlayToggle.addEventListener("change", () => {
    const tp = select.value;
    const url = overlayUrlFor(tp);

    if (!overlayToggle.checked || !url) {
      overlayLayer.setVisible(false);
      return;
    }

    overlayLayer.setSource(getOverlaySource(url));
    overlayLayer.setVisible(true);
  });
}

// --------------------------------------------------
// Custom zoom buttons
// --------------------------------------------------

document.getElementById("zoomIn").onclick = () => {
  view.setZoom(view.getZoom() + 1);
};

document.getElementById("zoomOut").onclick = () => {
  view.setZoom(view.getZoom() - 1);
};

// --------------------------------------------------
// mac / iOS warning system
// --------------------------------------------------

const isMacOrIOS =
  /Mac|iPhone|iPad|iPod/.test(navigator.platform) ||
  /(Macintosh|iPhone|iPad)/.test(navigator.userAgent);

if (isMacOrIOS) {
  document.getElementById("macWarningIcon").style.display = "block";
}

document.getElementById("macWarningIcon").onclick = () => {
  document.getElementById("macWarningModal").style.display = "flex";
};

document.getElementById("macWarningClose").onclick = () => {
  document.getElementById("macWarningModal").style.display = "none";
};
