// Will Greene 01/05/2026
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

// Overlays (vector)
import VectorLayer from "https://esm.sh/ol@latest/layer/Vector.js";
import VectorSource from "https://esm.sh/ol@latest/source/Vector.js";
import GeoJSON from "https://esm.sh/ol@latest/format/GeoJSON.js";
import Style from "https://esm.sh/ol@latest/style/Style.js";
import Stroke from "https://esm.sh/ol@latest/style/Stroke.js";
import Fill from "https://esm.sh/ol@latest/style/Fill.js";

// Popup
import Overlay from "https://esm.sh/ol@latest/Overlay.js";

// Geodesic area fallback
import { getArea as getGeodesicArea } from "https://esm.sh/ol@latest/sphere.js";

// IMPORTANT: JS Map, not OpenLayers Map
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
// Base raster layer
// --------------------------------------------------

const reefLayer = new WebGLTileLayer({
  source: createGeoTIFFSource(timepoints[years[0]]),
  transition: 0,
  cacheSize: 256,
  useInterimTilesOnError: true,
  buffer: 3
});

// --------------------------------------------------
// Overlay palette (species -> RGB)
// --------------------------------------------------

const coralPalette = await fetch("data/carribean_corals.json").then(r => r.json());

// id -> [r,g,b]
const coralColorById = new JSMap(
  (coralPalette.Labels || []).map(l => [String(l.id), l.fill])
);

// id -> human name
const coralNameById = new JSMap(
  (coralPalette.Labels || []).map(l => [String(l.id), l.name])
);

function getSpeciesIdFromFeature(feat) {
  // Your overlay file uses TL_Class, so prioritize it
  const candidates = [
    "TL_Class",
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

// --------------------------------------------------
// Overlay layer (GeoJSON outlines + fill)
// --------------------------------------------------

const overlayToggleWrap = document.getElementById("overlayToggleWrap");
const overlayToggle = document.getElementById("overlayToggle");

const styleCache = new JSMap();

// Filled polygons using species color; black = nodata elsewhere (raster), so vector fill is fine
function overlayStyleFn(feat) {
  const speciesId = getSpeciesIdFromFeature(feat) || "Unidentified_coral";
  const rgb =
    coralColorById.get(speciesId) ||
    coralColorById.get("Unidentified_coral") ||
    [255, 255, 255];

  // Tune these if you want stronger/weaker overlay
  const fillRGBA = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.35)`;
  const strokeRGBA = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.85)`;

  const key = `${fillRGBA}|${strokeRGBA}`;
  if (styleCache.has(key)) return styleCache.get(key);

  const style = new Style({
    fill: new Fill({ color: fillRGBA }),
    stroke: new Stroke({ color: strokeRGBA, width: 2 })
  });

  styleCache.set(key, style);
  return style;
}

const overlayLayer = new VectorLayer({
  visible: false,
  source: null,
  style: overlayStyleFn
});

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
// Map
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

// Black background
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
// Popup for coral info (species + area)
// --------------------------------------------------

// Create popup DOM (no viewer.html edits needed)
const popupEl = document.createElement("div");
popupEl.style.position = "absolute";
popupEl.style.background = "rgba(0,0,0,0.9)";
popupEl.style.color = "#fff";
popupEl.style.border = "1px solid rgba(255,255,255,0.25)";
popupEl.style.borderRadius = "6px";
popupEl.style.padding = "10px 12px";
popupEl.style.fontFamily = `"Courier New", Courier, monospace`;
popupEl.style.fontSize = "13px";
popupEl.style.maxWidth = "280px";
popupEl.style.pointerEvents = "auto";
popupEl.style.whiteSpace = "normal";
popupEl.style.display = "none";

const popupOverlay = new Overlay({
  element: popupEl,
  offset: [12, 12],
  positioning: "bottom-left",
  stopEvent: true
});
map.addOverlay(popupOverlay);

function formatAreaCm2(feat) {
  // Prefer TL_Area if present (already looks like cm^2 in your data)
  const a = feat.get("TL_Area");
  if (typeof a === "number" && isFinite(a)) return a;

  // Fallback: geodesic area from geometry (m^2 -> cm^2)
  const geom = feat.getGeometry();
  if (!geom) return null;

  const m2 = getGeodesicArea(geom, { projection: view.getProjection() });
  const cm2 = m2 * 10000;
  return cm2;
}

map.on("singleclick", (evt) => {
  if (!overlayLayer.getVisible()) {
    popupEl.style.display = "none";
    popupOverlay.setPosition(undefined);
    return;
  }

  let found = null;

  map.forEachFeatureAtPixel(
    evt.pixel,
    (feat, layer) => {
      if (layer === overlayLayer) {
        found = feat;
        return true;
      }
      return false;
    },
    {
      hitTolerance: 3,
      layerFilter: (layer) => layer === overlayLayer
    }
  );

  if (!found) {
    popupEl.style.display = "none";
    popupOverlay.setPosition(undefined);
    return;
  }

  const speciesId = getSpeciesIdFromFeature(found) || "Unidentified_coral";
  const speciesName = coralNameById.get(speciesId) || speciesId;

  const areaCm2 = formatAreaCm2(found);
  const areaText =
    (typeof areaCm2 === "number" && isFinite(areaCm2))
      ? `${areaCm2.toFixed(2)} cm²`
      : "N/A";

  popupEl.innerHTML = `
    <div style="font-weight:bold; margin-bottom:6px;">${speciesName}</div>
    <div><span style="opacity:0.85;">Area:</span> ${areaText}</div>
  `;

  popupEl.style.display = "block";
  popupOverlay.setPosition(evt.coordinate);
});

// Hide popup on drag (keeps it from “sticking” while panning)
map.on("movestart", () => {
  popupEl.style.display = "none";
  popupOverlay.setPosition(undefined);
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

// init overlay UI
syncOverlayUI(years[0]);

select.addEventListener("change", () => {
  const tp = select.value;
  reefLayer.setSource(createGeoTIFFSource(timepoints[tp]));
  syncOverlayUI(tp);

  // Close popup when changing timepoints
  popupEl.style.display = "none";
  popupOverlay.setPosition(undefined);
});

// toggle overlay on/off
if (overlayToggle) {
  overlayToggle.addEventListener("change", () => {
    const tp = select.value;
    const url = overlayUrlFor(tp);

    // Close popup whenever toggling
    popupEl.style.display = "none";
    popupOverlay.setPosition(undefined);

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
