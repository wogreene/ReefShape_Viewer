// js/map.js

// ---------------------------
// Access control (client-side "soft gate")
// Projects + master access are defined in data/projects.json
// Site membership is defined in data/sites.geojson via properties.passwords = [ ... ]
// ---------------------------

function normalizePw(pw) {
  // Case-sensitive by default. If you want case-insensitive, use:
  // return (pw || "").trim().toLowerCase();
  return (pw || "").trim();
}

function getPassword() {
  return normalizePw(sessionStorage.getItem("reefshape_password"));
}

// Loaded from projects.json (any project with "isMaster": true becomes master)
let MASTER_PASSWORDS = new Set();

async function loadProjectsConfig() {
  const data = await fetch("data/projects.json", { cache: "no-store" }).then(r => r.json());
  const projects = Array.isArray(data.projects) ? data.projects : [];
  MASTER_PASSWORDS = new Set(
    projects
      .filter(p => p && p.isMaster)
      .map(p => normalizePw(p.password))
      .filter(Boolean)
  );
}

function isMaster(pw) {
  return MASTER_PASSWORDS.has(normalizePw(pw));
}

function hasAccess(featureProps, pw) {
  if (!pw) return false;
  if (isMaster(pw)) return true;

  // New schema: passwords: ["msc","DEMO",...]
  const pwList = featureProps?.passwords;
  if (Array.isArray(pwList)) {
    return pwList.some(p => normalizePw(p) === pw);
  }

  // Back-compat (optional): legacy schema: password: "msc"
  const legacy = featureProps?.password;
  if (legacy) return normalizePw(legacy) === pw;

  return false;
}

function computeBBoxLonLat(features) {
  // Returns [[minLon, minLat], [maxLon, maxLat]] for Point features
  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;

  for (const f of features || []) {
    const geom = f?.geometry;
    if (!geom || geom.type !== "Point") continue;
    const c = geom.coordinates;
    if (!Array.isArray(c) || c.length < 2) continue;

    const lon = Number(c[0]);
    const lat = Number(c[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;

    minLon = Math.min(minLon, lon);
    minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon);
    maxLat = Math.max(maxLat, lat);
  }

  if (!Number.isFinite(minLon)) return null;
  return [[minLon, minLat], [maxLon, maxLat]];
}

// A safe default view BEFORE we know what sites are accessible.
// Once sites load, we will always fit to the accessible sites.
const DEFAULT_VIEW = { center: [-74, 18], zoom: 6 };

// ---------------------------
// Map style
// ---------------------------
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
      maxzoom: 16 // hide basemap labels when zoomed in
    }
  ]
};

const map = new maplibregl.Map({
  container: "map",
  center: DEFAULT_VIEW.center,
  zoom: DEFAULT_VIEW.zoom,
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

// ---------------------------
// Site loading + filtering
// ---------------------------
async function loadAndAddSites() {
  const pw = getPassword();
  if (!pw) return; // don't load anything until they enter a password

  const sitesRaw = await fetch("data/sites.geojson", { cache: "no-store" }).then(r => r.json());

  // Filter sites based on password(s)
  const filteredSites = {
    ...sitesRaw,
    features: (sitesRaw.features || []).filter(f => hasAccess(f.properties, pw))
  };

  // If source exists already (re-enter), just update
  if (map.getSource("sites")) {
    map.getSource("sites").setData(filteredSites);
  } else {
    map.addSource("sites", {
      type: "geojson",
      data: filteredSites
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
      maxzoom: 18, // hide reef labels once zoomed in
      layout: {
        "text-field": ["get", "name"],
        "text-size": 14,
        "text-offset": [0, 1.2],
        "text-anchor": "top",
        "text-font": ["Klokantech Noto Sans Regular"]
      },
      paint: {
        "text-color": "#ffffff",
        "text-halo-color": "#000000",
        "text-halo-width": 1.5
      }
    });
  }

  // Always auto-zoom to whatever sites are accessible for the password
  const bbox = computeBBoxLonLat(filteredSites.features);
  if (bbox) {
    map.fitBounds(bbox, {
      padding: 80,
      maxZoom: 16
    });
  }

  if ((filteredSites.features || []).length === 0) {
    console.warn("No sites available for this password.");
  }
}

map.on("load", async () => {
  // Load projects.json first so master-password logic is correct
  try {
    await loadProjectsConfig();
  } catch (e) {
    console.error("Failed to load data/projects.json (master access may not work):", e);
    MASTER_PASSWORDS = new Set(); // fallback: no masters if config fails
  }

  // If they already have a password (auto-enter path), load sites now
  await loadAndAddSites();

  // If they *didn't* have a password yet, the splash modal is up.
  // We watch for it to be hidden (password accepted) and then load sites.
  const introModal = document.getElementById("intro-modal");
  if (introModal) {
    const observer = new MutationObserver(async () => {
      const pw = getPassword();
      const isHidden = introModal.style.display === "none";
      if (pw && isHidden) {
        observer.disconnect();
        await loadAndAddSites();
      }
    });

    observer.observe(introModal, { attributes: true, attributeFilter: ["style"] });
  }
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

  modal.onclick = e => {
    if (e.target === modal) modal.style.display = "none";
  };
}
