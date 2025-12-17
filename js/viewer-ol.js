// js/viewer-ol.js

import Map from "https://cdn.jsdelivr.net/npm/ol@latest/Map.js";
import View from "https://cdn.jsdelivr.net/npm/ol@latest/View.js";
import TileLayer from "https://cdn.jsdelivr.net/npm/ol@latest/layer/Tile.js";
import GeoTIFF from "https://cdn.jsdelivr.net/npm/ol@latest/source/GeoTIFF.js";

// Your COG URL
const COG_URL =
  "https://dl.dropboxusercontent.com/scl/fi/6o939vhxcpxtrw4qcg9xx/BullRun_20251103_cog.tif?rlkey=cz07p9uq4p4al5ww5wzdf4ick";

// GeoTIFF source (this is the key part)
const reefSource = new GeoTIFF({
  sources: [
    { url: COG_URL }
  ],
  convertToRGB: true
});

// Tile layer wrapping the COG
const reefLayer = new TileLayer({
  source: reefSource
});

// Create the map
const map = new Map({
  target: "map",
  layers: [reefLayer],
  view: new View({
    projection: "EPSG:4326",

    // Rough center of the reef
    center: [-79.2479, 25.4535],

    // Initial zoom
    zoom: 17
  })
});
