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
  ADDRESS_REPEAT,
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

// Lets people opt into forcing WebGL2 over WebGPU for comparison/debugging.
// Persisted across reloads since switching graphics backends requires a
// fresh page load.
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

// Clear-water blue rather than a flat black void where there's no
// geometry - and matched to FOG_COLOR below (same literal values) so a
// fully-fogged-out splat blends seamlessly into the "empty" background
// instead of visibly fading to a different shade at the horizon.
const camera = new Entity("Camera");
camera.addComponent("camera", {
  clearColor: new Color(0.035, 0.22, 0.28),
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

    // The format spec treats out-of-bounds as solid (it's meant to stop a
    // first-person walking camera from wandering into unscanned space with
    // no floor). That's the wrong call for us: this is a free-orbiting
    // overview camera that legitimately wants to pull back for a wide shot
    // beyond the tightly-cropped scan volume, so only actual occupied
    // voxels should ever block movement here.
    if (
      px < gridMin[0] || px > gridMax[0] ||
      py < gridMin[1] || py > gridMax[1] ||
      pz < gridMin[2] || pz > gridMax[2]
    ) {
      return false;
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

// Double-tap-to-zoom (touch): tracked separately from drag state since a
// "tap" is really a pointerdown/pointerup pair with negligible movement/
// duration in between, not a distinct gesture the pointer handlers already
// model. Mouse gets this for free via the native "dblclick" event instead.
const pointerDownInfo = new Map(); // pointerId -> {x, y, time}
const TAP_MAX_DURATION_MS = 300;
const TAP_MAX_MOVEMENT_PX = 10;
const DOUBLE_TAP_MAX_INTERVAL_MS = 350;
const DOUBLE_TAP_MAX_DISTANCE_PX = 30;
let lastTapTime = 0;
let lastTapX = 0;
let lastTapY = 0;

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
  //
  // Pulling back (distance increasing) is exempt: the voxel data is a
  // flood fill from a seed point in the open water, so it's only ever
  // "solid" beyond the fill - which includes the region above the actual
  // water surface, since the fill has nowhere to go once it reaches the
  // top of the captured volume. That's a real boundary of the scan, not
  // reef material, and zooming out to frame the whole reef can legitimately
  // cross it. Getting closer is exactly the case this exists to stop.
  const isBlocked = () => {
    const p = worldToVoxelSpace(cameraPosition);
    return voxelOctree.isSolid(p.x, p.y, p.z);
  };

  if (voxelOctree && distance <= lastGoodDistance) {
    if (isBlocked()) {
      // Full move blocked - before giving up entirely, try sliding along
      // just one horizontal target axis (keeping yaw/pitch/distance as
      // requested). Reef terrain gets more irregular the farther you
      // explore from the open starting pocket, and a hard "undo the whole
      // gesture" on the first graze felt broken - a wall should let you
      // slide along it, not stonewall the entire drag.
      const candidateX = target.x;
      const candidateZ = target.z;

      target.set(candidateX, target.y, lastGoodTarget.z);
      updateBasis();

      if (isBlocked()) {
        target.set(lastGoodTarget.x, target.y, candidateZ);
        updateBasis();

        if (isBlocked()) {
          yaw = lastGoodYaw;
          pitch = lastGoodPitch;
          distance = lastGoodDistance;
          target.copy(lastGoodTarget);
          updateBasis();
        }
      }
    }

    if (!isBlocked()) {
      lastGoodYaw = yaw;
      lastGoodPitch = pitch;
      lastGoodDistance = distance;
      lastGoodTarget.copy(target);
    }
  } else {
    lastGoodYaw = yaw;
    lastGoodPitch = pitch;
    lastGoodDistance = distance;
    lastGoodTarget.copy(target);
  }

  cameraRig.setPosition(cameraPosition);
  cameraRig.lookAt(target, up);
};

const getFrameDistance = radius => {
  const halfFovRad = (fov * Math.PI) / 360;
  return radius / Math.sin(halfFovRad);
};

const clampDistance = value => {
  // sceneRadius comes from the splat's raw AABB, which photogrammetry
  // captures often blow out with a handful of stray outlier gaussians far
  // from the actual reef - scaling the close-up limit off it (as this used
  // to) made zooming in stop far earlier than intended. Collision (see
  // VoxelOctree above) is the real stopping point for getting close now;
  // this floor just keeps distance off zero/negative.
  const minDistance = 0.001;
  const maxDistance = Math.max(sceneRadius * 60, 60);
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

// Casts a ray from the camera through a screen pixel and intersects it with
// the horizontal plane at world height `planeY`, writing the result into
// `out`. Returns null if the ray is (near) parallel to the plane or points
// away from it - shouldn't normally happen given pitch is always tilted
// well away from the horizon, but a drag flung to the edge of the screen at
// a low FOV could still graze it.
const rayDir = new Vec3();
function computeRayDir(screenX, screenY, out) {
  const width = canvas.clientWidth || window.innerWidth;
  const height = canvas.clientHeight || window.innerHeight;
  const ndcX = (screenX / width) * 2 - 1;
  const ndcY = 1 - (screenY / height) * 2;
  const tanHalfFovY = Math.tan((fov * Math.PI) / 360);
  const tanHalfFovX = tanHalfFovY * (width / height);

  return out
    .copy(forward)
    .addScaled(right, ndcX * tanHalfFovX)
    .addScaled(up, ndcY * tanHalfFovY)
    .normalize();
}

function screenToGroundPoint(screenX, screenY, planeY, out) {
  computeRayDir(screenX, screenY, rayDir);
  if (Math.abs(rayDir.y) < 1e-6) return null;

  const t = (planeY - cameraPosition.y) / rayDir.y;
  if (t <= 0) return null;

  out.copy(cameraPosition).addScaled(rayDir, t);
  return out;
}

// True "grab and drag" pan: the ground point under the cursor at the start
// of a move stays pinned under the cursor at the end of it, solved via
// ray/ground-plane intersection rather than a flat FOV*distance
// approximation. The old approximation assumed the camera looked straight
// along its forward axis at a plane perpendicular to it, which increasingly
// under/over-shoots the farther pitch tilts away from straight-down -
// exactly where dragging started feeling disconnected from the cursor.
const rayHitPrev = new Vec3();
const rayHitCur = new Vec3();
const panDrag = (prevX, prevY, curX, curY) => {
  updateBasis();

  const planeY = target.y;
  const hitPrev = screenToGroundPoint(prevX, prevY, planeY, rayHitPrev);
  const hitCur = screenToGroundPoint(curX, curY, planeY, rayHitCur);
  if (!hitPrev || !hitCur) return;

  nextTarget.copy(hitPrev).sub(hitCur);
  target.add(nextTarget);
  updateCamera();
};

// Zoom toward whatever world point is under the cursor/pinch-center rather
// than always toward the orbit target: solves for the target shift that
// keeps that point fixed on screen while distance changes, so zooming in
// on something off-center actually moves you toward it instead of just
// changing FOV-like scale around whatever the target happened to be.
const zoomRayDir = new Vec3();
const zoomAtScreenPoint = (screenX, screenY, factor) => {
  updateBasis();

  const groundPoint = screenToGroundPoint(screenX, screenY, target.y, rayHitPrev);
  const newDistance = clampDistance(distance * factor);

  if (!groundPoint) {
    distance = newDistance;
    updateCamera();
    return;
  }

  computeRayDir(screenX, screenY, zoomRayDir);

  if (Math.abs(zoomRayDir.y) > 1e-6) {
    const tPrime = (newDistance * forward.y) / zoomRayDir.y;
    target.set(
      groundPoint.x - tPrime * zoomRayDir.x + newDistance * forward.x,
      target.y,
      groundPoint.z - tPrime * zoomRayDir.z + newDistance * forward.z
    );
  }

  distance = newDistance;
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
      pointerDownInfo.set(event.pointerId, { x: event.clientX, y: event.clientY, time: performance.now() });
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

    // Fingers moving apart/together => pinch-zoom, centered on the
    // pinch midpoint rather than the orbit target.
    if (pinchDist > 0) {
      zoomAtScreenPoint(cx, cy, pinchDist / dist);
    }

    touchCenterX = cx;
    touchCenterY = cy;
    pinchDist = dist;
    return;
  }

  if (!dragMode) return;

  const prevX = lastPointerX;
  const prevY = lastPointerY;
  const deltaX = event.clientX - prevX;
  const deltaY = event.clientY - prevY;
  lastPointerX = event.clientX;
  lastPointerY = event.clientY;

  if (dragMode === "pan") {
    panDrag(prevX, prevY, event.clientX, event.clientY);
  } else if (dragMode === "orbit") {
    orbitDrag(deltaX, deltaY);
  }
});

const endPointerDrag = event => {
  activePointers.delete(event.pointerId);

  if (canvas.hasPointerCapture(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }

  const downInfo = pointerDownInfo.get(event.pointerId);
  pointerDownInfo.delete(event.pointerId);

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

  if (event.pointerType === "touch" && downInfo) {
    const heldMs = performance.now() - downInfo.time;
    const movedPx = Math.hypot(event.clientX - downInfo.x, event.clientY - downInfo.y);

    if (heldMs < TAP_MAX_DURATION_MS && movedPx < TAP_MAX_MOVEMENT_PX) {
      const now = performance.now();
      const sinceLastTap = now - lastTapTime;
      const distFromLastTap = Math.hypot(event.clientX - lastTapX, event.clientY - lastTapY);

      if (sinceLastTap < DOUBLE_TAP_MAX_INTERVAL_MS && distFromLastTap < DOUBLE_TAP_MAX_DISTANCE_PX) {
        zoomAtScreenPoint(event.clientX, event.clientY, 0.5);
        lastTapTime = 0; // consume - a third tap starts a fresh pair, not a triple
      } else {
        lastTapTime = now;
        lastTapX = event.clientX;
        lastTapY = event.clientY;
      }
    }
  }
};

canvas.addEventListener("pointerup", endPointerDrag);
canvas.addEventListener("pointercancel", endPointerDrag);
canvas.addEventListener("contextmenu", event => event.preventDefault());
canvas.addEventListener("dblclick", event => {
  zoomAtScreenPoint(event.clientX, event.clientY, 0.5);
});

canvas.addEventListener(
  "wheel",
  event => {
    event.preventDefault();

    if (event.shiftKey) {
      panDrag(event.clientX - event.deltaX, event.clientY - event.deltaY, event.clientX, event.clientY);
      return;
    }

    if (event.ctrlKey && isControlKeyDown) {
      yaw -= event.deltaX * TRACKPAD_ORBIT_SENSITIVITY;
      pitch = clampPitch(pitch + event.deltaY * TRACKPAD_ORBIT_SENSITIVITY);
      updateCamera();
      return;
    }

    const zoomSpeed = event.ctrlKey ? PINCH_ZOOM_SPEED : WHEEL_ZOOM_SPEED;
    zoomAtScreenPoint(event.clientX, event.clientY, 1 + event.deltaY * zoomSpeed);
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

// Real caustics texture (a tileable Worley/cellular "F2-F1" ridge network -
// bright thin veins at cell boundaries, dark interiors), sampled the same
// way PlayCanvas's own underwater water script does it (engine PR #9029,
// scripts/esm/water.mjs): two independently-scrolling copies of the same
// texture, combined and pushed through a steep threshold. That's what
// actually gives the fine, fast, sharp-edged look real caustics have - no
// procedural function we tried (raymarched singularities, value noise)
// reproduced it as convincingly as just sampling a proper network texture.
let causticsTexture = null;
let latestSplatForCaustics = null;
let latestAabbForCaustics = null;

// The quad is only created once the texture has actually finished loading
// (see the "load" handler below) rather than up front with the sampler
// unset.
function loadCausticsTexture() {
  const asset = new Asset("causticsMap", "texture", { url: "img/caustics.png" });
  asset.on("load", () => {
    causticsTexture = asset.resource;
    causticsTexture.addressU = ADDRESS_REPEAT;
    causticsTexture.addressV = ADDRESS_REPEAT;

    try {
      const created = createCausticsQuad();
      causticsEntity = created.entity;
      causticsMaterial = created.material;
      if (latestAabbForCaustics) {
        positionCausticsForAabb(latestSplatForCaustics, latestAabbForCaustics);
      }
    } catch (e) {
      console.warn("Caustics overlay unavailable:", e);
    }

    setupCausticsToggle();
  });
  asset.on("error", e => console.warn("Caustics texture failed to load:", e));
  app.assets.add(asset);
  app.assets.load(asset);
}

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
      uniform sampler2D uCausticsMap;
      uniform float uTime;
      uniform float uScale;
      uniform float uSpeed;
      uniform float uIntensity;

      void main(void) {
        vec2 cuv = vUv * uScale;
        float ct = uTime * uSpeed;
        float ca = texture2D(uCausticsMap, cuv + vec2(ct, ct * 0.8)).r;
        float cb = texture2D(uCausticsMap, cuv * 1.37 + vec2(-ct * 1.1, ct * 0.9)).g;
        float bands = pow(clamp((ca + cb) * 0.5 * 2.2 - 0.9, 0.0, 1.0), 2.0);

        vec3 color = vec3(0.65, 0.85, 1.0) * bands * uIntensity;
        gl_FragColor = vec4(color, bands * uIntensity);
      }
    `,
    // WGSL twin so WebGPU (the default renderer) runs this natively instead
    // of needing a GLSL->WGSL transpiler the engine package doesn't bundle.
    vertexWGSL: `
      attribute aPosition: vec3f;
      attribute aUv0: vec2f;
      uniform matrix_model: mat4x4f;
      uniform matrix_viewProjection: mat4x4f;
      varying vUv: vec2f;
      @vertex fn vertexMain(input: VertexInput) -> VertexOutput {
        var output: VertexOutput;
        output.vUv = input.aUv0;
        output.position = uniform.matrix_viewProjection * uniform.matrix_model * vec4f(input.aPosition, 1.0);
        return output;
      }
    `,
    fragmentWGSL: `
      varying vUv: vec2f;
      var uCausticsMap: texture_2d<f32>;
      var uCausticsMapSampler: sampler;
      uniform uTime: f32;
      uniform uScale: f32;
      uniform uSpeed: f32;
      uniform uIntensity: f32;

      @fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput {
        var output: FragmentOutput;

        let cuv = input.vUv * uniform.uScale;
        let ct = uniform.uTime * uniform.uSpeed;
        let ca = textureSample(uCausticsMap, uCausticsMapSampler, cuv + vec2f(ct, ct * 0.8)).r;
        let cb = textureSample(uCausticsMap, uCausticsMapSampler, cuv * 1.37 + vec2f(-ct * 1.1, ct * 0.9)).g;
        let bands = pow(clamp((ca + cb) * 0.5 * 2.2 - 0.9, 0.0, 1.0), 2.0);

        let color = vec3f(0.65, 0.85, 1.0) * bands * uniform.uIntensity;
        output.color = vec4f(color, bands * uniform.uIntensity);
        return output;
      }
    `
  });

  material.blendType = BLEND_ADDITIVE;
  material.cull = CULLFACE_NONE;
  material.depthWrite = false;
  material.setParameter("uTime", 0);
  material.setParameter("uScale", 6.0);
  material.setParameter("uSpeed", 0.06);
  material.setParameter("uIntensity", 0.5);
  if (causticsTexture) material.setParameter("uCausticsMap", causticsTexture);

  const meshInstance = new MeshInstance(mesh, material);
  const entity = new Entity("Caustics");
  entity.addComponent("render", { meshInstances: [meshInstance] });
  entity.enabled = !!(causticsToggle && causticsToggle.checked);
  app.root.addChild(entity);

  return { entity, material };
}

function positionCausticsForAabb(splat, aabb) {
  latestSplatForCaustics = splat;
  latestAabbForCaustics = aabb;
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

// The caustics shader ships both GLSL and WGSL, so it runs natively on
// either backend - no renderer switch required. The quad itself is created
// once the texture asset resolves (see loadCausticsTexture above); this
// just kicks that load off. Wrapped in a try/catch: if something about this
// specific shader/texture turns out to be unhappy on a given device/
// browser, the toggle just hides instead of breaking the rest of the viewer.
const causticsToggleWrap = document.getElementById("causticsToggleWrap");

function setupCausticsToggle() {
  if (!causticsToggleWrap) return;
  if (!causticsEntity) {
    causticsToggleWrap.style.display = "none";
    return;
  }
  causticsToggleWrap.style.display = "";
  if (causticsToggle) {
    causticsToggle.addEventListener("change", () => {
      if (causticsEntity) causticsEntity.enabled = causticsToggle.checked;
    });
  }
}

try {
  loadCausticsTexture();
} catch (e) {
  console.warn("Caustics overlay unavailable:", e);
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

// Same literal values as the camera's clearColor above - keep them in sync
// so fully-fogged splats fade into the background instead of a visible seam.
const FOG_COLOR = [0.035, 0.22, 0.28];
const FOG_DENSITY = 0.035;
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

window.__debug = {
  getYaw: () => yaw,
  getPitch: () => pitch,
  getDistance: () => distance,
  getTarget: () => target.clone(),
  getCameraPosition: () => cameraPosition.clone(),
  hasCaustics: () => !!causticsEntity,
  hasCausticsTexture: () => !!causticsTexture,
  isSolidAtWorld: (x, y, z) => {
    const p = worldToVoxelSpace(new Vec3(x, y, z));
    return voxelOctree ? voxelOctree.isSolid(p.x, p.y, p.z) : null;
  }
};

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
