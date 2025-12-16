// js/viewer.js

const TILER_BASE =
  "https://YOUR-TITILER-APP/cog/tiles/{z}/{x}/{y}.png?url=";

const params = new URLSearchParams(window.location.search);
const reefId = params.get("id");

const map = new maplibregl.Map({
  container: "map",
  center: [-77.32, 25.08],
  zoom: 16,

  style: {
    version: 8,
    sources: {
      "esri-satellite": {
        type: "raster",
        tiles: [
          "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
        ],
        tileSize: 256
      },
      "esri-labels": {
        type: "raster",
        tiles: [
          "https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"
        ],
        tileSize: 256
      }
    },
    layers: [
      {
        id: "satellite",
        type: "raster",
        source: "esri-satellite"
      },
      {
        id: "labels",
        type: "raster",
        source: "esri-labels"
      }
    ]
  }
});

async function init() {
  const sites = await fetch("data/sites.geojson").then(r => r.json());
  const feature = sites.features.find(
    f => f.properties.id === reefId
  );

  if (!feature) {
    alert("Reef not found");
    return;
  }

  const timepoints = feature.properties.timepoints;
  const years = Object.keys(timepoints);

  const select = document.getElementById("timepointSelect");
  years.forEach(y => {
    const opt = document.createElement("option");
    opt.value = y;
    opt.textContent = y;
    select.appendChild(opt);
  });

  const [lon, lat] = feature.geometry.coordinates;
  map.setCenter([lon, lat]);

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
    tileSize: 256
  });

  map.addLayer({
    id: "reef-layer",
    type: "raster",
    source: "reef",
    paint: {
      "raster-opacity": 0.9
    }
  });
}

function switchTimepoint(cogUrl) {
  map.getSource("reef").setTiles([
    TILER_BASE + encodeURIComponent(cogUrl)
  ]);
}

init();
