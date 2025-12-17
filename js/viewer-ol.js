// js/viewer-ol.js
// OpenLayers GeoTIFF viewer (correct WebGL setup)

import Map from "https://esm.sh/ol@latest/Map.js";
import View from "https://esm.sh/ol@latest/View.js";
import WebGLTileLayer from "https://esm.sh/ol@latest/layer/WebGLTile.js";
import GeoTIFF from "https://esm.sh/ol@latest/source/GeoTIFF.js";

// Your COG URL
const COG_URL =
  "https://dl.dropboxusercontent.com/scl/fi/6o939vhxcpxtrw4qcg9xx/BullRun_20251103_cog.tif?rlkey=cz07p9uq4p4al5ww5wzdf4ick";

// GeoTIFF source (explicit RGB bands)
const reefSource = new GeoTIFF({
  sources: [
    {
      url: COG_URL,
      bands: [1, 2, 3]
    }
  ]
});

// 🔑 MUST be WebGLTileLayer
const reefLayer = new WebGLTileLayer({
  source: reefSource
});

// Create the map
const map = new Map({
  target: "map",
  layers: [reefLayer],
  view: new View({
    projection: "EPSG:4326",

    // Approximate reef center
    center: [-79.2479, 25.4535],

    // Initial zoom
    zoom: 17
  })
});
