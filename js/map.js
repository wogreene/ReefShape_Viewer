const map = new maplibregl.Map({
  container: "map",
  style: "https://demotiles.maplibre.org/style.json",
  center: [-77.32, 25.08],
  zoom: 7
});

map.on("load", async () => {
  const sites = await fetch("data/sites.geojson").then(r => r.json());

  map.addSource("sites", {
    type: "geojson",
    data: sites
  });

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
});

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
