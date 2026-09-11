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

  function appendProfileDetails(details) {
    for (const [key, value] of Object.entries(details || {})) {
      if (key.toLowerCase() === "name") continue;
      const term = document.createElement("dt");
      const description = document.createElement("dd");
      term.textContent = key.replace(/[_-]/g, " ");
      description.textContent = String(value);
      detailsList.append(term, description);
    }
  }

  function findProfile(personId) {
    return profiles.find((profile) => profile.person_id === personId);
  }

  function captureAnnotatedImage(detections, matches) {
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    context.lineWidth = Math.max(3, Math.round(canvas.width / 220));
    context.font = `bold ${Math.max(16, Math.round(canvas.width / 32))}px system-ui, sans-serif`;
    detections.forEach((detection, index) => {
      const box = detection.detection.box;
      const matchedProfile = matches[index];
      const label = matchedProfile ? matchedProfile.name : "Not recognized";
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
  }

  function stopAutomaticScanning() {
    if (scanTimer) window.clearInterval(scanTimer);
    scanTimer = null;
    scanningPaused = true;
    scanButton.textContent = "Restart Scanning";
  }

  function showProfile(profile, distance) {
    resultCard.hidden = false;
    resultCard.classList.remove("not-recognized");
    resultIcon.textContent = "✓";
    resultLabel.textContent = "Recognized face profile";
    resultName.textContent = profile.name;
    confidence.textContent = `Match confidence: ${Math.max(0, (1 - distance) * 100).toFixed(1)}%`;
    detailsList.replaceChildren();
    appendProfileDetails(profile.details);
  }

  function showNoMatch(message) {
    resultCard.hidden = false;
    resultCard.classList.add("not-recognized");
    resultIcon.textContent = "!";
    resultLabel.textContent = "Scan result";
    resultName.textContent = "Face not recognized";
    confidence.textContent = message;
    detailsList.replaceChildren();
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
      const matchedProfiles = bestMatches.map((match) => match.label === "unknown" ? null : findProfile(match.label));
      captureAnnotatedImage(detections, matchedProfiles);
      const matchIndex = matchedProfiles.findIndex(Boolean);
      if (matchIndex !== -1) {
        showProfile(matchedProfiles[matchIndex], bestMatches[matchIndex].distance);
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
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 960 }, height: { ideal: 540 } },
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
