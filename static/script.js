(() => {
  const video = document.querySelector("#camera");
  const startButton = document.querySelector("#startCamera");
  const scanButton = document.querySelector("#scanFace");
  const videoUpload = document.querySelector("#videoUpload");
  const scanVideoButton = document.querySelector("#scanVideo");
  const selectedVideo = document.querySelector("#selectedVideo");
  const placeholder = document.querySelector("#cameraPlaceholder");
  const overlay = document.querySelector("#scanOverlay");
  const statusMessage = document.querySelector("#statusMessage");
  const resultCards = document.querySelector("#resultCards");
  const lastScanCard = document.querySelector("#lastScanCard");
  const lastScannedImage = document.querySelector("#lastScannedImage");

  const MODEL_URL = "https://justadudewhohacks.github.io/face-api.js/models";
  const profiles = Array.isArray(window.ENROLLED_PROFILES) ? window.ENROLLED_PROFILES : [];
  const threshold = Number(window.FACE_MATCH_THRESHOLD || 0.5);
  let stream = null;
  let matcher = null;
  let isScanning = false;
  let isVideoScanning = false;
  let scanningPaused = false;
  let scanTimer = null;
  let uploadedVideoUrl = null;
  let uploadedVideoName = "";
  const DETECTION_OPTIONS = new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.35 });

  function setStatus(message, kind = "") {
    statusMessage.textContent = message;
    statusMessage.className = `status-message ${kind}`;
  }

  function clearResult() {
    resultCards.hidden = true;
    resultCards.replaceChildren();
    lastScanCard.hidden = true;
    lastScannedImage.removeAttribute("src");
  }

  function stopCameraStream() {
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    if (scanTimer) window.clearInterval(scanTimer);
    scanTimer = null;
  }

  function clearUploadedVideo() {
    if (uploadedVideoUrl) URL.revokeObjectURL(uploadedVideoUrl);
    uploadedVideoUrl = null;
    uploadedVideoName = "";
    selectedVideo.hidden = true;
    selectedVideo.textContent = "";
    video.removeAttribute("src");
    video.controls = false;
    video.load();
  }

  function waitForVideoEvent(eventName) {
    return new Promise((resolve, reject) => {
      const onEvent = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error("The selected video could not be read.")); };
      const cleanup = () => {
        video.removeEventListener(eventName, onEvent);
        video.removeEventListener("error", onError);
      };
      video.addEventListener(eventName, onEvent, { once: true });
      video.addEventListener("error", onError, { once: true });
    });
  }

  async function seekVideo(seconds) {
    if (Math.abs(video.currentTime - seconds) < 0.05) return;
    const seeked = waitForVideoEvent("seeked");
    video.currentTime = Math.min(seconds, Math.max(0, video.duration - 0.05));
    await seeked;
  }

  function formatVideoTime(seconds) {
    const minutes = Math.floor(seconds / 60);
    const remainder = Math.floor(seconds % 60).toString().padStart(2, "0");
    return `${minutes}:${remainder}`;
  }

  function modelError(error) {
    console.error("Face recognition setup failed", error);
    setStatus("Recognition model could not load. Check your internet connection, then reload this page.", "error");
  }

  async function descriptorFromImage(url) {
    const image = await faceapi.fetchImage(url);
    const result = await faceapi
      .detectSingleFace(image, DETECTION_OPTIONS)
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
    scanVideoButton.disabled = !uploadedVideoUrl;
    setStatus(`${profiles.length} enrolled profile(s) ready. Start the camera to scan.`);
  }

  function addDetailLine(list, label, value) {
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = label;
    description.textContent = value;
    list.append(term, description);
  }

  function appendProfileDetails(list, details, clothesColour) {
    for (const [key, value] of Object.entries(details || {})) {
      if (key.toLowerCase() === "name") continue;
      addDetailLine(list, key.replace(/[_-]/g, " "), String(value));
    }
    addDetailLine(list, "clothes colour", clothesColour === "not visible" ? "Show upper body in camera" : clothesColour);
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

  function captureAnnotatedImage(detections, matches, source = video, showCapture = true) {
    const canvas = document.createElement("canvas");
    canvas.width = source.videoWidth;
    canvas.height = source.videoHeight;
    const context = canvas.getContext("2d");
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
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
    const imageUrl = canvas.toDataURL("image/jpeg", 0.9);
    if (showCapture) {
      lastScannedImage.src = imageUrl;
      lastScanCard.hidden = false;
    }
    return { clothesColours, imageUrl };
  }

  function stopAutomaticScanning() {
    if (scanTimer) window.clearInterval(scanTimer);
    scanTimer = null;
    scanningPaused = true;
    scanButton.textContent = "Restart Scanning";
  }

  function createProfileCard(profile, distance, clothesColour, index, sourceNote = "", snapshotUrl = "") {
    const card = document.createElement("article");
    card.className = "result-card";
    const icon = document.createElement("div");
    icon.className = "result-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "✓";
    const content = document.createElement("div");
    const label = document.createElement("p");
    label.className = "result-label";
    label.textContent = `Recognized face ${index + 1}`;
    const name = document.createElement("h2");
    name.textContent = profile.name;
    const confidence = document.createElement("p");
    confidence.className = "confidence";
    confidence.textContent = `Match confidence: ${Math.max(0, (1 - distance) * 100).toFixed(1)}%`;
    const source = document.createElement("p");
    source.className = "source-note";
    source.textContent = sourceNote;
    const details = document.createElement("dl");
    details.className = "details-list";
    appendProfileDetails(details, profile.details, clothesColour);
    const summary = document.createElement("section");
    summary.className = "scan-summary";
    summary.setAttribute("aria-label", `${profile.name} quick scan summary`);
    const summaryLabel = document.createElement("p");
    summaryLabel.className = "summary-label";
    summaryLabel.textContent = "Quick summary";
    const summaryList = document.createElement("dl");
    summaryList.className = "details-list summary-list";
    addDetailLine(
      summaryList,
      "Overall",
      `${profile.details?.age || "Age not provided"} · ${profile.details?.face_shape || "Enrolled profile verified"}`
    );
    addDetailLine(
      summaryList,
      "Appearance",
      `${profile.details?.head_hair || "Hair details unavailable"}; ${profile.details?.facial_hair || "facial-hair details unavailable"}`
    );
    addDetailLine(
      summaryList,
      "Live scan",
      `Clothes colour: ${clothesColour === "not visible" ? "show upper body in camera" : clothesColour}`
    );
    summary.append(summaryLabel, summaryList);
    content.append(label, name, confidence);
    if (sourceNote) content.append(source);
    content.append(details, summary);
    if (snapshotUrl) {
      const snapshot = document.createElement("img");
      snapshot.className = "profile-snapshot";
      snapshot.src = snapshotUrl;
      snapshot.alt = `${profile.name} identified in the uploaded video`;
      content.append(snapshot);
    }
    card.append(icon, content);
    return card;
  }

  function showNoMatch(message) {
    resultCards.hidden = false;
    const card = document.createElement("article");
    card.className = "result-card not-recognized";
    const icon = document.createElement("div");
    icon.className = "result-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "!";
    const content = document.createElement("div");
    const label = document.createElement("p");
    label.className = "result-label";
    label.textContent = "Scan result";
    const name = document.createElement("h2");
    name.textContent = "Face not recognized";
    const description = document.createElement("p");
    description.className = "confidence";
    description.textContent = message;
    content.append(label, name, description);
    card.append(icon, content);
    resultCards.replaceChildren(card);
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
        .detectAllFaces(video, DETECTION_OPTIONS)
        .withFaceLandmarks()
        .withFaceDescriptors();
      if (!detections.length) {
        showNoMatch("No face detected. Center one well-lit face in the camera and try again.");
        setStatus("No face detected.", "warning");
        return;
      }
      setStatus(`${detections.length} face${detections.length === 1 ? "" : "s"} detected. Checking enrolled profile…`);
      const bestMatches = detections.map((detection) => matcher.findBestMatch(detection.descriptor));
      const matchedProfiles = await Promise.all(bestMatches.map((match) =>
        match.label === "unknown" ? null : fetchProfile(match.label)
      ));
      const capturedFrame = captureAnnotatedImage(detections, matchedProfiles);
      const recognizedFaces = matchedProfiles
        .map((profile, index) => profile ? { profile, distance: bestMatches[index].distance, clothesColour: capturedFrame.clothesColours[index] } : null)
        .filter(Boolean);
      if (recognizedFaces.length) {
        resultCards.hidden = false;
        resultCards.replaceChildren(...recognizedFaces.map((face, index) =>
          createProfileCard(face.profile, face.distance, face.clothesColour, index)
        ));
        stopAutomaticScanning();
        setStatus(`${recognizedFaces.length} face${recognizedFaces.length === 1 ? "" : "s"} recognized. Scanning is paused; click Restart Scanning for a new scan.`);
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

  async function chooseVideo() {
    const file = videoUpload.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("video/")) {
      setStatus("Choose a valid video file such as MP4, MOV, or WebM.", "error");
      videoUpload.value = "";
      return;
    }
    stopCameraStream();
    scanningPaused = false;
    video.pause();
    video.srcObject = null;
    clearUploadedVideo();
    uploadedVideoUrl = URL.createObjectURL(file);
    uploadedVideoName = file.name;
    video.src = uploadedVideoUrl;
    video.muted = true;
    video.controls = true;
    video.playsInline = true;
    placeholder.hidden = true;
    selectedVideo.textContent = `Selected video: ${file.name}`;
    selectedVideo.hidden = false;
    startButton.disabled = false;
    startButton.textContent = "Start Camera";
    scanButton.disabled = true;
    scanButton.textContent = "Scan Face";
    scanVideoButton.disabled = !matcher;
    setStatus(matcher ? "Video ready. Click Analyse Video to scan every face in it." : "Loading recognition model. Video analysis will unlock when it is ready.");
  }

  async function analyseUploadedVideo() {
    if (!uploadedVideoUrl || !matcher || isVideoScanning) return;
    try {
      isVideoScanning = true;
      clearResult();
      scanVideoButton.disabled = true;
      startButton.disabled = true;
      video.pause();
      if (video.readyState < HTMLMediaElement.HAVE_METADATA) await waitForVideoEvent("loadedmetadata");
      if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error("The selected video has no readable duration.");

      const maxSamples = 240;
      const sampleEvery = Math.max(0.5, video.duration / maxSamples);
      const sampleTimes = [];
      for (let time = 0; time < video.duration; time += sampleEvery) sampleTimes.push(time);
      if (!sampleTimes.length) sampleTimes.push(0);

      const bestMatchesByPerson = new Map();
      let faceFrames = 0;
      for (let sampleIndex = 0; sampleIndex < sampleTimes.length; sampleIndex += 1) {
        const sampleTime = sampleTimes[sampleIndex];
        await seekVideo(sampleTime);
        const detections = await faceapi
          .detectAllFaces(video, DETECTION_OPTIONS)
          .withFaceLandmarks()
          .withFaceDescriptors();
        if (detections.length) faceFrames += 1;

        const nearest = detections.map((detection) => matcher.findBestMatch(detection.descriptor));
        const improving = nearest
          .map((match, index) => ({ match, index }))
          .filter(({ match }) => match.label !== "unknown")
          .filter(({ match }) => !bestMatchesByPerson.has(match.label) || match.distance < bestMatchesByPerson.get(match.label).distance);

        if (improving.length) {
          const profilesForFrame = await Promise.all(improving.map(({ match }) => fetchProfile(match.label)));
          const matchedProfiles = detections.map(() => null);
          improving.forEach((candidate, index) => { matchedProfiles[candidate.index] = profilesForFrame[index]; });
          const capturedFrame = captureAnnotatedImage(detections, matchedProfiles, video, false);
          improving.forEach((candidate, index) => {
            bestMatchesByPerson.set(candidate.match.label, {
              profile: profilesForFrame[index],
              distance: candidate.match.distance,
              clothesColour: capturedFrame.clothesColours[candidate.index],
              snapshotUrl: capturedFrame.imageUrl,
              time: sampleTime
            });
          });
        }
        setStatus(`Analysing video: ${sampleIndex + 1} of ${sampleTimes.length} frame samples…`);
      }

      const recognised = [...bestMatchesByPerson.values()].sort((first, second) => first.time - second.time);
      if (recognised.length) {
        resultCards.hidden = false;
        resultCards.replaceChildren(...recognised.map((face, index) =>
          createProfileCard(
            face.profile,
            face.distance,
            face.clothesColour,
            index,
            `Found in uploaded video at ${formatVideoTime(face.time)}`,
            face.snapshotUrl
          )
        ));
        lastScannedImage.src = recognised[0].snapshotUrl;
        lastScanCard.hidden = false;
        setStatus(`${recognised.length} enrolled face${recognised.length === 1 ? "" : "s"} identified in ${uploadedVideoName}.`);
      } else {
        showNoMatch(faceFrames ? "Faces were found, but none matched an enrolled profile in this video." : "No clear face was found in this video. Choose a brighter video with visible faces.");
        setStatus("Video analysis complete.", faceFrames ? "warning" : "error");
      }
      await seekVideo(0);
    } catch (error) {
      console.error("Video analysis failed", error);
      showNoMatch(`Video analysis could not finish: ${error.message}`);
      setStatus("Video analysis failed. Try MP4/WebM and a shorter, well-lit clip.", "error");
    } finally {
      isVideoScanning = false;
      scanVideoButton.disabled = !uploadedVideoUrl || !matcher;
      startButton.disabled = false;
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
      clearUploadedVideo();
      video.srcObject = null;
      videoUpload.value = "";
      scanVideoButton.disabled = true;
      const compactScreen = window.matchMedia("(max-width: 600px)").matches;
      stream = await navigator.mediaDevices.getUserMedia({
        video: compactScreen
          ? { facingMode: "user", width: { ideal: 960 }, height: { ideal: 1280 }, aspectRatio: { ideal: 3 / 4 } }
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
      // Do not make the person wait for the first interval tick. This also
      // provides an immediate visible status change after Camera On is shown.
      window.setTimeout(scanFrame, 600);
    } catch (error) {
      const denied = error.name === "NotAllowedError" || error.name === "SecurityError";
      setStatus(denied ? "Camera permission was denied. Allow it in browser settings, then reload." : `Could not start camera: ${error.message}`, "error");
    }
  }

  startButton.addEventListener("click", startCamera);
  scanButton.addEventListener("click", scanFrame);
  videoUpload.addEventListener("change", chooseVideo);
  scanVideoButton.addEventListener("click", analyseUploadedVideo);
  window.addEventListener("beforeunload", () => {
    stopCameraStream();
    if (uploadedVideoUrl) URL.revokeObjectURL(uploadedVideoUrl);
  });
  loadRecognition().catch(modelError);
})();
