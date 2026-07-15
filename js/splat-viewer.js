// js/splat-viewer.js
//
// Custom Gaussian Splat viewer built directly on PlayCanvas Engine instead of
// embedding superspl.at (that embed has no control API - no postMessage, no
// camera hooks - so there's nowhere to add custom camera limits or timepoint
// swapping on top of it).
//
// The camera controller below is ported from a Supersplat "Vite project"
// export's src/main.ts (PlayCanvas's own generated starter for a published
// splat), with three changes:
//   1) tilt is clamped to a near-top-down range (pitch 45-90, 90 = straight
//      down) instead of the full -90..90 range
//   2) WASD/arrow "advance" glides horizontally across the reef instead of
//      dollying toward/away from it (which is what full 3D "forward" does
//      once the camera is pitched close to top-down)
//   3) the splat asset can be swapped (timepoints) without touching the
//      camera's yaw/pitch/distance/target, since they're never coupled to
//      which splat is currently loaded

import {
  AppBase,
  AppOptions,
  Asset,
  CameraComponentSystem,
  GSplatComponentSystem,
  RenderComponentSystem,
  TextureHandler,
  GSplatHandler,
  Color,
  Entity,
  FILLMODE_FILL_WINDOW,
  RESOLUTION_AUTO,
  Vec3,
  Mesh,
  MeshInstance,
  ShaderMaterial,
  SEMANTIC_POSITION,
  SEMANTIC_TEXCOORD0,
  BLEND_ADDITIVE,
  CULLFACE_NONE,
  DEVICETYPE_WEBGPU,
  DEVICETYPE_WEBGL2,
  createGraphicsDevice
} from "https://cdn.jsdelivr.net/npm/playcanvas@2.20.0/+esm";

// --------------------------------------------------
// Password gate helpers (same pattern as js/viewer-ol.js)
// --------------------------------------------------

function normalizePw(pw) {
  return (pw || "").trim();
}

function getSessionPassword() {
  return normalizePw(sessionStorage.getItem("reefshape_password"));
}

function bounceToIndex(message) {
  if (message) alert(message);
  window.location.replace("./index.html");
}

let MASTER_PASSWORDS = new Set();

async function loadProjectsConfig() {
  const data = await fetch("data/projects.json", { cache: "no-store" }).then(r => r.json());
  const projects = Array.isArray(data.projects) ? data.projects : [];
  MASTER_PASSWORDS = new Set(
    projects.filter(p => p && p.isMaster).map(p => normalizePw(p.password)).filter(Boolean)
  );
}

function isMaster(pw) {
  return MASTER_PASSWORDS.has(normalizePw(pw));
}

function featureAllowsAccess(featureProps, pw) {
  if (!pw) return false;
  if (isMaster(pw)) return true;

  const pwList = featureProps?.passwords;
  if (Array.isArray(pwList)) {
    return pwList.some(p => normalizePw(p) === pw);
  }

  const legacy = featureProps?.password;
  if (legacy) return normalizePw(legacy) === pw;

  return false;
}

// --------------------------------------------------
// Read reef ID + enforce access
// --------------------------------------------------

const params = new URLSearchParams(window.location.search);
const reefId = params.get("id");
if (!reefId) {
  alert("No reef id specified");
  throw new Error("Missing reef id");
}

const sessionPw = getSessionPassword();
if (!sessionPw) {
  bounceToIndex("Please enter a project password to access this viewer.");
  throw new Error("Missing session password");
}

try {
  await loadProjectsConfig();
} catch (e) {
  console.error("Failed to load data/projects.json (master access may not work):", e);
  MASTER_PASSWORDS = new Set();
}

const sites = await fetch("data/sites.geojson", { cache: "no-store" }).then(r => r.json());
const feature = (sites.features || []).find(f => f?.properties?.id === reefId);

if (!feature) {
  alert("Reef not found");
  throw new Error("Invalid reef id");
}

if (!featureAllowsAccess(feature.properties, sessionPw)) {
  bounceToIndex("Access denied for this site with the current password.");
  throw new Error("Access denied");
}

const { splats, splatPose } = feature.properties;
const years = Object.keys(splats || {}).sort();

if (!years.length) {
  alert("No 3D model available for this reef yet.");
  throw new Error("Missing splats");
}

// --------------------------------------------------
// DOM references
// --------------------------------------------------

const canvas = document.getElementById("app");
const select = document.getElementById("timepointSelect");
const causticsToggle = document.getElementById("causticsToggle");
const loaderEl = document.getElementById("loader");
const loaderMessageEl = document.getElementById("loader-message");
const loaderProgressBar = document.getElementById("loader-progress-bar");

years.forEach(y => {
  const opt = document.createElement("option");
  opt.value = y;
  opt.textContent = y;
  select.appendChild(opt);
});

function setLoadingState(message, progress, failed = false) {
  if (loaderMessageEl) loaderMessageEl.textContent = message;
  if (loaderProgressBar && progress !== undefined) {
    loaderProgressBar.style.transform = `scaleX(${Math.max(0, Math.min(1, progress))})`;
  }
  if (loaderEl) loaderEl.dataset.state = failed ? "error" : "loading";
}

function showLoader() {
  if (loaderEl) loaderEl.dataset.hidden = "false";
}

function hideLoader() {
  if (loaderEl) loaderEl.dataset.hidden = "true";
}

// --------------------------------------------------
// PlayCanvas app setup
// --------------------------------------------------

const device = await createGraphicsDevice(canvas, {
  deviceTypes: [DEVICETYPE_WEBGPU, DEVICETYPE_WEBGL2],
  // Gaussian splats don't benefit from antialiasing and it's expensive.
  antialias: false
});
device.maxPixelRatio = Math.min(window.devicePixelRatio || 1, 2);

const createOptions = new AppOptions();
createOptions.graphicsDevice = device;
createOptions.componentSystems = [CameraComponentSystem, GSplatComponentSystem, RenderComponentSystem];
createOptions.resourceHandlers = [TextureHandler, GSplatHandler];

const app = new AppBase(canvas);
app.init(createOptions);
app.setCanvasFillMode(FILLMODE_FILL_WINDOW);
app.setCanvasResolution(RESOLUTION_AUTO);
app.start();

window.addEventListener("resize", () => app.resizeCanvas());

// Cap GPU memory so phones can handle a 30M+ gaussian source scene - the
// streamed LOD system uses this budget to pick how much detail to keep
// resident regardless of the full scene's size.
if (app.scene.gsplat) {
  app.scene.gsplat.splatBudget = 3_500_000;
}

const camera = new Entity("Camera");
camera.addComponent("camera", {
  clearColor: new Color(0.02, 0.025, 0.035),
  fov: 75
});
app.root.addChild(camera);

// --------------------------------------------------
// Camera controller
//   - drag to orbit, right-drag / shift+wheel to pan, wheel to zoom
//   - WASD/arrows glide horizontally across the reef (no vertical dolly)
//   - pitch clamped to [45, 90] (90 = straight down) so the view stays
//     primarily top-down instead of tilting toward the horizon
// --------------------------------------------------

const DEFAULT_FOV = 75;
const ORBIT_SENSITIVITY = (18 * 0.5) / 60;
const TRACKPAD_ORBIT_SENSITIVITY = (18 * 0.75) / 60;
const MOVE_SPEED = 4;
const FLY_MOVE_ACCELERATION_DAMPING = 0.992;
const FLY_MOVE_DECELERATION_DAMPING = 0.993;
const WHEEL_ZOOM_SPEED = 0.06 / 60;
const PINCH_ZOOM_SPEED = WHEEL_ZOOM_SPEED * 2;
const MIN_PITCH = 45; // can't tilt further toward the horizon than this
const MAX_PITCH = 90; // straight down
const MIN_SCENE_RADIUS = 0.5;

const target = new Vec3(0, 0, 0);
const cameraPosition = new Vec3();
const forward = new Vec3();
const right = new Vec3();
const up = new Vec3();
const flatForward = new Vec3();
const move = new Vec3();
const desiredMove = new Vec3();
const flyVelocity = new Vec3();
const nextTarget = new Vec3();
const worldAabbCenter = new Vec3();
const pressedKeys = new Set();

let yaw = -45;
let pitch = MAX_PITCH;
let distance = 3;
let fov = DEFAULT_FOV;
let sceneRadius = 1;
let dragMode = null;
let activePointerId = null;
let lastPointerX = 0;
let lastPointerY = 0;
let isControlKeyDown = false;
let hasLoadedOnce = false;

const clampPitch = p => Math.max(MIN_PITCH, Math.min(MAX_PITCH, p));

const updateCameraPosition = () => {
  const yawRad = (yaw * Math.PI) / 180;
  const pitchRad = (pitch * Math.PI) / 180;
  const cosPitch = Math.cos(pitchRad);

  cameraPosition.set(
    target.x + distance * Math.sin(yawRad) * cosPitch,
    target.y + distance * Math.sin(pitchRad),
    target.z + distance * Math.cos(yawRad) * cosPitch
  );
};

const updateCamera = () => {
  updateCameraPosition();
  camera.setPosition(cameraPosition);
  camera.lookAt(target);
};

const getFrameDistance = radius => {
  const halfFovRad = (fov * Math.PI) / 360;
  return radius / Math.sin(halfFovRad);
};

const clampDistance = value => {
  const minDistance = Math.max(sceneRadius * 0.02, 0.02);
  const maxDistance = Math.max(sceneRadius * 40, 30);
  return Math.max(minDistance, Math.min(maxDistance, value));
};

const damp = (damping, dt) => 1 - Math.pow(damping, dt * 1000);

const setDefaultFrame = () => {
  target.set(0, 0, 0);
  sceneRadius = 1;
  yaw = -45;
  pitch = MAX_PITCH;
  distance = getFrameDistance(sceneRadius);
  updateCamera();
};

const applyCameraPose = pose => {
  const dx = pose.position[0] - pose.target[0];
  const dy = pose.position[1] - pose.target[1];
  const dz = pose.position[2] - pose.target[2];
  const poseDistance = Math.sqrt(dx * dx + dy * dy + dz * dz);

  // a pose looking at its own position has no view direction
  if (!Number.isFinite(poseDistance) || poseDistance < 1e-6) {
    return false;
  }

  target.set(pose.target[0], pose.target[1], pose.target[2]);
  yaw = (Math.atan2(dx, dz) * 180) / Math.PI;
  // Authored poses from the Supersplat editor are often more oblique than
  // our new tilt floor (Sandy Cay's is ~38deg) - clamp on the way in.
  pitch = clampPitch((Math.asin(Math.max(-1, Math.min(1, dy / poseDistance))) * 180) / Math.PI);
  distance = poseDistance;
  fov = pose.fov;

  if (camera.camera) camera.camera.fov = fov;

  updateCamera();
  return true;
};

const frameSplat = (splat, aabb) => {
  if (aabb) {
    splat.getWorldTransform().transformPoint(aabb.center, worldAabbCenter);
    target.copy(worldAabbCenter);
    sceneRadius = Math.max(aabb.halfExtents.length(), MIN_SCENE_RADIUS);
  } else {
    target.set(0, 0, 0);
    sceneRadius = 1;
  }

  yaw = -45;
  pitch = MAX_PITCH;
  distance = clampDistance(getFrameDistance(sceneRadius));
  updateCamera();
};

const updateBasis = () => {
  updateCameraPosition();
  const yawRad = (yaw * Math.PI) / 180;
  const pitchRad = (pitch * Math.PI) / 180;
  const cosPitch = Math.cos(pitchRad);

  forward.set(-Math.sin(yawRad) * cosPitch, -Math.sin(pitchRad), -Math.cos(yawRad) * cosPitch).normalize();
  right.set(Math.cos(yawRad), 0, -Math.sin(yawRad)).normalize();
  up.cross(right, forward).normalize();

  // Flatten forward to the horizontal plane so WASD/arrow "advance" glides
  // across the reef surface instead of dollying toward/away from it - at
  // near-top-down pitches, true 3D "forward" is mostly vertical.
  flatForward.set(forward.x, 0, forward.z);
  if (flatForward.lengthSq() > 1e-8) {
    flatForward.normalize();
  } else {
    // Looking (almost) straight down: fall back to the yaw's heading.
    flatForward.set(-Math.sin(yawRad), 0, -Math.cos(yawRad));
  }
};

const panTarget = (deltaX, deltaY) => {
  updateBasis();

  const height = canvas.clientHeight || window.innerHeight;
  const width = canvas.clientWidth || window.innerWidth;
  const halfHeight = distance * Math.tan((fov * Math.PI) / 360);
  const halfWidth = halfHeight * (width / height);

  nextTarget
    .copy(right)
    .mulScalar((-deltaX / width) * halfWidth * 2)
    .add(up.clone().mulScalar((deltaY / height) * halfHeight * 2));

  target.add(nextTarget);
  updateCamera();
};

canvas.addEventListener("pointerdown", event => {
  if (activePointerId !== null) return;

  dragMode = event.button === 2 ? "pan" : "orbit";
  activePointerId = event.pointerId;
  lastPointerX = event.clientX;
  lastPointerY = event.clientY;
  canvas.setPointerCapture(event.pointerId);
});

canvas.addEventListener("pointermove", event => {
  if (activePointerId !== event.pointerId || !dragMode) return;

  const deltaX = event.clientX - lastPointerX;
  const deltaY = event.clientY - lastPointerY;
  lastPointerX = event.clientX;
  lastPointerY = event.clientY;

  if (dragMode === "pan") {
    panTarget(deltaX, deltaY);
  } else {
    yaw -= deltaX * ORBIT_SENSITIVITY;
    pitch = clampPitch(pitch + deltaY * ORBIT_SENSITIVITY);
    updateCamera();
  }
});

const endPointerDrag = event => {
  if (activePointerId !== event.pointerId) return;

  dragMode = null;
  activePointerId = null;

  if (canvas.hasPointerCapture(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }
};

canvas.addEventListener("pointerup", endPointerDrag);
canvas.addEventListener("pointercancel", endPointerDrag);
canvas.addEventListener("contextmenu", event => event.preventDefault());

canvas.addEventListener(
  "wheel",
  event => {
    event.preventDefault();

    if (event.shiftKey) {
      panTarget(event.deltaX, event.deltaY);
      return;
    }

    if (event.ctrlKey && isControlKeyDown) {
      yaw -= event.deltaX * TRACKPAD_ORBIT_SENSITIVITY;
      pitch = clampPitch(pitch + event.deltaY * TRACKPAD_ORBIT_SENSITIVITY);
      updateCamera();
      return;
    }

    const zoomSpeed = event.ctrlKey ? PINCH_ZOOM_SPEED : WHEEL_ZOOM_SPEED;
    distance = clampDistance(distance * (1 + event.deltaY * zoomSpeed));
    updateCamera();
  },
  { passive: false }
);

window.addEventListener("keydown", event => {
  if (event.metaKey || event.altKey) return;

  pressedKeys.add(event.code);

  if (event.code === "ControlLeft" || event.code === "ControlRight") {
    isControlKeyDown = true;
  }
});

window.addEventListener("keyup", event => {
  pressedKeys.delete(event.code);

  if (event.code === "ControlLeft" || event.code === "ControlRight") {
    isControlKeyDown = false;
  }
});

window.addEventListener("blur", () => {
  pressedKeys.clear();
  isControlKeyDown = false;
});

app.on("update", dt => {
  desiredMove.set(0, 0, 0);

  const strafe =
    Number(pressedKeys.has("KeyD") || pressedKeys.has("ArrowRight")) -
    Number(pressedKeys.has("KeyA") || pressedKeys.has("ArrowLeft"));
  const advance =
    Number(pressedKeys.has("KeyW") || pressedKeys.has("ArrowUp")) -
    Number(pressedKeys.has("KeyS") || pressedKeys.has("ArrowDown"));

  if (strafe !== 0 || advance !== 0) {
    updateBasis();

    desiredMove.addScaled(right, strafe).addScaled(flatForward, advance);

    if (desiredMove.lengthSq() > 0) {
      const speedMultiplier =
        pressedKeys.has("ShiftLeft") || pressedKeys.has("ShiftRight")
          ? 4
          : pressedKeys.has("ControlLeft") || pressedKeys.has("ControlRight")
            ? 0.25
            : 1;

      desiredMove.normalize().mulScalar(MOVE_SPEED * speedMultiplier);
    }
  }

  const damping =
    desiredMove.lengthSq() > flyVelocity.lengthSq() ? FLY_MOVE_ACCELERATION_DAMPING : FLY_MOVE_DECELERATION_DAMPING;
  flyVelocity.lerp(flyVelocity, desiredMove, damp(damping, dt));

  if (desiredMove.lengthSq() === 0 && flyVelocity.lengthSq() < 1e-4) {
    flyVelocity.set(0, 0, 0);
  }

  if (flyVelocity.lengthSq() === 0) return;

  move.copy(flyVelocity).mulScalar(dt);
  target.add(move);
  updateCamera();
});

setDefaultFrame();

// --------------------------------------------------
// Caustics overlay (animated shimmering light bands over the reef)
//
// Not a post-process: PlayCanvas's post-processing pipeline is a closed
// config wrapper (bloom/vignette/tonemap knobs only, no custom-pass
// injection) and this app's minimal AppOptions doesn't register a
// post-effect system anyway. Since the camera is always near-top-down over
// an essentially horizontal reef, a large additive-blended quad positioned
// just above the splat's surface reads convincingly as light bands without
// touching the render pipeline at all.
// --------------------------------------------------

let causticsEntity = null;
let causticsMaterial = null;
let causticsTime = 0;

function createCausticsQuad() {
  const mesh = new Mesh(device);
  mesh.setPositions([-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5]);
  mesh.setUvs(0, [0, 0, 1, 0, 1, 1, 0, 1]);
  mesh.setIndices([0, 1, 2, 0, 2, 3]);
  mesh.update();

  const material = new ShaderMaterial({
    uniqueName: "ReefCaustics",
    attributes: {
      aPosition: SEMANTIC_POSITION,
      aUv0: SEMANTIC_TEXCOORD0
    },
    vertexGLSL: `
      attribute vec3 aPosition;
      attribute vec2 aUv0;
      uniform mat4 matrix_model;
      uniform mat4 matrix_viewProjection;
      varying vec2 vUv;
      void main(void) {
        vUv = aUv0;
        gl_Position = matrix_viewProjection * matrix_model * vec4(aPosition, 1.0);
      }
    `,
    fragmentGLSL: `
      precision mediump float;
      varying vec2 vUv;
      uniform float uTime;
      uniform float uScale;
      uniform float uIntensity;

      float bandLayer(vec2 uv, float t) {
        vec2 p = uv * uScale;
        float a = sin(p.x * 1.7 + t * 0.6) + sin(p.y * 1.3 - t * 0.5);
        float b = sin((p.x + p.y) * 1.1 - t * 0.8) + sin((p.x - p.y) * 1.9 + t * 0.4);
        return a + b;
      }

      void main(void) {
        float n1 = bandLayer(vUv, uTime);
        float n2 = bandLayer(vUv * 1.37 + 5.2, -uTime * 0.8);
        float bands = pow(max(0.0, (n1 * n2) * 0.25 + 0.5), 6.0);
        vec3 color = vec3(0.65, 0.85, 1.0) * bands * uIntensity;
        gl_FragColor = vec4(color, bands * uIntensity);
      }
    `
  });

  material.blendType = BLEND_ADDITIVE;
  material.cull = CULLFACE_NONE;
  material.depthWrite = false;
  material.setParameter("uTime", 0);
  material.setParameter("uScale", 6.0);
  material.setParameter("uIntensity", 0.35);

  const meshInstance = new MeshInstance(mesh, material);
  const entity = new Entity("Caustics");
  entity.addComponent("render", { meshInstances: [meshInstance] });
  entity.enabled = !!(causticsToggle && causticsToggle.checked);
  app.root.addChild(entity);

  return { entity, material };
}

function positionCausticsForAabb(splat, aabb) {
  if (!causticsEntity || !aabb) return;

  splat.getWorldTransform().transformPoint(aabb.center, worldAabbCenter);

  const padding = 1.15;
  const sizeX = Math.max(aabb.halfExtents.x * 2 * padding, 1);
  const sizeZ = Math.max(aabb.halfExtents.z * 2 * padding, 1);

  causticsEntity.setLocalScale(sizeX, 1, sizeZ);
  causticsEntity.setPosition(
    worldAabbCenter.x,
    worldAabbCenter.y + aabb.halfExtents.y + 0.05,
    worldAabbCenter.z
  );
}

// The caustics shader is hand-written GLSL. WebGL2 runs it natively; WebGPU
// would need a glslang/twgsl transpiler that isn't bundled with the engine
// package, so on WebGPU we skip it entirely rather than show a dead toggle.
const causticsSupported = !device.isWebGPU;

if (causticsSupported) {
  try {
    const created = createCausticsQuad();
    causticsEntity = created.entity;
    causticsMaterial = created.material;
  } catch (e) {
    console.warn("Caustics overlay unavailable:", e);
  }
}

const causticsToggleWrap = document.getElementById("causticsToggleWrap");
if (!causticsSupported || !causticsEntity) {
  if (causticsToggleWrap) causticsToggleWrap.style.display = "none";
} else if (causticsToggle) {
  causticsToggle.addEventListener("change", () => {
    if (causticsEntity) causticsEntity.enabled = causticsToggle.checked;
  });
}

app.on("update", dt => {
  if (!causticsMaterial) return;
  causticsTime += dt;
  causticsMaterial.setParameter("uTime", causticsTime);
});

// --------------------------------------------------
// Splat loading + timepoint swapping
//
// Camera state (yaw/pitch/distance/target/fov) is never touched by which
// splat is loaded, so swapping timepoints naturally preserves the viewpoint.
// It's only reset (via applyCameraPose/frameSplat) on the very first load.
// --------------------------------------------------

let currentSplatEntity = null;
let currentSplatAsset = null;

function loadTimepoint(url) {
  showLoader();
  setLoadingState("Loading splat…", 0);

  const filename = url.split("/").pop() || "splat";
  const asset = new Asset(filename, "gsplat", { url, filename });

  asset.on("progress", (received, length) => {
    if (length > 0) {
      const progress = Math.max(0, Math.min(1, received / length));
      setLoadingState(`Loading splat ${Math.floor(progress * 100)}%`, progress);
    }
  });

  asset.on("error", error => {
    console.error(error);
    setLoadingState("Failed to load splat.", 1, true);
  });

  asset.on("load", () => {
    const splat = new Entity("Splat");
    splat.setLocalEulerAngles(0, 0, 180);
    splat.addComponent("gsplat", { asset });
    app.root.addChild(splat);

    const previousEntity = currentSplatEntity;
    const previousAsset = currentSplatAsset;

    currentSplatEntity = splat;
    currentSplatAsset = asset;

    const resource = asset.resource;
    const aabb = resource?.aabb;
    if (aabb) {
      sceneRadius = Math.max(aabb.halfExtents.length(), MIN_SCENE_RADIUS);
    }
    positionCausticsForAabb(splat, aabb);

    if (!hasLoadedOnce) {
      hasLoadedOnce = true;
      if (!splatPose || !applyCameraPose(splatPose)) {
        frameSplat(splat, aabb);
      }
    }
    // On later swaps we deliberately skip re-framing the camera so the
    // current viewpoint survives the timepoint change.

    if (previousEntity) previousEntity.destroy();
    if (previousAsset) {
      app.assets.remove(previousAsset);
      previousAsset.unload();
    }

    hideLoader();
  });

  app.assets.add(asset);
  app.assets.load(asset);
}

select.addEventListener("change", () => {
  loadTimepoint(splats[select.value]);
});

loadTimepoint(splats[years[0]]);
