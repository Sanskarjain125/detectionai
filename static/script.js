(() => {
  const video = document.querySelector("#camera");
  const canvas = document.querySelector("#captureCanvas");
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

  let stream = null;
  let scanTimer = null;
  let isScanning = false;
  let serverReady = false;
  let scanningPaused = false;

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

  function stopAutomaticScanning() {
    if (scanTimer) {
      window.clearInterval(scanTimer);
      scanTimer = null;
    }
    scanningPaused = true;
    scanButton.textContent = "Restart Scanning";
  }

  function restartScanning() {
    scanningPaused = false;
    clearResult();
    scanButton.textContent = "Scan Face";
    setStatus("Scanning restarted. Position one face in good light.");
    if (!scanTimer) scanTimer = window.setInterval(scanFrame, 2500);
  }

  function appendProfileDetails(list, details, clothesColour, prefix = "") {
    for (const [key, value] of Object.entries(details)) {
      if (key.toLowerCase() === "name") continue;
      const term = document.createElement("dt");
      const description = document.createElement("dd");
      term.textContent = `${prefix}${key.replace(/[_-]/g, " ")}`;
      description.textContent = String(value);
      list.append(term, description);
    }
    const clothesTerm = document.createElement("dt");
    const clothesDescription = document.createElement("dd");
    clothesTerm.textContent = `${prefix}clothes colour (estimated)`;
    clothesDescription.textContent = clothesColour || "Not clearly visible in this scan";
    list.append(clothesTerm, clothesDescription);
  }

  function showResult({ recognized, title, message, matchConfidence, details = {}, clothesColour }) {
    resultCard.hidden = false;
    resultCard.classList.toggle("not-recognized", !recognized);
    resultIcon.textContent = recognized ? "✓" : "!";
    resultLabel.textContent = recognized ? "Recognized face profile" : "Scan result";
    resultName.textContent = title;
    confidence.textContent = message || (matchConfidence ? `Match confidence: ${matchConfidence}%` : "");
    detailsList.replaceChildren();
    if (recognized) {
      appendProfileDetails(detailsList, details, clothesColour);
    }
  }

  function drawArrow(context, fromX, fromY, toX, toY, colour) {
    const angle = Math.atan2(toY - fromY, toX - fromX);
    const headLength = 10;
    context.strokeStyle = colour;
    context.fillStyle = colour;
    context.lineWidth = 3;
    context.beginPath();
    context.moveTo(fromX, fromY);
    context.lineTo(toX, toY);
    context.stroke();
    context.beginPath();
    context.moveTo(toX, toY);
    context.lineTo(toX - headLength * Math.cos(angle - Math.PI / 6), toY - headLength * Math.sin(angle - Math.PI / 6));
    context.lineTo(toX - headLength * Math.cos(angle + Math.PI / 6), toY - headLength * Math.sin(angle + Math.PI / 6));
    context.closePath();
    context.fill();
  }

  function showAnnotatedCapture(dataUrl, faces) {
    const source = new Image();
    source.onload = () => {
      const annotatedCanvas = document.createElement("canvas");
      annotatedCanvas.width = source.naturalWidth;
      annotatedCanvas.height = source.naturalHeight;
      const context = annotatedCanvas.getContext("2d");
      context.drawImage(source, 0, 0);
      context.font = "bold 18px system-ui, sans-serif";
      context.textBaseline = "middle";
      faces.forEach((face, index) => {
        const { top, right, bottom, left } = face.location;
        const colour = face.match ? "#38e7a3" : "#ff7885";
        const label = face.match ? face.name : "Not recognized";
        const labelWidth = Math.min(260, context.measureText(label).width + 22);
        const labelX = Math.max(6, Math.min(source.naturalWidth - labelWidth - 6, left));
        const labelY = Math.max(28, top - 34 - (index % 2) * 28);
        context.strokeStyle = colour;
        context.lineWidth = 4;
        context.strokeRect(left, top, right - left, bottom - top);
        context.fillStyle = "rgba(5, 9, 20, .86)";
        context.fillRect(labelX, labelY - 18, labelWidth, 30);
        context.fillStyle = colour;
        context.fillText(label, labelX + 10, labelY - 3);
        drawArrow(context, labelX + Math.min(labelWidth / 2, 90), labelY + 13, (left + right) / 2, top + 4, colour);
      });
      lastScannedImage.src = annotatedCanvas.toDataURL("image/jpeg", 0.9);
      lastScanCard.hidden = false;
    };
    source.onerror = () => {
      lastScannedImage.src = dataUrl;
      lastScanCard.hidden = false;
    };
    source.src = dataUrl;
  }

  async function showMatchedProfiles(faces) {
    const profiles = await Promise.all(faces.map(async (face) => {
      const response = await fetch(`/api/details/${encodeURIComponent(face.person_id)}`);
      const payload = response.ok ? await response.json() : { details: {} };
      return { ...face, details: payload.details };
    }));

    if (profiles.length === 1) {
      const [profile] = profiles;
      showResult({
        recognized: true,
        title: profile.name,
        matchConfidence: profile.confidence,
        details: profile.details,
        clothesColour: profile.clothes_colour
      });
      return;
    }

    showResult({
      recognized: true,
      title: `${profiles.length} recognised faces`,
      message: "Each recognised face is labelled in the captured image above."
    });
    for (const profile of profiles) {
      const nameTerm = document.createElement("dt");
      const nameDescription = document.createElement("dd");
      nameTerm.textContent = "Recognised person";
      nameDescription.textContent = `${profile.name} — match confidence: ${profile.confidence}%`;
      detailsList.append(nameTerm, nameDescription);
      appendProfileDetails(detailsList, profile.details, profile.clothes_colour, `${profile.name} — `);
    }
  }

  async function checkServerStatus() {
    try {
      const response = await fetch("/api/status");
      const status = await response.json();
      serverReady = status.ready;
      if (serverReady) {
        setStatus(`${status.reference_count} enrolled face record(s) loaded. Start the camera to scan.`);
      } else {
        setStatus("No reference faces are loaded. Add photos to known_faces, then restart the app.", "warning");
      }
    } catch {
      setStatus("Could not check the local recognition service.", "error");
    }
  }

  async function startCamera() {
    clearResult();
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("This browser does not support webcam access. Use a current Chrome, Edge, or Firefox browser.", "error");
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
      scanButton.disabled = !serverReady;
      setStatus(serverReady ? "Camera ready. Position one face in good light; scanning automatically every 2.5 seconds." : "Camera ready, but no reference faces are available.", serverReady ? "" : "warning");
      if (serverReady) scanTimer = window.setInterval(scanFrame, 2500);
    } catch (error) {
      const permissionDenied = error.name === "NotAllowedError" || error.name === "SecurityError";
      setStatus(permissionDenied ? "Camera permission was denied. Allow camera access in your browser settings, then reload." : `Could not start the camera: ${error.message}`, "error");
    }
  }

  function frameDataUrl() {
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) throw new Error("The camera is not ready yet.");
    // Smaller frames reduce latency while preserving enough detail for matching.
    const scale = Math.min(1, 640 / width);
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const context = canvas.getContext("2d", { willReadFrequently: false });
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.88);
  }

  async function scanFrame() {
    if (scanningPaused) {
      restartScanning();
    }
    if (isScanning || !stream || !serverReady) return;
    isScanning = true;
    scanButton.disabled = true;
    overlay.hidden = false;
    setStatus("Scanning face…");
    try {
      const capturedFrame = frameDataUrl();
      const response = await fetch("/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: capturedFrame })
      });
      const data = await response.json();
      if (!response.ok && data.reason === "no_reference_faces") serverReady = false;
      const detectedFaces = Array.isArray(data.faces) ? data.faces : [];
      if (detectedFaces.length) showAnnotatedCapture(capturedFrame, detectedFaces);

      if (data.match) {
        const matchedFaces = detectedFaces.filter((face) => face.match);
        await showMatchedProfiles(matchedFaces);
        stopAutomaticScanning();
        setStatus("Face recognized. The captured image and details are shown below; scanning is paused. Click Restart Scanning for a new scan.");
      } else {
        const friendlyMessage = data.message || "Face not recognized.";
        const title = detectedFaces.length > 1 ? "Faces not recognized" : "Face not recognized";
        showResult({ recognized: false, title, message: friendlyMessage });
        setStatus(friendlyMessage, data.reason === "low_light" ? "warning" : "");
      }
    } catch (error) {
      setStatus(`Scan failed: ${error.message}. Check that the local server is still running.`, "error");
    } finally {
      isScanning = false;
      overlay.hidden = true;
      scanButton.disabled = !stream || !serverReady;
    }
  }

  startButton.addEventListener("click", startCamera);
  scanButton.addEventListener("click", scanFrame);
  window.addEventListener("beforeunload", () => {
    if (scanTimer) window.clearInterval(scanTimer);
    stream?.getTracks().forEach((track) => track.stop());
  });
  checkServerStatus();
})();
