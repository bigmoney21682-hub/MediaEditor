import { FilesetResolver, FaceLandmarker } from '@mediapipe/tasks-vision';

/**
 * MediaPipe Face Landmarker wrapper: 478 landmarks per face, all on-device.
 * The wasm runtime and the .task model are served from /public, so once cached
 * the whole thing works offline.
 */

let landmarkerPromise = null;
export let loadFailed = null;

const url = (p) => new URL(p, document.baseURI).href;

export function loadLandmarker() {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const fileset = await FilesetResolver.forVisionTasks(url('mediapipe/wasm'));
      const opts = (delegate) => ({
        baseOptions: { modelAssetPath: url('models/face_landmarker.task'), delegate },
        runningMode: 'IMAGE',
        numFaces: 8
      });
      try {
        return await FaceLandmarker.createFromOptions(fileset, opts('GPU'));
      } catch {
        return await FaceLandmarker.createFromOptions(fileset, opts('CPU'));
      }
    })().catch((e) => {
      loadFailed = e;
      landmarkerPromise = null;      // allow a later retry
      throw e;
    });
  }
  return landmarkerPromise;
}

/** Detect faces in a canvas. Returns [{ pts:[{x,y}], box:{x,y,w,h} }, ...] in pixels. */
export async function detectFaces(canvas) {
  const lm = await loadLandmarker();
  const res = lm.detect(canvas);
  const faces = [];
  for (const set of res.faceLandmarks || []) {
    const pts = set.map((p) => ({ x: p.x * canvas.width, y: p.y * canvas.height, z: p.z }));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const i of FACE_OVAL) {
      const p = pts[i];
      if (p.x < x0) x0 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.x > x1) x1 = p.x;
      if (p.y > y1) y1 = p.y;
    }
    faces.push({ pts, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } });
  }
  return faces;
}

/* ------------------------------------------------- canonical index groups */

export const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378,
  400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109
];
export const JAW = [172, 136, 150, 149, 176, 148, 152, 377, 400, 378, 379, 365, 397, 288, 361];
export const LEFT_EYE = [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398];
export const RIGHT_EYE = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
export const LEFT_BROW = [336, 296, 334, 293, 300, 285, 295, 282, 283, 276];
export const RIGHT_BROW = [107, 66, 105, 63, 70, 55, 65, 52, 53, 46];
export const LIPS_OUTER = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];
export const LIPS_INNER = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191];
export const NOSE_BRIDGE = [168, 6, 197, 195, 5, 4, 1];

export const IDX = {
  chin: 152,
  foreheadTop: 10,
  noseTip: 1,
  noseBase: 2,
  noseLeftWing: 358,
  noseRightWing: 129,
  mouthLeft: 291,
  mouthRight: 61,
  mouthTop: 0,
  mouthBottom: 17,
  eyeOuterL: 263,
  eyeOuterR: 33,
  eyeInnerL: 362,
  eyeInnerR: 133,
  eyeUnderL: 374,
  eyeUnderR: 145,
  cheekL: 425,
  cheekR: 205,
  jawLeft: 361,
  jawRight: 132,
  templeL: 454,
  templeR: 234,
  browCenterL: 336,
  browCenterR: 107,
  glabella: 168
};

/** Rough face scale in pixels — used to keep effects resolution-independent. */
export function faceScale(pts) {
  const a = pts[IDX.templeR], b = pts[IDX.templeL];
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Roll angle of the face, from the eye-corner axis. */
export function faceAngle(pts) {
  const a = pts[IDX.eyeOuterR], b = pts[IDX.eyeOuterL];
  return Math.atan2(b.y - a.y, b.x - a.x);
}

export const groupPoints = (pts, idx) => idx.map((i) => pts[i]);
