"""Flask API for the face scanner application.

Reference photos are encoded once when this module is imported, before the
server begins accepting camera scans. In a hosted deployment, the files and
camera frames are processed by that deployment's server.
"""

from __future__ import annotations

import base64
import io
import json
import logging
import os
import re
from collections import defaultdict
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, render_template, request, send_from_directory

# Keep the Flask UI alive if its native recognition packages are unavailable,
# and expose a clear API status instead of allowing an import-time crash.
FACE_RUNTIME_ERROR: str | None = None
try:
    import cv2
    import face_recognition
    import numpy as np
except Exception as error:  # Includes missing native libraries during cloud import.
    cv2 = None
    face_recognition = None
    np = None
    FACE_RUNTIME_ERROR = str(error)


# ---- Recognition settings -------------------------------------------------
# Lower values are stricter.  0.50 is a conservative threshold for the
# face_recognition/dlib 128-dimensional embedding distance.
FACE_MATCH_THRESHOLD = 0.50
FACE_DETECTION_MODEL = "hog"  # "cnn" is slower and requires a CUDA-capable build.
MIN_BRIGHTNESS = 20
MAX_UPLOAD_BYTES = 6 * 1024 * 1024
SUPPORTED_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}

BASE_DIR = Path(__file__).resolve().parent
KNOWN_FACES_DIR = BASE_DIR / "known_faces"
DETAILS_FILE = BASE_DIR / "details.json"

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_BYTES
app.logger.setLevel(logging.INFO)

# The website uses browser-side recognition.  The legacy Python scanner stays
# available only when a local operator explicitly opts in with
# SERVER_SIDE_RECOGNITION=1; this prevents slow native model loading in Vercel.
SERVER_SIDE_RECOGNITION = os.getenv("SERVER_SIDE_RECOGNITION") == "1"


def person_id_from_filename(image_path: Path) -> str:
    """Map person1_1.jpg and person1_2.jpg to the person id ``person1``.

    A trailing underscore followed by a number is treated as a photo sequence.
    Names without that suffix use their complete filename stem as the id.
    """

    return re.sub(r"_\d+$", "", image_path.stem).strip()


def load_details() -> dict[str, dict[str, Any]]:
    """Read and validate the local details file without exposing malformed data."""

    if not DETAILS_FILE.exists():
        app.logger.warning("details.json is missing; matched records will have no extra fields.")
        return {}
    try:
        with DETAILS_FILE.open("r", encoding="utf-8") as file:
            raw_details = json.load(file)
    except (json.JSONDecodeError, OSError) as error:
        app.logger.error("Could not read details.json: %s", error)
        return {}

    if not isinstance(raw_details, dict):
        app.logger.error("details.json must contain an object keyed by person id.")
        return {}
    return {
        str(person_id): values
        for person_id, values in raw_details.items()
        if isinstance(values, dict)
    }


def enrolled_profiles() -> list[dict[str, Any]]:
    """Return the browser-safe enrolment manifest.

    The hosted scanner performs recognition in the visitor's browser. This
    keeps a live camera frame off the Vercel function and avoids native dlib
    binaries, which are not available in Vercel's Python runtime.
    """

    images_by_person: defaultdict[str, list[str]] = defaultdict(list)
    if KNOWN_FACES_DIR.exists():
        for image_path in sorted(KNOWN_FACES_DIR.iterdir()):
            if image_path.is_file() and image_path.suffix.lower() in SUPPORTED_IMAGE_EXTENSIONS:
                images_by_person[person_id_from_filename(image_path)].append(image_path.name)

    profiles: list[dict[str, Any]] = []
    for person_id, image_names in images_by_person.items():
        record = PERSON_DETAILS.get(person_id, {})
        profiles.append(
            {
                "person_id": person_id,
                "name": record.get("name", person_id),
                "details": record,
                "reference_images": [f"/references/{name}" for name in image_names],
            }
        )
    return sorted(profiles, key=lambda profile: str(profile["name"]).lower())


def load_known_faces() -> tuple[dict[str, np.ndarray], list[str], dict[str, int]]:
    """Create one average encoding per person from their reference photos."""

    KNOWN_FACES_DIR.mkdir(exist_ok=True)
    encodings_by_person: defaultdict[str, list[np.ndarray]] = defaultdict(list)
    warnings: list[str] = []

    image_paths = sorted(
        path for path in KNOWN_FACES_DIR.iterdir()
        if path.is_file() and path.suffix.lower() in SUPPORTED_IMAGE_EXTENSIONS
    )
    for image_path in image_paths:
        person_id = person_id_from_filename(image_path)
        try:
            image = face_recognition.load_image_file(image_path)
            locations = face_recognition.face_locations(image, model=FACE_DETECTION_MODEL)
            if len(locations) != 1:
                warnings.append(
                    f"{image_path.name}: expected exactly one face, found {len(locations)}; skipped."
                )
                continue
            image_encodings = face_recognition.face_encodings(image, known_face_locations=locations)
            if not image_encodings:
                warnings.append(f"{image_path.name}: face could not be encoded; skipped.")
                continue
            encodings_by_person[person_id].append(image_encodings[0])
        except Exception as error:  # Invalid/corrupt images must not stop the server.
            warnings.append(f"{image_path.name}: could not be loaded ({error}); skipped.")

    averaged = {
        person_id: np.mean(person_encodings, axis=0)
        for person_id, person_encodings in encodings_by_person.items()
    }
    reference_counts = {
        person_id: len(person_encodings)
        for person_id, person_encodings in encodings_by_person.items()
    }
    for warning in warnings:
        app.logger.warning(warning)
    app.logger.info(
        "Loaded %d reference image(s) for %d person(s).",
        sum(len(value) for value in encodings_by_person.values()),
        len(averaged),
    )
    return averaged, warnings, reference_counts


PERSON_DETAILS = load_details()
if not SERVER_SIDE_RECOGNITION:
    KNOWN_ENCODINGS = {}
    STARTUP_WARNINGS = []
    REFERENCE_COUNTS = {}
elif FACE_RUNTIME_ERROR:
    KNOWN_ENCODINGS: dict[str, np.ndarray] = {}
    STARTUP_WARNINGS = [
        "Face-recognition runtime is unavailable in this deployment. "
        "Check the server's native Python dependencies."
    ]
    REFERENCE_COUNTS: dict[str, int] = {}
else:
    KNOWN_ENCODINGS, STARTUP_WARNINGS, REFERENCE_COUNTS = load_known_faces()


def decode_frame(payload: str) -> np.ndarray:
    """Decode a browser data URL into an OpenCV BGR image."""

    if not isinstance(payload, str) or not payload:
        raise ValueError("No camera frame was received.")
    encoded = payload.split(",", 1)[-1]
    try:
        image_bytes = base64.b64decode(encoded, validate=True)
    except (ValueError, base64.binascii.Error) as error:
        raise ValueError("The camera frame is not valid base64 image data.") from error
    image_array = np.frombuffer(image_bytes, dtype=np.uint8)
    image_bgr = cv2.imdecode(image_array, cv2.IMREAD_COLOR)
    if image_bgr is None:
        raise ValueError("The camera frame could not be decoded as an image.")
    return image_bgr


def estimate_clothes_colour(image_bgr: np.ndarray, location: tuple[int, int, int, int]) -> str:
    """Estimate the dominant clothing colour immediately below a detected face.

    This is a visual estimate from the current camera frame, not an identity
    attribute. If the torso is outside the frame, it deliberately reports that
    the colour cannot be determined rather than inventing a result.
    """

    top, right, bottom, left = location
    face_height = max(1, bottom - top)
    face_width = max(1, right - left)
    height, width = image_bgr.shape[:2]
    crop_top = min(height, bottom + int(face_height * 0.08))
    crop_bottom = min(height, bottom + int(face_height * 1.45))
    crop_left = max(0, left - int(face_width * 0.30))
    crop_right = min(width, right + int(face_width * 0.30))
    if crop_bottom - crop_top < 12 or crop_right - crop_left < 12:
        return "Not clearly visible in this scan"

    clothing_crop = image_bgr[crop_top:crop_bottom, crop_left:crop_right]
    hsv_pixels = cv2.cvtColor(clothing_crop, cv2.COLOR_BGR2HSV).reshape(-1, 3)
    hue, saturation, brightness = np.median(hsv_pixels, axis=0)
    if brightness < 50:
        return "Black or very dark"
    if saturation < 30:
        return "White" if brightness > 185 else "Grey"
    if hue < 10 or hue >= 170:
        return "Red" if brightness > 115 else "Maroon"
    if hue < 22:
        return "Brown" if brightness < 170 else "Orange"
    if hue < 35:
        return "Yellow or beige"
    if hue < 85:
        return "Green"
    if hue < 135:
        return "Blue"
    if hue < 160:
        return "Purple"
    return "Pink"


@app.get("/")
def index() -> str:
    profiles = enrolled_profiles()
    return render_template(
        "index.html",
        threshold=FACE_MATCH_THRESHOLD,
        enrolled_profiles=profiles,
    )


@app.get("/references/<path:filename>")
def reference_image(filename: str) -> Any:
    """Serve only a file from the enrolled-reference directory."""

    return send_from_directory(KNOWN_FACES_DIR, filename)


@app.get("/api/status")
def status() -> Any:
    """Small diagnostics response used by the UI before a user starts scanning."""

    return jsonify(
        ready=bool(enrolled_profiles()),
        enrolled_people=[profile["person_id"] for profile in enrolled_profiles()],
        reference_count=len(enrolled_profiles()),
        reference_images=sum(len(profile["reference_images"]) for profile in enrolled_profiles()),
        recognition_runtime_ready=True,
        server_side_recognition=SERVER_SIDE_RECOGNITION and FACE_RUNTIME_ERROR is None,
        warnings=STARTUP_WARNINGS,
        threshold=FACE_MATCH_THRESHOLD,
    )


@app.get("/api/details/<person_id>")
def details(person_id: str) -> Any:
    """Return the locally stored details only for a recognised person id."""

    record = PERSON_DETAILS.get(person_id)
    if record is None:
        return jsonify(error="No details record exists for this recognised face."), 404
    return jsonify(person_id=person_id, details=record)


@app.post("/scan")
def scan() -> Any:
    """Match one browser frame against the startup-loaded reference encodings."""

    if not SERVER_SIDE_RECOGNITION:
        return jsonify(
            match=False,
            reason="browser_recognition",
            message="This website recognises faces in the browser. Use the web scanner instead of this API.",
        ), 410

    if FACE_RUNTIME_ERROR:
        return jsonify(
            match=False,
            reason="recognition_runtime_unavailable",
            message="Face recognition is unavailable because this server is missing its native Python dependencies.",
        ), 503

    if not KNOWN_ENCODINGS:
        return jsonify(
            match=False,
            reason="no_reference_faces",
            message="No valid reference faces are loaded. Add clear photos to known_faces and restart the app.",
        ), 503

    data = request.get_json(silent=True) or {}
    try:
        image_bgr = decode_frame(data.get("image", ""))
    except ValueError as error:
        return jsonify(match=False, reason="invalid_frame", message=str(error)), 400

    grayscale = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    if float(np.mean(grayscale)) < MIN_BRIGHTNESS:
        return jsonify(
            match=False,
            reason="low_light",
            message="The image is too dark. Improve the lighting and try again.",
        )

    # Phone cameras may deliver portrait JPEG pixels in a landscape orientation.
    # Try the four upright orientations so a valid mobile capture is not
    # rejected simply because its EXIF orientation is not applied by OpenCV.
    scan_image_bgr = image_bgr
    rgb_image = cv2.cvtColor(scan_image_bgr, cv2.COLOR_BGR2RGB)
    locations = face_recognition.face_locations(rgb_image, model=FACE_DETECTION_MODEL)
    if not locations:
        for rotation in (cv2.ROTATE_90_CLOCKWISE, cv2.ROTATE_180, cv2.ROTATE_90_COUNTERCLOCKWISE):
            candidate_bgr = cv2.rotate(image_bgr, rotation)
            candidate_rgb = cv2.cvtColor(candidate_bgr, cv2.COLOR_BGR2RGB)
            candidate_locations = face_recognition.face_locations(candidate_rgb, model=FACE_DETECTION_MODEL)
            if candidate_locations:
                scan_image_bgr = candidate_bgr
                rgb_image = candidate_rgb
                locations = candidate_locations
                break
    if not locations:
        return jsonify(
            match=False,
            reason="no_face",
            message="No face detected. Center one well-lit face in the camera and try again.",
        )
    probe_encodings = face_recognition.face_encodings(rgb_image, known_face_locations=locations)
    if not probe_encodings:
        return jsonify(
            match=False,
            reason="encoding_failed",
            message="A face was found but could not be read. Face the camera directly and try again.",
        )

    person_ids = list(KNOWN_ENCODINGS)
    reference_encodings = np.array([KNOWN_ENCODINGS[person_id] for person_id in person_ids])
    faces: list[dict[str, Any]] = []
    for location, probe_encoding in zip(locations, probe_encodings):
        distances = face_recognition.face_distance(reference_encodings, probe_encoding)
        best_index = int(np.argmin(distances))
        best_distance = float(distances[best_index])
        person_id = person_ids[best_index]
        is_match = best_distance < FACE_MATCH_THRESHOLD
        person_record = PERSON_DETAILS.get(person_id, {})
        top, right, bottom, left = location
        faces.append(
            {
                "match": is_match,
                "person_id": person_id if is_match else None,
                "name": person_record.get("name", person_id) if is_match else "Face not recognized",
                "confidence": round(max(0.0, (1.0 - best_distance) * 100), 1),
                "distance": round(best_distance, 4),
                "location": {"top": top, "right": right, "bottom": bottom, "left": left},
                "clothes_colour": estimate_clothes_colour(scan_image_bgr, location),
            }
        )

    matched_faces = [face for face in faces if face["match"]]
    response: dict[str, Any] = {
        "match": bool(matched_faces),
        "faces": faces,
        "message": "Face recognized." if matched_faces else "Face not recognized.",
    }
    # Keep the original single-face response fields for compatibility.
    if len(faces) == 1:
        response.update(faces[0])
        response["reason"] = "recognized" if faces[0]["match"] else "not_recognized"
    return jsonify(response)


@app.errorhandler(413)
def request_too_large(_: Any) -> Any:
    return jsonify(match=False, reason="frame_too_large", message="Camera frame is too large. Try again."), 413


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)
