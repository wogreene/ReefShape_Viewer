// js/viewer-ol.js

// Hardcoded COG for now (we will generalize later)
const COG_URL =
  "https://dl.dropboxusercontent.com/scl/fi/6o939vhxcpxtrw4qcg9xx/BullRun_20251103_cog.tif?rlkey=cz07p9uq4p4al5ww5wzdf4ick";

// Create a GeoTIFF source (this reads the COG directly)
const reefSource = new ol.source.GeoTIFF({
  sources: [
    { url: COG_URL }
  ],
  convertToRGB: true
});

// Wrap it in a tile layer
const reefLayer = new ol.layer.Tile({
  source: reefSource
});

// Create the map
const map = new ol.Map({
  target: "map",
  layers: [reefLayer],
  view: new ol.View({
    projection: "EPSG:4326",

    // Approximate center of the reef
    center: [-79.2479, 25.4535],

    // Starting zoom
    zoom: 17
  })
});
