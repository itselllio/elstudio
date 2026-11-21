/* ============================================================
   AUTOFOTO — Christmas Photobooth
   Three screens: landing -> capture -> strip editor
   ============================================================ */
(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  /* ------------------------------------------------------------------ *
   * Strip geometry (design units; the export renders at 2x)
   * ------------------------------------------------------------------ */
  const STRIP = {
    W: 900,
    marginX: 100,
    marginTop: 150,
    marginBottom: 150,
    gap: 80,
    photoW: 700,
    photoH: 933,   // 3:4 portrait
    border: 16,    // white print border around each frame
    shots: 4,
  };
  STRIP.cellH = STRIP.photoH + STRIP.border * 2;

  const DOT_SIZES = { none: null, small: { step: 38, radius: 3 }, medium: { step: 68, radius: 10 }, large: { step: 120, radius: 24 } };
  const STICKER_COUNT = 10;
  const PHOTO_W = 720;          // capture resolution
  const PHOTO_H = 960;

  /* the film grade — warm, saturated, slightly faded */
  const GRADE = "brightness(1.02) contrast(0.98) saturate(0.98)";
  const GRAIN_ALPHA = 0.012;    // heavy grain was overwhelming the faces

  /* ------------------------------------------------------------------ *
   * State
   * ------------------------------------------------------------------ */
  const state = {
    shots: [],            // { canvas }
    frameColor: "#141414",
    dotSize: "none",
    stickers: [],         // { id, index, img, x, y, rot, scale }
    active: new Set(),    // sticker indexes currently on the strip
    stream: null,
    shooting: false,
    nextId: 1,
    selectedStickerId: null,
    segFailed: false,
    photoStyle: "color",
  };

  const stickerImages = new Map();   // index -> HTMLImageElement

  /* ------------------------------------------------------------------ *
   * Small helpers
   * ------------------------------------------------------------------ */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function showScreen(name) {
    document.body.dataset.screen = name;
    $("#screen-landing").hidden = name !== "landing";
    $("#screen-capture").hidden = name !== "capture";
    $("#screen-printing").hidden = name !== "printing";
    $("#screen-editor").hidden = name !== "editor";
  }

  /* ================================================================== *
   * THE BOOTH BACKDROP — red velvet curtain behind the subject
   * ================================================================== *
   * The photo must not show the room behind the person, so the subject is
   * cut out with MediaPipe selfie segmentation and placed on a painted
   * velvet curtain — the way a real photobooth looks.
   * ================================================================== */
  const SEG_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation@0.1.1675465747/";
  let segmenter = null;
  let segReady = false;
  let lastMask = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.crossOrigin = "anonymous";
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("could not load " + src));
      document.head.appendChild(s);
    });
  }

  async function initSegmentation() {
    const status = $("#background-status");
    status.textContent = "Preparing the red background…";
    status.hidden = false;
    try {
      await loadScript(SEG_CDN + "selfie_segmentation.js");
      segmenter = new window.SelfieSegmentation({ locateFile: (f) => SEG_CDN + f });
      // model 0 = the general-purpose selfie model, which fits a close-up
      // photobooth portrait better than the full-body "landscape" model
      segmenter.setOptions({ modelSelection: 0 });
      segmenter.onResults(onSegmentResults);
      segReady = true;
    } catch (err) {
      state.segFailed = true;
      status.textContent = "Red background is unavailable; your original camera background will be used.";
      status.hidden = false;
      console.warn("Background separation unavailable:", err);
    }
  }

  /* scratch layer holding the cut-out subject */
  const subjectCanvas = document.createElement("canvas");
  subjectCanvas.width = PHOTO_W;
  subjectCanvas.height = PHOTO_H;
  const subjectCtx = subjectCanvas.getContext("2d");
  const refinedMask = document.createElement("canvas");
  refinedMask.width = 360;
  refinedMask.height = 480;
  const refinedMaskCtx = refinedMask.getContext("2d", { willReadFrequently: true });
  const monoCanvas = document.createElement("canvas");
  monoCanvas.width = PHOTO_W;
  monoCanvas.height = PHOTO_H;
  const monoCtx = monoCanvas.getContext("2d");

  const video = $("#video");
  const previewCanvas = $("#preview-canvas");
  const previewCtx = previewCanvas.getContext("2d", { willReadFrequently: true });

  // Some mobile browsers accept the filter property but do not actually apply it.
  function supportsCanvasGrayscale() {
    const test = document.createElement("canvas");
    test.width = test.height = 1;
    const context = test.getContext("2d", { willReadFrequently: true });
    if (!("filter" in context)) return false;
    context.filter = "grayscale(1)";
    context.fillStyle = "rgb(255,0,0)";
    context.fillRect(0, 0, 1, 1);
    const pixel = context.getImageData(0, 0, 1, 1).data;
    return Math.abs(pixel[0] - pixel[1]) < 3 && Math.abs(pixel[1] - pixel[2]) < 3;
  }
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const canvasGrayscaleWorks = !isIOS && supportsCanvasGrayscale();

  /** Centre-crop the live feed to a 3:4 portrait. */
  function videoCrop() {
    const vw = video.videoWidth || PHOTO_W;
    const vh = video.videoHeight || PHOTO_H;
    const target = 3 / 4;
    let sw = vw;
    let sh = vh;
    if (vw / vh > target) sw = vh * target;
    else sh = vw / target;
    return { sx: (vw - sw) / 2, sy: (vh - sh) / 2, sw, sh };
  }

  /**
   * MediaPipe can hand back an almost-empty mask (no person in frame, bad
   * lighting, a synthetic test feed). Compositing that would leave a bare red
   * curtain with nobody in it, so we measure the coverage first and fall back
   * to the raw feed when the cut-out is not trustworthy.
   */
  const maskProbe = document.createElement("canvas");
  maskProbe.width = 64;
  maskProbe.height = 80;
  const maskProbeCtx = maskProbe.getContext("2d", { willReadFrequently: true });
  function maskIsUsable(mask) {
    if (!mask) return false;
    maskProbeCtx.clearRect(0, 0, maskProbe.width, maskProbe.height);
    maskProbeCtx.drawImage(mask, 0, 0, maskProbe.width, maskProbe.height);
    let person = 0;
    try {
      const d = maskProbeCtx.getImageData(0, 0, maskProbe.width, maskProbe.height).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 40) person++;
    } catch (_) {
      return true;                       // tainted / unreadable — trust it
    }
    const ok = person / (maskProbe.width * maskProbe.height) > 0.04;
    return ok;
  }

  /**
   * Draw one composed frame: velvet curtain + cut-out subject + film grade.
   * Without a usable mask the raw feed is used and a curtain is drawn over the
   * edges, so the room is at least pushed out of frame.
   */
  function composeFrame(c, mask, w, h) {
    const { sx, sy, sw, sh } = videoCrop();
    c.save();
    c.clearRect(0, 0, w, h);
    if (canvasGrayscaleWorks) c.filter = "grayscale(1) brightness(1.07) contrast(1.07)";
    c.translate(w, 0);
    c.scale(-1, 1);
    c.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
    c.restore();
    if (!canvasGrayscaleWorks) {
      const frame = c.getImageData(0, 0, w, h);
      const pixels = frame.data;
      for (let i = 0; i < pixels.length; i += 4) {
        const luminance = 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
        const gray = Math.max(0, Math.min(255, (luminance * 1.07 - 128) * 1.07 + 128));
        pixels[i] = pixels[i + 1] = pixels[i + 2] = gray;
      }
      c.putImageData(frame, 0, 0);
    }
    applyFilmLook(c, w, h);
  }

  /** A restrained, neutral film texture; preserve natural skin and shadows. */
  function applyFilmLook(c, w, h) {
    c.save();
    c.globalCompositeOperation = "overlay";
    c.globalAlpha = GRAIN_ALPHA;
    c.drawImage(grainCanvas(w, h), 0, 0);
    c.restore();
  }

  /** A tileable noise field used as film grain. */
  const grainCache = new Map();
  function grainCanvas(w, h) {
    const key = `${w}x${h}`;
    if (grainCache.has(key)) return grainCache.get(key);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d");
    const img = g.createImageData(w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = 128 + (Math.random() - 0.5) * 110;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    grainCache.set(key, c);
    return c;
  }

  /* ================================================================== *
   * SCREEN 1 — LANDING
   * ================================================================== */
  async function startCamera() {
    const errBox = $("#camera-error");
    const demoBtn = $("#demo-btn");
    errBox.hidden = true;
    demoBtn.hidden = true;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      errBox.textContent =
        "This browser can't open a camera here. Try Chrome or Safari over https, or use the demo roll.";
      errBox.hidden = false;
      demoBtn.hidden = false;
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1080 }, height: { ideal: 1440 } },
        audio: false,
      });
      state.stream = stream;
      video.srcObject = stream;
      showScreen("capture");
      await video.play();
      $("#landing-hint").textContent = "Camera ready. Let's take four.";
      startPreviewLoop();
    } catch (err) {
      if (state.stream) state.stream.getTracks().forEach((track) => track.stop());
      state.stream = null;
      video.srcObject = null;
      showScreen("landing");
      const denied = err && (err.name === "NotAllowedError" || err.name === "SecurityError");
      errBox.textContent = denied
        ? "Camera access is blocked. To play: tap the camera icon in your browser's address bar, allow the camera, then tap the coin slot again."
        : `We couldn't start the camera (${err && err.name ? err.name : "unknown error"}). You can still use the demo roll.`;
      errBox.hidden = false;
      demoBtn.hidden = false;
    }
  }

  $("#coin-hotspot").addEventListener("click", startCamera);
  $("#booth-stage").addEventListener("click", (ev) => {
    if (ev.target.closest("#coin-hotspot")) return;
    startCamera();
  });

  /* ================================================================== *
   * SCREEN 2 — CAPTURE
   * ================================================================== */
  let segBusy = false;

  function onSegmentResults(results) {
    const mask = results.segmentationMask;
    const { sx, sy, sw, sh } = videoCrop();
    const scaleX = (mask.width || mask.videoWidth || video.videoWidth) / video.videoWidth;
    const scaleY = (mask.height || mask.videoHeight || video.videoHeight) / video.videoHeight;
    refinedMaskCtx.clearRect(0, 0, refinedMask.width, refinedMask.height);
    refinedMaskCtx.drawImage(mask, sx * scaleX, sy * scaleY, sw * scaleX, sh * scaleY,
      0, 0, refinedMask.width, refinedMask.height);
    // Reduce uncertain outer pixels while keeping a soft transition at hair edges.
    const pixels = refinedMaskCtx.getImageData(0, 0, refinedMask.width, refinedMask.height);
    for (let i = 3; i < pixels.data.length; i += 4) {
      const t = clamp((pixels.data[i] / 255 - 0.18) / 0.64, 0, 1);
      pixels.data[i] = Math.round(255 * t * t * (3 - 2 * t));
    }
    refinedMaskCtx.putImageData(pixels, 0, 0);
    lastMask = refinedMask;
    $("#background-status").hidden = true;
    drawPreview(lastMask);
  }

  function drawPreview(mask) {
    if (document.body.dataset.screen !== "capture") return;
    composeFrame(previewCtx, mask, PHOTO_W, PHOTO_H);
  }

  async function previewLoop() {
    if (!state.stream) return;
    if (video.readyState < 2) {
      requestAnimationFrame(previewLoop);
      return;
    }
    if (segReady && !segBusy) {
      segBusy = true;
      try {
        await segmenter.send({ image: video });
      } catch (err) {
        state.segFailed = true;
        segReady = false;
        lastMask = null;
        const status = $("#background-status");
        status.textContent = "Red background is unavailable; your original camera background will be used.";
        status.hidden = false;
        drawPreview(null);
      }
      segBusy = false;
    } else {
      drawPreview(lastMask);
    }
    if (state.stream) requestAnimationFrame(previewLoop);
  }

  function startPreviewLoop() {
    if (!state.stream) return;
    requestAnimationFrame(previewLoop);
  }

  /** Capture one graded frame with the curtain backdrop. */
  function grabFrame() {
    const out = document.createElement("canvas");
    out.width = PHOTO_W;
    out.height = PHOTO_H;
    composeFrame(out.getContext("2d", { willReadFrequently: true }), lastMask, PHOTO_W, PHOTO_H);
    return out;
  }

  const countdownEl = $("#countdown");
  const countNum = $("#count-num");
  const flashEl = $("#flash");

  async function runCountdown() {
    countdownEl.hidden = false;
    for (let n = 3; n >= 1; n--) {
      countNum.textContent = n;
      await sleep(1000);
    }
    countdownEl.hidden = true;
  }

  function fireFlash() {
    flashEl.classList.remove("fire");
    void flashEl.offsetWidth;
    flashEl.classList.add("fire");
  }

  async function takeRoll() {
    if (state.shooting || state.shots.length) return;
    state.shooting = true;
    const btn = $("#shutter-btn");
    btn.disabled = true;
    $$("[data-photo-style]").forEach((button) => { button.disabled = true; });
    $("#control-note").textContent = "Hold still…";

    for (let i = 0; i < STRIP.shots; i++) {
      $("#shot-counter").textContent = `${i + 1}/${STRIP.shots}`;
      await runCountdown();
      const frame = grabFrame();
      fireFlash();
      state.shots.push(frame);
      const thumbButton = $$("#shot-rail button")[i];
      const thumbnail = thumbButton.querySelector("canvas");
      thumbnail.getContext("2d").drawImage(frame, 0, 0, thumbnail.width, thumbnail.height);
      thumbButton.hidden = false;
      thumbButton.disabled = true;
      $$("#progress-dots i").forEach((dot, k) => dot.classList.toggle("done", k < state.shots.length));
      await sleep(260);
    }

    $("#shot-counter").textContent = "4/4";
    $("#control-note").textContent = "click a photo to retake it";
    state.shooting = false;
    btn.hidden = true;
    $("#review-continue").hidden = false;
    $$("#shot-rail button").forEach((button) => { button.disabled = false; });
  }

  $("#shutter-btn").addEventListener("click", takeRoll);
  $("#review-continue").addEventListener("click", () => { if (!state.shooting && state.shots.length === STRIP.shots) printStrip(); });
  $$("#shot-rail button").forEach((button, index) => {
    button.addEventListener("click", async () => {
      if (state.shooting || !state.shots[index]) return;
      state.shooting = true;
      $("#review-continue").disabled = true;
      $$("#shot-rail button").forEach((item) => { item.disabled = true; });
      $("#control-note").textContent = `retaking photo ${index + 1}…`;
      $("#shot-counter").textContent = `${index + 1}/${STRIP.shots}`;
      await runCountdown();
      const frame = grabFrame();
      fireFlash();
      state.shots[index] = frame;
      const thumbnail = button.querySelector("canvas");
      thumbnail.getContext("2d").drawImage(frame, 0, 0, thumbnail.width, thumbnail.height);
      state.shooting = false;
      $("#review-continue").disabled = false;
      $$("#shot-rail button").forEach((item) => { item.disabled = false; });
      $("#control-note").textContent = "click a photo to retake it";
    });
  });
  /* ------------------------------------------------------- demo roll -- */
  function makeDemoShots() {
    const palettes = [
      ["#8C1A20", "#D6303A"], ["#1B2A4A", "#4E6FA8"], ["#2D4F3E", "#6FA387"], ["#4A3528", "#A87B54"],
    ];
    state.shots = [];
    for (let i = 0; i < STRIP.shots; i++) {
      const c = document.createElement("canvas");
      c.width = PHOTO_W;
      c.height = PHOTO_H;
      const ctx = c.getContext("2d");
      const [a, b] = palettes[i % palettes.length];
      const g = ctx.createLinearGradient(0, 0, 0, PHOTO_H);
      g.addColorStop(0, b);
      g.addColorStop(1, a);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, PHOTO_W, PHOTO_H);

      ctx.fillStyle = "rgba(0,0,0,.28)";
      ctx.beginPath();
      ctx.ellipse(360, 360, 150, 180, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(130, PHOTO_H);
      ctx.quadraticCurveTo(360, 560, 590, PHOTO_H);
      ctx.fill();

      ctx.save();
      ctx.globalCompositeOperation = "overlay";
      ctx.globalAlpha = 0.05;
      ctx.drawImage(grainCanvas(PHOTO_W, PHOTO_H), 0, 0);
      ctx.restore();
      state.shots.push(c);
    }
    openEditor();
  }

  $("#demo-btn").addEventListener("click", () => {
    showScreen("capture");
    $("#control-note").textContent = "Demo roll — no camera needed.";
    makeDemoShots();
  });

  /* ================================================================== *
   * SCREEN 3 — STRIP EDITOR
   * ================================================================== */
  const canvas = $("#strip-canvas");
  const ctx = canvas.getContext("2d");

  function photoRects() {
    const rects = [];
    for (let i = 0; i < STRIP.shots; i++) {
      const x = (STRIP.W - STRIP.photoW) / 2;
      const y = STRIP.marginTop + i * (STRIP.cellH + STRIP.gap) + STRIP.border;
      rects.push({ x, y, w: STRIP.photoW, h: STRIP.photoH });
    }
    return rects;
  }

  function stripHeight() {
    return STRIP.marginTop + STRIP.shots * STRIP.cellH + (STRIP.shots - 1) * STRIP.gap + STRIP.marginBottom;
  }

  /** Regions a sticker may land in when sprinkled: frame borders and the gaps. */
  function sprinkleZones() {
    const rects = photoRects();
    const zones = [];
    zones.push({ x: 0, y: 0, w: STRIP.W, h: rects[0].y });
    zones.push({ x: 0, y: rects[3].y + rects[3].h + STRIP.border, w: STRIP.W, h: STRIP.marginBottom });
    for (let i = 0; i < rects.length - 1; i++) {
      const top = rects[i].y + rects[i].h + STRIP.border;
      zones.push({ x: 0, y: top, w: STRIP.W, h: rects[i + 1].y - top });
    }
    zones.push({ x: 0, y: 0, w: STRIP.marginX + 26, h: stripHeight() });
    zones.push({ x: STRIP.W - STRIP.marginX - 26, y: 0, w: STRIP.marginX + 26, h: stripHeight() });
    return zones;
  }

  /** The face zone of each photo that a sprinkled sticker must never cover. */
  function protectedZones() {
    return photoRects().map((r) => ({
      x: r.x + r.w * 0.15,
      y: r.y + r.h * 0.18,
      w: r.w * 0.70,
      h: r.h * 0.62,
    }));
  }

  function randomSpot() {
    const zones = sprinkleZones();
    const prot = protectedZones();
    for (let attempt = 0; attempt < 500; attempt++) {
      const zone = zones[Math.floor(Math.random() * zones.length)];
      const x = rand(zone.x + 20, zone.x + zone.w - 20);
      const y = rand(zone.y + 20, zone.y + zone.h - 20);
      const clash = prot.some(
        (p) => x > p.x - 34 && x < p.x + p.w + 34 && y > p.y - 34 && y < p.y + p.h + 34
      );
      if (!clash) return { x, y };
    }
    return { x: rand(60, STRIP.W - 60), y: rand(40, 80) };
  }

  function makeSticker(index, img) {
    const spot = randomSpot();
    return {
      id: state.nextId++,
      index,
      img,
      x: spot.x,
      y: spot.y,
      rot: rand(-20, 20),
      scale: rand(0.62, 1.05),
    };
  }

  function addSticker(index) {
    const img = stickerImages.get(index);
    if (!img) return;
    // the PNG may still be decoding — drawing an incomplete image throws, so
    // wait for it and add the sticker once it is actually ready
    if (!img.complete || !img.naturalWidth) {
      img.addEventListener(
        "load",
        () => {
          if (!state.active.has(index)) return;
          const sticker = makeSticker(index, img);
          state.stickers.push(sticker);
          state.selectedStickerId = sticker.id;
          syncStickerControls();
          drawStrip();
        },
        { once: true }
      );
      return;
    }
    const sticker = makeSticker(index, img);
    state.stickers.push(sticker);
    state.selectedStickerId = sticker.id;
    syncStickerControls();
  }

  function removeSticker(index) {
    if (state.stickers.some((s) => s.index === index && s.id === state.selectedStickerId)) state.selectedStickerId = null;
    state.stickers = state.stickers.filter((s) => s.index !== index);
    syncStickerControls();
  }

  function shuffleStickers() {
    state.stickers.forEach((s) => {
      const spot = randomSpot();
      s.x = spot.x;
      s.y = spot.y;
      s.rot = rand(-20, 20);
    });
    drawStrip();
  }

  /* ----------------------------------------------------------- render -- */
  function drawDots(c) {
    const size = DOT_SIZES[state.dotSize];
    if (!size) return;
    const { step, radius: r } = size;
    for (let y = step / 2; y < stripHeight(); y += step) {
      const positions = [STRIP.marginX / 2, STRIP.W - STRIP.marginX / 2];
      for (let x = STRIP.marginX + step / 2; x < STRIP.W - STRIP.marginX; x += step) positions.push(x);
      for (const x of positions) {
        c.beginPath();
        c.arc(x, y, r, 0, Math.PI * 2);
        c.fillStyle = state.frameColor.toUpperCase() === "#FFFFFF" ? "rgba(150,145,140,.45)" : "rgba(255,255,255,.86)";
        c.fill();
      }
    }
  }

  function drawStickers(c) {
    state.stickers.forEach((s) => {
      if (!s.img.complete || !s.img.naturalWidth) return;
      const size = 150 * s.scale;
      const w = size * (s.img.naturalWidth / s.img.naturalHeight || 1);
      c.save();
      c.translate(s.x, s.y);
      c.rotate((s.rot * Math.PI) / 180);
      c.drawImage(s.img, -w / 2, -size / 2, w, size);
      c.restore();
    });
  }

  function drawStrip() {
    const H = stripHeight();
    if (canvas.width !== STRIP.W || canvas.height !== H) {
      canvas.width = STRIP.W;
      canvas.height = H;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, STRIP.W, H);

    // frame background
    ctx.fillStyle = state.frameColor;
    ctx.fillRect(0, 0, STRIP.W, H);

    // polka dots sit on the frame only — the photos are painted over them
    drawDots(ctx);

    // the four prints
    photoRects().forEach((r, i) => {
      const shot = state.shots[i];
      if (state.frameColor.toUpperCase() === "#FFFFFF") {
        ctx.fillStyle = "#FFFFFF";
        ctx.fillRect(r.x - STRIP.border, r.y - STRIP.border, r.w + STRIP.border * 2, r.h + STRIP.border * 2);
      }
      if (shot) {
        ctx.drawImage(shot, r.x, r.y, r.w, r.h);
      } else {
        ctx.fillStyle = "#E7E2D8";
        ctx.fillRect(r.x, r.y, r.w, r.h);
      }
    });

    drawStickers(ctx);

    const selected = state.stickers.find((s) => s.id === state.selectedStickerId);
    if (selected && selected.img.naturalWidth) {
      const h = 150 * selected.scale;
      const w = h * selected.img.naturalWidth / selected.img.naturalHeight;
      ctx.save();
      ctx.translate(selected.x, selected.y);
      ctx.rotate(selected.rot * Math.PI / 180);
      ctx.strokeStyle = "#b65c53";
      ctx.lineWidth = 5;
      ctx.setLineDash([12, 8]);
      ctx.strokeRect(-w / 2 - 10, -h / 2 - 10, w + 20, h + 20);
      ctx.restore();
    }

    // a whisper of paper grain, so the strip feels printed
    ctx.save();
    ctx.globalCompositeOperation = "overlay";
    ctx.globalAlpha = 0.04;
    ctx.drawImage(grainCanvas(STRIP.W, H), 0, 0);
    ctx.restore();
  }

  /* ------------------------------------------------------ high-res PNG -- */
  function makeExportCanvas() {
    const scale = 2;
    const H = stripHeight();
    const out = document.createElement("canvas");
    out.width = STRIP.W * scale;
    out.height = H * scale;
    const c = out.getContext("2d");
    c.scale(scale, scale);

    c.fillStyle = state.frameColor;
    c.fillRect(0, 0, STRIP.W, H);
    drawDots(c);
    photoRects().forEach((r, i) => {
      const shot = state.shots[i];
      if (state.frameColor.toUpperCase() === "#FFFFFF") {
        c.fillStyle = "#FFFFFF";
        c.fillRect(r.x - STRIP.border, r.y - STRIP.border, r.w + STRIP.border * 2, r.h + STRIP.border * 2);
      }
      if (shot) c.drawImage(shot, r.x, r.y, r.w, r.h);
    });
    drawStickers(c);

    return out;
  }

  function exportStrip() {
    makeExportCanvas().toBlob((blob) => {
      if (!blob) { $("#action-status").textContent = "Could not prepare the image. Please try again."; resetDownloadButtons(); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "autofoto-strip.png";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      resetDownloadButtons();
    }, "image/png");
  }

  /** The high-res PNG takes a moment to encode — say so on the buttons. */
  function resetDownloadButtons() {
    $$("#download-btn").forEach((b) => {
      b.disabled = false;
      b.textContent = "Download";
    });
  }

  function startDownload() {
    $$("#download-btn").forEach((b) => {
      b.disabled = true;
      b.textContent = "Preparing…";
    });
    exportStrip();
    setTimeout(resetDownloadButtons, 15000);
  }

  function exportBlob() {
    return new Promise((resolve, reject) => makeExportCanvas().toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("Image encoding failed")), "image/png"
    ));
  }

  $("#share-btn").addEventListener("click", async () => {
    const status = $("#action-status");
    status.textContent = "";
    if (!navigator.share || !navigator.canShare || !navigator.canShare({ files: [new File([], "strip.png", { type: "image/png" })] })) {
      status.textContent = "Sharing images isn't available here. Download your strip to share it.";
      return;
    }
    try {
      const file = new File([await exportBlob()], "el-studio-strip.png", { type: "image/png" });
      await navigator.share({ files: [file], title: "My photo strip" });
    } catch (err) {
      if (err.name !== "AbortError") status.textContent = "Could not open sharing. Try downloading your strip instead.";
    }
  });

  $("#print-btn").addEventListener("click", async () => {
    const status = $("#action-status");
    status.textContent = "Preparing your strip for printing…";
    try {
      const blob = await exportBlob();
      const url = URL.createObjectURL(blob);
      const img = $("#print-image");
      img.src = url;
      await img.decode();
      status.textContent = "";
      window.print();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (_) {
      status.textContent = "Could not prepare the print. Try downloading your strip instead.";
    }
  });

  /* ------------------------------------------------- drag the stickers -- */
  /** Canvas client coordinates -> strip design coordinates. */
  function canvasPoint(e) {
    const r = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * STRIP.W,
      y: ((e.clientY - r.top) / r.height) * stripHeight(),
    };
  }

  /** Topmost sticker under the given point, if any. */
  function hitTest(x, y) {
    for (let i = state.stickers.length - 1; i >= 0; i--) {
      const s = state.stickers[i];
      const size = 150 * s.scale;
      const w = size * ((s.img.naturalWidth / s.img.naturalHeight) || 1);
      const a = (-s.rot * Math.PI) / 180;
      const dx = x - s.x;
      const dy = y - s.y;
      const lx = dx * Math.cos(a) - dy * Math.sin(a);
      const ly = dx * Math.sin(a) + dy * Math.cos(a);
      if (Math.abs(lx) <= w / 2 && Math.abs(ly) <= size / 2) return s;
    }
    return null;
  }

  let dragging = null;

  canvas.addEventListener("pointerdown", (e) => {
    const p = canvasPoint(e);
    const hit = hitTest(p.x, p.y);
    state.selectedStickerId = hit ? hit.id : null;
    syncStickerControls();
    drawStrip();
    if (!hit) return;
    dragging = { sticker: hit, dx: p.x - hit.x, dy: p.y - hit.y };
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    canvas.classList.add("grabbing");
  });

  canvas.addEventListener("pointermove", (e) => {
    const p = canvasPoint(e);
    if (!dragging) {
      canvas.classList.toggle("over", !!hitTest(p.x, p.y));
      return;
    }
    dragging.sticker.x = clamp(p.x - dragging.dx, 0, STRIP.W);
    dragging.sticker.y = clamp(p.y - dragging.dy, 0, stripHeight());
    drawStrip();
  });

  const endDrag = () => {
    dragging = null;
    canvas.classList.remove("grabbing");
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  // double click removes a sticker
  canvas.addEventListener("dblclick", (e) => {
    const p = canvasPoint(e);
    const hit = hitTest(p.x, p.y);
    if (!hit) return;
    removeSticker(hit.index);
    state.active.delete(hit.index);
    syncThumbs();
    drawStrip();
  });

  // the wheel resizes the sticker under the cursor
  canvas.addEventListener(
    "wheel",
    (e) => {
      const p = canvasPoint(e);
      const hit = hitTest(p.x, p.y);
      if (!hit) return;
      e.preventDefault();
      hit.scale = clamp(hit.scale * (e.deltaY < 0 ? 1.08 : 0.93), 0.35, 2.4);
      drawStrip();
    },
    { passive: false }
  );

  /* ------------------------------------------------------------ setup -- */
  function openEditor() {
    showScreen("editor");
    drawStrip();
  }

  async function printStrip() {
    drawStrip();
    const preview = $("#printing-strip");
    preview.width = 180;
    preview.height = Math.round(stripHeight() * preview.width / STRIP.W);
    preview.getContext("2d").drawImage(canvas, 0, 0, preview.width, preview.height);
    preview.classList.remove("emerge");
    showScreen("printing");
    void preview.offsetWidth;
    preview.classList.add("emerge");
    await sleep(3000);
    openEditor();
  }

  function syncStickerControls() {
    const selected = state.stickers.find((s) => s.id === state.selectedStickerId);
    ["#sticker-smaller", "#sticker-larger", "#sticker-delete"].forEach((selector) => {
      $(selector).disabled = !selected;
    });
    $("#sticker-selection").textContent = selected
      ? "Sticker selected — drag it, resize it, or delete it."
      : "Select a sticker on your strip to edit it.";
  }

  function resizeSelectedSticker(factor) {
    const selected = state.stickers.find((s) => s.id === state.selectedStickerId);
    if (!selected) return;
    selected.scale = clamp(selected.scale * factor, 0.35, 2.4);
    drawStrip();
  }
  $("#sticker-smaller").addEventListener("click", () => resizeSelectedSticker(0.85));
  $("#sticker-larger").addEventListener("click", () => resizeSelectedSticker(1.18));
  $("#sticker-delete").addEventListener("click", () => {
    const selected = state.stickers.find((s) => s.id === state.selectedStickerId);
    if (!selected) return;
    state.stickers = state.stickers.filter((s) => s.id !== selected.id);
    if (!state.stickers.some((s) => s.index === selected.index)) state.active.delete(selected.index);
    state.selectedStickerId = null;
    syncStickerControls();
    syncThumbs();
    drawStrip();
  });

  function syncThumbs() {
    $$(".sticker-thumb").forEach((t) =>
      t.classList.toggle("active", state.active.has(Number(t.dataset.sticker)))
    );
  }

  function loadStickers() {
    const grid = $("#sticker-grid");
    for (let i = 1; i <= STICKER_COUNT; i++) {
      const img = new Image();
      img.src = `public/new-stickers/sticker-${String(i).padStart(2, "0")}.png`;
      img.alt = `Sticker ${i}`;
      stickerImages.set(i, img);

      img.addEventListener("load", () => drawStrip(), { once: true });

      const btn = document.createElement("button");
      btn.className = "sticker-thumb";
      btn.type = "button";
      btn.dataset.sticker = i;
      btn.title = `Sprinkle sticker ${i}`;
      btn.appendChild(img);
      btn.addEventListener("click", () => toggleSticker(i));
      grid.appendChild(btn);
    }
  }

  function toggleSticker(index) {
    if (state.active.has(index)) {
      state.active.delete(index);
      removeSticker(index);
    } else {
      state.active.add(index);
      addSticker(index);
    }
    syncThumbs();
    drawStrip();
  }

  /* frame colour swatches */
  $("#swatches").addEventListener("click", (ev) => {
    const sw = ev.target.closest(".swatch");
    if (!sw) return;
    state.frameColor = sw.dataset.color;
    $$(".swatch").forEach((s) => s.classList.toggle("active", s === sw));
    drawStrip();
  });

  /* polka dot size */
  $("#dot-sizes").addEventListener("click", (ev) => {
    const btn = ev.target.closest("button");
    if (!btn) return;
    state.dotSize = btn.dataset.size;
    $$("#dot-sizes button").forEach((b) => b.classList.toggle("active", b === btn));
    drawStrip();
  });

  $("#shuffle-btn").addEventListener("click", shuffleStickers);
  $("#clear-stickers-btn").addEventListener("click", () => {
    state.stickers = [];
    state.active.clear();
    state.selectedStickerId = null;
    syncStickerControls();
    syncThumbs();
    drawStrip();
  });

  $("#download-btn").addEventListener("click", startDownload);

  function retake() {
    state.shots = [];
    state.stickers = [];
    state.active.clear();
    state.selectedStickerId = null;
    syncStickerControls();
    syncThumbs();
    $$("#shot-rail button").forEach((button) => { button.hidden = true; const thumb = button.querySelector("canvas"); thumb.getContext("2d").clearRect(0, 0, thumb.width, thumb.height); });
    $$("#progress-dots i").forEach((d) => d.classList.remove("done"));
    $("#shot-counter").textContent = `1/${STRIP.shots}`;
    $("#control-note").textContent = "click the coin and smile!!!";
    $("#shutter-btn").hidden = false;
    $("#shutter-btn").disabled = false;
    $("#review-continue").hidden = true;
    if (state.stream && state.stream.active) {
      showScreen("capture");
    } else {
      showScreen("landing");
      startCamera();
    }
  }
  $("#retake-btn").addEventListener("click", retake);

  /* ------------------------------------------------------------ start -- */
  loadStickers();
  $$(".swatch").forEach((s, i) => s.classList.toggle("active", i === 0));
})();
