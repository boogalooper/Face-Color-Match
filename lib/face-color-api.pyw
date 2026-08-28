# -*- coding: utf-8 -*-
"""Face Color Match local API for Adobe Photoshop.

Single-file Python server. It deliberately uses the system Python installation.
Supported runtime targets: CPython 3.11 and 3.14 on Windows.
"""
from __future__ import annotations

import json
import math
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import uuid
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

APP_NAME = "Face Color Match"
VERSION = "0.1.7"
API_PROTOCOL = 1
API_HOST = "127.0.0.1"
API_RECEIVE_PORT = 42971
API_REPLY_PORT = 42972
IDLE_TIMEOUT_SECONDS = 30 * 60
MAX_MESSAGE_BYTES = 8 * 1024 * 1024
SUPPORTED_PYTHON = {(3, 11), (3, 14)}

SCRIPT_FILE = Path(__file__).resolve()
SCRIPT_DIR = SCRIPT_FILE.parent
MODEL_DIR = SCRIPT_DIR / "models"
YUNET_MODEL = MODEL_DIR / "face_detection_yunet_2023mar.onnx"
TEMP_DIR = Path(tempfile.gettempdir())
STARTUP_STATUS_FILE = TEMP_DIR / "face-color-match-startup.json"
LAUNCH_CONFIG_FILE = TEMP_DIR / "face-color-match-launch.json"
LOG_FILE = TEMP_DIR / "face-color-match.log"

_LAST_ACTIVITY = time.monotonic()
_ACTIVITY_LOCK = threading.Lock()
_STOP = threading.Event()
_REPLY_LOCK = threading.Lock()


def _write_log(message: str) -> None:
    try:
        stamp = time.strftime("%Y-%m-%d %H:%M:%S")
        with LOG_FILE.open("a", encoding="utf-8") as stream:
            stream.write(f"[{stamp}] {message}\n")
    except Exception:
        pass


def log_exception(prefix: str) -> None:
    _write_log(prefix + "\n" + traceback.format_exc())


def atomic_json_write(path: Path, data: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(str(tmp), str(path))


def write_startup_status(status: str, message: str = "", **extra: Any) -> None:
    payload: Dict[str, Any] = {
        "status": status,
        "message": message,
        "version": VERSION,
        "protocol": API_PROTOCOL,
        "python": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
        "log_file": str(LOG_FILE),
        "time": time.time(),
    }
    payload.update(extra)
    try:
        atomic_json_write(STARTUP_STATUS_FILE, payload)
    except Exception:
        pass


def touch_activity() -> None:
    global _LAST_ACTIVITY
    with _ACTIVITY_LOCK:
        _LAST_ACTIVITY = time.monotonic()


def _load_launch_config() -> Dict[str, Any]:
    try:
        data = json.loads(LAUNCH_CONFIG_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _launcher_executable() -> Optional[str]:
    if os.name != "nt":
        return None
    candidates = [
        Path(os.environ.get("WINDIR", r"C:\Windows")) / "pyw.exe",
        Path(os.environ.get("WINDIR", r"C:\Windows")) / "py.exe",
    ]
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    return "pyw.exe"


def _probe_requested_python(version: str, require_modules: bool = False) -> bool:
    if os.name != "nt":
        return False
    launcher = str(Path(os.environ.get("WINDIR", r"C:\Windows")) / "py.exe")
    code = "import sys; assert sys.version_info[:2] == tuple(map(int, '" + version + "'.split('.')))"
    if require_modules:
        code += "; import cv2,numpy"
    try:
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        result = subprocess.run(
            [launcher, f"-{version}", "-c", code],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=12,
            creationflags=creationflags,
        )
        return result.returncode == 0
    except Exception:
        return False


def _spawn_requested_python(version: str) -> bool:
    launcher = _launcher_executable()
    if not launcher:
        return False
    flag = f"-{version}"
    try:
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        subprocess.Popen(
            [launcher, flag, str(SCRIPT_FILE)],
            cwd=str(SCRIPT_DIR),
            close_fds=True,
            creationflags=creationflags,
        )
        return True
    except Exception:
        log_exception(f"Could not re-launch with Python {version}")
        return False


def bootstrap_python_version() -> None:
    """Re-launch with the interpreter selected by JSX before importing cv2/numpy."""
    config = _load_launch_config()
    preferred = str(config.get("python_version") or "auto").strip().lower()
    current = f"{sys.version_info.major}.{sys.version_info.minor}"
    if preferred in {"3.11", "3.14"} and preferred != current:
        write_startup_status("starting", f"Switching to Python {preferred}")
        if _probe_requested_python(preferred, False) and _spawn_requested_python(preferred):
            raise SystemExit(0)
        write_startup_status(
            "error",
            f"Could not start Python {preferred}. Run install_python{preferred.replace('.', '')}.bat and verify the Python Launcher for Windows is installed.",
        )
        raise SystemExit(2)
    if preferred == "auto" and (sys.version_info.major, sys.version_info.minor) not in SUPPORTED_PYTHON:
        # Prefer an installed supported interpreter that already has the modules.
        for require_modules in (True, False):
            for candidate in ("3.14", "3.11"):
                if _probe_requested_python(candidate, require_modules) and _spawn_requested_python(candidate):
                    write_startup_status("starting", f"Switching to supported Python {candidate}")
                    raise SystemExit(0)
        write_startup_status(
            "error",
            f"Python {current} is not supported. Install Python 3.11 or 3.14 with the Python Launcher for Windows.",
        )
        raise SystemExit(2)


if os.environ.get("FCM_SKIP_BOOTSTRAP") != "1":
    bootstrap_python_version()

try:
    import numpy as np
    import cv2
except Exception as _import_error:
    # In Auto mode, try the other supported system Python if it already has dependencies.
    config = _load_launch_config()
    preferred = str(config.get("python_version") or "auto").strip().lower()
    current = (sys.version_info.major, sys.version_info.minor)
    if os.name == "nt" and preferred == "auto":
        launcher = _launcher_executable()
        if launcher:
            for candidate in ("3.14", "3.11"):
                parts = tuple(int(x) for x in candidate.split("."))
                if parts == current:
                    continue
                if _probe_requested_python(candidate, True) and _spawn_requested_python(candidate):
                    raise SystemExit(0)
    write_startup_status(
        "error",
        "Required Python modules are missing. Run install_python311.bat or install_python314.bat before the first launch.\n"
        + str(_import_error),
    )
    raise SystemExit(3)


class ApiError(Exception):
    def __init__(self, message: str, code: str = "", details: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.code = code
        self.details = details or {}


def json_ascii(data: Any) -> bytes:
    return (json.dumps(data, ensure_ascii=True, separators=(",", ":")) + "\n").encode("ascii")


def send_reply(payload: Dict[str, Any], retries: int = 30) -> bool:
    data = json_ascii(payload)
    with _REPLY_LOCK:
        for attempt in range(retries):
            try:
                with socket.create_connection((API_HOST, API_REPLY_PORT), timeout=1.0) as sock:
                    sock.sendall(data)
                return True
            except OSError:
                if attempt + 1 < retries:
                    time.sleep(0.05)
    return False


def reply(request_id: str, message: Any) -> None:
    send_reply({
        "protocol": API_PROTOCOL,
        "request_id": request_id,
        "type": "answer",
        "message": message,
    })


def error_reply(request_id: str, exc: Exception) -> None:
    payload: Dict[str, Any] = {
        "protocol": API_PROTOCOL,
        "request_id": request_id,
        "type": "error",
        "message": str(exc) or exc.__class__.__name__,
    }
    if isinstance(exc, ApiError):
        if exc.code:
            payload["code"] = exc.code
        if exc.details:
            payload["details"] = exc.details
    send_reply(payload)


def imread_unicode(path: str) -> np.ndarray:
    p = Path(path)
    if not p.is_file():
        raise ApiError(f"Image file does not exist: {path}", "IMAGE_NOT_FOUND")
    try:
        raw = np.fromfile(str(p), dtype=np.uint8)
        image = cv2.imdecode(raw, cv2.IMREAD_COLOR)
    except Exception as exc:
        raise ApiError(f"Could not read image: {path}\n{exc}", "IMAGE_READ_ERROR")
    if image is None or image.size == 0:
        raise ApiError(f"Could not decode image: {path}", "IMAGE_READ_ERROR")
    return image


def _detect_yunet(image: np.ndarray) -> List[Dict[str, Any]]:
    if not (YUNET_MODEL.is_file() and YUNET_MODEL.stat().st_size > 100000) or not hasattr(cv2, "FaceDetectorYN_create"):
        return []
    h, w = image.shape[:2]
    detect_size = (320, 320)
    scale = min(detect_size[0] / float(max(w, 1)), detect_size[1] / float(max(h, 1)))
    nw, nh = max(1, int(round(w * scale))), max(1, int(round(h * scale)))
    resized = cv2.resize(image, (nw, nh), interpolation=cv2.INTER_AREA if scale < 1.0 else cv2.INTER_LINEAR)
    small = np.zeros((detect_size[1], detect_size[0], 3), dtype=np.uint8)
    pad_x = (detect_size[0] - nw) // 2
    pad_y = (detect_size[1] - nh) // 2
    small[pad_y:pad_y + nh, pad_x:pad_x + nw] = resized
    try:
        detector = cv2.FaceDetectorYN_create(str(YUNET_MODEL), "", detect_size, 0.72, 0.3, 5000)
        _retval, faces = detector.detect(small)
    except Exception:
        log_exception("YuNet detection failed")
        return []
    if faces is None:
        return []
    results: List[Dict[str, Any]] = []
    for row in faces:
        x, y, fw, fh = [float(v) for v in row[:4]]
        x = (x - pad_x) / scale
        y = (y - pad_y) / scale
        fw = fw / scale
        fh = fh / scale
        landmarks = []
        for i in range(5):
            landmarks.append([(float(row[4 + i * 2]) - pad_x) / scale, (float(row[5 + i * 2]) - pad_y) / scale])
        results.append({
            "bbox": [x, y, fw, fh],
            "landmarks": landmarks,
            "score": float(row[14]),
            "detector": "yunet",
        })
    return results


def _detect_haar(image: np.ndarray) -> List[Dict[str, Any]]:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    cascade_path = Path(cv2.data.haarcascades) / "haarcascade_frontalface_default.xml"
    cascade = cv2.CascadeClassifier(str(cascade_path))
    if cascade.empty():
        return []
    faces = cascade.detectMultiScale(gray, scaleFactor=1.08, minNeighbors=5, minSize=(48, 48))
    results: List[Dict[str, Any]] = []
    for x, y, w, h in faces:
        results.append({
            "bbox": [float(x), float(y), float(w), float(h)],
            "landmarks": [],
            "score": 0.5,
            "detector": "haar-fallback",
        })
    return results


def detect_faces(image: np.ndarray) -> List[Dict[str, Any]]:
    faces = _detect_yunet(image)
    if not faces:
        faces = _detect_haar(image)
    h, w = image.shape[:2]
    cx, cy = w * 0.5, h * 0.5
    for face in faces:
        x, y, fw, fh = face["bbox"]
        area = max(1.0, fw * fh)
        fx, fy = x + fw * 0.5, y + fh * 0.5
        dist = math.hypot((fx - cx) / max(w, 1), (fy - cy) / max(h, 1))
        face["rank"] = area * max(0.2, 1.0 - 0.45 * dist)
    faces.sort(key=lambda item: float(item.get("rank", 0.0)), reverse=True)
    return faces


def canonical_face_patch(image: np.ndarray, face: Dict[str, Any], size: int = 256) -> Tuple[np.ndarray, List[List[float]]]:
    """Normalize scale/roll from YuNet landmarks before sampling skin zones."""
    landmarks = face.get("landmarks") or []
    if len(landmarks) >= 5:
        eyes = sorted([landmarks[0], landmarks[1]], key=lambda p: float(p[0]))
        mouth = sorted([landmarks[3], landmarks[4]], key=lambda p: float(p[0]))
        src = np.asarray([eyes[0], eyes[1], landmarks[2], mouth[0], mouth[1]], dtype=np.float32)
        dst = np.asarray([
            [size * 0.31, size * 0.35],
            [size * 0.69, size * 0.35],
            [size * 0.50, size * 0.54],
            [size * 0.36, size * 0.72],
            [size * 0.64, size * 0.72],
        ], dtype=np.float32)
        matrix, _inliers = cv2.estimateAffinePartial2D(src, dst, method=cv2.LMEDS)
        if matrix is not None:
            patch = cv2.warpAffine(
                image, matrix, (size, size), flags=cv2.INTER_LINEAR,
                borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0)
            )
            return patch, [[float(v[0]), float(v[1])] for v in dst]

    x, y, w, h = [float(v) for v in face["bbox"]]
    ih, iw = image.shape[:2]
    margin_x = w * 0.08
    margin_y_top = h * 0.10
    margin_y_bottom = h * 0.04
    x0 = max(0, int(round(x - margin_x)))
    y0 = max(0, int(round(y - margin_y_top)))
    x1 = min(iw, int(round(x + w + margin_x)))
    y1 = min(ih, int(round(y + h + margin_y_bottom)))
    crop = image[y0:y1, x0:x1]
    if crop.size == 0:
        raise ApiError("Could not build a normalized face crop.", "FACE_CROP_ERROR")
    patch = cv2.resize(crop, (size, size), interpolation=cv2.INTER_AREA if max(crop.shape[:2]) > size else cv2.INTER_LINEAR)
    return patch, []


ZONE_DEFS: Dict[str, Tuple[float, float, float, float]] = {
    "forehead": (0.28, 0.18, 0.72, 0.36),
    "left_cheek": (0.15, 0.43, 0.43, 0.68),
    "right_cheek": (0.57, 0.43, 0.85, 0.68),
    "nose": (0.41, 0.36, 0.59, 0.66),
    "chin": (0.34, 0.69, 0.66, 0.84),
}
ZONE_WEIGHTS = {
    "forehead": 0.50,
    "left_cheek": 1.00,
    "right_cheek": 1.00,
    "nose": 0.22,
    "chin": 0.30,
}
TONE_Q = [0.12, 0.30, 0.50, 0.70, 0.88]
TONE_WEIGHTS = [0.15, 0.35, 0.65, 1.00, 0.65]
SKIN_SEED_DEFS: Dict[str, Tuple[float, float, float, float]] = {
    "left_cheek_seed": (0.23, 0.47, 0.37, 0.61),
    "right_cheek_seed": (0.63, 0.47, 0.77, 0.61),
    "forehead_seed": (0.39, 0.23, 0.61, 0.33),
}


def _rect_mask(shape: Tuple[int, int], rect: Sequence[float]) -> np.ndarray:
    h, w = shape
    x0, y0, x1, y1 = rect
    x0i = max(0, min(w, int(round(x0))))
    x1i = max(0, min(w, int(round(x1))))
    y0i = max(0, min(h, int(round(y0))))
    y1i = max(0, min(h, int(round(y1))))
    mask = np.zeros((h, w), dtype=np.uint8)
    if x1i > x0i and y1i > y0i:
        mask[y0i:y1i, x0i:x1i] = 1
    return mask


def _ellipse_exclusion(mask: np.ndarray, center: Tuple[float, float], axes: Tuple[float, float]) -> None:
    cx, cy = int(round(center[0])), int(round(center[1]))
    ax, ay = max(1, int(round(axes[0]))), max(1, int(round(axes[1])))
    cv2.ellipse(mask, (cx, cy), (ax, ay), 0, 0, 360, 0, -1)


def _robust_pixels(rgb: np.ndarray, mask: np.ndarray) -> np.ndarray:
    pixels = rgb[mask.astype(bool)]
    if pixels.shape[0] < 25:
        return pixels
    pixels_f = pixels.astype(np.float32)
    y = 0.2126 * pixels_f[:, 0] + 0.7152 * pixels_f[:, 1] + 0.0722 * pixels_f[:, 2]
    keep = (y > 12.0) & (y < 248.0)
    if keep.sum() >= 25:
        pixels_f = pixels_f[keep]
    if pixels_f.shape[0] < 25:
        return pixels_f.astype(np.uint8)

    lab = cv2.cvtColor((pixels_f.reshape(-1, 1, 3) / 255.0).astype(np.float32), cv2.COLOR_RGB2LAB).reshape(-1, 3)
    chroma = lab[:, 1:3]
    med = np.median(chroma, axis=0)
    distance = np.sqrt(np.sum((chroma - med) ** 2, axis=1))
    threshold = max(8.0, float(np.percentile(distance, 88.0)))
    keep = distance <= threshold
    if keep.sum() >= 25:
        pixels_f = pixels_f[keep]
    return np.clip(pixels_f, 0, 255).astype(np.uint8)




def _feature_safe_mask(shape: Tuple[int, int], rect: Sequence[float], landmarks: Sequence[Sequence[float]]) -> np.ndarray:
    h, w = shape
    mask = _rect_mask(shape, rect)
    if len(landmarks) >= 5:
        eye_axes = (w * 0.105, h * 0.070)
        _ellipse_exclusion(mask, tuple(landmarks[0]), eye_axes)
        _ellipse_exclusion(mask, tuple(landmarks[1]), eye_axes)
        mouth_cx = (landmarks[3][0] + landmarks[4][0]) * 0.5
        mouth_cy = (landmarks[3][1] + landmarks[4][1]) * 0.5
        mouth_w = abs(landmarks[4][0] - landmarks[3][0]) * 0.72 + w * 0.035
        _ellipse_exclusion(mask, (mouth_cx, mouth_cy), (max(w * 0.08, mouth_w), h * 0.07))
        nose_guard = _rect_mask(shape, (w * 0.43, h * 0.36, w * 0.57, h * 0.58))
        mask[nose_guard.astype(bool)] = mask[nose_guard.astype(bool)]
    return mask


def _lab_pixels_from_rgb(pixels: np.ndarray) -> np.ndarray:
    if pixels.size == 0:
        return np.empty((0, 3), dtype=np.float32)
    return cv2.cvtColor((pixels.reshape(-1, 1, 3).astype(np.float32) / 255.0), cv2.COLOR_RGB2LAB).reshape(-1, 3)


def _lab_image_from_rgb(rgb: np.ndarray) -> np.ndarray:
    return cv2.cvtColor((rgb.astype(np.float32) / 255.0), cv2.COLOR_RGB2LAB)


def _finalize_skin_pixels(rgb: np.ndarray, mask: np.ndarray, seed_lab: np.ndarray | None = None) -> np.ndarray:
    pixels = rgb[mask.astype(bool)]
    if pixels.shape[0] < 25:
        return pixels
    pixels = _robust_pixels(rgb, mask)
    if pixels.shape[0] < 25 or seed_lab is None or seed_lab.shape[0] < 25:
        return pixels

    lab = _lab_pixels_from_rgb(pixels)
    seed_center = np.median(seed_lab, axis=0)
    seed_ab = seed_lab[:, 1:3]
    seed_ab_center = np.median(seed_ab, axis=0)
    seed_ab_dist = np.sqrt(np.sum((seed_ab - seed_ab_center) ** 2, axis=1))
    ab_threshold = float(np.percentile(seed_ab_dist, 92.0)) + 4.0
    ab_threshold = float(np.clip(ab_threshold, 6.0, 18.0))
    l_low = float(np.percentile(seed_lab[:, 0], 5.0) - 16.0)
    l_high = float(np.percentile(seed_lab[:, 0], 97.0) + 12.0)
    chroma = np.sqrt(np.sum((lab[:, 1:3] - seed_ab_center) ** 2, axis=1))
    keep = (lab[:, 0] >= l_low) & (lab[:, 0] <= l_high) & (chroma <= ab_threshold)
    if np.count_nonzero(keep) >= 25:
        pixels = pixels[keep]
    return pixels


def _skin_mask_from_patch(rgb: np.ndarray, landmarks: Sequence[Sequence[float]]) -> Tuple[np.ndarray, Dict[str, np.ndarray], Dict[str, Any]]:
    h, w = rgb.shape[:2]
    zone_masks: Dict[str, np.ndarray] = {}
    union_mask = np.zeros((h, w), dtype=np.uint8)
    for name, rect in ZONE_DEFS.items():
        mask = _feature_safe_mask((h, w), (w * rect[0], h * rect[1], w * rect[2], h * rect[3]), landmarks)
        zone_masks[name] = mask
        union_mask = np.maximum(union_mask, mask)

    seed_masks: List[np.ndarray] = []
    seed_pixels_list: List[np.ndarray] = []
    for rect in SKIN_SEED_DEFS.values():
        mask = _feature_safe_mask((h, w), (w * rect[0], h * rect[1], w * rect[2], h * rect[3]), landmarks)
        pixels = _robust_pixels(rgb, mask)
        if pixels.shape[0] >= 18:
            seed_masks.append(mask)
            seed_pixels_list.append(pixels)

    if seed_pixels_list:
        seed_pixels = np.concatenate(seed_pixels_list, axis=0)
        seed_lab = _lab_pixels_from_rgb(seed_pixels)
        lab_img = _lab_image_from_rgb(rgb)
        rgb_f = rgb.astype(np.float32)
        lum = 0.2126 * rgb_f[:, :, 0] + 0.7152 * rgb_f[:, :, 1] + 0.0722 * rgb_f[:, :, 2]
        seed_ab_center = np.median(seed_lab[:, 1:3], axis=0)
        seed_ab_dist = np.sqrt(np.sum((seed_lab[:, 1:3] - seed_ab_center) ** 2, axis=1))
        ab_threshold = float(np.percentile(seed_ab_dist, 92.0)) + 4.0
        ab_threshold = float(np.clip(ab_threshold, 6.0, 18.0))
        l_low = float(np.percentile(seed_lab[:, 0], 4.0) - 16.0)
        l_high = float(np.percentile(seed_lab[:, 0], 98.0) + 12.0)
        ab_dist = np.sqrt(np.sum((lab_img[:, :, 1:3] - seed_ab_center.reshape(1, 1, 2)) ** 2, axis=2))
        final_mask = ((union_mask > 0) & (lum > 18.0) & (lum < 245.0) & (lab_img[:, :, 0] >= l_low) & (lab_img[:, :, 0] <= l_high) & (ab_dist <= ab_threshold)).astype(np.uint8)
        kept = int(np.count_nonzero(final_mask))
        if kept < 80:
            final_mask = union_mask.copy()
        cheek_left = _finalize_skin_pixels(rgb, zone_masks["left_cheek"], seed_lab)
        cheek_right = _finalize_skin_pixels(rgb, zone_masks["right_cheek"], seed_lab)
        cheek_de = None
        if cheek_left.shape[0] >= 25 and cheek_right.shape[0] >= 25:
            cheek_de = float(delta_e_2000(rgb_to_lab(np.median(cheek_left, axis=0)), rgb_to_lab(np.median(cheek_right, axis=0))))
        quality_score = 100.0
        quality_score -= max(0.0, 18.0 - min(18.0, float(kept) / 24.0)) * 2.0
        quality_score -= float(np.clip(ab_threshold - 9.0, 0.0, 8.0)) * 4.5
        if cheek_de is not None:
            quality_score -= max(0.0, cheek_de - 2.5) * 6.0
        quality = {
            "seed_pixels": int(seed_pixels.shape[0]),
            "candidate_pixels": int(np.count_nonzero(union_mask)),
            "skin_pixels": kept,
            "ab_threshold": round(ab_threshold, 2),
            "cheek_delta_e": round(cheek_de, 3) if cheek_de is not None else None,
            "score": round(float(np.clip(quality_score, 0.0, 100.0)), 1),
        }
        return final_mask, zone_masks, quality

    return union_mask.copy(), zone_masks, {
        "seed_pixels": 0,
        "candidate_pixels": int(np.count_nonzero(union_mask)),
        "skin_pixels": int(np.count_nonzero(union_mask)),
        "ab_threshold": None,
        "cheek_delta_e": None,
        "score": 45.0,
    }

def _anchors_from_pixels(pixels: np.ndarray) -> List[Dict[str, Any]]:
    if pixels.shape[0] < 25:
        return []
    arr = pixels.astype(np.float32)
    lum = 0.2126 * arr[:, 0] + 0.7152 * arr[:, 1] + 0.0722 * arr[:, 2]
    order = np.argsort(lum)
    arr = arr[order]
    lum = lum[order]
    n = len(lum)
    half_window = max(12, int(round(n * 0.09)))
    result: List[Dict[str, Any]] = []
    for q in TONE_Q:
        center = int(round((n - 1) * q))
        lo = max(0, center - half_window)
        hi = min(n, center + half_window + 1)
        sample = arr[lo:hi]
        sample_l = lum[lo:hi]
        if sample.shape[0] < 8:
            continue
        rgb_med = np.median(sample, axis=0)
        y_med = float(np.median(sample_l))
        spread = float(np.mean(np.std(sample, axis=0)))
        result.append({
            "q": float(q),
            "r": float(rgb_med[0]),
            "g": float(rgb_med[1]),
            "b": float(rgb_med[2]),
            "y": y_med,
            "count": int(sample.shape[0]),
            "spread": spread,
        })
    return result


def _hist_quantile(hist: np.ndarray, q: float) -> float:
    counts = np.asarray(hist, dtype=np.float64).reshape(-1)
    total = float(np.sum(counts))
    if total <= 0.0:
        return float(np.clip(q, 0.0, 1.0) * 255.0)
    cdf = np.cumsum(counts)
    idx = int(np.searchsorted(cdf, total * float(np.clip(q, 0.0, 1.0)), side="left"))
    return float(np.clip(idx, 0, 255))


def _smooth_histogram(hist: np.ndarray, sigma: float = 3.2) -> np.ndarray:
    values = np.asarray(hist, dtype=np.float64).reshape(-1)
    radius = max(3, int(round(float(sigma) * 3.0)))
    x = np.arange(-radius, radius + 1, dtype=np.float64)
    kernel = np.exp(-0.5 * (x / max(0.8, float(sigma))) ** 2)
    kernel /= max(1e-12, float(np.sum(kernel)))
    padded = np.pad(values, (radius, radius), mode="edge")
    return np.convolve(padded, kernel, mode="same")[radius:-radius]


def _histogram_channel_profile(values: np.ndarray) -> Dict[str, Any]:
    channel = np.asarray(values, dtype=np.uint8).reshape(-1)
    hist = np.bincount(channel, minlength=256).astype(np.float64)
    smooth = _smooth_histogram(hist)
    peak_global = max(1.0, float(np.max(smooth)))
    low = _hist_quantile(hist, 0.015)
    high = _hist_quantile(hist, 0.985)
    if high - low < 72.0:
        low = _hist_quantile(hist, 0.005)
        high = _hist_quantile(hist, 0.995)
    low = float(np.clip(low, 4.0, 210.0))
    high = float(np.clip(high, low + 48.0, 251.0))

    valleys: List[Dict[str, Any]] = []
    # Local minima are scored by the two neighboring tonal masses. This makes
    # the preferred Photoshop control positions sit in histogram saddles rather
    # than on top of the dominant pixel peaks.
    lo_i = max(12, int(math.floor(low + 4.0)))
    hi_i = min(243, int(math.ceil(high - 4.0)))
    for i in range(lo_i, hi_i + 1):
        local0 = max(lo_i, i - 3)
        local1 = min(hi_i + 1, i + 4)
        if float(smooth[i]) > float(np.min(smooth[local0:local1])) + 1e-9:
            continue
        left0, left1 = max(lo_i, i - 44), max(lo_i, i - 6)
        right0, right1 = min(hi_i + 1, i + 7), min(hi_i + 1, i + 45)
        if left1 <= left0 or right1 <= right0:
            continue
        left_peak = float(np.max(smooth[left0:left1]))
        right_peak = float(np.max(smooth[right0:right1]))
        saddle = min(left_peak, right_peak)
        if saddle <= 0.0:
            continue
        depth = max(0.0, (saddle - float(smooth[i])) / saddle)
        support = saddle / peak_global
        if depth < 0.025 or support < 0.018:
            continue
        valleys.append({
            "x": int(i),
            "depth": round(float(depth), 6),
            "support": round(float(support), 6),
            "score": round(float(depth * (0.65 + min(1.0, support) * 0.70)), 6),
        })

    # Collapse tiny runs of neighboring minima into the strongest saddle.
    collapsed: List[Dict[str, Any]] = []
    for item in sorted(valleys, key=lambda row: int(row["x"])):
        if collapsed and int(item["x"]) - int(collapsed[-1]["x"]) <= 6:
            if float(item["score"]) > float(collapsed[-1]["score"]):
                collapsed[-1] = item
        else:
            collapsed.append(item)

    norm = smooth / peak_global
    return {
        "low": round(low, 3),
        "high": round(high, 3),
        "q25": round(_hist_quantile(hist, 0.25), 3),
        "q50": round(_hist_quantile(hist, 0.50), 3),
        "q75": round(_hist_quantile(hist, 0.75), 3),
        # Normalized smoothed histogram is compact enough for a preset and makes
        # diagnostics reproducible without keeping the original preview image.
        "smooth": [round(float(v), 6) for v in norm.tolist()],
        "valleys": collapsed,
    }


def _image_histogram_profile(rgb: np.ndarray) -> Dict[str, Any]:
    arr = np.asarray(rgb, dtype=np.uint8)
    # Limit the amount of work without changing the tonal distribution materially.
    flat = arr.reshape(-1, 3)
    if flat.shape[0] > 650000:
        step = int(math.ceil(flat.shape[0] / 650000.0))
        flat = flat[::step]
    lum = np.clip(np.round(0.2126 * flat[:, 0] + 0.7152 * flat[:, 1] + 0.0722 * flat[:, 2]), 0, 255).astype(np.uint8)
    return {
        "red": _histogram_channel_profile(flat[:, 0]),
        "green": _histogram_channel_profile(flat[:, 1]),
        "blue": _histogram_channel_profile(flat[:, 2]),
        "luma": _histogram_channel_profile(lum),
    }



def analyze_face(image: np.ndarray) -> Dict[str, Any]:
    faces = detect_faces(image)
    if not faces:
        raise ApiError("No face was found in the image.", "NO_FACE")
    face = faces[0]
    ih, iw = image.shape[:2]
    bx, by, bw, bh = [float(v) for v in face["bbox"]]
    bx = max(0.0, bx)
    by = max(0.0, by)
    bw = min(float(iw) - bx, bw)
    bh = min(float(ih) - by, bh)
    if bw < 32 or bh < 32:
        raise ApiError("The detected face is too small for reliable color measurement.", "FACE_TOO_SMALL")

    patch_bgr, canonical_landmarks = canonical_face_patch(image, face, 256)
    h, w = patch_bgr.shape[:2]
    rgb = cv2.cvtColor(patch_bgr, cv2.COLOR_BGR2RGB)
    skin_mask, zone_masks, quality = _skin_mask_from_patch(rgb, canonical_landmarks)
    zones: Dict[str, Any] = {}
    all_zone_pixels: List[np.ndarray] = []
    seed_lab = None
    pooled_seed_pixels = rgb[skin_mask.astype(bool)]
    if pooled_seed_pixels.shape[0] >= 25:
        seed_lab = _lab_pixels_from_rgb(pooled_seed_pixels)

    for name in ZONE_DEFS.keys():
        zone_mask = ((zone_masks.get(name, np.zeros((h, w), dtype=np.uint8)) > 0) & (skin_mask > 0)).astype(np.uint8)
        pixels = _finalize_skin_pixels(rgb, zone_mask, seed_lab)
        if pixels.shape[0] < 25 and np.count_nonzero(zone_mask) >= 25:
            pixels = _robust_pixels(rgb, zone_mask)
        anchors = _anchors_from_pixels(pixels)
        if anchors:
            zones[name] = {"anchors": anchors, "pixels": int(pixels.shape[0])}
            all_zone_pixels.append(pixels)

    if len(zones) < 2:
        raise ApiError("The face was found, but there are not enough reliable skin regions to measure.", "INSUFFICIENT_SKIN")

    if all_zone_pixels:
        pooled = np.concatenate(all_zone_pixels, axis=0)
    else:
        pooled = rgb[skin_mask.astype(bool)]
    pooled = pooled if pooled.size else np.empty((0, 3), dtype=np.uint8)
    pooled_anchors = _anchors_from_pixels(pooled)
    full_rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
    return {
        "zones": zones,
        "pooled": {"anchors": pooled_anchors, "pixels": int(pooled.shape[0])},
        "image_histogram": _image_histogram_profile(full_rgb),
        "quality": quality,
        "face": {
            "bbox": [round(float(v), 3) for v in [bx, by, bw, bh]],
            "score": round(float(face.get("score", 0.0)), 5),
            "detector": str(face.get("detector") or "unknown"),
            "face_count": len(faces),
            "normalized": bool(canonical_landmarks),
        },
    }


def _anchor_map(model: Dict[str, Any]) -> Dict[Tuple[str, float], Dict[str, Any]]:
    out: Dict[Tuple[str, float], Dict[str, Any]] = {}
    zones = model.get("zones") or {}
    for zone_name, zone in zones.items():
        for anchor in zone.get("anchors") or []:
            out[(str(zone_name), round(float(anchor.get("q", 0.0)), 2))] = anchor
    return out


def build_correspondences(target: Dict[str, Any], reference: Dict[str, Any]) -> List[Dict[str, Any]]:
    ta = _anchor_map(target)
    ra = _anchor_map(reference)
    rows: List[Dict[str, Any]] = []
    q_weight = {round(q, 2): w for q, w in zip(TONE_Q, TONE_WEIGHTS)}
    for key, t in ta.items():
        r = ra.get(key)
        if not r:
            continue
        zone, q = key
        spread = max(1.0, float(t.get("spread", 1.0)) + float(r.get("spread", 1.0)))
        stability = 1.0 / (1.0 + spread / 28.0)
        weight = float(ZONE_WEIGHTS.get(zone, 1.0)) * float(q_weight.get(q, 0.8)) * stability
        rows.append({"zone": zone, "q": q, "target": t, "reference": r, "weight": weight})
    if len(rows) < 6:
        raise ApiError("Not enough corresponding skin measurements were available for curve fitting.", "INSUFFICIENT_MATCH_DATA")
    return rows


def _interp_curve(curve: Sequence[Sequence[float]], values: np.ndarray) -> np.ndarray:
    xp = np.array([float(p[0]) for p in curve], dtype=np.float32)
    yp = np.array([float(p[1]) for p in curve], dtype=np.float32)
    return np.interp(values.astype(np.float32), xp, yp)


def weighted_median(values: Sequence[float], weights: Sequence[float]) -> float:
    va = np.asarray(values, dtype=np.float64)
    wa = np.asarray(weights, dtype=np.float64)
    finite = np.isfinite(va) & np.isfinite(wa)
    va, wa = va[finite], wa[finite]
    if va.size == 0:
        return 0.0
    if float(np.sum(wa)) <= 0:
        return float(np.median(va))
    order = np.argsort(va)
    va, wa = va[order], wa[order]
    c = np.cumsum(wa)
    idx = int(np.searchsorted(c, c[-1] * 0.5, side="left"))
    return float(va[min(max(idx, 0), len(va) - 1)])


def _tone_groups(rows: List[Dict[str, Any]]) -> Dict[float, Dict[str, Any]]:
    groups: Dict[float, Dict[str, Any]] = {}
    for q in TONE_Q:
        qk = round(float(q), 2)
        selected = [row for row in rows if round(float(row.get("q", 0.0)), 2) == qk]
        if not selected:
            continue
        weights = [max(1e-4, float(row.get("weight", 1.0))) for row in selected]
        target_rgb = []
        reference_rgb = []
        for key in ("r", "g", "b"):
            target_rgb.append(weighted_median([float(row["target"][key]) for row in selected], weights))
            reference_rgb.append(weighted_median([float(row["reference"][key]) for row in selected], weights))
        target_y = weighted_median([float(row["target"].get("y", 0.0)) for row in selected], weights)
        reference_y = weighted_median([float(row["reference"].get("y", 0.0)) for row in selected], weights)
        de = delta_e_2000(rgb_to_lab(target_rgb), rgb_to_lab(reference_rgb))
        groups[qk] = {
            "q": qk,
            "target_rgb": target_rgb,
            "reference_rgb": reference_rgb,
            "target_y": target_y,
            "reference_y": reference_y,
            "delta_e": float(de),
            "weight": float(sum(weights)),
        }
    return groups


def _soft_match_factor(delta_e: float, tolerance: float, mode: str) -> float:
    """Leave a perceptual dead-band instead of forcing every sample to the reference.

    The power term makes corrections just outside the tolerance deliberately soft;
    large mismatches approach full correction gradually instead of producing a jump.
    """
    de = max(0.0, float(delta_e))
    tol = max(0.0, float(tolerance))
    if de <= tol or de <= 1e-6:
        return 0.0
    residual_fraction = max(0.0, min(1.0, (de - tol) / de))
    gamma = 1.45 if mode == "safe" else 1.22
    factor = residual_fraction ** gamma
    if mode == "safe":
        factor *= 0.88
    return max(0.0, min(1.0, factor))


def _curve_slopes(points: Sequence[Sequence[float]]) -> List[float]:
    slopes: List[float] = []
    for a, b in zip(points[:-1], points[1:]):
        dx = max(1e-6, float(b[0]) - float(a[0]))
        slopes.append((float(b[1]) - float(a[1])) / dx)
    return slopes



def _curve_from_displacements(
    positions: Sequence[float],
    displacement: Sequence[float],
    mode: str,
    severity: float,
    kind: str = "color",
) -> List[List[int]]:
    """Convert solved displacement values into a sparse, smooth Photoshop curve.

    Large mismatches are allowed to move the whole curve farther from the identity,
    but local slope changes remain constrained. The final transform may therefore
    be strong while still looking like one broad photographic correction.
    """
    xs = np.asarray([float(v) for v in positions], dtype=np.float64)
    delta = np.asarray([float(v) for v in displacement], dtype=np.float64)
    if xs.size == 0:
        return [[0, 0], [255, 255]]

    sev = float(np.clip(severity, 0.0, 1.0))
    if kind == "luma":
        max_delta = (10.0 + 26.0 * sev) if mode == "safe" else (13.0 + 34.0 * sev)
        max_slope_dev = (0.24 + 0.22 * sev) if mode == "safe" else (0.30 + 0.40 * sev)
        max_bend = (0.13 + 0.23 * sev) if mode == "safe" else (0.16 + 0.39 * sev)
    else:
        max_delta = (9.0 + 20.0 * sev) if mode == "safe" else (12.0 + 30.0 * sev)
        max_slope_dev = (0.20 + 0.18 * sev) if mode == "safe" else (0.27 + 0.39 * sev)
        max_bend = (0.11 + 0.16 * sev) if mode == "safe" else (0.15 + 0.36 * sev)

    delta = np.clip(delta, -max_delta, max_delta)

    def points_for(scale: float) -> List[List[float]]:
        pts: List[List[float]] = [[0.0, 0.0]]
        for x, d in zip(xs, delta):
            pts.append([float(x), float(np.clip(x + d * scale, 1.0, 254.0))])
        pts.append([255.0, 255.0])
        return pts

    # Scale the whole displacement field only if the composed curve becomes too
    # steep or forms an abrupt bend. The relative relation between control points
    # is preserved instead of shrinking each point independently.
    scale = 1.0
    for _ in range(10):
        pts = points_for(scale)
        slopes = _curve_slopes(pts)
        slope_dev = max([abs(v - 1.0) for v in slopes] or [0.0])
        bend = max([abs(b - a) for a, b in zip(slopes[:-1], slopes[1:])] or [0.0])
        factor = 1.0
        if slope_dev > max_slope_dev + 1e-9:
            factor = min(factor, max_slope_dev / max(1e-9, slope_dev))
        if bend > max_bend + 1e-9:
            factor = min(factor, max_bend / max(1e-9, bend))
        if factor >= 0.999:
            break
        scale *= max(0.0, min(1.0, factor * 0.985))

    pts = points_for(scale)
    rounded: List[List[int]] = [[0, 0]]
    for x, y in pts[1:-1]:
        xi = int(round(x))
        yi = int(round(y))
        if xi <= rounded[-1][0]:
            xi = rounded[-1][0] + 1
        yi = max(rounded[-1][1] + 1, min(254, yi))
        rounded.append([xi, yi])
    rounded.append([255, 255])
    for i in range(len(rounded) - 2, 0, -1):
        rounded[i][0] = min(rounded[i][0], rounded[i + 1][0] - 1)
        rounded[i][1] = min(rounded[i][1], rounded[i + 1][1] - 1)
    return rounded


def _displacement_basis(positions: Sequence[float], sample_x: Sequence[float]) -> np.ndarray:
    """Piecewise-linear Photoshop-curve basis with fixed 0->0 and 255->255.

    Unknowns are vertical displacements of histogram-valley control points.
    Solving through this basis means a point between histogram peaks is moved far
    enough that interpolation at the actual skin peak receives the requested
    correction. The old distance-falloff heuristic systematically under-corrected
    large mismatches.
    """
    xs = np.asarray([float(v) for v in positions], dtype=np.float64)
    samples = np.asarray([float(v) for v in sample_x], dtype=np.float64)
    m = int(xs.size)
    B = np.zeros((int(samples.size), m), dtype=np.float64)
    if m == 0:
        return B
    all_x = np.concatenate(([0.0], xs, [255.0]))
    for row, raw_x in enumerate(samples):
        x = float(np.clip(raw_x, 0.0, 255.0))
        seg = int(np.searchsorted(all_x, x, side="right") - 1)
        seg = max(0, min(seg, len(all_x) - 2))
        x0, x1 = float(all_x[seg]), float(all_x[seg + 1])
        t = (x - x0) / max(1e-9, x1 - x0)
        if seg > 0:
            B[row, seg - 1] += 1.0 - t
        if seg + 1 < len(all_x) - 1:
            B[row, seg] += t
    return B


def _solve_control_curve(
    positions: Sequence[float],
    samples: List[Tuple[float, float, float]],
    mode: str,
    severity: float,
    kind: str = "color",
) -> List[List[int]]:
    """Least-squares fit of sparse valley controls to measured corrections.

    Regularization favours an almost straight displacement field. For a large
    mismatch the data term is trusted more, so one run can do the work which
    previously required several stacked Face Color Match layers.
    """
    xs = np.asarray(sorted(float(v) for v in positions), dtype=np.float64)
    if xs.size == 0 or not samples:
        return [[0, 0], [255, 255]]

    sx = np.asarray([float(row[0]) for row in samples], dtype=np.float64)
    desired = np.asarray([float(row[1]) for row in samples], dtype=np.float64)
    weights = np.asarray([max(0.02, float(row[2])) for row in samples], dtype=np.float64)
    finite = np.isfinite(sx) & np.isfinite(desired) & np.isfinite(weights)
    sx, desired, weights = sx[finite], desired[finite], weights[finite]
    if sx.size == 0:
        return [[0, 0], [255, 255]]

    sev = float(np.clip(severity, 0.0, 1.0))
    B = _displacement_basis(xs, sx)
    m = int(xs.size)

    if kind == "luma":
        ridge = (0.42 - 0.26 * sev) if mode == "safe" else (0.24 - 0.17 * sev)
        lambda_first = (24.0 - 11.0 * sev) if mode == "safe" else (14.0 - 8.0 * sev)
        lambda_bend = (150.0 - 60.0 * sev) if mode == "safe" else (90.0 - 48.0 * sev)
    else:
        ridge = (0.55 - 0.31 * sev) if mode == "safe" else (0.30 - 0.21 * sev)
        lambda_first = (28.0 - 12.0 * sev) if mode == "safe" else (16.0 - 9.0 * sev)
        lambda_bend = (175.0 - 70.0 * sev) if mode == "safe" else (105.0 - 55.0 * sev)

    A = B.T @ (weights[:, None] * B) + np.eye(m, dtype=np.float64) * max(0.03, ridge)
    b = B.T @ (weights * desired)
    all_x = np.concatenate(([0.0], xs, [255.0]))

    # Penalize displacement slope, i.e. deviation of the curve from the diagonal.
    for seg in range(m + 1):
        dx = max(18.0, float(all_x[seg + 1] - all_x[seg]))
        coeff = np.zeros(m, dtype=np.float64)
        if seg > 0:
            coeff[seg - 1] -= 1.0 / dx
        if seg < m:
            coeff[seg] += 1.0 / dx
        A += max(0.0, lambda_first) * np.outer(coeff, coeff)

    # Penalize abrupt changes of slope at knots.
    for knot in range(1, m + 1):
        dx0 = max(18.0, float(all_x[knot] - all_x[knot - 1]))
        dx1 = max(18.0, float(all_x[knot + 1] - all_x[knot]))
        coeff = np.zeros(m, dtype=np.float64)
        if knot - 1 > 0:
            coeff[knot - 2] -= 1.0 / dx0
        coeff[knot - 1] += 1.0 / dx0 + 1.0 / dx1
        if knot < m:
            coeff[knot] -= 1.0 / dx1
        A += max(0.0, lambda_bend) * np.outer(coeff, coeff)

    try:
        displacement = np.linalg.solve(A, b)
    except np.linalg.LinAlgError:
        displacement = np.linalg.lstsq(A, b, rcond=None)[0]

    return _curve_from_displacements(xs, displacement, mode, sev, kind)


def _aggregate_group_delta_e(groups: Dict[float, Dict[str, Any]]) -> float:
    values: List[float] = []
    weights: List[float] = []
    for q in sorted(groups):
        g = groups[q]
        values.append(float(g.get("delta_e", 0.0)))
        weights.append(max(0.02, float(g.get("weight", 1.0))))
    if not values:
        return 0.0
    va = np.asarray(values, dtype=np.float64)
    wa = np.asarray(weights, dtype=np.float64)
    return float(np.sum(va * wa) / max(1e-9, np.sum(wa)))


def _luma_mismatch(groups: Dict[float, Dict[str, Any]]) -> float:
    values: List[float] = []
    weights: List[float] = []
    for q in sorted(groups):
        g = groups[q]
        values.append(abs(float(g["reference_y"]) - float(g["target_y"])))
        weights.append(max(0.02, float(g.get("weight", 1.0))))
    if not values:
        return 0.0
    va = np.asarray(values, dtype=np.float64)
    wa = np.asarray(weights, dtype=np.float64)
    return float(np.sum(va * wa) / max(1e-9, np.sum(wa)))


def _severity_from_delta_e(delta_e: float, tolerance: float, mode: str) -> float:
    excess = max(0.0, float(delta_e) - max(0.0, float(tolerance)))
    scale = 10.0 if mode == "safe" else 8.0
    return float(np.clip(excess / scale, 0.0, 1.0))


def _severity_from_luma(delta: float, mode: str) -> float:
    scale = 30.0 if mode == "safe" else 24.0
    return float(np.clip(max(0.0, float(delta) - 2.0) / scale, 0.0, 1.0))

def _nearest_histogram_valley(
    profile: Dict[str, Any],
    fraction: float,
    used: Sequence[float],
    min_spacing: float,
    mode: str,
    optional: bool = False,
) -> Optional[float]:
    low = float(profile.get("low", 10.0))
    high = float(profile.get("high", 245.0))
    span = max(60.0, high - low)
    target = low + float(fraction) * span
    radius = max(24.0, span * (0.18 if optional else 0.20))
    valleys = profile.get("valleys") or []
    candidates: List[Tuple[float, float]] = []
    for row in valleys:
        x = float(row.get("x", 0.0))
        if abs(x - target) > radius:
            continue
        if any(abs(x - float(prev)) < min_spacing for prev in used):
            continue
        depth = float(row.get("depth", 0.0))
        support = float(row.get("support", 0.0))
        if optional:
            min_depth = 0.055 if mode == "safe" else 0.040
            if depth < min_depth:
                continue
        closeness = max(0.0, 1.0 - abs(x - target) / max(1.0, radius))
        score = float(row.get("score", 0.0)) * 2.1 + depth * 0.55 + support * 0.12 + closeness * 0.42
        candidates.append((score, x))
    if candidates:
        candidates.sort(reverse=True)
        return float(candidates[0][1])
    if optional:
        return None

    # Required shadow/highlight anchors: if there is no formal saddle, use the
    # quietest point in the local histogram band rather than placing a point on
    # the nearby peak itself.
    smooth = np.asarray(profile.get("smooth") or [], dtype=np.float64)
    if smooth.size != 256:
        return float(np.clip(target, 12.0, 243.0))
    # Do not let the fallback drift toward a central peak/valley. When there is
    # no convincing saddle in the requested tonal zone, stay close to the true
    # shadow/highlight target and use only a narrow local density search.
    local_radius = max(6.0, min(9.0, span * 0.040))
    lo = max(int(math.floor(low + 5.0)), int(round(target - local_radius)))
    hi = min(int(math.ceil(high - 5.0)), int(round(target + local_radius)))
    allowed = [i for i in range(max(12, lo), min(243, hi) + 1)
               if not any(abs(float(i) - float(prev)) < min_spacing for prev in used)]
    if not allowed:
        return None
    def fallback_score(i: int) -> float:
        dist = abs(float(i) - target) / max(1.0, local_radius)
        return float(smooth[i]) * 0.40 + 0.90 * min(1.0, dist)
    return float(min(allowed, key=fallback_score))


def _histogram_anchor_positions(profile: Dict[str, Any], max_points: int, mode: str) -> List[float]:
    """Return at most max_points control positions in true tonal gaps.

    Two anchors (shadow/highlight) are structural. Mid and the fourth point are
    optional and appear only when the smoothed image histogram contains a real
    saddle far enough from all existing anchors.
    """
    limit = max(2, min(4, int(max_points)))
    min_spacing = 32.0 if mode == "safe" else 34.0
    used: List[float] = []
    shadow = _nearest_histogram_valley(profile, 0.28, used, min_spacing, mode, optional=False)
    if shadow is not None:
        used.append(shadow)
    highlight = _nearest_histogram_valley(profile, 0.78, used, min_spacing, mode, optional=False)
    if highlight is not None:
        used.append(highlight)
    used.sort()
    if limit >= 3:
        mid = _nearest_histogram_valley(profile, 0.52, used, min_spacing, mode, optional=True)
        if mid is not None:
            used.append(mid)
            used.sort()
    if limit >= 4:
        # The fourth point is not tied to a fixed quantile: use the strongest
        # remaining real saddle, preferably inside the largest current interval.
        valleys = profile.get("valleys") or []
        low = float(profile.get("low", 10.0))
        high = float(profile.get("high", 245.0))
        rows: List[Tuple[float, float]] = []
        for row in valleys:
            x = float(row.get("x", 0.0))
            depth = float(row.get("depth", 0.0))
            if x < low + 0.15 * (high - low) or x > low + 0.88 * (high - low):
                continue
            if any(abs(x - prev) < min_spacing for prev in used):
                continue
            min_depth = 0.095 if mode == "safe" else 0.070
            if depth < min_depth:
                continue
            # Reward a point which sits well inside a broad unguarded interval.
            neighbors = [0.0] + sorted(used) + [255.0]
            gap = 0.0
            for a, b in zip(neighbors[:-1], neighbors[1:]):
                if a < x < b:
                    gap = min(x - a, b - x)
                    break
            score = float(row.get("score", 0.0)) * 2.0 + min(1.0, gap / 55.0) * 0.45
            rows.append((score, x))
        if rows:
            rows.sort(reverse=True)
            used.append(float(rows[0][1]))
            used.sort()
    return used[:limit]



def _channel_delta_samples(
    groups: Dict[float, Dict[str, Any]],
    ci: int,
    composite: Sequence[Sequence[float]],
    use_master: bool,
    tolerance: float,
    mode: str,
) -> List[Tuple[float, float, float]]:
    samples: List[Tuple[float, float, float]] = []
    for q in sorted(groups):
        g = groups[q]
        target_rgb = [float(v) for v in g["target_rgb"]]
        if use_master:
            after_master = [
                float(_interp_curve(composite, np.asarray([v], dtype=np.float32))[0])
                for v in target_rgb
            ]
        else:
            after_master = target_rgb
        ref_rgb = [float(v) for v in g["reference_rgb"]]
        residual_de = delta_e_2000(rgb_to_lab(after_master), rgb_to_lab(ref_rgb))
        factor = _soft_match_factor(residual_de, tolerance, mode)
        sx = float(after_master[ci])
        delta = factor * (float(ref_rgb[ci]) - sx)
        samples.append((sx, delta, float(g["weight"])))
    return samples


def _luma_delta_samples(
    groups: Dict[float, Dict[str, Any]], mode: str
) -> List[Tuple[float, float, float]]:
    """Exposure samples for the composite RGB curve.

    Luminance is intentionally independent from chromatic ΔE gating. Therefore a
    dark and a bright version of the same face still receive a meaningful master
    curve even when their chroma is already similar.
    """
    samples: List[Tuple[float, float, float]] = []
    deadband = 2.0 if mode == "safe" else 1.5
    for q in sorted(groups):
        g = groups[q]
        x = float(g["target_y"])
        raw_delta = float(g["reference_y"]) - x
        magnitude = abs(raw_delta)
        if magnitude <= deadband:
            delta = 0.0
        else:
            factor = (magnitude - deadband) / max(magnitude, 1e-9)
            if mode == "safe":
                factor *= 0.90
            delta = raw_delta * factor
        samples.append((x, delta, float(g["weight"])))
    return samples


def _fit_histogram_curves(
    rows: List[Dict[str, Any]],
    groups: Dict[float, Dict[str, Any]],
    histogram: Dict[str, Any],
    point_limit: int,
    mode: str,
    use_master: bool,
    tolerance: float,
) -> Tuple[Dict[str, List[List[int]]], Dict[str, Any]]:
    effective_tol = max(float(tolerance), 3.0) if mode == "safe" else float(tolerance)
    before_group_de = _aggregate_group_delta_e(groups)
    luma_before = _luma_mismatch(groups)
    color_severity = _severity_from_delta_e(before_group_de, effective_tol, mode)
    luma_severity = _severity_from_luma(luma_before, mode)

    composite: List[List[int]] = [[0, 0], [255, 255]]
    anchor_positions: Dict[str, List[int]] = {}

    if use_master:
        luma_profile = histogram.get("luma") or {}
        luma_positions = _histogram_anchor_positions(luma_profile, point_limit, mode)
        luma_samples = _luma_delta_samples(groups, mode)
        composite = _solve_control_curve(
            luma_positions, luma_samples, mode, luma_severity, kind="luma"
        )
        anchor_positions["composite"] = [int(round(x)) for x in luma_positions]

    channel_curves: Dict[str, List[List[int]]] = {}
    for out_key, ci in (("red", 0), ("green", 1), ("blue", 2)):
        profile = histogram.get(out_key) or {}
        positions = _histogram_anchor_positions(profile, point_limit, mode)
        samples = _channel_delta_samples(
            groups, ci, composite, use_master, effective_tol, mode
        )
        channel_curves[out_key] = _solve_control_curve(
            positions, samples, mode, color_severity, kind="color"
        )
        anchor_positions[out_key] = [int(round(x)) for x in positions]

    curves: Dict[str, List[List[int]]] = {"composite": composite}
    curves.update(channel_curves)

    before_values: List[float] = []
    after_values: List[float] = []
    luma_before_values: List[float] = []
    luma_after_values: List[float] = []
    weights: List[float] = []
    for row in rows:
        t = row["target"]
        r = row["reference"]
        target_rgb = [float(t["r"]), float(t["g"]), float(t["b"])]
        ref_rgb = [float(r["r"]), float(r["g"]), float(r["b"])]
        corrected = apply_curves_to_rgb(target_rgb, curves, use_master)
        before_values.append(delta_e_2000(rgb_to_lab(target_rgb), rgb_to_lab(ref_rgb)))
        after_values.append(delta_e_2000(rgb_to_lab(corrected), rgb_to_lab(ref_rgb)))
        target_y = 0.2126 * target_rgb[0] + 0.7152 * target_rgb[1] + 0.0722 * target_rgb[2]
        ref_y = 0.2126 * ref_rgb[0] + 0.7152 * ref_rgb[1] + 0.0722 * ref_rgb[2]
        corrected_y = 0.2126 * corrected[0] + 0.7152 * corrected[1] + 0.0722 * corrected[2]
        luma_before_values.append(abs(ref_y - target_y))
        luma_after_values.append(abs(ref_y - corrected_y))
        weights.append(float(row["weight"]))

    wa = np.asarray(weights, dtype=np.float64)
    if float(wa.sum()) <= 0:
        wa = np.ones_like(wa)
    before = float(np.sum(np.asarray(before_values) * wa) / np.sum(wa))
    after = float(np.sum(np.asarray(after_values) * wa) / np.sum(wa))
    measured_luma_before = float(np.sum(np.asarray(luma_before_values) * wa) / np.sum(wa))
    measured_luma_after = float(np.sum(np.asarray(luma_after_values) * wa) / np.sum(wa))

    bend = 0.0
    max_slope_deviation = 0.0
    for key in ("composite", "red", "green", "blue"):
        if key == "composite" and not use_master:
            continue
        slopes = _curve_slopes(curves[key])
        bend = max(
            bend,
            max([abs(b - a) for a, b in zip(slopes[:-1], slopes[1:])] or [0.0]),
        )
        max_slope_deviation = max(
            max_slope_deviation,
            max([abs(v - 1.0) for v in slopes] or [0.0]),
        )

    actual_points = max(
        [max(0, len(curves[k]) - 2) for k in ("red", "green", "blue")] or [0]
    )
    return curves, {
        "delta_e_before": before,
        "delta_e_after": after,
        "luma_error_before": measured_luma_before,
        "luma_error_after": measured_luma_after,
        "max_bend": bend,
        "max_slope_deviation": max_slope_deviation,
        "internal_points": actual_points,
        "point_limit": int(point_limit),
        "tolerance": effective_tol,
        "anchor_strategy": "histogram_valleys_direct_fit",
        "anchor_positions": anchor_positions,
        "color_severity": color_severity,
        "luma_severity": luma_severity,
    }

def fit_curves(
    rows: List[Dict[str, Any]],
    target_model: Dict[str, Any],
    max_points: int,
    mode: str,
    use_master: bool,
    tolerance: float = 2.0,
) -> Tuple[Dict[str, List[List[int]]], Dict[str, Any]]:
    mode = "safe" if str(mode).lower() == "safe" else "precise"
    max_points = int(max_points or 0)
    tolerance = max(0.0, min(10.0, float(tolerance)))
    groups = _tone_groups(rows)
    if len(groups) < 3:
        raise ApiError("Not enough tonal groups were available for curve fitting.", "INSUFFICIENT_TONES")
    histogram = target_model.get("image_histogram") or {}
    if not all(isinstance(histogram.get(k), dict) for k in ("red", "green", "blue")):
        raise ApiError("The target histogram could not be measured reliably.", "INSUFFICIENT_HISTOGRAM")

    # The UI value is a maximum, not a demand to create unnecessary points.
    limits = [max_points] if max_points in (2, 3, 4) else [2, 3, 4]
    candidates = [
        _fit_histogram_curves(rows, groups, histogram, limit, mode, use_master, tolerance)
        for limit in limits
    ]

    best_curves, best_diag = candidates[0]
    if len(candidates) > 1:
        # AUTO deliberately prefers sparse curves. A new point is accepted only
        # when it adds a *real, well-spaced histogram saddle* and materially lowers
        # perceptual error without increasing bend too much.
        for curves, diag in candidates[1:]:
            if int(diag["internal_points"]) <= int(best_diag["internal_points"]):
                continue
            current_after = float(best_diag["delta_e_after"])
            new_after = float(diag["delta_e_after"])
            gain = current_after - new_after
            bend_growth = float(diag["max_bend"]) - float(best_diag["max_bend"])
            threshold = (0.60 if mode == "safe" else 0.35)
            before_de = float(best_diag.get("delta_e_before", current_after))
            large_mismatch = before_de >= max(7.0, float(tolerance) + 4.0)
            allowed_bend_growth = (0.045 if mode == "safe" else (0.075 if large_mismatch else 0.055))
            if gain >= threshold and bend_growth <= allowed_bend_growth:
                best_curves, best_diag = curves, diag

    before = float(best_diag["delta_e_before"])
    after = float(best_diag["delta_e_after"])
    best_diag.update({
        "delta_e_before": round(before, 3),
        "delta_e_after": round(after, 3),
        "improvement_percent": round(max(0.0, (before - after) / max(before, 1e-6) * 100.0), 1),
        "correspondences": len(rows),
        "max_bend": round(float(best_diag.get("max_bend", 0.0)), 4),
        "max_slope_deviation": round(float(best_diag.get("max_slope_deviation", 0.0)), 4),
        "luma_error_before": round(float(best_diag.get("luma_error_before", 0.0)), 2),
        "luma_error_after": round(float(best_diag.get("luma_error_after", 0.0)), 2),
    })
    return best_curves, best_diag

def apply_curves_to_rgb(rgb: Sequence[float], curves: Dict[str, List[List[int]]], use_master: bool) -> List[float]:
    values = np.asarray(rgb, dtype=np.float32)
    if use_master:
        values = _interp_curve(curves["composite"], values)
    out = []
    for value, key in zip(values, ("red", "green", "blue")):
        out.append(float(_interp_curve(curves[key], np.asarray([value], dtype=np.float32))[0]))
    return out


def rgb_to_lab(rgb: Sequence[float]) -> Tuple[float, float, float]:
    arr = np.asarray(rgb, dtype=np.float32).reshape(1, 1, 3) / 255.0
    lab = cv2.cvtColor(arr, cv2.COLOR_RGB2LAB).reshape(3)
    return float(lab[0]), float(lab[1]), float(lab[2])


def delta_e_2000(lab1: Sequence[float], lab2: Sequence[float]) -> float:
    # Sharma et al. CIEDE2000, scalar implementation.
    L1, a1, b1 = [float(v) for v in lab1]
    L2, a2, b2 = [float(v) for v in lab2]
    C1 = math.hypot(a1, b1)
    C2 = math.hypot(a2, b2)
    Cbar = (C1 + C2) / 2.0
    G = 0.5 * (1.0 - math.sqrt((Cbar ** 7) / (Cbar ** 7 + 25.0 ** 7))) if Cbar > 0 else 0.0
    ap1 = (1.0 + G) * a1
    ap2 = (1.0 + G) * a2
    Cp1 = math.hypot(ap1, b1)
    Cp2 = math.hypot(ap2, b2)

    def hp(a: float, b: float) -> float:
        angle = math.degrees(math.atan2(b, a))
        return angle + 360.0 if angle < 0 else angle

    hp1, hp2 = hp(ap1, b1), hp(ap2, b2)
    dL = L2 - L1
    dC = Cp2 - Cp1
    dh = hp2 - hp1
    if Cp1 * Cp2 == 0:
        dh = 0.0
    elif dh > 180:
        dh -= 360.0
    elif dh < -180:
        dh += 360.0
    dH = 2.0 * math.sqrt(Cp1 * Cp2) * math.sin(math.radians(dh / 2.0))
    Lbar = (L1 + L2) / 2.0
    Cbarp = (Cp1 + Cp2) / 2.0
    if Cp1 * Cp2 == 0:
        hbar = hp1 + hp2
    elif abs(hp1 - hp2) <= 180:
        hbar = (hp1 + hp2) / 2.0
    elif hp1 + hp2 < 360:
        hbar = (hp1 + hp2 + 360.0) / 2.0
    else:
        hbar = (hp1 + hp2 - 360.0) / 2.0
    T = (
        1
        - 0.17 * math.cos(math.radians(hbar - 30))
        + 0.24 * math.cos(math.radians(2 * hbar))
        + 0.32 * math.cos(math.radians(3 * hbar + 6))
        - 0.20 * math.cos(math.radians(4 * hbar - 63))
    )
    dtheta = 30.0 * math.exp(-(((hbar - 275.0) / 25.0) ** 2))
    Rc = 2.0 * math.sqrt((Cbarp ** 7) / (Cbarp ** 7 + 25.0 ** 7)) if Cbarp > 0 else 0.0
    Sl = 1.0 + 0.015 * ((Lbar - 50.0) ** 2) / math.sqrt(20.0 + ((Lbar - 50.0) ** 2))
    Sc = 1.0 + 0.045 * Cbarp
    Sh = 1.0 + 0.015 * Cbarp * T
    Rt = -math.sin(math.radians(2.0 * dtheta)) * Rc
    return math.sqrt(
        (dL / Sl) ** 2
        + (dC / Sc) ** 2
        + (dH / Sh) ** 2
        + Rt * (dC / Sc) * (dH / Sh)
    )


def safe_preset_filename(name: str, preset_id: str) -> str:
    clean = "".join(ch if ch not in '<>:"/\\|?*' and ord(ch) >= 32 else "_" for ch in name).strip(" .")
    clean = clean[:80] or "Preset"
    return f"{clean} [{preset_id[:8]}].json"


def preset_summary(path: Path, data: Dict[str, Any]) -> Dict[str, Any]:
    quality = ((data.get("reference_model") or {}).get("quality") or {})
    return {
        "id": str(data.get("preset_id") or ""),
        "name": str(data.get("name") or path.stem),
        "path": str(path),
        "updated_at": str(data.get("updated_at") or data.get("created_at") or ""),
        "detector": str(((data.get("reference_model") or {}).get("face") or {}).get("detector") or ""),
        "quality_score": float(quality.get("score", 0.0) or 0.0),
    }


def list_presets(folder: str) -> List[Dict[str, Any]]:
    root = Path(folder).expanduser()
    if not root.exists():
        return []
    items: List[Dict[str, Any]] = []
    for path in root.glob("*.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if data.get("kind") != "face-color-match-preset" or int(data.get("format_version") or 0) != 1:
                continue
            if not data.get("preset_id"):
                continue
            items.append(preset_summary(path, data))
        except Exception:
            continue
    items.sort(key=lambda item: str(item.get("name") or "").lower())
    return items


def load_preset(path: Path) -> Dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise ApiError(f"Could not read preset: {path}\n{exc}", "PRESET_READ_ERROR")
    if data.get("kind") != "face-color-match-preset" or int(data.get("format_version") or 0) != 1:
        raise ApiError(f"Unsupported preset format: {path}", "PRESET_FORMAT_ERROR")
    if not isinstance(data.get("reference_model"), dict):
        raise ApiError(f"Preset does not contain reference measurements: {path}", "PRESET_FORMAT_ERROR")
    return data


def resolve_preset(folder: str, preset_id: str, preset_path: str = "") -> Tuple[Path, Dict[str, Any]]:
    if preset_path:
        p = Path(preset_path)
        if p.is_file():
            data = load_preset(p)
            if not preset_id or str(data.get("preset_id")) == str(preset_id):
                return p, data
    root = Path(folder)
    for item in list_presets(folder):
        if str(item.get("id")) == str(preset_id):
            p = Path(str(item["path"]))
            return p, load_preset(p)
    raise ApiError(f"Preset was not found: {preset_id}", "PRESET_NOT_FOUND")


def create_or_update_preset(message: Dict[str, Any], update: bool) -> Dict[str, Any]:
    image_path = str(message.get("image_path") or "")
    folder = Path(str(message.get("preset_folder") or "")).expanduser()
    if not image_path or not str(folder):
        raise ApiError("Image path and preset folder are required.", "INVALID_ARGUMENT")
    folder.mkdir(parents=True, exist_ok=True)
    image = imread_unicode(image_path)
    model = analyze_face(image)
    now = time.strftime("%Y-%m-%dT%H:%M:%S%z")

    if update:
        preset_id = str(message.get("preset_id") or "")
        path, old = resolve_preset(str(folder), preset_id, str(message.get("preset_path") or ""))
        data = old
        data["reference_model"] = model
        data["algorithm_version"] = VERSION
        data["updated_at"] = now
        data["source"] = {
            "file_name": str(message.get("source_name") or Path(image_path).name),
            "working_space": "sRGB IEC61966-2.1",
            "preview_size": [int(image.shape[1]), int(image.shape[0])],
        }
        atomic_json_write(path, data)
        return {"preset": preset_summary(path, data), "face": model["face"]}

    name = str(message.get("name") or "Preset").strip() or "Preset"
    preset_id = uuid.uuid4().hex
    path = folder / safe_preset_filename(name, preset_id)
    data = {
        "kind": "face-color-match-preset",
        "format_version": 1,
        "algorithm_version": VERSION,
        "preset_id": preset_id,
        "name": name,
        "created_at": now,
        "updated_at": now,
        "source": {
            "file_name": str(message.get("source_name") or Path(image_path).name),
            "working_space": "sRGB IEC61966-2.1",
            "preview_size": [int(image.shape[1]), int(image.shape[0])],
        },
        "reference_model": model,
    }
    atomic_json_write(path, data)
    return {"preset": preset_summary(path, data), "face": model["face"]}


def command_match(message: Dict[str, Any]) -> Dict[str, Any]:
    image_path = str(message.get("image_path") or "")
    preset_folder = str(message.get("preset_folder") or "")
    preset_id = str(message.get("preset_id") or "")
    preset_path = str(message.get("preset_path") or "")
    mode = str(message.get("mode") or "precise").lower()
    max_points = int(message.get("max_points") or 0)
    use_master = bool(message.get("use_master", False))
    tolerance = float(message.get("color_tolerance", 2.0) or 2.0)
    if mode not in {"safe", "precise"}:
        mode = "precise"
    if max_points not in {0, 2, 3, 4}:
        max_points = 0

    path, preset = resolve_preset(preset_folder, preset_id, preset_path)
    image = imread_unicode(image_path)
    target_model = analyze_face(image)
    rows = build_correspondences(target_model, preset["reference_model"])
    curves, diagnostics = fit_curves(rows, target_model, max_points, mode, use_master, tolerance)
    return {
        "preset": preset_summary(path, preset),
        "curves": curves,
        "use_master": use_master,
        "mode": mode,
        "max_points": max_points,
        "diagnostics": diagnostics,
        "face": target_model["face"],
    }


def handle_command(command: Dict[str, Any]) -> None:
    touch_activity()
    request_id = str(command.get("request_id") or "")
    try:
        if int(command.get("protocol") or 0) != API_PROTOCOL:
            raise ApiError(
                f"Incompatible API protocol: {command.get('protocol')}; expected {API_PROTOCOL}.",
                "PROTOCOL_MISMATCH",
            )
        command_type = str(command.get("type") or "")
        message = command.get("message") if isinstance(command.get("message"), dict) else {}
        if command_type == "ping":
            result = {
                "version": VERSION,
                "protocol": API_PROTOCOL,
                "python": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
                "opencv": str(cv2.__version__),
                "numpy": str(np.__version__),
                "detector": "yunet" if (YUNET_MODEL.is_file() and YUNET_MODEL.stat().st_size > 100000) else "haar-fallback",
                "yunet_model": str(YUNET_MODEL),
                "yunet_available": bool(YUNET_MODEL.is_file() and YUNET_MODEL.stat().st_size > 100000),
                "idle_timeout_seconds": IDLE_TIMEOUT_SECONDS,
                "log_file": str(LOG_FILE),
            }
        elif command_type == "list_presets":
            result = {"presets": list_presets(str(message.get("preset_folder") or ""))}
        elif command_type == "create_preset":
            result = create_or_update_preset(message, update=False)
        elif command_type == "update_preset":
            result = create_or_update_preset(message, update=True)
        elif command_type == "delete_preset":
            preset_id = str(message.get("preset_id") or "")
            path, _preset = resolve_preset(str(message.get("preset_folder") or ""), preset_id, str(message.get("preset_path") or ""))
            try:
                path.unlink()
            except OSError as exc:
                raise ApiError(f"Could not delete preset: {path}\n{exc}", "PRESET_DELETE_ERROR")
            result = {"deleted": True, "preset_id": preset_id}
        elif command_type == "match":
            result = command_match(message)
        elif command_type == "shutdown":
            result = {"stopping": True}
            _STOP.set()
        else:
            raise ApiError(f"Unknown API command: {command_type}", "UNKNOWN_COMMAND")
        reply(request_id, result)
    except Exception as exc:
        if not isinstance(exc, ApiError):
            log_exception(f"Command failed: {command.get('type')}")
        error_reply(request_id, exc)
    finally:
        touch_activity()


def idle_watcher() -> None:
    while not _STOP.wait(5.0):
        with _ACTIVITY_LOCK:
            idle = time.monotonic() - _LAST_ACTIVITY
        if idle > IDLE_TIMEOUT_SECONDS:
            _write_log(f"Shutting down after {idle:.0f} seconds of inactivity")
            _STOP.set()
            try:
                with socket.create_connection((API_HOST, API_RECEIVE_PORT), timeout=0.5):
                    pass
            except OSError:
                pass
            return


def start_server() -> None:
    if (sys.version_info.major, sys.version_info.minor) not in SUPPORTED_PYTHON:
        write_startup_status(
            "error",
            f"Unsupported Python {sys.version_info.major}.{sys.version_info.minor}. Install Python 3.11 or 3.14.",
        )
        return
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        server.bind((API_HOST, API_RECEIVE_PORT))
    except OSError as exc:
        write_startup_status("error", f"Could not open local API port {API_RECEIVE_PORT}: {exc}")
        try:
            server.close()
        except OSError:
            pass
        return
    server.listen(8)
    server.settimeout(1.0)
    write_startup_status(
        "ready",
        "Face Color Match Python API is ready",
        opencv=str(cv2.__version__),
        numpy=str(np.__version__),
        detector="yunet" if (YUNET_MODEL.is_file() and YUNET_MODEL.stat().st_size > 100000) else "haar-fallback",
    )
    _write_log(
        f"{APP_NAME} {VERSION} started; Python {sys.version.split()[0]}, OpenCV {cv2.__version__}, NumPy {np.__version__}, detector={'YuNet' if (YUNET_MODEL.is_file() and YUNET_MODEL.stat().st_size > 100000) else 'Haar fallback'}"
    )
    watcher = threading.Thread(target=idle_watcher, name="IdleWatcher", daemon=True)
    watcher.start()
    try:
        while not _STOP.is_set():
            try:
                conn, _addr = server.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            try:
                chunks: List[bytes] = []
                total = 0
                conn.settimeout(2.0)
                while True:
                    part = conn.recv(65536)
                    if not part:
                        break
                    chunks.append(part)
                    total += len(part)
                    if total > MAX_MESSAGE_BYTES:
                        raise ApiError("API message is too large.", "MESSAGE_TOO_LARGE")
                    if b"\n" in part:
                        break
                raw = b"".join(chunks).split(b"\n", 1)[0]
                if not raw:
                    continue
                command = json.loads(raw.decode("utf-8"))
                if not isinstance(command, dict):
                    raise ApiError("Invalid API command.", "INVALID_COMMAND")
                handle_command(command)
            except Exception as exc:
                log_exception("Socket command failed")
                try:
                    error_reply("", exc)
                except Exception:
                    pass
            finally:
                try:
                    conn.close()
                except OSError:
                    pass
    finally:
        try:
            server.close()
        except OSError:
            pass
        _write_log(f"{APP_NAME} stopped")


if __name__ == "__main__":
    try:
        start_server()
    except Exception:
        log_exception("Fatal server error")
        write_startup_status("error", "Fatal Python server error. See log file.")
