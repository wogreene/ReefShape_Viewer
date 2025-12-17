// js/map.js

const STYLE = {
  version: 8,

  // REQUIRED for any text labels
  glyphs: "https://fonts.openmaptiles.org/{fontstack}/{range}.pbf",

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
      id: "basemap-labels",
      type: "raster",
      source: "esri-labels",
      maxzoom: 16   // hide basemap labels when zoomed in
    }
  ]
};

const map = new maplibregl.Map({
  container: "map",
  center: [-79.21, 25.42],
  zoom: 10,
  minZoom: 0,
  maxZoom: 26,
  style: STYLE
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

  // Reef labels (stable default font)
  map.addLayer({
    id: "site-labels",
    type: "symbol",
    source: "sites",
    minzoom: 6,
    maxzoom: 18,   // hide reef labels once zoomed in

    layout: {
      "text-field": ["get", "name"],
      "text-size": 14,
      "text-offset": [0, 1.2],
      "text-anchor": "top",
      "text-font": ["Roboto Regular"]
    },
    paint: {
      "text-color": "#ffffff",
      "text-halo-color": "#000000",
      "text-halo-width": 1.5
    }
  });
});

// ---------------------------
// Click → viewer
// ---------------------------

map.on("click", "sites", e => {
  const feature = e.features[0];
  const id = feature.properties.id;
  const name = feature.properties.name;

  // Victory Reef special case
  if (id === "victoryreef") {
    openViewChoiceModal(id, name);
  } else {
    // default behavior
    window.location.href = `viewer.html?id=${id}`;
  }
});


map.on("mouseenter", "sites", () => {
  map.getCanvas().style.cursor = "pointer";
});

map.on("mouseleave", "sites", () => {
  map.getCanvas().style.cursor = "";
});

function openViewChoiceModal(id, name) {
  const modal = document.getElementById("view-choice-modal");
  const title = document.getElementById("view-choice-title");

  title.textContent = name || "Select view";

  modal.style.display = "flex";

  document.getElementById("view-2d").onclick = () => {
    window.location.href = `viewer.html?id=${id}`;
  };

  document.getElementById("view-3d").onclick = () => {
    window.location.href = `splat.html?id=${id}`;
  };

  document.getElementById("view-cancel").onclick = () => {
    modal.style.display = "none";
  };

  // Click outside to close
  modal.onclick = e => {
    if (e.target === modal) modal.style.display = "none";
  };
}
