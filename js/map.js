// js/map.js
// Overview map with clickable reef points → viewer.html?id=...

const map = new maplibregl.Map({
  container: "map",
  center: [-79.5, 25.2], // adjust as needed
  zoom: 10,
  minZoom: 2,
  maxZoom: 22,

  style: {
    version: 8,

    /* 🔑 REQUIRED for text rendering */
    glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",

    sources: {
      /* ---------- Satellite basemap ---------- */
      "esri-satellite": {
        type: "raster",
        tiles: [
          "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
        ],
        tileSize: 256,
        maxzoom: 18
      },

      /* ---------- Reef sites ---------- */
      "sites": {
        type: "geojson",
        data: "data/sites.geojson"
      }
    },

    layers: [
      /* ---------- Satellite base ---------- */
      {
        id: "satellite",
        type: "raster",
        source: "esri-satellite",
        paint: {
          "raster-resampling": "linear"
        }
      },

      /* ---------- Reef points ---------- */
      {
        id: "sites",
        type: "circle",
        source: "sites",
        paint: {
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            4, 4,
            8, 6,
            12, 10,
            18, 16
          ],
          "circle-color": "#ffffff",
          "circle-stroke-color": "#000000",
          "circle-stroke-width": 1.5
        }
      },

      /* ---------- Reef labels (Courier-style) ---------- */
      {
        id: "site-labels",
        type: "symbol",
        source: "sites",
        layout: {
          "text-field": ["get", "name"],

          /* Monospace font */
          "text-font": ["Noto Sans Mono Regular"],

          "text-size": [
            "interpolate",
            ["linear"],
            ["zoom"],
            6, 11,
            10, 14,
            16, 18
          ],
          "text-offset": [0, 1.2],
          "text-anchor": "top",
          "text-allow-overlap": false
        },
        paint: {
          "text-color": "#ffffff",
          "text-halo-color": "#000000",
          "text-halo-width": 2
        }
      }
    ]
  }
});

/* -----------------------------------
   Cursor feedback
----------------------------------- */

map.on("mouseenter", "sites", () => {
  map.getCanvas().style.cursor = "pointer";
});
map.on("mouseleave", "sites", () => {
  map.getCanvas().style.cursor = "";
});
map.on("mouseenter", "site-labels", () => {
  map.getCanvas().style.cursor = "pointer";
});
map.on("mouseleave", "site-labels", () => {
  map.getCanvas().style.cursor = "";
});

/* -----------------------------------
   Click → viewer navigation
----------------------------------- */

function handleSiteClick(e) {
  const feature = e.features && e.features[0];
  if (!feature || !feature.properties || !feature.properties.id) {
    console.error("Clicked feature missing properties.id");
    return;
  }

  const reefId = feature.properties.id;
  window.location.href = `viewer.html?id=${reefId}`;
}

map.on("click", "sites", handleSiteClick);
map.on("click", "site-labels", handleSiteClick);

/* -----------------------------------
   Optional scale bar
----------------------------------- */

map.addControl(
  new maplibregl.ScaleControl({
    maxWidth: 120,
    unit: "metric"
  }),
  "bottom-right"
);
