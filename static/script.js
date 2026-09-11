(() => {
  const video = document.querySelector("#camera");
  const startButton = document.querySelector("#startCamera");
  const scanButton = document.querySelector("#scanFace");
  const placeholder = document.querySelector("#cameraPlaceholder");
  const overlay = document.querySelector("#scanOverlay");
  const statusMessage = document.querySelector("#statusMessage");
  const resultCard = document.querySelector("#resultCard");
  const resultIcon = document.querySelector("#resultIcon");
  const resultLabel = document.querySelector("#resultLabel");
  const resultName = document.querySelector("#resultName");
  const confidence = document.querySelector("#confidence");
  const detailsList = document.querySelector("#detailsList");
  const scanSummary = document.querySelector("#scanSummary");
  const summaryList = document.querySelector("#summaryList");
  const lastScanCard = document.querySelector("#lastScanCard");
  const lastScannedImage = document.querySelector("#lastScannedImage");

  const MODEL_URL = "https://justadudewhohacks.github.io/face-api.js/models";
  const profiles = Array.isArray(window.ENROLLED_PROFILES) ? window.ENROLLED_PROFILES : [];
  const threshold = Number(window.FACE_MATCH_THRESHOLD || 0.5);
  let stream = null;
  let matcher = null;
  let isScanning = false;
  let scanningPaused = false;
  let scanTimer = null;

  function setStatus(message, kind = "") {
    statusMessage.textContent = message;
    statusMessage.className = `status-message ${kind}`;
  }

  function clearResult() {
    resultCard.hidden = true;
    detailsList.replaceChildren();
    summaryList.replaceChildren();
    scanSummary.hidden = true;
    lastScanCard.hidden = true;
    lastScannedImage.removeAttribute("src");
  }

  function modelError(error) {
    console.error("Face recognition setup failed", error);
    setStatus("Recognition model could not load. Check your internet connection, then reload this page.", "error");
  }

  async function descriptorFromImage(url) {
    const image = await faceapi.fetchImage(url);
    const result = await faceapi
      .detectSingleFace(image, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.45 }))
      .withFaceLandmarks()
      .withFaceDescriptor();
    if (!result) throw new Error(`No clear single face was found in ${url}.`);
    return result.descriptor;
  }

  async function loadRecognition() {
    if (!window.faceapi) throw new Error("The face recognition library did not load.");
    if (!profiles.length) throw new Error("No enrolled profiles are available.");
    setStatus("Loading face recognition model…");
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
    ]);
    setStatus("Encoding enrolled reference photos…");
    const labeledDescriptors = await Promise.all(profiles.map(async (profile) => {
      const descriptors = await Promise.all(profile.reference_images.map(descriptorFromImage));
      return new faceapi.LabeledFaceDescriptors(profile.person_id, descriptors);
    }));
    matcher = new faceapi.FaceMatcher(labeledDescriptors, threshold);
    setStatus(`${profiles.length} enrolled profile(s) ready. Start the camera to scan.`);
  }

  function addSummaryLine(label, value) {
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = label;
    description.textContent = value;
    summaryList.append(term, description);
  }

  function appendProfileDetails(details, clothesColour) {
    for (const [key, value] of Object.entries(details || {})) {
      if (key.toLowerCase() === "name") continue;
      const term = document.createElement("dt");
      const description = document.createElement("dd");
      term.textContent = key.replace(/[_-]/g, " ");
      description.textContent = String(value);
      detailsList.append(term, description);
    }
    const clothesTerm = document.createElement("dt");
    const clothesDescription = document.createElement("dd");
    clothesTerm.textContent = "clothes colour";
    clothesDescription.textContent = clothesColour === "not visible" ? "Show upper body in camera" : clothesColour;
    detailsList.append(clothesTerm, clothesDescription);
  }

  function rgbToHsv(red, green, blue) {
    const r = red / 255;
    const g = green / 255;
    const b = blue / 255;
    const maximum = Math.max(r, g, b);
    const minimum = Math.min(r, g, b);
    const delta = maximum - minimum;
    let hue = 0;
    if (delta) {
      if (maximum === r) hue = ((g - b) / delta) % 6;
      else if (maximum === g) hue = (b - r) / delta + 2;
      else hue = (r - g) / delta + 4;
      hue = (hue * 60 + 360) % 360;
    }
    return { hue, saturation: maximum ? delta / maximum : 0, value: maximum };
  }

  function colourName(hue, saturation, value) {
    if (value < 0.18) return "black";
    if (saturation < 0.16) return value > 0.84 ? "white" : "grey";
    // Dark warm fabric is perceived as brown before it is perceived as orange.
    if (hue >= 12 && hue < 52 && value < 0.62) return "brown";
    if (hue < 12 || hue >= 348) return "red";
    if (hue < 38) return "orange";
    if (hue < 65) return "yellow";
    if (hue < 165) return "green";
    if (hue < 200) return "teal";
    if (hue < 255) return "blue";
    if (hue < 292) return "purple";
    return "pink";
  }

  function detectClothesColour(context, faceBox, frameWidth, frameHeight) {
    // Sample the upper torso below the detected face, avoiding skin pixels in
    // the face itself. A full upper-body preview gives the most reliable label.
    const left = Math.max(0, Math.floor(faceBox.x - faceBox.width * 0.38));
    const top = Math.max(0, Math.floor(faceBox.y + faceBox.height * 0.92));
    const right = Math.min(frameWidth, Math.ceil(faceBox.x + faceBox.width * 1.38));
    const bottom = Math.min(frameHeight, Math.ceil(faceBox.y + faceBox.height * 2.7));
    if (right - left < 20 || bottom - top < 20) return "not visible";

    const pixels = context.getImageData(left, top, right - left, bottom - top).data;
    const hueBins = Array.from({ length: 36 }, () => ({ weight: 0, hue: 0, saturation: 0, value: 0 }));
    const neutral = { black: 0, white: 0, grey: 0 };
    for (let index = 0; index < pixels.length; index += 16) {
      const { hue, saturation, value } = rgbToHsv(pixels[index], pixels[index + 1], pixels[index + 2]);
      if (value < 0.18) { neutral.black += 1; continue; }
      if (saturation < 0.16) {
        neutral[value > 0.84 ? "white" : "grey"] += 1;
        continue;
      }
      const bin = hueBins[Math.min(35, Math.floor(hue / 10))];
      const weight = saturation * (0.55 + value * 0.45);
      bin.weight += weight;
      bin.hue += hue * weight;
      bin.saturation += saturation * weight;
      bin.value += value * weight;
    }
    const colourful = hueBins.reduce((best, bin) => bin.weight > best.weight ? bin : best, hueBins[0]);
    const strongestNeutral = Object.entries(neutral).reduce((best, entry) => entry[1] > best[1] ? entry : best, ["grey", 0]);
    if (!colourful.weight || strongestNeutral[1] > colourful.weight * 2.2) return strongestNeutral[0];
    return colourName(
      colourful.hue / colourful.weight,
      colourful.saturation / colourful.weight,
      colourful.value / colourful.weight
    );
  }

  async function fetchProfile(personId) {
    const response = await fetch(`/api/details/${encodeURIComponent(personId)}`);
    if (!response.ok) throw new Error("The recognised profile could not be loaded.");
    const payload = await response.json();
    return {
      person_id: personId,
      name: payload.details?.name || personId,
      details: payload.details || {}
    };
  }

  function captureAnnotatedImage(detections, matches) {
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    context.lineWidth = Math.max(3, Math.round(canvas.width / 220));
    context.font = `bold ${Math.max(16, Math.round(canvas.width / 32))}px system-ui, sans-serif`;
    const clothesColours = detections.map((detection) =>
      detectClothesColour(context, detection.detection.box, canvas.width, canvas.height)
    );
    detections.forEach((detection, index) => {
      const box = detection.detection.box;
      const matchedProfile = matches[index];
      const label = matchedProfile ? `${matchedProfile.name} · ${clothesColours[index]}` : "Not recognized";
      const colour = matchedProfile ? "#38e7a3" : "#ff7885";
      context.strokeStyle = colour;
      context.strokeRect(box.x, box.y, box.width, box.height);
      const width = Math.min(canvas.width - 8, context.measureText(label).width + 20);
      const x = Math.max(4, Math.min(canvas.width - width - 4, box.x));
      const y = Math.max(4, box.y - 34);
      context.fillStyle = "rgba(5, 9, 20, .88)";
      context.fillRect(x, y, width, 29);
      context.fillStyle = colour;
      context.fillText(label, x + 10, y + 21);
    });
    lastScannedImage.src = canvas.toDataURL("image/jpeg", 0.9);
    lastScanCard.hidden = false;
    return clothesColours;
  }

  function stopAutomaticScanning() {
    if (scanTimer) window.clearInterval(scanTimer);
    scanTimer = null;
    scanningPaused = true;
    scanButton.textContent = "Restart Scanning";
  }

  function showProfile(profile, distance, clothesColour) {
    resultCard.hidden = false;
    resultCard.classList.remove("not-recognized");
    resultIcon.textContent = "✓";
    resultLabel.textContent = "Recognized face profile";
    resultName.textContent = profile.name;
    confidence.textContent = `Match confidence: ${Math.max(0, (1 - distance) * 100).toFixed(1)}%`;
    detailsList.replaceChildren();
    summaryList.replaceChildren();
    scanSummary.hidden = false;
    appendProfileDetails(profile.details, clothesColour);
    addSummaryLine(
      "Overall",
      `${profile.details?.age || "Age not provided"} · ${profile.details?.face_shape || "Enrolled profile verified"}`
    );
    addSummaryLine(
      "Appearance",
      `${profile.details?.head_hair || "Hair details unavailable"}; ${profile.details?.facial_hair || "facial-hair details unavailable"}`
    );
    addSummaryLine(
      "Live scan",
      `Clothes colour: ${clothesColour === "not visible" ? "show upper body in camera" : clothesColour}`
    );
  }

  function showNoMatch(message) {
    resultCard.hidden = false;
    resultCard.classList.add("not-recognized");
    resultIcon.textContent = "!";
    resultLabel.textContent = "Scan result";
    resultName.textContent = "Face not recognized";
    confidence.textContent = message;
    detailsList.replaceChildren();
    summaryList.replaceChildren();
    scanSummary.hidden = true;
  }

  async function scanFrame() {
    if (scanningPaused) {
      scanningPaused = false;
      clearResult();
      scanButton.textContent = "Scan Face";
    }
    if (isScanning || !stream || !matcher) return;
    isScanning = true;
    scanButton.disabled = true;
    overlay.hidden = false;
    setStatus("Scanning face in this browser…");
    try {
      const detections = await faceapi
        .detectAllFaces(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.45 }))
        .withFaceLandmarks()
        .withFaceDescriptors();
      if (!detections.length) {
        showNoMatch("No face detected. Center one well-lit face in the camera and try again.");
        setStatus("No face detected.", "warning");
        return;
      }
      const bestMatches = detections.map((detection) => matcher.findBestMatch(detection.descriptor));
      const matchedProfiles = await Promise.all(bestMatches.map((match) =>
        match.label === "unknown" ? null : fetchProfile(match.label)
      ));
      const clothesColours = captureAnnotatedImage(detections, matchedProfiles);
      const matchIndex = matchedProfiles.findIndex(Boolean);
      if (matchIndex !== -1) {
        showProfile(matchedProfiles[matchIndex], bestMatches[matchIndex].distance, clothesColours[matchIndex]);
        stopAutomaticScanning();
        setStatus("Face recognized. Scanning is paused; click Restart Scanning for a new scan.");
      } else {
        showNoMatch("This face does not match an enrolled profile.");
        setStatus("Face not recognized.");
      }
    } catch (error) {
      console.error("Scan failed", error);
      setStatus("The scan could not finish. Improve lighting and try again.", "error");
    } finally {
      isScanning = false;
      overlay.hidden = true;
      scanButton.disabled = !stream || !matcher;
    }
  }

  async function startCamera() {
    clearResult();
    if (!window.isSecureContext) {
      setStatus("Camera access needs HTTPS (or localhost). Open this site through Vercel or use localhost.", "error");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("Use a current Chrome, Edge, or Firefox browser and allow camera access.", "error");
      return;
    }
    try {
      const compactScreen = window.matchMedia("(max-width: 600px)").matches;
      stream = await navigator.mediaDevices.getUserMedia({
        video: compactScreen
          ? { facingMode: "user", width: { ideal: 1080 }, height: { ideal: 1920 }, aspectRatio: { ideal: 9 / 16 } }
          : { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
      video.srcObject = stream;
      await video.play();
      placeholder.hidden = true;
      startButton.textContent = "Camera On";
      startButton.disabled = true;
      scanButton.disabled = false;
      setStatus("Camera ready. Position one face in good light; scanning starts automatically.");
      scanTimer = window.setInterval(scanFrame, 2500);
    } catch (error) {
      const denied = error.name === "NotAllowedError" || error.name === "SecurityError";
      setStatus(denied ? "Camera permission was denied. Allow it in browser settings, then reload." : `Could not start camera: ${error.message}`, "error");
    }
  }

  startButton.addEventListener("click", startCamera);
  scanButton.addEventListener("click", scanFrame);
  window.addEventListener("beforeunload", () => stream?.getTracks().forEach((track) => track.stop()));
  loadRecognition().catch(modelError);
})();
