// js/viewer.js

const TILER_BASE =
  "https://reef-titiler.onrender.com/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png?tileSize=512&url=";

const params = new URLSearchParams(window.location.search);
const reefId = params.get("id");

const map = new maplibregl.Map({
  container: "map",
  minZoom: 0,
  maxZoom: 32,
  style: {
    version: 8,
    sources: {
      "esri-satellite": {
        type: "raster",
        tiles: [
          "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
        ],
        tileSize: 256
      }
    },
    layers: [
      {
        id: "satellite",
        type: "raster",
        source: "esri-satellite"
      }
    ]
  }
});

map.addControl(
  new maplibregl.ScaleControl({
    maxWidth: 140,
    unit: "metric"
  }),
  "bottom-right"
);

async function init() {
  const sites = await fetch("data/sites.geojson").then(r => r.json());
  const feature = sites.features.find(f => f.properties.id === reefId);

  if (!feature) {
    alert("Reef not found");
    return;
  }

  const { timepoints, bounds } = feature.properties;
  const years = Object.keys(timepoints);

  map.fitBounds(bounds, { padding: 40, duration: 0 });

  map.on("load", () => {
    map.addSource("reef", {
      type: "raster",
      tiles: [TILER_BASE + encodeURIComponent(timepoints[years[0]])],
      tileSize: 512,

      // 🔑 realistic data zoom
      maxzoom: 30,

      // 🔑 prevent global tile spam
      bounds: bounds
    });

    map.addLayer({
      id: "reef-layer",
      type: "raster",
      source: "reef",
      paint: {
        "raster-resampling": "nearest",
        "raster-fade-duration": 0
      }
    });
  });
}

init();
