// js/splat-viewer.js
//
// Custom Gaussian Splat viewer built directly on PlayCanvas Engine instead of
// embedding superspl.at (that embed has no control API - no postMessage, no
// camera hooks - so there's nowhere to add custom camera limits or timepoint
// swapping on top of it).
//
// The camera controller is built on PlayCanvas's own Pose/OrbitController
// primitives (src/extras/input/ - shipped in the engine package, alpha but
// used in the engine's own orbit-camera example) rather than a fully
// hand-rolled implementation. See the "Camera controller" section below for
// why.

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
  Vec2,
  Vec3,
  Pose,
  OrbitController,
  InputFrame,
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

// Collision enforcement is disabled for now - some "solid" voxels appear to
// be the edge of the scanned area rather than real reef, blocking the camera
// well before it reaches actual coral. Revisit once that's sorted out (see
// translateCamera's use of isBlockedAt below for where it plugs back in).
const ENABLE_VOXEL_COLLISION = false;

let voxelOctree = null;
const voxelQueryPoint = new Vec3();

// The splat entity is rotated 180deg around Z (see loadTimepoint), so its
// raw/local space - which is what the voxel data was exported in - relates
// to our world (post-rotation) space by negating X and Y, Z unchanged.
function worldToVoxelSpace(worldPoint) {
  voxelQueryPoint.set(-worldPoint.x, -worldPoint.y, worldPoint.z);
  return voxelQueryPoint;
}

function isBlockedAt(position) {
  if (!ENABLE_VOXEL_COLLISION || !voxelOctree) return false;
  const p = worldToVoxelSpace(position);
  return voxelOctree.isSolid(p.x, p.y, p.z);
}

if (voxelCollision) {
  (async () => {
    try {
      const meta = await fetch(`${voxelCollision}.json`, { cache: "no-store" }).then(r => r.json());
      const buffer = await fetch(`${voxelCollision}.bin`, { cache: "no-store" }).then(r => r.arrayBuffer());
      voxelOctree = new VoxelOctree(meta, buffer);
    } catch (e) {
      console.warn("Collision voxels unavailable:", e);
    }
  })();
}

// --------------------------------------------------
// Camera controller
//
// Built on PlayCanvas's own Pose/OrbitController primitives instead of a
// fully hand-rolled camera. A hand-rolled version of this (tracking yaw/
// pitch/distance/target as plain numbers, applying orientation via
// lookAt()) went through several rounds of bugs: gimbal lock at straight-
// down pitch, and a click-to-focus feature that only ever turned the
// camera instead of moving it. Pose's setEulerAngles()-based orientation
// (instead of lookAt()) avoids the gimbal-lock singularity at pitch=90
// (straight down) structurally, with no up-vector hack needed.
//
// OrbitController is only used for its rotate (orbit) handling now - zoom
// is a hand-rolled forward/backward dolly through full 3D space (see
// dollyCamera below) rather than OrbitController's built-in "shrink the
// distance to a fixed orbit target" zoom. That distance-shrink approach
// only ever gets the camera closer to *the orbit target's height* - fine
// for a flat reef, but reefs with real topography don't have one flat
// "bottom" for the target to sit at, so zooming in on a coral head at a
// different height than the target would stall well short of it. Dollying
// through space instead means the camera can freely ascend/descend to
// follow whatever it's actually pointed at - the same way a diver swims
// toward a subject rather than orbiting a fixed point above the reef.
//
// WASD/arrows and left-drag are hand-rolled too, because they're specific
// requirements for this project rather than generic orbit-camera behavior:
// both move the camera across the *flat* horizontal plane (ignoring pitch
// tilt), driven by key state for WASD and directly by drag distance for
// the mouse/touch version, so lateral movement always glides across the
// reef surface instead of dollying toward/away from it. Q/E move straight
// along world Y (dive/surface) to complement that plane, so between the
// two, the camera can reach anywhere in full 3D like a diver swimming
// through open water - planar glide, vertical lift, and forward/back dolly
// (zoom) each cover one axis without fighting the others.
//
// The pitch clamp's default range (30-90 degrees, 90 = straight down) is
// also project-specific, set via OrbitController's pitchRange rather than
// its default of unrestricted.
//
// Button mapping:
//   - left-drag / one-finger touch-drag = planar pan
//   - right-drag / two-finger touch-drag = orbit (tilt/rotate)
//   - wheel / pinch = zoom (forward/backward dolly, full 3D)
// --------------------------------------------------

const DEFAULT_FOV = 75;
const ORBIT_SENSITIVITY = 0.2;
const TRACKPAD_ORBIT_SENSITIVITY = 0.3;
const MOVE_SPEED = 4;
const FLY_MOVE_ACCELERATION_DAMPING = 0.992;
const FLY_MOVE_DECELERATION_DAMPING = 0.993;
const WHEEL_ZOOM_SPEED = 0.06 / 60;
const PINCH_ZOOM_SPEED = WHEEL_ZOOM_SPEED * 2;
const MIN_PITCH = 30; // can't tilt further toward the horizon than this
const MAX_PITCH = 90; // straight down
const MIN_SCENE_RADIUS = 0.5;

const orbitController = new OrbitController();
// Pose applies rotation as Euler angles where angles.x is the *negative* of
// the "pitch" used everywhere else in this file (see Pose.look/getFocus in
// the engine source - angles.x = -elevation) - so our [MIN_PITCH, MAX_PITCH]
// tilt range becomes [-MAX_PITCH, -MIN_PITCH] here.
orbitController.pitchRange = new Vec2(-MAX_PITCH, -MIN_PITCH);
// Instant response (no damping) to match the crisp, 1:1 feel this project
// wants rather than the eased/springy feel OrbitController defaults to.
orbitController.rotateDamping = 0;
orbitController.zoomDamping = 0;
orbitController.moveDamping = 0;

const pose = new Pose();
const inputFrame = new InputFrame({ move: [0, 0, 0], rotate: [0, 0, 0] });

let fov = DEFAULT_FOV;
let sceneRadius = 1;
let isControlKeyDown = false;
let hasLoadedOnce = false;

const right = new Vec3();
const flatForward = new Vec3();
const move = new Vec3();
const desiredMove = new Vec3();
const flyVelocity = new Vec3();
const worldAabbCenter = new Vec3();
const pressedKeys = new Set();

const damp = (damping, dt) => 1 - Math.pow(damping, dt * 1000);

const getFrameDistance = radius => {
  const halfFovRad = (fov * Math.PI) / 360;
  return radius / Math.sin(halfFovRad);
};

// sceneRadius comes from the splat's raw AABB, which photogrammetry
// captures often blow out with a handful of stray outlier gaussians far
// from the actual reef - the 60x multiplier just needs to be generous
// enough to frame/zoom out past that, not physically meaningful.
//
// Tracked separately from orbitController.zoomRange (rather than reading it
// back) because that getter appears to read a different internal field
// than its own setter writes to (an inconsistency in the engine's alpha
// code, verified against the source) - the setter itself works correctly
// for actual zoom clamping, but isn't safe to read back.
let maxZoomDistance = 60;

// The camera component defaults to nearClip=0.1 - way bigger than this
// splat's whole scale (a few units across) and its 0.001 minimum zoom
// distance. Zooming in past 0.1 units didn't hit a position limit at all;
// the target point (and everything near it) was simply behind the near
// clip plane and getting culled, which reads exactly like "hit an
// invisible wall" - the geometry didn't get harder to approach, it just
// stopped being rendered. farClip needs the same scaling in the other
// direction so the whole scene stays visible when zoomed all the way out.
function updateZoomRange() {
  maxZoomDistance = Math.max(sceneRadius * 60, 60);
  orbitController.zoomRange = new Vec2(0.001, maxZoomDistance);
  if (camera.camera) {
    camera.camera.nearClip = 0.0005;
    camera.camera.farClip = maxZoomDistance * 2;
  }
}
updateZoomRange();

// Flat (pitch-ignoring) horizontal basis derived from the current yaw, used
// by both WASD/arrows and left-drag pan so "planar movement" means the same
// thing everywhere: gliding across the reef surface, not dollying toward/
// away from it the way full 3D "forward" would once pitched close to
// top-down.
function updateFlatBasis() {
  const yawRad = (pose.angles.y * Math.PI) / 180;
  right.set(Math.cos(yawRad), 0, -Math.sin(yawRad));
  flatForward.set(-Math.sin(yawRad), 0, -Math.cos(yawRad));
}

// Translates the camera (and, since the orbit target moves by the same
// amount, the point it orbits around) by a world-space offset, without
// touching angles or distance. Re-seeding the controller like this (rather
// than reaching into its private state) is the same pattern PlayCanvas's
// own camera-controls.mjs script uses for its focus/reset/look methods.
//
// Collision: if the straight offset would put the camera inside solid
// reef, try sliding along just one world axis at a time (keeping the
// others at their last-good value) before giving up entirely - grazing a
// wall should let you slide along it, not stonewall the whole gesture.
// `skipCollision` exists for backing away (zoom-out, see dollyCamera):
// the voxel data is a flood fill from a seed point in open water, so
// "solid" also covers the region beyond the fill entirely (including
// above the actual water surface, since the fill has nowhere to go once
// it reaches the top of the captured volume) - pulling back to frame the
// whole reef can legitimately cross that boundary, so it's exempted the
// same way getting closer is the only case collision needs to stop.
const movedPose = new Pose();
const candidatePosition = new Vec3();
const slideCandidate = new Vec3();
function translateCamera(offset, { skipCollision = false } = {}) {
  candidatePosition.copy(pose.position).add(offset);

  if (!skipCollision && isBlockedAt(candidatePosition)) {
    const base = pose.position;
    let resolved = null;

    // Try each axis independently, skipping axes the offset doesn't actually move
    // along - a zero-offset axis's "slide" candidate is just the base position,
    // which is trivially open and would otherwise mask a genuine slide on another axis.
    if (offset.x !== 0) {
      slideCandidate.set(base.x + offset.x, base.y, base.z);
      if (!isBlockedAt(slideCandidate)) resolved = slideCandidate;
    }
    if (!resolved && offset.y !== 0) {
      slideCandidate.set(base.x, base.y + offset.y, base.z);
      if (!isBlockedAt(slideCandidate)) resolved = slideCandidate;
    }
    if (!resolved && offset.z !== 0) {
      slideCandidate.set(base.x, base.y, base.z + offset.z);
      if (!isBlockedAt(slideCandidate)) resolved = slideCandidate;
    }

    candidatePosition.copy(resolved || base);
  }

  movedPose.position.copy(candidatePosition);
  movedPose.angles.copy(pose.angles);
  movedPose.distance = pose.distance;
  orbitController.attach(movedPose, false);
  pose.copy(movedPose);
}

function setPose(position, angles, distance) {
  pose.set(position, angles, distance);
  orbitController.attach(pose, false);
  cameraRig.setPosition(pose.position);
  cameraRig.setEulerAngles(pose.angles);
}

const sphericalPosition = new Vec3();
function positionFromOrbit(target, yaw, pitch, distance, out) {
  const yawRad = (yaw * Math.PI) / 180;
  const pitchRad = (pitch * Math.PI) / 180;
  const cosPitch = Math.cos(pitchRad);
  return out.set(
    target.x + distance * Math.sin(yawRad) * cosPitch,
    target.y + distance * Math.sin(pitchRad),
    target.z + distance * Math.cos(yawRad) * cosPitch
  );
}

const clampDistance = value => Math.max(0.001, Math.min(maxZoomDistance, value));

const setDefaultFrame = () => {
  sceneRadius = 1;
  updateZoomRange();
  const distance = clampDistance(getFrameDistance(sceneRadius));
  const position = positionFromOrbit(Vec3.ZERO, -45, MAX_PITCH, distance, sphericalPosition);
  setPose(position, new Vec3(-MAX_PITCH, -45, 0), distance);
  viewDistance = distance;
};

const posePosition = new Vec3();
const poseTarget = new Vec3();
const applyCameraPose = authoredPose => {
  posePosition.set(...authoredPose.position);
  poseTarget.set(...authoredPose.target);
  const poseDistance = posePosition.distance(poseTarget);

  // a pose looking at its own position has no view direction
  if (!Number.isFinite(poseDistance) || poseDistance < 1e-6) {
    return false;
  }

  pose.look(posePosition, poseTarget);
  // Authored poses from the Supersplat editor are often more oblique than
  // our tilt floor (Sandy Cay's is ~38deg) - clamp on the way in.
  const clampedPitch = Math.max(-MAX_PITCH, Math.min(-MIN_PITCH, pose.angles.x));
  fov = authoredPose.fov;
  if (camera.camera) camera.camera.fov = fov;

  setPose(pose.position, new Vec3(clampedPitch, pose.angles.y, 0), pose.distance);
  viewDistance = pose.distance;
  return true;
};

const frameSplat = (splat, aabb) => {
  let target = Vec3.ZERO;
  if (aabb) {
    splat.getWorldTransform().transformPoint(aabb.center, worldAabbCenter);
    target = worldAabbCenter;
    sceneRadius = Math.max(aabb.halfExtents.length(), MIN_SCENE_RADIUS);
  } else {
    sceneRadius = 1;
  }
  updateZoomRange();

  const distance = clampDistance(getFrameDistance(sceneRadius));
  const position = positionFromOrbit(target, -45, MAX_PITCH, distance, sphericalPosition);
  setPose(position, new Vec3(-MAX_PITCH, -45, 0), distance);
  viewDistance = distance;
};

function appendOrbitRotate(yawDeltaDeg, pitchDeltaDeg) {
  inputFrame.deltas.rotate.append([yawDeltaDeg, pitchDeltaDeg, 0]);
}

// Full (non-flattened) view-direction vector, derived from the current pose
// angles - unlike flatForward (used for WASD/pan, which stay intentionally
// horizontal), this includes the vertical component of where the camera is
// actually looking.
const viewForward = new Vec3();
function updateViewForward() {
  const yawRad = (pose.angles.y * Math.PI) / 180;
  const pitchRad = (-pose.angles.x * Math.PI) / 180;
  const cosPitch = Math.cos(pitchRad);
  viewForward.set(-Math.sin(yawRad) * cosPitch, -Math.sin(pitchRad), -Math.cos(yawRad) * cosPitch);
}

// Zoom is a true forward/backward dolly through full 3D space - translating
// the camera (and the point it orbits around, by the same amount - see
// translateCamera) along the direction it's actually looking, rather than
// shrinking a "distance to a fixed orbit target" that only ever gets you
// closer to wherever that target height happens to be. A reef with real
// topography doesn't have one flat "bottom" the orbit target can sit at, so
// the old distance-shrink approach could only ever get close to *a* height,
// not necessarily the one you're actually looking at - dollying through
// space instead means you can descend/ascend to follow the terrain, the
// same way a diver swims toward whatever they're looking at rather than
// orbiting a fixed point above the reef.
//
// Backing away (amount < 0) is exempted from collision - see translateCamera.
const dollyDelta = new Vec3();
function dollyCamera(amount) {
  updateViewForward();
  dollyDelta.copy(viewForward).mulScalar(amount);
  translateCamera(dollyDelta, { skipCollision: amount < 0 });
}

// Tracks "how zoomed in" the camera currently is, independent of the orbit
// controller's own `distance` (the fixed arm length used only for right-
// drag orbit, which dollying never touches - see dollyCamera/translateCamera
// above). Pan and dolly speed both scale off *this* instead, so a drag
// still feels 1:1 - the point under the cursor stays under the cursor -
// no matter how far you've zoomed, rather than always scaling as if the
// camera were still at its starting distance.
let viewDistance = 1;

// Applies a multiplicative zoom factor (< 1 = zooming in) as a forward/back
// dolly of the equivalent absolute distance, and updates viewDistance by
// the same factor so pan/future zoom stay scaled to the new depth.
function zoomByFactor(factor) {
  dollyCamera(viewDistance * (1 - factor));
  viewDistance = Math.max(0.001, Math.min(maxZoomDistance, viewDistance * factor));
}

// "Grab and drag" planar pan: the point on the flat plane under the cursor
// at the start of a move stays pinned under the cursor at the end of it, at
// any zoom level - scaled by viewDistance (how far dollyCamera has actually
// brought the camera in), not pose.distance (the orbit arm length, which
// zoom no longer touches at all - see dollyCamera/viewDistance above). Using
// pose.distance here was the bug: it stayed frozen at whatever it started
// at, so pan always moved at that one fixed scale regardless of how far
// you'd actually zoomed - too slow zoomed out, too fast zoomed in.
const panDelta = new Vec3();
function planarPanDrag(deltaX, deltaY) {
  updateFlatBasis();

  const width = canvas.clientWidth || window.innerWidth;
  const height = canvas.clientHeight || window.innerHeight;
  const halfHeight = viewDistance * Math.tan((fov * Math.PI) / 360);
  const halfWidth = halfHeight * (width / height);

  panDelta
    .set(0, 0, 0)
    .addScaled(right, (-deltaX / width) * halfWidth * 2)
    .addScaled(flatForward, (deltaY / height) * halfHeight * 2);
  translateCamera(panDelta);
}

function touchCenterAndDist(activePointers) {
  const [a, b] = Array.from(activePointers.values());
  return {
    cx: (a.x + b.x) / 2,
    cy: (a.y + b.y) / 2,
    dist: Math.hypot(a.x - b.x, a.y - b.y)
  };
}

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
      const { cx, cy, dist } = touchCenterAndDist(activePointers);
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

    const { cx, cy, dist } = touchCenterAndDist(activePointers);

    // Two fingers moving together => orbit (mirrors right-click-drag).
    appendOrbitRotate((cx - touchCenterX) * ORBIT_SENSITIVITY, (cy - touchCenterY) * ORBIT_SENSITIVITY);

    // Fingers moving apart/together => pinch-zoom (dolly forward/back).
    if (pinchDist > 0 && dist > 0) {
      zoomByFactor(pinchDist / dist);
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
    planarPanDrag(deltaX, deltaY);
  } else if (dragMode === "orbit") {
    appendOrbitRotate(deltaX * ORBIT_SENSITIVITY, deltaY * ORBIT_SENSITIVITY);
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
      planarPanDrag(event.deltaX, event.deltaY);
      return;
    }

    if (event.ctrlKey && isControlKeyDown) {
      appendOrbitRotate(event.deltaX * TRACKPAD_ORBIT_SENSITIVITY, event.deltaY * TRACKPAD_ORBIT_SENSITIVITY);
      return;
    }

    const zoomSpeed = event.ctrlKey ? PINCH_ZOOM_SPEED : WHEEL_ZOOM_SPEED;
    zoomByFactor(1 + event.deltaY * zoomSpeed);
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
  // Straight world-Y lift, complementing WASD's flat glide - E surfaces,
  // Q dives, so between the two the camera can reach anywhere in full 3D.
  const lift = Number(pressedKeys.has("KeyE")) - Number(pressedKeys.has("KeyQ"));

  if (strafe !== 0 || advance !== 0 || lift !== 0) {
    updateFlatBasis();

    desiredMove.addScaled(right, strafe).addScaled(flatForward, advance);
    desiredMove.y += lift;

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

  if (flyVelocity.lengthSq() > 0) {
    move.copy(flyVelocity).mulScalar(dt);
    translateCamera(move);
  }

  // Orbit (right-drag/two-finger) and zoom (wheel/pinch) deltas accumulated
  // since last frame get processed and folded into the pose here.
  pose.copy(orbitController.update(inputFrame, dt));
  cameraRig.setPosition(pose.position);
  cameraRig.setEulerAngles(pose.angles);
});

setDefaultFrame();

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

// --------------------------------------------------
// Splat loading + timepoint swapping
//
// Camera state (pose/fov) is never touched by which splat is loaded, so
// swapping timepoints naturally preserves the viewpoint. It's only reset
// (via applyCameraPose/frameSplat) on the very first load.
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
      updateZoomRange();
    }

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
  getYaw: () => pose.angles.y,
  getPitch: () => -pose.angles.x,
  getDistance: () => pose.distance,
  getViewDistance: () => viewDistance,
  getTarget: () => pose.getFocus(new Vec3()),
  getCameraPosition: () => pose.position.clone(),
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
