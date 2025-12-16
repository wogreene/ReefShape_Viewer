// js/viewer.js

const TILER_BASE =
  "http://localhost:8000/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png?url=";

// 🔑 Native resolution of your COG (~0.5 mm)
const REEF_NATIVE_MAX_ZOOM = 28;

const params = new URLSearchParams(window.location.search);
const reefId = params.get("id");

const map = new maplibregl.Map({
  container: "map",
  minZoom: 0,

  // Allow overscaling beyond native resolution
  maxZoom: 32,

  style: {
    version: 8,
    glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
    sources: {
      "esri-satellite": {
        type: "raster",
        tiles: [
          "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
        ],
        tileSize: 256,
        maxzoom: 18
      }
    },
    layers: [
      {
        id: "satellite",
        type: "raster",
        source: "esri-satellite",
        paint: {
          "raster-resampling": "linear"
        }
      }
    ]
  }
});

// Scale bar (critical at mm scale)
map.addControl(
  new maplibregl.ScaleControl({
    maxWidth: 140,
    unit: "metric"
  }),
  "bottom-right"
);

async function init() {
  const sites = await fetch("data/sites.geojson").then(r => r.json());
  const feature = sites.features.find(
    f => f.properties.id === reefId
  );

  if (!feature) {
    alert("Reef not found");
    return;
  }

  const { timepoints, bounds } = feature.properties;
  const years = Object.keys(timepoints);

  map.fitBounds(bounds, {
    padding: 40,
    duration: 0
  });

  const select = document.getElementById("timepointSelect");
  years.forEach(y => {
    const opt = document.createElement("option");
    opt.value = y;
    opt.textContent = y;
    select.appendChild(opt);
  });

  map.on("load", () => {
    addRaster(timepoints[years[0]]);
  });

  select.onchange = () => {
    switchTimepoint(timepoints[select.value]);
  };
}

function addRaster(cogUrl) {
  map.addSource("reef", {
    type: "raster",
    tiles: [
      TILER_BASE + encodeURIComponent(cogUrl)
    ],
    tileSize: 256,

    // 🔑 THIS is the missing link
    maxzoom: REEF_NATIVE_MAX_ZOOM
  });

  map.addLayer({
    id: "reef-layer",
    type: "raster",
    source: "reef",
    paint: {
      "raster-opacity": 0.95,

      // Honest pixel behavior
      "raster-resampling": "nearest"
    }
  });
}

function switchTimepoint(cogUrl) {
  map.getSource("reef").setTiles([
    TILER_BASE + encodeURIComponent(cogUrl)
  ]);
}

init();
