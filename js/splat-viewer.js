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
  XRTYPE_VR,
  XRSPACE_LOCALFLOOR,
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

const { splats, splatPose, voxelCollision } = feature.properties;
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

// The caustics shader is WebGL-only (see below), so let people opt into
// forcing WebGL2 over WebGPU if they want to see it. Persisted across
// reloads since switching graphics backends requires a fresh page load.
const FORCE_WEBGL_KEY = "reefshape_force_webgl";
const forceWebGL = () => localStorage.getItem(FORCE_WEBGL_KEY) === "1";

const device = await createGraphicsDevice(canvas, {
  deviceTypes: forceWebGL() ? [DEVICETYPE_WEBGL2] : [DEVICETYPE_WEBGPU, DEVICETYPE_WEBGL2],
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

// The camera sits under a "rig" entity: our orbit/pan/zoom/WASD logic moves
// and orients the rig, while the camera itself stays at local identity. In a
// WebXR session the engine drives the camera's local position/rotation
// directly from headset tracking - keeping it as a child means that just
// works, with the rig acting as the headset's anchor point in the scene.
const cameraRig = new Entity("CameraRig");
app.root.addChild(cameraRig);

const camera = new Entity("Camera");
camera.addComponent("camera", {
  clearColor: new Color(0.02, 0.025, 0.035),
  fov: 75
});
cameraRig.addChild(camera);

// --------------------------------------------------
// Collision voxels
//
// A sparse voxel octree (PlayCanvas's own .voxel.json/.bin format, exported
// alongside the splat from Supersplat) used to stop the camera from flying
// into the reef geometry. Format spec: developer.playcanvas.com/user-manual/
// splat-transform/voxel-format/ - each node is one uint32: 0xFF000000 marks
// a fully-solid leaf, a zero top byte marks a "mixed" leaf (bottom 24 bits
// index a pair of uint32s in leafData holding a 4x4x4=64-bit occupancy
// mask), anything else is an interior node (top byte = 8-bit child mask,
// bottom 24 bits = index of its first present child). Points outside
// gridBounds count as solid per the spec.
// --------------------------------------------------

class VoxelOctree {
  constructor(meta, buffer) {
    this.gridMin = meta.gridBounds.min;
    this.gridMax = meta.gridBounds.max;
    this.voxelResolution = meta.voxelResolution;
    this.treeDepth = meta.treeDepth;
    this.rootVoxels = meta.leafSize * (1 << meta.treeDepth);
    this.nodes = new Uint32Array(buffer, 0, meta.nodeCount);
    this.leafData = new Uint32Array(buffer, meta.nodeCount * 4, meta.leafDataCount);
  }

  isSolid(px, py, pz) {
    const { gridMin, gridMax, voxelResolution, treeDepth, rootVoxels, nodes, leafData } = this;

    if (
      px < gridMin[0] || px > gridMax[0] ||
      py < gridMin[1] || py > gridMax[1] ||
      pz < gridMin[2] || pz > gridMax[2]
    ) {
      return true;
    }

    let vx = (px - gridMin[0]) / voxelResolution;
    let vy = (py - gridMin[1]) / voxelResolution;
    let vz = (pz - gridMin[2]) / voxelResolution;

    let nodeIndex = 0;
    let cubeSize = rootVoxels;

    for (let level = 0; level < treeDepth; level++) {
      const word = nodes[nodeIndex];

      if (word === 0xff000000) return true;
      if (word >>> 24 === 0) break; // reached a leaf earlier than expected

      const childMask = word >>> 24;
      const firstChild = word & 0xffffff;
      const half = cubeSize / 2;

      const ox = vx >= half ? 1 : 0;
      const oy = vy >= half ? 1 : 0;
      const oz = vz >= half ? 1 : 0;
      const oct = ox | (oy << 1) | (oz << 2);

      if (!(childMask & (1 << oct))) return false;

      let count = 0;
      for (let b = 0; b < oct; b++) {
        if (childMask & (1 << b)) count++;
      }
      nodeIndex = firstChild + count;

      vx -= ox * half;
      vy -= oy * half;
      vz -= oz * half;
      cubeSize = half;
    }

    const word = nodes[nodeIndex];
    if (word === 0xff000000) return true;
    if (word >>> 24 === 0) {
      const leafIndex = word & 0xffffff;
      const lx = Math.min(3, Math.max(0, Math.floor(vx)));
      const ly = Math.min(3, Math.max(0, Math.floor(vy)));
      const lz = Math.min(3, Math.max(0, Math.floor(vz)));
      const bit = lx + (ly << 2) + (lz << 4);
      return !!(bit < 32 ? (leafData[2 * leafIndex] >>> bit) & 1 : (leafData[2 * leafIndex + 1] >>> (bit - 32)) & 1);
    }

    return false;
  }
}

let voxelOctree = null;
const voxelQueryPoint = new Vec3();

// The splat entity is rotated 180deg around Z (see loadTimepoint), so its
// raw/local space - which is what the voxel data was exported in - relates
// to our world (post-rotation) space by negating X and Y, Z unchanged.
function worldToVoxelSpace(worldPoint) {
  voxelQueryPoint.set(-worldPoint.x, -worldPoint.y, worldPoint.z);
  return voxelQueryPoint;
}

if (voxelCollision) {
  (async () => {
    try {
      const meta = await fetch(`${voxelCollision}.json`, { cache: "no-store" }).then(r => r.json());
      const buffer = await fetch(`${voxelCollision}.bin`, { cache: "no-store" }).then(r => r.arrayBuffer());
      voxelOctree = new VoxelOctree(meta, buffer);
      // Seed the rollback baseline from wherever the camera already is
      // (the authored/framed pose) rather than stale defaults, since
      // collision checking only starts once this promise resolves.
      lastGoodYaw = yaw;
      lastGoodPitch = pitch;
      lastGoodDistance = distance;
      lastGoodTarget.copy(target);
    } catch (e) {
      console.warn("Collision voxels unavailable:", e);
    }
  })();
}

// --------------------------------------------------
// Camera controller
//   - left-drag / one-finger touch-drag pans horizontally, same as WASD/arrows
//   - right-drag / two-finger touch-drag tilts (orbit)
//   - wheel zooms; pinch (two-finger, distance changing) zooms on touch
//   - WASD/arrows glide horizontally across the reef (no vertical dolly)
//   - pitch clamped to [30, 90] (90 = straight down) so the view stays
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
const MIN_PITCH = 30; // can't tilt further toward the horizon than this
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
let isControlKeyDown = false;
let hasLoadedOnce = false;

// Last camera state that passed the collision check - rolled back to
// whenever a move would put the eye inside solid voxels, so blocked moves
// just don't happen rather than needing per-input-handler special casing.
let lastGoodYaw = yaw;
let lastGoodPitch = pitch;
let lastGoodDistance = distance;
const lastGoodTarget = new Vec3();

// Pointer/touch state. Every active pointer (mouse button held, or finger
// down) is tracked by id so we can tell a one-finger touch (pan) from a
// two-finger touch (orbit + pinch-zoom combined, like a map app) apart from
// mouse input (button decides pan vs orbit; there's never more than one).
const activePointers = new Map(); // pointerId -> {x, y}
let dragMode = null; // "pan" | "orbit" | "touch2" | null
let lastPointerX = 0;
let lastPointerY = 0;
let touchCenterX = 0;
let touchCenterY = 0;
let pinchDist = 0;

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
  // updateBasis() computes cameraPosition plus a {right, up, forward} basis
  // from yaw/pitch. Passing our own `up` hint to lookAt (rather than letting
  // it default to world-up) is what matters here: `up` is built as
  // cross(right, forward), which is mathematically perpendicular to `forward`
  // at every yaw/pitch - including pitch === 90 (straight down), where world
  // Y is parallel to `forward` and a lookAt() left to its own default up
  // vector hits a singularity and flips the whole orientation (and, with it,
  // whatever movement basis is derived from it that frame).
  updateBasis();

  // Collision: if the eye would end up inside solid voxels, roll yaw/pitch/
  // distance/target back to the last position that was clear instead of
  // moving there. No per-input special-casing needed - every pan/orbit/zoom/
  // WASD update funnels through here. Fails open (no blocking) until the
  // voxel data has loaded, or if this reef has none.
  if (voxelOctree) {
    const p = worldToVoxelSpace(cameraPosition);
    if (voxelOctree.isSolid(p.x, p.y, p.z)) {
      yaw = lastGoodYaw;
      pitch = lastGoodPitch;
      distance = lastGoodDistance;
      target.copy(lastGoodTarget);
      updateBasis();
    } else {
      lastGoodYaw = yaw;
      lastGoodPitch = pitch;
      lastGoodDistance = distance;
      lastGoodTarget.copy(target);
    }
  }

  cameraRig.setPosition(cameraPosition);
  cameraRig.lookAt(target, up);
};

const getFrameDistance = radius => {
  const halfFovRad = (fov * Math.PI) / 360;
  return radius / Math.sin(halfFovRad);
};

const clampDistance = value => {
  const minDistance = Math.max(sceneRadius * 0.008, 0.008);
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

// Horizontal pan driven by a drag delta - same {right, flatForward} basis
// WASD/arrows use, so a left-drag (or one-finger touch-drag) feels like the
// same "glide across the reef" motion, just under direct pointer control
// instead of key-hold + damping.
const panHorizontal = (deltaX, deltaY) => {
  updateBasis();

  const height = canvas.clientHeight || window.innerHeight;
  const width = canvas.clientWidth || window.innerWidth;
  const halfHeight = distance * Math.tan((fov * Math.PI) / 360);
  const halfWidth = halfHeight * (width / height);

  nextTarget
    .copy(right)
    .mulScalar((-deltaX / width) * halfWidth * 2)
    .add(flatForward.clone().mulScalar((deltaY / height) * halfHeight * 2));

  target.add(nextTarget);
  updateCamera();
};

const orbitDrag = (deltaX, deltaY) => {
  yaw -= deltaX * ORBIT_SENSITIVITY;
  pitch = clampPitch(pitch + deltaY * ORBIT_SENSITIVITY);
  updateCamera();
};

function touchCenterAndDist() {
  const [a, b] = Array.from(activePointers.values());
  return {
    cx: (a.x + b.x) / 2,
    cy: (a.y + b.y) / 2,
    dist: Math.hypot(a.x - b.x, a.y - b.y)
  };
}

canvas.addEventListener("pointerdown", event => {
  activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  try {
    canvas.setPointerCapture(event.pointerId);
  } catch (e) {
    // Ignore - capture can fail for synthetic/replayed pointer ids; the
    // gesture still works via our own activePointers tracking below.
  }

  if (event.pointerType === "touch") {
    if (activePointers.size === 1) {
      dragMode = "pan";
      lastPointerX = event.clientX;
      lastPointerY = event.clientY;
    } else if (activePointers.size === 2) {
      dragMode = "touch2";
      const { cx, cy, dist } = touchCenterAndDist();
      touchCenterX = cx;
      touchCenterY = cy;
      pinchDist = dist;
    }
    // A third+ finger is ignored - keep whatever gesture was already active.
  } else if (activePointers.size === 1) {
    // Mouse (or pen): left button pans, right button orbits.
    dragMode = event.button === 2 ? "orbit" : "pan";
    lastPointerX = event.clientX;
    lastPointerY = event.clientY;
  }
});

canvas.addEventListener("pointermove", event => {
  if (!activePointers.has(event.pointerId)) return;
  activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

  if (dragMode === "touch2") {
    if (activePointers.size !== 2) return;

    const { cx, cy, dist } = touchCenterAndDist();

    // Two fingers moving together => orbit (mirrors right-click-drag).
    orbitDrag(cx - touchCenterX, cy - touchCenterY);

    // Fingers moving apart/together => pinch-zoom.
    if (pinchDist > 0) {
      distance = clampDistance(distance * (pinchDist / dist));
      updateCamera();
    }

    touchCenterX = cx;
    touchCenterY = cy;
    pinchDist = dist;
    return;
  }

  if (!dragMode) return;

  const deltaX = event.clientX - lastPointerX;
  const deltaY = event.clientY - lastPointerY;
  lastPointerX = event.clientX;
  lastPointerY = event.clientY;

  if (dragMode === "pan") {
    panHorizontal(deltaX, deltaY);
  } else if (dragMode === "orbit") {
    orbitDrag(deltaX, deltaY);
  }
});

const endPointerDrag = event => {
  activePointers.delete(event.pointerId);

  if (canvas.hasPointerCapture(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }

  if (activePointers.size === 0) {
    dragMode = null;
  } else if (activePointers.size === 1) {
    // Dropped from two touches to one - resume single-finger pan with
    // whichever finger is still down, instead of ending the gesture.
    const [pos] = Array.from(activePointers.values());
    dragMode = "pan";
    lastPointerX = pos.x;
    lastPointerY = pos.y;
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
      panHorizontal(event.deltaX, event.deltaY);
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
      uniform float uSpeed;
      uniform float uIntensity;

      // A raymarched-looking 2D interference pattern (the classic real-time
      // "underwater caustics" GLSL trick) rather than a value-noise field:
      // value noise is smooth/round by construction, so no amount of
      // thresholding turns it into anything but soft blobs. This instead
      // approximates light concentrating along focal lines via 1/distance
      // singularities, which is what naturally produces thin, sharp,
      // interconnected bands - tiled and animated fast per uScale/uSpeed.
      void main(void) {
        vec2 p = mod(vUv * uScale, 1.0) - 0.5;
        vec2 i = p;
        float c = 0.0;
        float inten = 0.06;

        for (int n = 0; n < 5; n++) {
          float t = uTime * uSpeed * (1.0 - (3.5 / float(n + 1)));
          i = p + vec2(cos(t - i.x) + sin(t + i.y), sin(t - i.y) + cos(t + i.x));
          vec2 d = vec2(p.x / (sin(i.x + t) / inten), p.y / (cos(i.y + t) / inten));
          c += 1.0 / length(d);
        }
        c /= 5.0;
        c = 1.17 - pow(c, 1.4);
        float bands = pow(clamp(c, 0.0, 1.0), 8.0);

        vec3 color = vec3(0.65, 0.85, 1.0) * bands * uIntensity;
        gl_FragColor = vec4(color, bands * uIntensity);
      }
    `
  });

  material.blendType = BLEND_ADDITIVE;
  material.cull = CULLFACE_NONE;
  material.depthWrite = false;
  material.setParameter("uTime", 0);
  material.setParameter("uScale", 14.0);
  material.setParameter("uSpeed", 1.8);
  material.setParameter("uIntensity", 0.6);

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

  // Height: use the camera's own focal height/distance rather than the
  // AABB's Y extent - photogrammetry splats often carry stray outlier
  // gaussians far above the real reef surface, which inflates
  // aabb.halfExtents.y well past where the visible content actually sits.
  // The framed target/distance are a much more reliable stand-in for "just
  // above the reef" at whatever scale this particular capture uses.
  causticsEntity.setPosition(
    worldAabbCenter.x,
    target.y + distance * 0.05,
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

// --------------------------------------------------
// Renderer toggle (WebGPU <-> WebGL2)
//
// Switching graphics backends means recreating the whole device, which
// PlayCanvas doesn't support live - so this just flips a persisted
// preference and reloads. Mainly useful for seeing caustics, which only
// render on WebGL2 (see above).
// --------------------------------------------------

const rendererToggleBtn = document.getElementById("rendererToggle");
if (rendererToggleBtn) {
  rendererToggleBtn.textContent = device.isWebGPU ? "Renderer: WebGPU" : "Renderer: WebGL2";
  rendererToggleBtn.title = device.isWebGPU
    ? "Switch to WebGL2 to see the caustics effect"
    : "Switch back to WebGPU (faster, but no caustics)";
  rendererToggleBtn.addEventListener("click", () => {
    if (forceWebGL()) {
      localStorage.removeItem(FORCE_WEBGL_KEY);
    } else {
      localStorage.setItem(FORCE_WEBGL_KEY, "1");
    }
    window.location.reload();
  });
}

// --------------------------------------------------
// VR (WebXR)
//
// Only shown when a headset is actually available. The camera's local
// position/rotation get overwritten by headset tracking once a session
// starts - that's exactly why `camera` is a child of `cameraRig` rather
// than being moved directly: our orbit/pan/WASD logic keeps controlling
// where the rig stands in the scene, headset tracking handles the rest.
// --------------------------------------------------

const vrButton = document.getElementById("vrButton");

function updateVrButtonVisibility() {
  if (!vrButton) return;
  const available = !!(app.xr && app.xr.supported && app.xr.isAvailable(XRTYPE_VR));
  vrButton.style.display = available ? "inline-block" : "none";
}

if (app.xr) {
  app.xr.on(`available:${XRTYPE_VR}`, updateVrButtonVisibility);
  app.xr.on("start", () => {
    if (vrButton) vrButton.textContent = "Exit VR";
  });
  app.xr.on("end", () => {
    if (vrButton) vrButton.textContent = "Enter VR";
  });
  app.xr.on("error", error => {
    console.error("WebXR error:", error);
    alert("Could not start the VR session.");
  });
}
updateVrButtonVisibility();

if (vrButton) {
  vrButton.addEventListener("click", () => {
    if (app.xr.active) {
      app.xr.end();
    } else {
      app.xr.start(camera.camera, XRTYPE_VR, XRSPACE_LOCALFLOOR);
    }
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

// --------------------------------------------------
// Distance-based underwater fog
//
// Tints each splat's color toward a fog color based on its distance from
// the camera - the classic exponential light-attenuation-through-water
// look. Implemented via the engine's gsplatModifyVS shader chunk override
// on the scene-wide *unified* gsplat material (app.scene.gsplat.material -
// see the "unified: true" component option in loadTimepoint below), the
// same technique PlayCanvas's own underwater water script uses for lit
// materials via litUserMainEndPS (engine PR #9029, scripts/esm/water.mjs),
// just applied per-splat instead of per-lit-pixel since our scene is 100%
// gsplat with nothing else to shade.
// --------------------------------------------------

const FOG_COLOR = [0.02, 0.12, 0.18];
const FOG_DENSITY = 0.08;
const camPos = new Vec3();
let fogSupported = false;

function setupUnderwaterFog() {
  try {
    const gsplatMat = app.scene.gsplat.material;

    gsplatMat.getShaderChunks("glsl").set(
      "gsplatModifyVS",
      `
        uniform vec3 uCamPos;
        uniform vec3 uFogColor;
        uniform float uFogDensity;

        void modifySplatCenter(inout vec3 center) {
        }
        void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
        }
        void modifySplatColor(vec3 center, inout vec4 color) {
          float dist = length(center - uCamPos);
          float fogFactor = clamp(exp(-uFogDensity * dist), 0.0, 1.0);
          color.rgb = mix(uFogColor, color.rgb, fogFactor);
        }
      `
    );

    gsplatMat.getShaderChunks("wgsl").set(
      "gsplatModifyVS",
      `
        uniform uCamPos : vec3f;
        uniform uFogColor : vec3f;
        uniform uFogDensity : f32;

        fn modifySplatCenter(center: ptr<function, vec3f>) {
        }
        fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
        }
        fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
          let dist: f32 = length(center - uniform.uCamPos);
          let fogFactor: f32 = clamp(exp(-uniform.uFogDensity * dist), 0.0, 1.0);
          (*color) = vec4f(mix(uniform.uFogColor, (*color).rgb, fogFactor), (*color).a);
        }
      `
    );

    gsplatMat.setParameter("uFogColor", FOG_COLOR);
    gsplatMat.setParameter("uFogDensity", FOG_DENSITY);
    gsplatMat.update();

    fogSupported = true;
  } catch (e) {
    console.warn("Underwater fog unavailable:", e);
  }
}

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
    // unified: true puts this (and every other) splat on the scene-wide
    // app.scene.gsplat.material, which is what the fog shader override below
    // hooks into - it only has to be set up once, not reapplied per entity.
    splat.addComponent("gsplat", { asset, unified: true });
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
      setupUnderwaterFog();
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

app.on("update", () => {
  if (!fogSupported) return;
  try {
    camPos.copy(cameraRig.getPosition());
    app.scene.gsplat.material.setParameter("uCamPos", [camPos.x, camPos.y, camPos.z]);
    app.scene.gsplat.material.update();
  } catch (e) {
    console.warn("Underwater fog update failed:", e);
    fogSupported = false;
  }
});
