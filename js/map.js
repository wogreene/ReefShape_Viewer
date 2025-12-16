// js/map.js

const map = new maplibregl.Map({
  container: "map",
  center: [-77.32, 25.08],
  zoom: 7,
  minZoom: 0,
  maxZoom: 30,

  style: {
    version: 8,

    // REQUIRED for text labels
    glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",

    sources: {
      "esri-satellite": {
        type: "raster",
        tiles: [
          "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
        ],
        tileSize: 256,
        maxzoom: 18
      },
      "esri-labels": {
        type: "raster",
        tiles: [
          "https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"
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
      },
      {
        id: "labels",
        type: "raster",
        source: "esri-labels"
      }
    ]
  }
});

// Scale bar
map.addControl(
  new maplibregl.ScaleControl({
    maxWidth: 120,
    unit: "metric"
  }),
  "bottom-right"
);

map.on("load", async () => {
  const sites = await fetch("data/sites.geojson").then(r => r.json());

  map.addSource("sites", {
    type: "geojson",
    data: sites
  });

  // Reef points
  map.addLayer({
    id: "sites",
    type: "circle",
    source: "sites",
    paint: {
      "circle-radius": 6,
      "circle-color": "#ff6600",
      "circle-stroke-width": 1,
      "circle-stroke-color": "#ffffff"
    }
  });

  // Reef labels (NOW WORKS)
  map.addLayer({
    id: "site-labels",
    type: "symbol",
    source: "sites",
    layout: {
      "text-field": ["get", "name"],
      "text-size": 12,
      "text-offset": [0, 1.2],
      "text-anchor": "top"
    },
    paint: {
      "text-color": "#ffffff",
      "text-halo-color": "#000000",
      "text-halo-width": 1.5
    }
  });
});

// Click → viewer
map.on("click", "sites", e => {
  const id = e.features[0].properties.id;
  window.location.href = `site.html?id=${id}`;
});

map.on("mouseenter", "sites", () => {
  map.getCanvas().style.cursor = "pointer";
});

map.on("mouseleave", "sites", () => {
  map.getCanvas().style.cursor = "";
});
