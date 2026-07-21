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
  ScreenComponentSystem,
  ElementComponentSystem,
  ElementInput,
  CanvasFont,
  ELEMENTTYPE_TEXT,
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
  XrManager,
  XRTYPE_VR,
  XRSPACE_LOCALFLOOR,
  XRSPACE_LOCAL,
  PROJECTION_ORTHOGRAPHIC,
  PROJECTION_PERSPECTIVE,
  StandardMaterial,
  Picker,
  TorusGeometry,
  PlaneGeometry,
  Mesh,
  MeshInstance,
  BLEND_ADDITIVE,
  BLEND_NORMAL,
  CULLFACE_NONE,
  Layer,
  Texture,
  FILTER_LINEAR,
  ADDRESS_CLAMP_TO_EDGE,
  PIXELFORMAT_RGBA8,
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

const sites = await fetch("data/sites.geojson", { cache: "no-store" }).then(r => r.json());
const feature = (sites.features || []).find(f => f?.properties?.id === reefId);

if (!feature) {
  alert("Reef not found");
  throw new Error("Invalid reef id");
}

// Reefs marked "public" (e.g. for sharing a direct link) skip the password
// gate entirely - this is opt-in per site in sites.geojson, not a general
// bypass, and doesn't touch index.html/map.js or any other viewer, so
// following "Back" from here still requires a password for everything else.
if (!feature.properties?.public) {
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

  if (!featureAllowsAccess(feature.properties, sessionPw)) {
    bounceToIndex("Access denied for this site with the current password.");
    throw new Error("Access denied");
  }
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
const debugHud = document.getElementById("debugHud");

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

// WebXR immersive sessions currently require WebGL - a WebGPU device needs
// XRGPUBinding, which isn't broadly supported yet, so PlayCanvas's own XR
// availability check (see the VR section below) reports VR as unavailable
// on WebGPU regardless of whether a headset is actually connected. Once the
// VR button's own WebGPU-detection flow (below) has the user opt into
// WebGL for a VR session, this flag makes that choice stick across the
// reload it triggers - otherwise we'd just pick WebGPU again and loop.
const forceWebglForXr = sessionStorage.getItem("reefshape_force_webgl") === "1";
const device = await createGraphicsDevice(canvas, {
  deviceTypes: forceWebglForXr ? [DEVICETYPE_WEBGL2] : [DEVICETYPE_WEBGPU, DEVICETYPE_WEBGL2],
  // Gaussian splats don't benefit from antialiasing and it's expensive.
  antialias: false
});
device.maxPixelRatio = Math.min(window.devicePixelRatio || 1, 2);

const createOptions = new AppOptions();
createOptions.graphicsDevice = device;
createOptions.componentSystems = [
  CameraComponentSystem,
  GSplatComponentSystem,
  RenderComponentSystem,
  ScreenComponentSystem,
  ElementComponentSystem
];
createOptions.resourceHandlers = [TextureHandler, GSplatHandler];
// Screen/Element are for the in-VR timepoint menu (see "VR timepoint menu"
// below) - it's world-space UI, not a DOM overlay, since a WebXR immersive
// session takes over the display entirely and the existing HTML controls
// simply aren't visible while it's active. XR-only (no mouse/touch): desktop
// already has its own <select> for this, unrelated to ElementInput.
createOptions.elementInput = new ElementInput(canvas, { useMouse: false, useTouch: false, useXr: true });
// Without this, AppBase leaves app.xr null (AppOptions.xr is opt-in, not
// automatic) - the VR button and everything in the "VR (WebXR)" section
// below silently no-ops without ever throwing, since every use of app.xr
// is behind an `if (app.xr)`/`app.xr?.` guard.
createOptions.xr = XrManager;

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
  // Required for gsplat entities to participate in Picker hit-testing at
  // all (see clickToCenter below) - without this, the picker's ID/depth
  // buffer never gets gsplat contributions, so every pick silently misses.
  app.scene.gsplat.enableIds = true;
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

// Click-to-center marker: a flat glowing ring dropped at wherever the last
// click/tap actually landed on the reef (see clickToCenter below). Emissive-
// only material since this scene has no light components registered - an
// ordinary lit material would render solid black without one.
const clickMarker = new Entity("ClickMarker");
// A thin ring rather than the primitive "torus" shape's default fat donut
// proportions (tubeRadius 0.2 vs ringRadius 0.3) - custom geometry is the
// only way to get that ratio, since the render component's primitive
// 'torus' type doesn't expose tube/ring radius as configurable options.
const clickMarkerGeometry = new TorusGeometry({ ringRadius: 1, tubeRadius: 0.06, segments: 48, sides: 16 });
const clickMarkerMesh = Mesh.fromGeometry(app.graphicsDevice, clickMarkerGeometry);
const clickMarkerMaterial = new StandardMaterial();
clickMarkerMaterial.emissive = new Color(1, 1, 1);
clickMarkerMaterial.emissiveIntensity = 4;
clickMarkerMaterial.diffuse = new Color(0, 0, 0);
// No light components exist in this scene at all, so a normally-lit
// material would render solid black - useLighting: false makes emissive
// the sole color source, independent of scene lighting. Additive blending
// (rather than opaque) gives it a soft glowing look instead of a flat disc.
clickMarkerMaterial.useLighting = false;
clickMarkerMaterial.blendType = BLEND_ADDITIVE;
clickMarkerMaterial.depthWrite = false;
clickMarkerMaterial.update();

const clickMarkerMeshInstance = new MeshInstance(clickMarkerMesh, clickMarkerMaterial);
clickMarkerMeshInstance.pick = false; // never let the marker itself be the click-to-center hit
clickMarker.addComponent("render", {
  meshInstances: [clickMarkerMeshInstance],
  castShadows: false,
  receiveShadows: false
});
app.root.addChild(clickMarker);
clickMarker.enabled = false;
let clickMarkerHideTimer = null;

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

// Raw occupancy query, independent of ENABLE_VOXEL_COLLISION - used both for
// movement collision (isBlockedAt, which does respect that flag) and for
// click-to-center's raycast below, which needs real hit-testing regardless
// of whether collision is currently enforced.
function isSolidAt(position) {
  if (!voxelOctree) return false;
  const p = worldToVoxelSpace(position);
  return voxelOctree.isSolid(p.x, p.y, p.z);
}

function isBlockedAt(position) {
  return ENABLE_VOXEL_COLLISION && isSolidAt(position);
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

// 2D ("photomosaic") mode: straight-down orthographic view. Unlike the free
// perspective dolly, ortho projection makes apparent size independent of
// camera height, so "zoom" there directly resizes the view frustum
// (orthoHeight) instead of moving the camera - which also gives it a natural
// hard zoom limit in both directions, unlike the perspective dolly.
const ORTHO_HEIGHT_MIN_FACTOR = 0.02; // relative to sceneRadius
const ORTHO_HEIGHT_MAX_FACTOR = 3;

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
let is2DMode = false;
let orthoHeight = null; // lazily initialized to sceneRadius on first entry into 2D mode

// In-progress click-to-center camera slide (see startRecenterAnimation) -
// { startPos, endPos, startTime, duration } or null when idle. Cancelled by
// translateCamera/appendOrbitRotate the instant any manual input arrives, so
// it never fights the user for control of the camera.
let recenterAnim = null;

const right = new Vec3();
const flatForward = new Vec3();
const move = new Vec3();
const desiredMove = new Vec3();
const flyVelocity = new Vec3();
const worldAabbCenter = new Vec3();
const pressedKeys = new Set();

// World-space point set on framing/click-to-center and carried along by
// every subsequent camera translation (see translateCamera's moveZoomTarget
// option) - primarily the point click-to-center last focused on.
const zoomTarget = new Vec3();

// "How zoomed in" the camera currently is - used to scale pan speed, dolly
// step size, and 2D's initial ortho framing. Tracked as its own scalar
// rather than derived from distance(camera, zoomTarget): that formula
// shrinks toward zero as dolly approaches zoomTarget (an actual point in
// space, e.g. wherever was last clicked), and since Euclidean distance can't
// go negative, continuing to dolly through that point made the camera fly
// past it while the "distance" - having bottomed out - started growing
// again on the other side. That reads as "zoom gets stuck near the target,
// then suddenly unsticks and increases as you move through it," which is
// exactly what it is: distance-to-a-point is the wrong quantity to zoom
// against once you can fly through the point. Dollying still updates this
// multiplicatively (zoomByFactor) and Q/E updates it additively by the
// actual vertical distance moved (translateCamera's trackHeightChange) - so it
// tracks real height above whatever's below, per its purpose - but neither
// depends on zoomTarget's position, so there's no point to converge on or
// pass through. WASD's horizontal glide and pan never touch it, matching
// the fact that neither changes how far you are from the ground.
let viewDistance = 1;

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
const appliedOffset = new Vec3();
// Whether the actual applied movement (which can differ from the requested
// offset if collision sliding kicked in) should carry zoomTarget along with
// it - true for essentially every movement type now, so zoomTarget stays a
// sensible nearby point rather than something zoom math has to route around.
// `trackHeightChange` separately feeds the *vertical* component of the
// applied movement into viewDistance (see its declaration) - true only for
// Q/E, since that's the one movement type that actually changes height
// above the reef without an explicit zoom action.
function translateCamera(offset, { skipCollision = false, moveZoomTarget = false, trackHeightChange = false } = {}) {
  // Any manual movement takes over from an in-progress click-to-center
  // slide immediately, rather than fighting it frame to frame.
  recenterAnim = null;

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

  if (moveZoomTarget || trackHeightChange) {
    // Use the actual applied delta, not the requested offset - they can
    // differ when collision sliding altered the candidate position.
    appliedOffset.copy(candidatePosition).sub(pose.position);
    if (moveZoomTarget) zoomTarget.add(appliedOffset);
    if (trackHeightChange) {
      viewDistance = Math.max(0.001, Math.min(maxZoomDistance, viewDistance + appliedOffset.y));
    }
  }

  movedPose.position.copy(candidatePosition);
  movedPose.angles.copy(pose.angles);
  movedPose.distance = pose.distance;
  orbitController.attach(movedPose, false);
  pose.copy(movedPose);
}

const cameraRigAngles = new Vec3();

// Pushes pose onto cameraRig - except for pitch/roll while an XR session is
// active. In VR the headset supplies its own full-range look direction (the
// engine overwrites camera's *local* rotation from tracking every frame -
// see the cameraRig/camera split above), so baking the desktop orbit
// camera's pitch (clamped to MIN_PITCH..MAX_PITCH - see its declaration)
// into the *rig's* rotation as well would tilt the real-world "up" the
// headset reports relative to the world - not a soft limit on how far you
// can look, but a constant disorienting skew, on top of whatever the
// headset itself is doing. Yaw is fine to carry over (turning the rig is
// how snap-turn works - see updateVrLocomotion), it's only pitch/roll of
// the *rig* that must stay level.
function syncCameraRig() {
  cameraRig.setPosition(pose.position);
  if (app.xr && app.xr.active) {
    cameraRigAngles.set(0, pose.angles.y, 0);
  } else {
    cameraRigAngles.copy(pose.angles);
  }
  cameraRig.setEulerAngles(cameraRigAngles);
}

function setPose(position, angles, distance) {
  pose.set(position, angles, distance);
  orbitController.attach(pose, false);
  syncCameraRig();
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
  zoomTarget.set(0, 0, 0);
  viewDistance = distance;
};

const posePosition = new Vec3();
const poseTarget = new Vec3();
const twoDPosition = new Vec3();
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
  zoomTarget.copy(poseTarget);
  viewDistance = clampDistance(poseDistance);
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
  zoomTarget.copy(target);
  viewDistance = distance;
};

function appendOrbitRotate(yawDeltaDeg, pitchDeltaDeg) {
  recenterAnim = null; // manual orbit input takes over from an in-progress slide
  inputFrame.deltas.rotate.append([yawDeltaDeg, pitchDeltaDeg, 0]);
}

// The engine's gsplat LOD system picks detail level from real world-space
// camera-to-splat distance (scaled by perspective FOV - it doesn't know
// about orthoHeight/projection mode at all), so a camera that never moves
// during "zoom" - which is otherwise exactly right for orthographic framing,
// since apparent scale there depends only on orthoHeight - would report the
// same (large, fixed) distance forever and never stream in the higher-detail
// LODs no matter how far you zoom in. Physically moving the camera closer
// as orthoHeight shrinks fixes this with zero visual side effect under
// orthographic projection (no perspective foreshortening to distort), while
// giving the LOD system a real, shrinking distance to react to.
function heightFor2DZoom(oh) {
  return oh * 3;
}

// Straight-down orthographic "photomosaic" mode. Keeps the current XZ
// position and yaw so toggling doesn't reframe the view, only what you can
// do with it: pitch gets locked at -90 (straight down) by pinning
// pitchRange to a zero-width range at that value - Pose.rotate (which
// OrbitController.update calls for right-drag/two-finger orbit input) clamps
// into that range every time, so no amount of vertical drag can move it.
//
// The full 3D pose is snapshotted here and restored on exit (see
// exit2DMode) so toggling back and forth doesn't leave the camera stuck at
// 2D's height, or jump-zoom the view - and orthoHeight is derived from the
// current 3D viewDistance (not a fixed scene-radius default) so the 2D view
// starts at roughly the same apparent zoom you were just looking at in 3D.
const saved3DPose = new Pose();
let has3DPoseSaved = false;

function enter2DMode() {
  if (is2DMode) return;
  is2DMode = true;

  saved3DPose.copy(pose);
  has3DPoseSaved = true;

  orthoHeight = Math.max(
    sceneRadius * ORTHO_HEIGHT_MIN_FACTOR,
    Math.min(sceneRadius * ORTHO_HEIGHT_MAX_FACTOR, viewDistance)
  );

  const height = heightFor2DZoom(orthoHeight);
  twoDPosition.set(pose.position.x, zoomTarget.y + height, pose.position.z);
  setPose(twoDPosition, new Vec3(-MAX_PITCH, pose.angles.y, 0), height);
  orbitController.pitchRange = new Vec2(-MAX_PITCH, -MAX_PITCH);

  if (camera.camera) {
    camera.camera.projection = PROJECTION_ORTHOGRAPHIC;
    camera.camera.orthoHeight = orthoHeight;
  }

  // The underwater fog tint is distance-from-camera based (see
  // setupGsplatShaderEffects below), and 2D mode's camera sits far enough above
  // the reef to frame the whole scene that everything reads as uniformly
  // fogged - fine for an immersive perspective view, wrong for a flat
  // photomosaic that's supposed to look like an evenly-exposed orthophoto.
  if (fogSupported) {
    app.scene.gsplat.material.setParameter("uFogDensity", 0);
    app.scene.gsplat.material.update();
  }
}

function exit2DMode() {
  if (!is2DMode) return;
  is2DMode = false;

  orbitController.pitchRange = new Vec2(-MAX_PITCH, -MIN_PITCH);

  if (has3DPoseSaved) {
    setPose(saved3DPose.position, saved3DPose.angles, saved3DPose.distance);
  }

  if (camera.camera) {
    camera.camera.projection = PROJECTION_PERSPECTIVE;
    camera.camera.fov = fov;
  }

  if (fogSupported) {
    app.scene.gsplat.material.setParameter("uFogDensity", FOG_DENSITY);
    app.scene.gsplat.material.update();
  }
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
// zoomTarget rides along (moveZoomTarget) so it stays a sensible nearby
// point rather than something the camera dollies through and away from.
const dollyDelta = new Vec3();
function dollyCamera(amount) {
  updateViewForward();
  dollyDelta.copy(viewForward).mulScalar(amount);
  translateCamera(dollyDelta, { skipCollision: amount < 0, moveZoomTarget: true });
}

// Applies a multiplicative zoom factor (< 1 = zooming in) as a forward/back
// dolly of the equivalent absolute distance, updating viewDistance by the
// same factor (see its declaration for why it's tracked independently
// rather than measured as distance-to-zoomTarget).
function zoomByFactor(factor) {
  dollyCamera(viewDistance * (1 - factor));
  viewDistance = Math.max(0.001, Math.min(maxZoomDistance, viewDistance * factor));
}

// 2D mode's zoom: no camera movement at all (see enter2DMode) - just resizes
// the orthographic frustum, clamped so you can't zoom in/out indefinitely.
function zoomOrthoByFactor(factor) {
  const min = sceneRadius * ORTHO_HEIGHT_MIN_FACTOR;
  const max = sceneRadius * ORTHO_HEIGHT_MAX_FACTOR;
  orthoHeight = Math.max(min, Math.min(max, orthoHeight * factor));
  if (camera.camera) camera.camera.orthoHeight = orthoHeight;

  // Move the camera closer/farther with it (see heightFor2DZoom) so the
  // engine's distance-based LOD system actually sees zoom happening.
  const height = heightFor2DZoom(orthoHeight);
  twoDPosition.set(pose.position.x, zoomTarget.y + height, pose.position.z);
  setPose(twoDPosition, pose.angles, height);
}

// "Grab and drag" planar pan: the point on the flat plane under the cursor
// at the start of a move stays pinned under the cursor at the end of it, at
// any zoom level - scaled by the camera's current distance to zoomTarget
// (or, in 2D mode, by orthoHeight directly - the true world-space half-
// height of the view, independent of camera distance under orthographic
// projection), not pose.distance (the orbit arm length, which zoom never
// touches - see dollyCamera above). Using pose.distance here was the
// original bug: it stayed frozen at whatever it started at, so pan always
// moved at that one fixed scale regardless of how far you'd actually
// zoomed.
const panDelta = new Vec3();
function planarPanDrag(deltaX, deltaY) {
  updateFlatBasis();

  const width = canvas.clientWidth || window.innerWidth;
  const height = canvas.clientHeight || window.innerHeight;
  const halfHeight = is2DMode ? orthoHeight : viewDistance * Math.tan((fov * Math.PI) / 360);
  const halfWidth = halfHeight * (width / height);

  panDelta
    .set(0, 0, 0)
    .addScaled(right, (-deltaX / width) * halfWidth * 2)
    .addScaled(flatForward, (deltaY / height) * halfHeight * 2);
  translateCamera(panDelta, { moveZoomTarget: true });
}

// Click-to-center: recenters the view on wherever was clicked, without
// changing the current viewing angle/zoom. This is the main way to recover
// when free-roaming (WASD/Q-E/dolly/pan, especially on mobile where drift is
// easy to rack up without noticing) has left the camera position and
// zoomTarget far apart or otherwise "out of range" - click a point on the
// reef and both snap back into a sane relationship, anchored on real
// geometry instead of empty space.
//
// Hit-testing uses the engine's own Picker (depth-enabled), the same
// mechanism Supersplat's own click-to-focus uses under the hood - it renders
// a small offscreen pass and reads back the exact world position of whatever
// gsplat/mesh is actually visible at that pixel, so the result always lands
// on the real rendered surface rather than an approximated collision proxy.
// Sized to CSS pixels (canvas.clientWidth/Height) rather than the physical
// device resolution so click coordinates need no devicePixelRatio scaling.
const picker = new Picker(app, canvas.clientWidth || 1, canvas.clientHeight || 1, true);
const clickOffset = new Vec3();

// Fraction of the view's vertical extent the ring's scale factor should
// span, so it reads as a constant on-screen size regardless of zoom level.
const MARKER_SCREEN_FRACTION = 0.035;

function showClickMarker(worldPoint) {
  // True fixed-screenspace sizing: derive the world-space scale that
  // produces a constant apparent size, from the actual distance to the
  // clicked point and the camera's current FOV (or orthoHeight in 2D,
  // where apparent size is distance-independent) - not viewDistance, which
  // is a bookkeeping proxy for zoom/pan speed, not the true distance to any
  // particular point.
  const size = Math.max(
    is2DMode
      ? orthoHeight * 2 * MARKER_SCREEN_FRACTION
      : pose.position.distance(worldPoint) * 2 * Math.tan((fov * Math.PI) / 360) * MARKER_SCREEN_FRACTION,
    0.0001
  );
  clickMarker.setPosition(worldPoint);
  clickMarker.setLocalScale(size, size, size);
  clickMarker.enabled = true;

  clearTimeout(clickMarkerHideTimer);
  clickMarkerHideTimer = setTimeout(() => {
    clickMarker.enabled = false;
  }, 900);
}

const currentFocus = new Vec3();

// click-to-center resets the camera to exactly this far from the clicked
// point (3D mode only) rather than preserving whatever distance it was
// already at - preserving it tended to land too close (e.g. right after
// zooming way in) since it just kept the pre-click camera-to-focus offset
// verbatim. A fixed, comfortable reset distance is what actually makes
// "recenter" useful as a way to recover from an extreme zoom.
const CLICK_RECENTER_DISTANCE = 2;
const recenterEndPosition = new Vec3();

// Eases the camera from its current position to `endPosition` (and
// pose.distance to `endDistance`) over 1-2 seconds instead of jumping
// there instantly, so a click-to-center reads as a deliberate camera move
// rather than a disorienting cut. Duration scales with how far the camera
// actually has to travel relative to its pre-click zoom depth, so a small
// nearby adjustment settles quickly while a hop across the whole reef
// takes the full 2 seconds. Cancelled the instant any manual input arrives
// (see translateCamera/appendOrbitRotate) rather than fighting for control.
function startRecenterAnimation(endPosition, endDistance, referenceViewDistance) {
  const travelDistance = pose.position.distance(endPosition);
  const duration = Math.min(2, 1 + Math.min(1, travelDistance / (referenceViewDistance * 4 + 0.001)));
  recenterAnim = {
    startPosition: pose.position.clone(),
    endPosition: endPosition.clone(),
    startDistance: pose.distance,
    endDistance,
    startTime: performance.now(),
    duration
  };
}

// Shared by clickToCenter (mouse/touch, screen-space) and vrTriggerRecenter
// (right controller ray, see the "VR controller locomotion" section below)
// - both resolve to a world-space hitPoint one way or another and then do
// the exact same "fly to and orbit around this point" recenter.
function recenterOn(hitPoint) {
  if (!hitPoint) return; // missed all geometry (e.g. background/open water)

  const oldViewDistance = viewDistance;
  let endDistance = pose.distance;

  if (is2DMode) {
    // 2D's camera height is a fixed function of orthoHeight (see
    // enter2DMode/zoomOrthoByFactor), not a zoom concept - only recenter
    // horizontally, and leave height/distance/viewDistance untouched. The
    // offset is measured from the point actually at screen center right
    // now (pose.getFocus()), not zoomTarget - zoomTarget drifts away from
    // "what's on screen" the moment you pan/orbit/dolly without an
    // explicit recenter, so anchoring on it here would translate the
    // clicked point to wherever zoomTarget last was rather than to center.
    pose.getFocus(currentFocus);
    clickOffset.copy(hitPoint).sub(currentFocus);
    clickOffset.y = 0;
    recenterEndPosition.copy(pose.position).add(clickOffset);
  } else {
    updateViewForward();
    recenterEndPosition.copy(hitPoint).addScaled(viewForward, -CLICK_RECENTER_DISTANCE);
    endDistance = CLICK_RECENTER_DISTANCE;
    viewDistance = CLICK_RECENTER_DISTANCE;
  }

  // Set directly rather than offsetting zoomTarget by an offset vector -
  // hitPoint is exactly what zoomTarget should become, unconditionally,
  // regardless of any prior drift in the camera-to-focus relationship.
  zoomTarget.copy(hitPoint);

  showClickMarker(hitPoint);
  startRecenterAnimation(recenterEndPosition, endDistance, oldViewDistance);
}

async function clickToCenter(screenX, screenY) {
  if (!camera.camera) return;

  const rect = canvas.getBoundingClientRect();
  const x = screenX - rect.left;
  const y = screenY - rect.top;

  picker.resize(rect.width, rect.height);
  picker.prepare(camera.camera, app.scene, [app.scene.layers.getLayerByName("World")]);
  recenterOn(await picker.getWorldPointAsync(x, y));
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

// Tracks whether the current single-pointer gesture is still a plain click/
// tap (as opposed to having turned into a pan drag) - cancelled the moment
// it moves more than CLICK_MOVE_THRESHOLD px, so an ordinary pan never also
// triggers a recenter.
const CLICK_MOVE_THRESHOLD = 6;
let clickCandidateActive = false;
let clickCandidateX = 0;
let clickCandidateY = 0;

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
      clickCandidateActive = true;
      clickCandidateX = event.clientX;
      clickCandidateY = event.clientY;
    } else if (activePointers.size === 2) {
      dragMode = "touch2";
      const { cx, cy, dist } = touchCenterAndDist(activePointers);
      touchCenterX = cx;
      touchCenterY = cy;
      pinchDist = dist;
      clickCandidateActive = false; // a second finger joined - no longer a simple tap
    }
    // A third+ finger is ignored - keep whatever gesture was already active.
  } else if (activePointers.size === 1) {
    lastPointerX = event.clientX;
    lastPointerY = event.clientY;

    // Mouse (or pen): left button pans, right button orbits. Shift+left
    // orbits too (mirrors right-click-drag exactly, pivoting around
    // pose.getFocus() same as always) - a laptop-friendly alternative on
    // trackpads where right-click-drag or two-finger-drag is unreliable.
    dragMode = event.button === 2 || (event.button === 0 && event.shiftKey) ? "orbit" : "pan";
    clickCandidateActive = event.button === 0 && !event.shiftKey;
    clickCandidateX = event.clientX;
    clickCandidateY = event.clientY;
  }
});

canvas.addEventListener("pointermove", event => {
  if (!activePointers.has(event.pointerId)) return;
  activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

  if (clickCandidateActive) {
    const movedDist = Math.hypot(event.clientX - clickCandidateX, event.clientY - clickCandidateY);
    if (movedDist > CLICK_MOVE_THRESHOLD) clickCandidateActive = false;
  }

  if (dragMode === "touch2") {
    if (activePointers.size !== 2) return;

    const { cx, cy, dist } = touchCenterAndDist(activePointers);

    // Two fingers moving together => orbit (mirrors right-click-drag).
    appendOrbitRotate((cx - touchCenterX) * ORBIT_SENSITIVITY, (cy - touchCenterY) * ORBIT_SENSITIVITY);

    // Fingers moving apart/together => pinch-zoom (dolly forward/back, or
    // resize the frustum in 2D mode).
    if (pinchDist > 0 && dist > 0) {
      if (is2DMode) {
        zoomOrthoByFactor(pinchDist / dist);
      } else {
        zoomByFactor(pinchDist / dist);
      }
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
  // Whether this is the last pointer lifting off (ending the whole gesture,
  // as opposed to dropping from two touches to one) has to be checked
  // before deleting it below.
  const isLastPointer = activePointers.size === 1;
  activePointers.delete(event.pointerId);

  if (canvas.hasPointerCapture(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }

  if (event.type === "pointerup" && isLastPointer && clickCandidateActive) {
    clickToCenter(event.clientX, event.clientY);
  }
  clickCandidateActive = false;

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
    const factor = 1 + event.deltaY * zoomSpeed;
    if (is2DMode) {
      zoomOrthoByFactor(factor);
    } else {
      zoomByFactor(factor);
    }
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

const recenterAnimPosition = new Vec3();

app.on("update", dt => {
  if (recenterAnim) {
    const elapsed = (performance.now() - recenterAnim.startTime) / 1000;
    const t = Math.min(1, elapsed / recenterAnim.duration);
    const eased = t * t * (3 - 2 * t); // smoothstep
    recenterAnimPosition.lerp(recenterAnim.startPosition, recenterAnim.endPosition, eased);
    const distance = recenterAnim.startDistance + (recenterAnim.endDistance - recenterAnim.startDistance) * eased;
    setPose(recenterAnimPosition, pose.angles, distance);
    if (t >= 1) recenterAnim = null;
  }

  desiredMove.set(0, 0, 0);

  const strafe =
    Number(pressedKeys.has("KeyD") || pressedKeys.has("ArrowRight")) -
    Number(pressedKeys.has("KeyA") || pressedKeys.has("ArrowLeft"));
  const advance =
    Number(pressedKeys.has("KeyW") || pressedKeys.has("ArrowUp")) -
    Number(pressedKeys.has("KeyS") || pressedKeys.has("ArrowDown"));
  // Straight world-Y lift, complementing WASD's flat glide - E surfaces,
  // Q dives, so between the two the camera can reach anywhere in full 3D.
  // Meaningless in 2D mode (camera height has no effect under orthographic
  // projection, and pitch is locked straight down anyway), so it's a no-op
  // there rather than silently moving the camera somewhere the view can't
  // show.
  const lift = is2DMode ? 0 : Number(pressedKeys.has("KeyE")) - Number(pressedKeys.has("KeyQ"));

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

      // In 2D mode, scale glide speed by orthoHeight the same way pan
      // already does - otherwise a fixed world-space speed would crawl when
      // zoomed in tight and blow past the reef when zoomed out.
      desiredMove.normalize().mulScalar(MOVE_SPEED * speedMultiplier * (is2DMode ? orthoHeight : 1));
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
    translateCamera(move, { moveZoomTarget: true, trackHeightChange: true });
  }

  if (app.xr && app.xr.active) {
    // Flight is suspended while the menu is open - the left stick is
    // repurposed for menu navigation instead (see updateVrMenuNavigationInput),
    // and flying around while browsing a menu would just be disorienting.
    if (vrMenuScreen.enabled) {
      updateVrMenuNavigationInput();
      vrVignetteTargetIntensity = 0; // updateVrLocomotion isn't running to do this itself
    } else {
      updateVrLocomotion(dt);
    }
    updateVrMenuToggleInput();
  }
  updateVrVignette(dt);

  // Orbit (right-drag/two-finger) and zoom (wheel/pinch) deltas accumulated
  // since last frame get processed and folded into the pose here (this is
  // also how updateVrLocomotion's snap-turn reaches the pose - it just
  // appends into the same rotate deltas WASD/mouse-orbit do).
  pose.copy(orbitController.update(inputFrame, dt));
  syncCameraRig();

  if (debugHud) {
    const { x, y, z } = pose.position;
    const zoom = is2DMode ? orthoHeight : viewDistance;
    debugHud.textContent =
      `X: ${x.toFixed(3)}  Y: ${y.toFixed(3)}  Z: ${z.toFixed(3)}\nZoom: ${zoom.toFixed(3)}`;
  }
});

setDefaultFrame();

const modeToggleButton = document.getElementById("modeToggleButton");
if (modeToggleButton) {
  modeToggleButton.addEventListener("click", () => {
    if (is2DMode) {
      exit2DMode();
      modeToggleButton.textContent = "2D";
    } else {
      enter2DMode();
      modeToggleButton.textContent = "3D";
    }
  });
}

// --------------------------------------------------
// Controls help popup
// --------------------------------------------------

const controlsHelpButton = document.getElementById("controlsHelpButton");
const controlsModal = document.getElementById("controlsModal");
if (controlsHelpButton && controlsModal) {
  const controlsBackdrop = controlsModal.querySelector(".help-backdrop");
  const controlsClose = controlsModal.querySelector(".help-close");

  const openControlsHelp = () => {
    controlsModal.classList.add("is-open");
    controlsModal.setAttribute("aria-hidden", "false");
  };
  const closeControlsHelp = () => {
    controlsModal.classList.remove("is-open");
    controlsModal.setAttribute("aria-hidden", "true");
  };

  controlsHelpButton.addEventListener("click", openControlsHelp);
  controlsClose.addEventListener("click", closeControlsHelp);
  controlsBackdrop.addEventListener("click", closeControlsHelp);
  window.addEventListener("keydown", event => {
    if (event.key === "Escape" && controlsModal.classList.contains("is-open")) {
      closeControlsHelp();
    }
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
//
// app.xr.isAvailable() reports false on a WebGPU device even with a
// perfectly good headset connected (see the forceWebglForXr comment above -
// XRGPUBinding isn't broadly supported yet, and PlayCanvas's own
// availability check accounts for that). Rather than just hiding the button
// in that case, separately probe the browser's raw, renderer-agnostic
// isSessionSupported() - if that says a session really would work, offer to
// reload with WebGL forced instead of leaving the button silently missing.
// Matches Supersplat's viewer, which hits the same WebGPU/XR gap.
// --------------------------------------------------

const vrButton = document.getElementById("vrButton");
let vrNeedsWebglForXr = false;

if (device.isWebGPU && navigator.xr) {
  navigator.xr.isSessionSupported(XRTYPE_VR).then(supported => {
    vrNeedsWebglForXr = supported;
    updateVrButtonVisibility();
  }).catch(() => {});
}

function updateVrButtonVisibility() {
  if (!vrButton) return;
  const available = !!(app.xr && app.xr.supported && app.xr.isAvailable(XRTYPE_VR));
  vrButton.style.display = available || vrNeedsWebglForXr ? "inline-block" : "none";
  if (!(app.xr && app.xr.active)) {
    vrButton.textContent = available ? "Enter VR" : "Enter VR (needs WebGL)";
  }
}

// Guards against a single click somehow reaching app.xr.start() twice
// (e.g. a duplicate click event) before the first attempt has resolved
// into either an active session or an "error" event - app.xr.active alone
// doesn't cover that window, since it only flips true once the session
// has actually started.
let vrStarting = false;

if (app.xr) {
  app.xr.on(`available:${XRTYPE_VR}`, updateVrButtonVisibility);
  app.xr.on("start", () => {
    vrStarting = false;
    if (vrButton) vrButton.textContent = "Exit VR";
  });
  app.xr.on("end", () => {
    if (vrButton) vrButton.textContent = "Enter VR";
  });
  // Logging only - user-facing alerting for a failed start happens in
  // startVrSession's own callback below, which (unlike this event) knows
  // whether the failure is the expected/retried local-floor case or a
  // genuine dead end. This event also fires for other error sources (e.g.
  // the availability probe above), where alerting would be noise anyway.
  app.xr.on("error", error => console.error("WebXR error:", error));
}
updateVrButtonVisibility();

// "local-floor" (real-world floor as origin) isn't guaranteed by every XR
// runtime - it failed outright on the runtime this was tested against over
// Air Link ("NotSupportedError: The specified session configuration is not
// supported"), even with a headset that otherwise works fine. "local"
// (origin at wherever the headset was when the session started) is the one
// reference space every immersive-vr session must support per spec, so
// retry with that on failure rather than giving up. The practical
// difference barely matters for this app - there's no walkable "floor" in
// an underwater scene, camera height is already fully controlled by our
// own pose/navigation rather than real-world floor calibration.
function startVrSession(spaceType) {
  vrStarting = true;
  app.xr.start(camera.camera, XRTYPE_VR, spaceType, {
    callback: err => {
      if (!err) return; // succeeded - the "start" event above handles the rest
      if (spaceType === XRSPACE_LOCALFLOOR) {
        startVrSession(XRSPACE_LOCAL);
        return;
      }
      vrStarting = false;
      // "already an active, immersive XRSession" here means something
      // else - another tab/page holding a live or stuck session, since
      // immersive sessions are exclusive browser-wide - needs closing.
      alert(`Could not start the VR session: ${err.message || err}`);
    }
  });
}

if (vrButton) {
  vrButton.addEventListener("click", () => {
    if (app.xr.active) {
      app.xr.end();
      return;
    }
    if (vrStarting) return;

    const available = !!(app.xr && app.xr.supported && app.xr.isAvailable(XRTYPE_VR));
    if (!available && vrNeedsWebglForXr) {
      const reload = confirm(
        "VR needs the WebGL renderer - this browser doesn't yet support VR on WebGPU.\n\nReload the viewer with WebGL to enter VR?"
      );
      if (reload) {
        sessionStorage.setItem("reefshape_force_webgl", "1");
        window.location.reload();
      }
      return;
    }

    startVrSession(XRSPACE_LOCALFLOOR);
  });
}

// --------------------------------------------------
// VR controller locomotion
//
// Left thumbstick: fly forward/strafe, relative to wherever the headset is
// actually looking right now (camera.forward/right - the real-time tracked
// direction, not just the rig's yaw, which only changes on a turn) -
// flattened the same way WASD's flatForward is (see updateFlatBasis), so
// glancing down doesn't turn "forward" into "dive".
// Right thumbstick Y: climb/dive along world-up, ignoring head tilt - same
// reasoning as Q/E on desktop (see the `lift` line below in the update
// loop): pushing the stick shouldn't do something different depending on
// which way you happen to be looking.
// Right thumbstick X: turns the rig continuously at VR_TURN_DEGREES_PER_SECOND
// (scaled by how far the stick is pushed).
// All tunable via the constants below.
// --------------------------------------------------

const VR_STICK_DEADZONE = 0.15;
const VR_TURN_DEGREES_PER_SECOND = 90;

let vrLeftInput = null;
let vrRightInput = null;

if (app.xr) {
  app.xr.input.on("add", inputSource => {
    if (inputSource.handedness === "left") {
      vrLeftInput = inputSource;
      // Left trigger: confirms whichever item the left stick has
      // highlighted in the VR timepoint menu (see
      // updateVrMenuNavigationInput) - only meaningful while the menu is
      // open, so this is a no-op otherwise. Kept on the same hand as the
      // stick doing the navigating (and the X button that opens the menu)
      // rather than the right trigger, so one hand does the whole
      // interaction.
      inputSource.on("select", () => {
        if (vrMenuScreen.enabled) {
          selectVrTimepoint(vrMenuItems[vrMenuSelectedIndex].year);
        }
      });
    } else if (inputSource.handedness === "right") {
      vrRightInput = inputSource;
      // Right trigger: recenters on wherever the controller is pointing,
      // the same "fly to and orbit around this point" behavior as a
      // desktop click (see clickToCenter/recenterOn), just aimed with the
      // controller's ray instead of the mouse. "select" fires on a full
      // press-and-release, matching a "point, then commit" click rather
      // than firing the instant the trigger is first touched. Suppressed
      // while the VR menu is open so an incidental right-trigger press
      // doesn't recenter the camera mid-menu-browsing.
      inputSource.on("select", () => {
        if (!vrMenuScreen.enabled) {
          vrTriggerRecenter(inputSource);
        }
      });
    }

    inputSource.on("remove", () => {
      if (vrLeftInput === inputSource) vrLeftInput = null;
      if (vrRightInput === inputSource) vrRightInput = null;
    });
  });

  // Belt-and-suspenders alongside the per-input-source "remove" handling
  // above - guarantees stale references can't survive a session ending.
  app.xr.on("end", () => {
    vrLeftInput = null;
    vrRightInput = null;
    // Snap off immediately rather than fading - there's nothing to fade
    // against once the session (and its stereo rendering) has ended.
    vrVignetteTargetIntensity = 0;
    vrVignetteIntensity = 0;
    if (vrVignetteMaterial) {
      vrVignetteMaterial.opacity = 0;
      vrVignetteMaterial.update();
    }
  });
}

function readVrStick(inputSource) {
  const gamepad = inputSource && inputSource.gamepad;
  const axes = gamepad && gamepad.axes;
  if (!axes || axes.length < 2) return null;

  // The xr-standard gamepad mapping reports the thumbstick at axes[2]/[3]
  // (axes[0]/[1] are the touchpad - always 0 on Quest Touch controllers,
  // which don't have one). Controllers that only ever expose two axes
  // total report the stick at [0]/[1] instead. Returns a fresh object each
  // call (rather than a shared scratch one) - readVrStick is called once
  // per controller per frame and both results are read back together
  // below, so a shared/reused return value would have the second call
  // silently clobber the first's.
  const x = axes.length >= 4 ? axes[2] : axes[0];
  const y = axes.length >= 4 ? axes[3] : axes[1];
  return {
    x: Math.abs(x) > VR_STICK_DEADZONE ? x : 0,
    y: Math.abs(y) > VR_STICK_DEADZONE ? y : 0
  };
}

const vrFlatForward = new Vec3();
const vrFlatRight = new Vec3();
const vrMove = new Vec3();

function updateVrLocomotion(dt) {
  const left = readVrStick(vrLeftInput);
  const right = readVrStick(vrRightInput);

  vrMove.set(0, 0, 0);

  if (left) {
    vrFlatForward.copy(camera.forward);
    vrFlatForward.y = 0;
    if (vrFlatForward.lengthSq() > 1e-8) vrFlatForward.normalize();

    vrFlatRight.copy(camera.right);
    vrFlatRight.y = 0;
    if (vrFlatRight.lengthSq() > 1e-8) vrFlatRight.normalize();

    // Stick Y is negative when pushed forward (away from the thumb).
    vrMove.addScaled(vrFlatRight, left.x).addScaled(vrFlatForward, -left.y);
  }

  if (right) {
    vrMove.y += -right.y;
  }

  const moving = vrMove.lengthSq() > 0;
  if (moving) {
    if (vrMove.lengthSq() > 1) vrMove.normalize(); // combined XZ+Y push shouldn't exceed a single stick's max speed
    vrMove.mulScalar(MOVE_SPEED * dt);
    translateCamera(vrMove, { moveZoomTarget: true, trackHeightChange: true });
  }

  const turning = !!(right && right.x !== 0);
  if (turning) {
    appendOrbitRotate(right.x * VR_TURN_DEGREES_PER_SECOND * dt, 0);
  }

  // Comfort vignette (see updateVrVignette) - on for either kind of
  // stick-driven vection, off the instant the stick centers.
  vrVignetteTargetIntensity = moving || turning ? 1 : 0;
}

// --------------------------------------------------
// VR comfort vignette
//
// Strongly darkens the periphery of the view while the stick is actively
// driving movement or turning, and fades it back out the instant it stops -
// the standard "tunneling" technique VR apps like Google Earth VR use to
// reduce motion sickness from vection (visually perceived self-motion with
// no matching real-world motion, which the peripheral/rod-dominated vision
// is most sensitive to). Implemented as a small quad parented directly to
// `camera` (not cameraRig) just past the near clip plane, rather than
// screen-space UI - a world-space object parented to the camera is
// automatically rendered correctly per-eye by the engine's existing stereo
// rendering with no VR-specific handling needed, which isn't something to
// take for granted for 2D/screen-space UI in an XR session.
// --------------------------------------------------

// Sized in terms of half-angle from the view direction rather than a flat
// world-space size. Two separate problems, two separate fixes:
//
// 1) The quad's own physical extent (VR_VIGNETTE_COVERAGE_ANGLE_DEG) is
//    deliberately much wider than any real headset's per-eye FOV:
//    PlayCanvas's XR rendering drives each eye from the device's own
//    (asymmetric, per-eye) projection matrix rather than the camera
//    component's .fov property, so there's no simple queryable "actual
//    FOV" number to size against here - instead the quad is made wide
//    enough (~85 degrees off-center) to guarantee it reaches past the
//    true edge of view in every direction, corners included (a square
//    quad's diagonal reach is naturally wider than its edge reach, which
//    conveniently mirrors how a headset's diagonal FOV exceeds its
//    horizontal/vertical FOV). A prior version sized the quad by a flat
//    world-space half-size with no angle check, which left a real gap
//    between the quad's edge and the actual edge of view - the periphery
//    out there stayed completely unmasked rather than merely
//    under-darkened.
// 2) Separately, the ring itself needs to reach full opacity well inside
//    that coverage, not right at the edge of the visible frame - an
//    earlier version put the fully-opaque ring at the same angle as a
//    typical display's own edge, so in practice the visible frame was
//    always mid-fade and never read as genuinely black. Pulling both ring
//    angles in close to center (moderate clear cone, opaque well before
//    any real FOV edge) is what actually produces "solid black at the
//    edges, narrow FOV in the middle" rather than a faint all-over tint.
const VR_VIGNETTE_DISTANCE = 0.08;
const VR_VIGNETTE_INNER_ANGLE_DEG = 15; // fully transparent within this angle of view center
const VR_VIGNETTE_OUTER_ANGLE_DEG = 28; // fully opaque black from this angle outward
const VR_VIGNETTE_COVERAGE_ANGLE_DEG = 85; // physical extent of the quad itself
const VR_VIGNETTE_HALF_SIZE = VR_VIGNETTE_DISTANCE * Math.tan((VR_VIGNETTE_COVERAGE_ANGLE_DEG * Math.PI) / 180);
const VR_VIGNETTE_INNER_FRACTION =
  Math.tan((VR_VIGNETTE_INNER_ANGLE_DEG * Math.PI) / 180) / Math.tan((VR_VIGNETTE_COVERAGE_ANGLE_DEG * Math.PI) / 180);
const VR_VIGNETTE_OUTER_FRACTION =
  Math.tan((VR_VIGNETTE_OUTER_ANGLE_DEG * Math.PI) / 180) / Math.tan((VR_VIGNETTE_COVERAGE_ANGLE_DEG * Math.PI) / 180);
const VR_VIGNETTE_FADE_SECONDS = 0.25;

let vrVignetteMaterial = null;
let vrVignetteIntensity = 0; // current, smoothed
let vrVignetteTargetIntensity = 0; // 1 while actively moving/turning via the stick, 0 otherwise
let vrVignetteLayer = null;
let vrVignetteEntity = null;

function createVrVignetteTexture() {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const gradient = ctx.createRadialGradient(
    size / 2,
    size / 2,
    size * VR_VIGNETTE_INNER_FRACTION,
    size / 2,
    size / 2,
    size * VR_VIGNETTE_OUTER_FRACTION
  );
  gradient.addColorStop(0, "rgba(0,0,0,0)");
  gradient.addColorStop(1, "rgba(0,0,0,1)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  return new Texture(app.graphicsDevice, {
    name: "VrVignette",
    width: size,
    height: size,
    format: PIXELFORMAT_RGBA8,
    mipmaps: false,
    minFilter: FILTER_LINEAR,
    magFilter: FILTER_LINEAR,
    addressU: ADDRESS_CLAMP_TO_EDGE,
    addressV: ADDRESS_CLAMP_TO_EDGE,
    levels: [canvas]
  });
}

function setupVrVignette() {
  try {
    vrVignetteMaterial = new StandardMaterial();
    vrVignetteMaterial.diffuse = new Color(0, 0, 0);
    vrVignetteMaterial.useLighting = false;
    vrVignetteMaterial.opacityMap = createVrVignetteTexture();
    vrVignetteMaterial.blendType = BLEND_NORMAL;
    vrVignetteMaterial.depthTest = false;
    vrVignetteMaterial.depthWrite = false;
    // Safety net, not a load-bearing assumption: PlaneGeometry's normal
    // faces its local +Y by default, reoriented below (setLocalEulerAngles)
    // to face back toward the camera - disabling culling entirely means a
    // sign error there still renders instead of silently vanishing.
    vrVignetteMaterial.cull = CULLFACE_NONE;
    vrVignetteMaterial.opacity = 0;
    vrVignetteMaterial.update();

    const geometry = new PlaneGeometry({ halfExtents: new Vec2(VR_VIGNETTE_HALF_SIZE, VR_VIGNETTE_HALF_SIZE) });
    const mesh = Mesh.fromGeometry(app.graphicsDevice, geometry);
    const meshInstance = new MeshInstance(mesh, vrVignetteMaterial);

    // Its own layer, pushed after every existing layer, so it always draws
    // last regardless of submission/sort order within "World" - combined
    // with depthTest:false above, this guarantees it's never occluded by
    // (or occludes) anything else, without needing depth-based sorting.
    const vignetteLayer = new Layer({ name: "VrVignette" });
    vrVignetteLayer = vignetteLayer;
    app.scene.layers.push(vignetteLayer);
    camera.camera.layers = camera.camera.layers.concat([vignetteLayer.id]);

    const vignetteEntity = new Entity("VrVignette");
    vrVignetteEntity = vignetteEntity;
    vignetteEntity.addComponent("render", { meshInstances: [meshInstance] });
    vignetteEntity.setLocalPosition(0, 0, -VR_VIGNETTE_DISTANCE);
    vignetteEntity.setLocalEulerAngles(90, 0, 0);
    // Layers must be set after the entity is parented into the live scene
    // graph, not before - RenderComponent's layers setter silently no-ops
    // (never actually registers the mesh instances with the layer at all)
    // while entity.enabled reads as not-yet-connected, which it is until
    // addChild below runs.
    camera.addChild(vignetteEntity);
    vignetteEntity.render.layers = [vignetteLayer.id];
  } catch (e) {
    console.warn("VR comfort vignette unavailable:", e);
    vrVignetteMaterial = null;
  }
}
setupVrVignette();

// Runs every frame regardless of XR/menu state (unlike updateVrLocomotion,
// which only sets the *target* intensity, and only while actively flying)
// so the fade-out still completes smoothly after the stick centers, the
// menu opens, or the VR session ends.
function updateVrVignette(dt) {
  if (!vrVignetteMaterial) return;
  vrVignetteIntensity += (vrVignetteTargetIntensity - vrVignetteIntensity) * Math.min(1, dt / VR_VIGNETTE_FADE_SECONDS);
  vrVignetteMaterial.opacity = vrVignetteIntensity;
  vrVignetteMaterial.update();
}

// A permanently-existing, never-visibly-rendered camera used solely to turn
// an arbitrary world-space ray (the right controller's pointer) into a
// pick - the Picker can only sample through an actual camera's projection,
// there's no direct "pick along this ray" API, so this camera is aimed
// along the ray and the picker is sampled at its exact center instead.
const rayPickCamera = new Entity("RayPickCamera");
rayPickCamera.addComponent("camera", { enabled: false, fov: 1 });
app.root.addChild(rayPickCamera);
const rayPickTarget = new Vec3();

async function pickWorldPointFromRay(origin, direction) {
  rayPickCamera.setPosition(origin);
  rayPickTarget.copy(origin).add(direction);
  rayPickCamera.lookAt(rayPickTarget);
  // Copied fresh each call rather than once at creation - updateZoomRange
  // adjusts the main camera's clip planes once the splat's real scene
  // radius is known (well after this entity is created), and this should
  // always see the same range the main camera does.
  rayPickCamera.camera.nearClip = camera.camera.nearClip;
  rayPickCamera.camera.farClip = camera.camera.farClip;

  // 3x3 rather than 1x1/2x2 so there's an exact, unambiguous center pixel.
  picker.resize(3, 3);
  picker.prepare(rayPickCamera.camera, app.scene, [app.scene.layers.getLayerByName("World")]);
  return picker.getWorldPointAsync(1, 1);
}

async function vrTriggerRecenter(inputSource) {
  const origin = inputSource.getOrigin();
  const direction = inputSource.getDirection();
  if (!origin || !direction) return;
  recenterOn(await pickWorldPointFromRay(origin, direction));
}

// --------------------------------------------------
// Splat loading + timepoint swapping
//
// Camera state (pose/fov) is never touched by which splat is loaded, so
// swapping timepoints naturally preserves the viewpoint. It's only reset
// (via applyCameraPose/frameSplat) on the very first load.
// --------------------------------------------------

// --------------------------------------------------
// Underwater fog + progressive load reveal effect
//
// Two independent gsplat vertex-shader effects, folded into one merged
// gsplatModifyVS/gsplatModifyPS chunk override on the scene-wide *unified*
// gsplat material (app.scene.gsplat.material - see the "unified: true"
// component option in loadTimepoint) because only one chunk source can
// occupy that slot at a time - they can't be set up independently.
//
// Fog tints each splat's color toward a fog color based on its distance
// from the camera - the classic exponential light-attenuation-through-water
// look, the same technique PlayCanvas's own underwater water script uses
// for lit materials via litUserMainEndPS (engine PR #9029,
// scripts/esm/water.mjs), just applied per-splat instead of per-lit-pixel
// since our scene is 100% gsplat with nothing else to shade.
//
// The reveal effect masks the block-by-block pop-in of a freshly (re)loaded
// splat's initial streamed tiles with a deliberate animated wave instead - a
// wave of tinted dots washes out from wherever the camera is currently
// looking (see startRevealEffect), followed by a lift wave that settles
// each splat into its real shape/color - rather than splats just appearing
// wherever their LOD tile happens to finish downloading, or the wave
// emanating from a model-center point that might not even be on screen.
// Ported from PlayCanvas's own GSplatRevealRadial script
// (playcanvas/scripts/esm/gsplat/reveal-radial.mjs, see the
// gaussian-splatting/lod-streaming example) rather than used directly,
// since that script's base class manages the gsplatModifyVS/gsplatModifyPS
// chunks by unconditionally overwriting them - fine on its own, but
// incompatible with also having fog in the same slot.
// --------------------------------------------------

// Same literal values as the camera's clearColor above - keep them in sync
// so fully-fogged splats fade into the background instead of a visible seam.
const FOG_COLOR = [0.035, 0.22, 0.28];
const FOG_DENSITY = 0.035;
const camPos = new Vec3();
let fogSupported = false;

// Additive tint colors for the reveal wave - components above 1 are
// intentional (additive blending), producing a brighter flash than a plain
// color could.
const REVEAL_DOT_TINT = [0.3, 0.8, 1.0];
const REVEAL_WAVE_TINT = [1.5, 1.8, 2.0];
// Total time from load to fully revealed, independent of scene scale (see
// startRevealEffect, which derives speed/endRadius from sceneRadius so a
// tiny reef and a huge one both take about this long).
const REVEAL_DURATION_SECONDS = 3.2;
const REVEAL_DELAY_SECONDS = 0.3; // gap between the dot wave and the lift wave starting

const revealCenter = new Vec3();
let revealActive = false;
let revealStartTime = 0;
let revealSpeed = 0;
let revealEndRadius = 0;
let revealBandWidth = 0;
let revealOscillation = 0;

function setupGsplatShaderEffects() {
  try {
    const gsplatMat = app.scene.gsplat.material;

    gsplatMat.getShaderChunks("glsl").set(
      "gsplatModifyVS",
      `
        uniform vec3 uCamPos;
        uniform vec3 uFogColor;
        uniform float uFogDensity;

        uniform float uTime;
        uniform vec3 uRevealCenter;
        uniform float uRevealSpeed;
        uniform float uRevealDelay;
        uniform vec3 uRevealDotTint;
        uniform vec3 uRevealWaveTint;
        uniform float uRevealOscillation;
        uniform float uRevealEndRadius;
        uniform float uRevealBandWidth;

        float g_revealDist;
        float g_revealDotWavePos;
        float g_revealLiftTime;
        float g_revealLiftWavePos;

        float revealHash(vec3 p) {
          return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
        }

        // uRevealEndRadius < 0 means "inactive" (see startRevealEffect) -
        // every function below is a guaranteed no-op in that state, since
        // g_revealDist (always >= 0) can never be within a negative radius.
        void modifySplatCenter(inout vec3 center) {
          g_revealDist = length(center - uRevealCenter);
          if (g_revealDist > uRevealEndRadius) return;

          g_revealDotWavePos = uRevealSpeed * uTime;
          g_revealLiftTime = max(0.0, uTime - uRevealDelay);
          g_revealLiftWavePos = uRevealSpeed * g_revealLiftTime;

          bool wavesActive = g_revealLiftTime <= 0.0 || g_revealDist > g_revealLiftWavePos - 1.5 * uRevealBandWidth;
          if (wavesActive) {
            float phase = revealHash(center) * 6.28318;
            center.y += sin(uTime * 3.0 + phase) * uRevealOscillation * 0.25;
          }

          float distToLiftWave = abs(g_revealDist - g_revealLiftWavePos);
          if (distToLiftWave < uRevealBandWidth && g_revealLiftTime > 0.0) {
            float normalizedDist = distToLiftWave / uRevealBandWidth;
            float liftAmount = (1.0 - normalizedDist) * sin(normalizedDist * 3.14159);
            center.y += liftAmount * uRevealOscillation * 0.9;
          }
        }

        void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
          if (g_revealDist > uRevealEndRadius) {
            // Only while actively revealing (endRadius >= 0) does "beyond
            // the wave" mean "not shown yet" - while inactive this must
            // stay a no-op, not hide the whole model.
            if (uRevealEndRadius >= 0.0) scale = vec3(0.0);
            return;
          }

          vec3 origScale = scale;
          float origSize = gsplatGetSizeFromScale(scale);

          float scaleFactor;
          bool isLiftWave = g_revealLiftTime > 0.0 && g_revealLiftWavePos > g_revealDist;

          if (isLiftWave) {
            scaleFactor = (g_revealLiftWavePos >= g_revealDist + 2.0) ? 1.0 : mix(0.1, 1.0, (g_revealLiftWavePos - g_revealDist) * 0.5);
          } else if (g_revealDist > g_revealDotWavePos + 1.0) {
            scale = vec3(0.0);
            return;
          } else if (g_revealDist > g_revealDotWavePos - 1.0) {
            float distToWave = abs(g_revealDist - g_revealDotWavePos);
            scaleFactor = (distToWave < 0.5)
              ? mix(0.1, 0.2, 1.0 - distToWave * 2.0)
              : mix(0.0, 0.1, smoothstep(g_revealDotWavePos + 1.0, g_revealDotWavePos - 1.0, g_revealDist));
          } else {
            scaleFactor = 0.1;
          }

          if (scaleFactor >= 1.0) {
            return;
          } else if (isLiftWave) {
            float t = (scaleFactor - 0.1) * 1.111111;
            float dotSize = scaleFactor * 0.05;
            float finalSize = mix(dotSize, origSize, t);
            vec3 sphericalScale = vec3(finalSize);
            vec3 scaledOrig = origScale * scaleFactor;
            scale = mix(sphericalScale, scaledOrig, t);
          } else {
            float targetSize = min(scaleFactor * 0.05, origSize);
            gsplatMakeSpherical(scale, targetSize);
          }
        }

        void modifySplatColor(vec3 center, inout vec4 color) {
          if (g_revealDist <= uRevealEndRadius) {
            if (g_revealLiftTime > 0.0 && g_revealDist >= g_revealLiftWavePos - 1.5 * uRevealBandWidth && g_revealDist <= g_revealLiftWavePos + 0.5 * uRevealBandWidth) {
              float distToLift = abs(g_revealDist - g_revealLiftWavePos);
              float liftIntensity = smoothstep(1.5 * uRevealBandWidth, 0.0, distToLift);
              color.rgb += uRevealWaveTint * liftIntensity;
            } else if (g_revealDist <= g_revealDotWavePos && (g_revealLiftTime <= 0.0 || g_revealDist > g_revealLiftWavePos + 0.5 * uRevealBandWidth)) {
              float distToDot = abs(g_revealDist - g_revealDotWavePos);
              float dotIntensity = smoothstep(uRevealBandWidth, 0.0, distToDot);
              color.rgb += uRevealDotTint * dotIntensity;
            }
          }

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

        uniform uTime : f32;
        uniform uRevealCenter : vec3f;
        uniform uRevealSpeed : f32;
        uniform uRevealDelay : f32;
        uniform uRevealDotTint : vec3f;
        uniform uRevealWaveTint : vec3f;
        uniform uRevealOscillation : f32;
        uniform uRevealEndRadius : f32;
        uniform uRevealBandWidth : f32;

        var<private> g_revealDist: f32;
        var<private> g_revealDotWavePos: f32;
        var<private> g_revealLiftTime: f32;
        var<private> g_revealLiftWavePos: f32;

        fn revealHash(p: vec3f) -> f32 {
          return fract(sin(dot(p, vec3f(127.1, 311.7, 74.7))) * 43758.5453);
        }

        // uRevealEndRadius < 0 means "inactive" (see startRevealEffect) -
        // every function below is a guaranteed no-op in that state, since
        // g_revealDist (always >= 0) can never be within a negative radius.
        fn modifySplatCenter(center: ptr<function, vec3f>) {
          g_revealDist = length(*center - uniform.uRevealCenter);
          if (g_revealDist > uniform.uRevealEndRadius) {
            return;
          }

          g_revealDotWavePos = uniform.uRevealSpeed * uniform.uTime;
          g_revealLiftTime = max(0.0, uniform.uTime - uniform.uRevealDelay);
          g_revealLiftWavePos = uniform.uRevealSpeed * g_revealLiftTime;

          let wavesActive = g_revealLiftTime <= 0.0 || g_revealDist > g_revealLiftWavePos - 1.5 * uniform.uRevealBandWidth;
          if (wavesActive) {
            let phase = revealHash(*center) * 6.28318;
            (*center).y += sin(uniform.uTime * 3.0 + phase) * uniform.uRevealOscillation * 0.25;
          }

          let distToLiftWave = abs(g_revealDist - g_revealLiftWavePos);
          if (distToLiftWave < uniform.uRevealBandWidth && g_revealLiftTime > 0.0) {
            let normalizedDist = distToLiftWave / uniform.uRevealBandWidth;
            let liftAmount = (1.0 - normalizedDist) * sin(normalizedDist * 3.14159);
            (*center).y += liftAmount * uniform.uRevealOscillation * 0.9;
          }
        }

        fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
          if (g_revealDist > uniform.uRevealEndRadius) {
            // Only while actively revealing (endRadius >= 0) does "beyond
            // the wave" mean "not shown yet" - while inactive this must
            // stay a no-op, not hide the whole model.
            if (uniform.uRevealEndRadius >= 0.0) {
              *scale = vec3f(0.0);
            }
            return;
          }

          let origScale = *scale;
          let origSize = gsplatGetSizeFromScale(*scale);

          var scaleFactor: f32;
          let isLiftWave = g_revealLiftTime > 0.0 && g_revealLiftWavePos > g_revealDist;

          if (isLiftWave) {
            scaleFactor = select(
              mix(0.1, 1.0, (g_revealLiftWavePos - g_revealDist) * 0.5),
              1.0,
              g_revealLiftWavePos >= g_revealDist + 2.0
            );
          } else if (g_revealDist > g_revealDotWavePos + 1.0) {
            *scale = vec3f(0.0);
            return;
          } else if (g_revealDist > g_revealDotWavePos - 1.0) {
            let distToWave = abs(g_revealDist - g_revealDotWavePos);
            scaleFactor = select(
              mix(0.0, 0.1, smoothstep(g_revealDotWavePos + 1.0, g_revealDotWavePos - 1.0, g_revealDist)),
              mix(0.1, 0.2, 1.0 - distToWave * 2.0),
              distToWave < 0.5
            );
          } else {
            scaleFactor = 0.1;
          }

          if (scaleFactor >= 1.0) {
            return;
          } else if (isLiftWave) {
            let t = (scaleFactor - 0.1) * 1.111111;
            let dotSize = scaleFactor * 0.05;
            let finalSize = mix(dotSize, origSize, t);
            let sphericalScale = vec3f(finalSize);
            let scaledOrig = origScale * scaleFactor;
            *scale = mix(sphericalScale, scaledOrig, t);
          } else {
            let targetSize = min(scaleFactor * 0.05, origSize);
            gsplatMakeSpherical(scale, targetSize);
          }
        }

        fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
          if (g_revealDist <= uniform.uRevealEndRadius) {
            if (g_revealLiftTime > 0.0 && g_revealDist >= g_revealLiftWavePos - 1.5 * uniform.uRevealBandWidth && g_revealDist <= g_revealLiftWavePos + 0.5 * uniform.uRevealBandWidth) {
              let distToLift = abs(g_revealDist - g_revealLiftWavePos);
              let liftIntensity = smoothstep(1.5 * uniform.uRevealBandWidth, 0.0, distToLift);
              (*color) = vec4f((*color).rgb + uniform.uRevealWaveTint * liftIntensity, (*color).a);
            } else if (g_revealDist <= g_revealDotWavePos && (g_revealLiftTime <= 0.0 || g_revealDist > g_revealLiftWavePos + 0.5 * uniform.uRevealBandWidth)) {
              let distToDot = abs(g_revealDist - g_revealDotWavePos);
              let dotIntensity = smoothstep(uniform.uRevealBandWidth, 0.0, distToDot);
              (*color) = vec4f((*color).rgb + uniform.uRevealDotTint * dotIntensity, (*color).a);
            }
          }

          let dist: f32 = length(center - uniform.uCamPos);
          let fogFactor: f32 = clamp(exp(-uniform.uFogDensity * dist), 0.0, 1.0);
          (*color) = vec4f(mix(uniform.uFogColor, (*color).rgb, fogFactor), (*color).a);
        }
      `
    );

    gsplatMat.setParameter("uFogColor", FOG_COLOR);
    gsplatMat.setParameter("uFogDensity", FOG_DENSITY);
    gsplatMat.setParameter("uRevealEndRadius", -1);
    gsplatMat.setParameter("uRevealCenter", [0, 0, 0]);
    gsplatMat.setParameter("uTime", 0);
    gsplatMat.setParameter("uRevealSpeed", 1);
    gsplatMat.setParameter("uRevealDelay", 0);
    gsplatMat.setParameter("uRevealDotTint", REVEAL_DOT_TINT);
    gsplatMat.setParameter("uRevealWaveTint", REVEAL_WAVE_TINT);
    gsplatMat.setParameter("uRevealOscillation", 0);
    gsplatMat.setParameter("uRevealBandWidth", 1);
    gsplatMat.update();

    fogSupported = true;
  } catch (e) {
    console.warn("Underwater fog / reveal effect unavailable:", e);
  }
}

// Starts (or restarts) the reveal wave from wherever the camera is
// currently looking (pose.getFocus() - the exact point at screen center
// right now) rather than the splat's own geometric center, which could be
// far outside the current view entirely on a large reef - the wave should
// wash out from what the user is actually looking at, not from a point
// that might not even be on screen. endRadius/speed/band width/oscillation
// are all derived from sceneRadius so the effect looks proportionally
// similar (and takes about REVEAL_DURATION_SECONDS either way) whether the
// reef spans 2 units or 60.
function startRevealEffect(radius) {
  if (!fogSupported) return; // shares the fog chunk - no chunk, no reveal

  pose.getFocus(revealCenter);

  revealEndRadius = Math.max(radius, MIN_SCENE_RADIUS) * 1.15;
  revealSpeed = revealEndRadius / (REVEAL_DURATION_SECONDS - REVEAL_DELAY_SECONDS);
  revealBandWidth = Math.max(revealEndRadius * 0.05, 0.05);
  revealOscillation = revealEndRadius * 0.01;
  revealStartTime = performance.now();
  revealActive = true;
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
    const isFirstLoad = !hasLoadedOnce;

    currentSplatEntity = splat;
    currentSplatAsset = asset;

    const resource = asset.resource;
    const aabb = resource?.aabb;
    if (aabb) {
      sceneRadius = Math.max(aabb.halfExtents.length(), MIN_SCENE_RADIUS);
      updateZoomRange();
    }

    if (isFirstLoad) {
      hasLoadedOnce = true;
      setupGsplatShaderEffects();
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

    // Pin to the coarsest LOD level for a fast initial paint, then release
    // it once frame:ready reports that level has actually finished
    // streaming (a real signal, not a guess - see PlayCanvas's own
    // gaussian-splatting/lod-streaming example). The reveal effect below
    // covers up whatever pop-in still happens on top of that.
    const gsplatComponent = splat.gsplat;
    const lodLevels = resource?.octree?.lodLevels;
    if (gsplatComponent && lodLevels) {
      const worstLod = lodLevels - 1;
      gsplatComponent.lodRangeMin = worstLod;
      gsplatComponent.lodRangeMax = worstLod;

      const onFrameReady = (cam, layer, ready, loadingCount) => {
        if (cam === camera.camera && ready && !loadingCount) {
          app.systems.gsplat.off("frame:ready", onFrameReady);
          // Only release the pin if this load hasn't already been
          // superseded by a later timepoint swap.
          if (currentSplatEntity === splat) {
            gsplatComponent.lodRangeMin = 0;
            gsplatComponent.lodRangeMax = lodLevels - 1;
          }
        }
      };
      app.systems.gsplat.on("frame:ready", onFrameReady);
    }

    startRevealEffect(sceneRadius);
    hideLoader();
  });

  app.assets.add(asset);
  app.assets.load(asset);
}

select.addEventListener("change", () => {
  loadTimepoint(splats[select.value]);
});

loadTimepoint(splats[years[0]]);

// --------------------------------------------------
// VR timepoint menu
//
// Desktop has the <select> dropdown for this, but that's ordinary HTML and
// isn't visible at all once an immersive XR session takes over the display
// - so VR gets its own equivalent: a small world-space UI panel (Screen +
// Element components, not a DOM overlay - see the elementInput/component
// systems setup above) that the left controller's X button toggles,
// spawned in front of wherever the headset is currently looking. Selecting
// an entry calls the exact same loadTimepoint() the desktop dropdown does,
// so it keeps the current viewpoint fixed and just swaps the splat asset,
// identically to non-VR mode (see loadTimepoint's hasLoadedOnce check).
// --------------------------------------------------

const VR_MENU_ITEM_WIDTH = 340;
const VR_MENU_ITEM_HEIGHT = 70;
const VR_MENU_ITEM_GAP = 10;
const VR_MENU_DISTANCE = 1.2; // meters in front of the headset when opened
const VR_MENU_SCALE = 0.0018; // world meters per UI unit (world-space Screen)

const vrMenuFont = new CanvasFont(app, {
  fontName: "Arial",
  fontSize: 64,
  color: new Color(1, 1, 1),
  width: 512,
  height: 128
});
vrMenuFont.createTextures(years.join(""));

const vrMenuScreen = new Entity("VrMenuScreen");
vrMenuScreen.addComponent("screen", { screenSpace: false, referenceResolution: new Vec2(400, 400) });
vrMenuScreen.setLocalScale(VR_MENU_SCALE, VR_MENU_SCALE, VR_MENU_SCALE);
vrMenuScreen.enabled = false;
app.root.addChild(vrMenuScreen);

const VR_MENU_HIGHLIGHT_COLOR = new Color(0.4, 1, 0.5);
const VR_MENU_DEFAULT_COLOR = new Color(1, 1, 1);

const vrMenuItems = years.map((year, i) => {
  const item = new Entity(`VrMenuItem_${year}`);
  item.addComponent("element", {
    type: ELEMENTTYPE_TEXT,
    text: year,
    font: vrMenuFont,
    fontSize: 48,
    color: VR_MENU_DEFAULT_COLOR,
    width: VR_MENU_ITEM_WIDTH,
    height: VR_MENU_ITEM_HEIGHT,
    autoWidth: false,
    autoHeight: false,
    pivot: [0.5, 0.5],
    anchor: [0.5, 0.5, 0.5, 0.5],
    alignment: [0.5, 0.5],
    useInput: true
  });
  const offsetFromCenter = (years.length - 1) / 2 - i;
  item.setLocalPosition(0, offsetFromCenter * (VR_MENU_ITEM_HEIGHT + VR_MENU_ITEM_GAP), 0);
  // Ray+trigger click via ElementInput's native XR support - left wired in
  // case it works on some setups, but unreliable in practice (same class of
  // issue as the right-trigger recenter ray-pick), so it's a bonus path,
  // not the supported one - see updateVrMenuNavigationInput below for that.
  item.element.on("click", () => selectVrTimepoint(year));
  vrMenuScreen.addChild(item);
  return { year, entity: item };
});

// Cursor-based selection: left stick up/down moves this between items,
// right trigger confirms - the supported way to use the menu, since
// pointing a ray at a specific Element and clicking it turned out to be
// unreliable (see the comment on the "click" listener above).
let vrMenuSelectedIndex = 0;

function updateVrMenuHighlight() {
  vrMenuItems.forEach(({ entity }, i) => {
    entity.element.color = i === vrMenuSelectedIndex ? VR_MENU_HIGHLIGHT_COLOR : VR_MENU_DEFAULT_COLOR;
  });
}

function moveVrMenuSelection(delta) {
  vrMenuSelectedIndex = (vrMenuSelectedIndex + delta + vrMenuItems.length) % vrMenuItems.length;
  updateVrMenuHighlight();
}

function selectVrTimepoint(year) {
  // Reselecting the already-loaded timepoint isn't a no-op the way it is
  // for the desktop <select> (whose "change" event never fires unless the
  // value actually changes) - loadTimepoint always creates a fresh Asset
  // and tears down the previous one, and doing that to itself leaves the
  // splat blank. Guard against it explicitly.
  if (year !== select.value) {
    select.value = year; // keep the desktop dropdown in sync
    loadTimepoint(splats[year]);
  }
  vrMenuScreen.enabled = false;
  updateVrMenuHighlight();
}

const vrMenuPosition = new Vec3();
const vrMenuLookTarget = new Vec3();

function openVrMenu() {
  vrMenuPosition.copy(camera.getPosition()).addScaled(camera.forward, VR_MENU_DISTANCE);
  vrMenuScreen.setPosition(vrMenuPosition);
  vrMenuLookTarget.copy(camera.getPosition());
  vrMenuScreen.lookAt(vrMenuLookTarget);
  // World-space UI renders on an Element's local +Z face, the opposite of
  // the usual "-Z is forward" convention lookAt orients toward its target -
  // without this the panel would face away from whoever it was just aimed
  // at.
  vrMenuScreen.rotateLocal(0, 180, 0);
  // Start the cursor on whichever timepoint is currently loaded.
  const currentIndex = years.indexOf(select.value);
  vrMenuSelectedIndex = currentIndex === -1 ? 0 : currentIndex;
  updateVrMenuHighlight();
  vrMenuScreen.enabled = true;
}

function toggleVrMenu() {
  if (vrMenuScreen.enabled) {
    vrMenuScreen.enabled = false;
  } else {
    openVrMenu();
  }
}

let vrMenuButtonWasPressed = false;
function updateVrMenuToggleInput() {
  const gamepad = vrLeftInput && vrLeftInput.gamepad;
  const buttons = gamepad && gamepad.buttons;
  // Button 4 is the left controller's X button under the xr-standard
  // gamepad mapping (0 trigger, 1 grip, 3 thumbstick click, 4 X, 5 Y) -
  // edge-detected so a held button only toggles once, not every frame.
  const pressed = !!(buttons && buttons[4] && buttons[4].pressed);
  if (pressed && !vrMenuButtonWasPressed) {
    toggleVrMenu();
  }
  vrMenuButtonWasPressed = pressed;
}

// While the menu is open, the left stick moves the highlighted item instead
// of flying (see the update loop, which calls this in place of
// updateVrLocomotion whenever vrMenuScreen.enabled) - one step per push,
// re-armed once the stick returns near center, same debounce idea as the
// old snap-turn. Pressing the stick itself also confirms the highlighted
// item, as an alternative to the left trigger - handy since the thumb is
// already on the stick while navigating.
let vrMenuStickArmed = true;
let vrMenuStickClickWasPressed = false;
function updateVrMenuNavigationInput() {
  const left = readVrStick(vrLeftInput);
  if (left) {
    if (Math.abs(left.y) > 0.6) {
      if (vrMenuStickArmed) {
        // Stick "up" (forward, away from the thumb) is negative y - move to
        // the previous (higher, per how items are laid out) item.
        moveVrMenuSelection(left.y < 0 ? -1 : 1);
        vrMenuStickArmed = false;
      }
    } else if (Math.abs(left.y) < 0.3) {
      vrMenuStickArmed = true;
    }
  }

  // Button 3 is the left controller's thumbstick click under the
  // xr-standard gamepad mapping (see updateVrMenuToggleInput for the rest
  // of the mapping).
  const gamepad = vrLeftInput && vrLeftInput.gamepad;
  const buttons = gamepad && gamepad.buttons;
  const stickClickPressed = !!(buttons && buttons[3] && buttons[3].pressed);
  if (stickClickPressed && !vrMenuStickClickWasPressed) {
    selectVrTimepoint(vrMenuItems[vrMenuSelectedIndex].year);
  }
  vrMenuStickClickWasPressed = stickClickPressed;
}

if (app.xr) {
  app.xr.on("end", () => {
    vrMenuScreen.enabled = false;
    vrMenuButtonWasPressed = false;
    vrMenuStickArmed = true;
    vrMenuStickClickWasPressed = false;
  });
}

window.__debug = {
  getYaw: () => pose.angles.y,
  getPitch: () => -pose.angles.x,
  getDistance: () => pose.distance,
  getViewDistance: () => viewDistance,
  getTarget: () => pose.getFocus(new Vec3()),
  getCameraPosition: () => pose.position.clone(),
  isSolidAtWorld: (x, y, z) => (voxelOctree ? isSolidAt(new Vec3(x, y, z)) : null),
  is2DMode: () => is2DMode,
  getOrthoHeight: () => orthoHeight,
  getProjection: () => camera.camera && camera.camera.projection,
  isRecentering: () => !!recenterAnim,
  getXrStatus: () => ({
    supported: !!(app.xr && app.xr.supported),
    available: !!(app.xr && app.xr.isAvailable(XRTYPE_VR)),
    active: !!(app.xr && app.xr.active),
    controllers: { left: !!vrLeftInput, right: !!vrRightInput }
  }),
  vrMenu: {
    open: () => openVrMenu(),
    close: () => { vrMenuScreen.enabled = false; },
    select: year => selectVrTimepoint(year),
    isOpen: () => vrMenuScreen.enabled,
    getItems: () => vrMenuItems.map(({ year, entity }) => ({
      year,
      position: entity.getPosition().clone(),
      color: entity.element.color.clone()
    })),
    getScreenTransform: () => ({
      position: vrMenuScreen.getPosition().clone(),
      forward: vrMenuScreen.forward.clone()
    }),
    getSelectedIndex: () => vrMenuSelectedIndex,
    moveSelection: delta => moveVrMenuSelection(delta),
    confirmSelection: () => selectVrTimepoint(vrMenuItems[vrMenuSelectedIndex].year)
  },
  vrVignette: {
    // Forces the intensity directly (bypassing the fade and the "only
    // while actively flying in VR" gating) purely so the quad/gradient/
    // orientation can be checked outside an actual XR session.
    forceIntensity: value => {
      if (!vrVignetteMaterial) return false;
      vrVignetteIntensity = value;
      vrVignetteTargetIntensity = value;
      vrVignetteMaterial.opacity = value;
      vrVignetteMaterial.update();
      return true;
    },
    getIntensity: () => vrVignetteIntensity,
    debugInfo: () => ({
      cameraLayers: camera.camera.layers.slice(),
      vignetteLayerId: vrVignetteLayer && vrVignetteLayer.id,
      layerMeshInstanceCount: vrVignetteLayer && vrVignetteLayer.meshInstances.length,
      entityEnabled: vrVignetteEntity && vrVignetteEntity.enabled,
      renderEnabled: vrVignetteEntity && vrVignetteEntity.render && vrVignetteEntity.render.enabled,
      renderLayers: vrVignetteEntity && vrVignetteEntity.render && vrVignetteEntity.render.layers.slice(),
      localPosition: vrVignetteEntity && vrVignetteEntity.getLocalPosition().clone(),
      worldPosition: vrVignetteEntity && vrVignetteEntity.getPosition().clone(),
      opacity: vrVignetteMaterial && vrVignetteMaterial.opacity,
      blendType: vrVignetteMaterial && vrVignetteMaterial.blendType
    })
  }
};

app.on("update", () => {
  if (!fogSupported) return;
  try {
    const gsplatMat = app.scene.gsplat.material;

    camPos.copy(cameraRig.getPosition());
    gsplatMat.setParameter("uCamPos", [camPos.x, camPos.y, camPos.z]);

    if (revealActive) {
      const effectTime = (performance.now() - revealStartTime) / 1000;
      const completionTime = REVEAL_DELAY_SECONDS + revealEndRadius / revealSpeed;
      if (effectTime >= completionTime) {
        // Switch back off rather than leaving it frozen at its final
        // state - see the "uRevealEndRadius < 0 means inactive" comment in
        // setupGsplatShaderEffects.
        revealActive = false;
        gsplatMat.setParameter("uRevealEndRadius", -1);
      } else {
        gsplatMat.setParameter("uTime", effectTime);
        gsplatMat.setParameter("uRevealCenter", [revealCenter.x, revealCenter.y, revealCenter.z]);
        gsplatMat.setParameter("uRevealSpeed", revealSpeed);
        gsplatMat.setParameter("uRevealDelay", REVEAL_DELAY_SECONDS);
        gsplatMat.setParameter("uRevealDotTint", REVEAL_DOT_TINT);
        gsplatMat.setParameter("uRevealWaveTint", REVEAL_WAVE_TINT);
        gsplatMat.setParameter("uRevealOscillation", revealOscillation);
        gsplatMat.setParameter("uRevealEndRadius", revealEndRadius);
        gsplatMat.setParameter("uRevealBandWidth", revealBandWidth);
      }
    }

    gsplatMat.update();
  } catch (e) {
    console.warn("Underwater fog / reveal effect update failed:", e);
    fogSupported = false;
  }
});
