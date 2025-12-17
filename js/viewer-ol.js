// js/viewer-ol.js
// OpenLayers ES modules via esm.sh (dependency-safe)

import Map from "https://esm.sh/ol@latest/Map.js";
import View from "https://esm.sh/ol@latest/View.js";
import TileLayer from "https://esm.sh/ol@latest/layer/Tile.js";
import GeoTIFF from "https://esm.sh/ol@latest/source/GeoTIFF.js";

// Your COG URL
const COG_URL =
  "https://dl.dropboxusercontent.com/scl/fi/6o939vhxcpxtrw4qcg9xx/BullRun_20251103_cog.tif?rlkey=cz07p9uq4p4al5ww5wzdf4ick";

// Create a GeoTIFF source
const reefSource = new GeoTIFF({
  sources: [
    { url: COG_URL }
  ],
  convertToRGB: true
});

// Wrap it in a tile layer
const reefLayer = new TileLayer({
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

    // Starting zoom
    zoom: 17
  })
});
