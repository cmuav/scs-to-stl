// SCS -> STL conversion app.
//
//   1. User picks an .scs file.
//   2. We hand a blob URL to GcHoopsViewer.mountViewer({ file }), which
//      internally XHRs the URL, hands the buffer to a HOOPS WebViewer, and
//      mounts a React UI for it.
//   3. We poll React fibers under #viewer to find the WebViewer instance,
//      then wait for the assembly tree to be ready.
//   4. We walk every node, pull mesh data via Symbol.iterator on faces, apply
//      the world matrix from getNodeNetMatrix, and emit a binary STL.


(() => {
  const fileInput = document.getElementById("file");
  const dropEl = document.getElementById("drop");
  const convertBtn = document.getElementById("convert");
  const flipZCb = document.getElementById("flipZ");
  const logEl = document.getElementById("log");
  const viewerEl = document.getElementById("viewer");

  let pickedFile = null;
  let blobUrl = null;
  let mounted = false;
  let loadedModel = null; // Set once preview is ready and the model can be extracted.

  function log(msg) {
    const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
    logEl.textContent += "\n" + line;
    logEl.scrollTop = logEl.scrollHeight;
    console.log(line);
  }
  function clearLog(msg) {
    logEl.textContent = msg || "";
    logEl.scrollTop = 0;
  }

  // ---- File picker / drag-and-drop ----------------------------------------

  function setFile(f) {
    if (!f) return;
    pickedFile = f;
    loadedModel = null;
    convertBtn.disabled = true;
    clearLog(`Selected: ${f.name} (${(f.size / 1024 / 1024).toFixed(2)} MB)`);
    // Auto-load the model into the viewer so the user can preview it. STL
    // extraction is deferred until they click "Convert".
    loadPreview();
  }

  async function loadPreview() {
    try {
      loadedModel = await mountAndWait();
      log("Model loaded — ready to convert.");
      convertBtn.disabled = false;
    } catch (e) {
      log("PREVIEW FAIL: " + (e && e.stack ? e.stack : e));
    }
  }

  async function runConvert() {
    if (!loadedModel) {
      log("No model loaded yet.");
      return;
    }
    convertBtn.disabled = true;
    try {
      await extractAndDownload(loadedModel);
    } catch (e) {
      log("FAIL: " + (e && e.stack ? e.stack : e));
    } finally {
      convertBtn.disabled = false;
    }
  }

  fileInput.addEventListener("change", e => setFile(e.target.files[0]));
  ["dragenter", "dragover"].forEach(ev =>
    dropEl.addEventListener(ev, e => {
      e.preventDefault();
      dropEl.classList.add("over");
    }),
  );
  ["dragleave", "drop"].forEach(ev =>
    dropEl.addEventListener(ev, e => {
      e.preventDefault();
      dropEl.classList.remove("over");
    }),
  );
  dropEl.addEventListener("drop", e => {
    if (e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
  });

  // ---- Convert button -----------------------------------------------------

  convertBtn.addEventListener("click", runConvert);

  // ---- Conversion pipeline ------------------------------------------------

  async function mountAndWait() {
    if (!window.GcHoopsViewer || typeof GcHoopsViewer.mountViewer !== "function") {
      throw new Error("GcHoopsViewer bundle did not load");
    }

    if (mounted) {
      // Tear down any prior session so the new file mounts cleanly.
      try { GcHoopsViewer.unmountViewer(); } catch (_) { }
      mounted = false;
    }
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    blobUrl = URL.createObjectURL(pickedFile);

    log("Mounting viewer…");
    GcHoopsViewer.mountViewer(viewerEl, {
      file: blobUrl,
      onAction: () => { },
      onError: e => log("viewer error: " + e),
    });
    mounted = true;

    log("Waiting for WebViewer instance…");
    const hwv = await waitFor(() => findWebViewer(viewerEl), 20000, "WebViewer instance");
    log("WebViewer found.");

    const model = typeof hwv.getModel === "function" ? hwv.getModel() : hwv.model;
    if (!model || typeof model.getNodeChildren !== "function") {
      throw new Error("Found viewer but its model surface is unrecognized");
    }

    log("Waiting for assembly tree…");
    await waitFor(() => modelHasGeometry(model), 60000, "model geometry");
    return model;
  }

  async function extractAndDownload(model) {
    log("Streaming geometry…");
    // Allow deeper LOD nodes to finish streaming before extraction runs.
    await sleep(750);

    const stl = await buildStl(model, flipZCb.checked);
    log(
      `Built STL: ${stl.triCount.toLocaleString()} triangles, ${(stl.bytes.byteLength / 1024).toFixed(1)} KB`,
    );

    const name = pickedFile.name.replace(/\.scs$/i, "") + ".stl";
    triggerDownload(stl.bytes, name);
    log(`Downloaded ${name}`);
  }

  // ---- Locating the WebViewer in the React tree ---------------------------

  function safe(fn) { try { return fn(); } catch (_) { return undefined; } }

  function looksLikeViewer(v) {
    if (!v || typeof v !== "object") return false;
    const m = safe(() => v.model) || safe(() => typeof v.getModel === "function" && v.getModel());
    return !!(m && typeof m.getNodeChildren === "function");
  }

  function findWebViewer(rootEl) {
    // Walk the React fiber tree under rootEl; mountViewer renders a class
    // component that, deep in its descendants, creates a HOOPS WebViewer
    // (`OU`) — we want that instance.
    const seen = new WeakSet();
    function walkFiber(fiber, depth) {
      if (!fiber || depth > 200 || seen.has(fiber)) return null;
      seen.add(fiber);
      for (const key of ["stateNode", "memoizedState", "memoizedProps", "ref"]) {
        const v = safe(() => fiber[key]);
        if (looksLikeViewer(v)) return v;
        if (v && typeof v === "object") {
          const cur = safe(() => v.current);
          if (looksLikeViewer(cur)) return cur;
          // Walk hook linked list.
          let h = v;
          for (let i = 0; i < 80 && h; i++) {
            if (looksLikeViewer(h)) return h;
            const hc = safe(() => h.current);
            if (looksLikeViewer(hc)) return hc;
            // Dispatched action records also hang off baseQueue / queue.
            for (const k of ["baseState", "memoizedState"]) {
              const inner = safe(() => h[k]);
              if (looksLikeViewer(inner)) return inner;
            }
            h = safe(() => h.next);
          }
        }
      }
      return walkFiber(safe(() => fiber.child), depth + 1) ||
        walkFiber(safe(() => fiber.sibling), depth + 1);
    }

    const stack = [rootEl];
    while (stack.length) {
      const el = stack.pop();
      const props = safe(() => Object.getOwnPropertyNames(el)) || [];
      for (const p of props) {
        if (!p.startsWith("__reactFiber") && !p.startsWith("__reactInternalInstance")) continue;
        const found = walkFiber(safe(() => el[p]), 0);
        if (found) return found;
      }
      for (const c of (safe(() => el.children) || [])) stack.push(c);
    }
    return null;
  }

  function modelHasGeometry(model) {
    try {
      const root = typeof model.getAbsoluteRootNode === "function"
        ? model.getAbsoluteRootNode()
        : model.getRootNode();
      const kids = model.getNodeChildren(root);
      return Array.isArray(kids) && kids.length > 0;
    } catch (_) { return false; }
  }

  // ---- Polling helper -----------------------------------------------------

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function waitFor(check, timeoutMs, label) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const v = check();
      if (v) return v;
      await sleep(150);
    }
    throw new Error(`Timed out waiting for ${label} (${timeoutMs}ms)`);
  }

  // ---- STL build ----------------------------------------------------------

  async function buildStl(model, flipZ) {
    // Walk every node from the absolute root, pull mesh data, apply the
    // world (net) matrix, and accumulate triangles.
    const root = typeof model.getAbsoluteRootNode === "function"
      ? model.getAbsoluteRootNode()
      : model.getRootNode();
    const nodes = [];
    (function walk(id) {
      nodes.push(id);
      for (const c of (model.getNodeChildren(id) || [])) walk(c);
    })(root);
    log(`Walked ${nodes.length} nodes`);

    const transform = (m, x, y, z) => {
      const o = [
        m[0] * x + m[4] * y + m[8] * z + m[12],
        m[1] * x + m[5] * y + m[9] * z + m[13],
        m[2] * x + m[6] * y + m[10] * z + m[14],
      ];
      if (flipZ) o[2] = -o[2];
      return o;
    };
    const transformDir = (m, x, y, z) => {
      const o = [
        m[0] * x + m[4] * y + m[8] * z,
        m[1] * x + m[5] * y + m[9] * z,
        m[2] * x + m[6] * y + m[10] * z,
      ];
      if (flipZ) o[2] = -o[2];
      return o;
    };

    const tris = [];
    let triCount = 0;
    let skipped = 0;

    for (const id of nodes) {
      let mesh;
      try { mesh = await model.getNodeMeshData(id); } catch (_) { skipped++; continue; }
      if (!mesh || !mesh.faces || !mesh.faces[Symbol.iterator] || !mesh.faces.vertexCount) continue;

      let matObj = null;
      try {
        if (typeof model.getNodeNetMatrix === "function") matObj = model.getNodeNetMatrix(id);
        else if (typeof model.getNetMatrix === "function") matObj = model.getNetMatrix(id);
        if (matObj && typeof matObj.then === "function") matObj = await matObj;
      } catch (_) { matObj = null; }

      let m;
      if (Array.isArray(matObj) && matObj.length === 16) m = matObj;
      else if (matObj && Array.isArray(matObj.m) && matObj.m.length === 16) m = matObj.m;
      else if (matObj && typeof matObj.getElements === "function") m = matObj.getElements();
      else m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

      const buf = [];
      for (const v of mesh.faces) {
        buf.push({
          p: [v.position[0], v.position[1], v.position[2]],
          n: v.normal ? [v.normal[0], v.normal[1], v.normal[2]] : null,
        });
        if (buf.length === 3) {
          const [a, b, c] = buf;
          const p0 = transform(m, a.p[0], a.p[1], a.p[2]);
          const p1 = transform(m, b.p[0], b.p[1], b.p[2]);
          const p2 = transform(m, c.p[0], c.p[1], c.p[2]);
          const n = a.n ? transformDir(m, a.n[0], a.n[1], a.n[2]) : [0, 0, 0];
          // Flipping a single axis inverts winding; swap v1/v2 to compensate.
          if (flipZ) {
            tris.push([n[0], n[1], n[2], p0[0], p0[1], p0[2], p2[0], p2[1], p2[2], p1[0], p1[1], p1[2]]);
          } else {
            tris.push([n[0], n[1], n[2], p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2]]);
          }
          triCount++;
          buf.length = 0;
        }
      }
    }
    if (skipped) log(`Skipped ${skipped} nodes with errors`);
    if (!triCount) throw new Error("No triangles collected — model may not have streamed yet");

    // Build binary STL: 80-byte header, uint32 count, 50 bytes/triangle.
    const buffer = new ArrayBuffer(84 + triCount * 50);
    const dv = new DataView(buffer);
    dv.setUint32(80, triCount, true);
    let off = 84;
    for (const t of tris) {
      for (let i = 0; i < 12; i++) { dv.setFloat32(off, t[i], true); off += 4; }
      dv.setUint16(off, 0, true); off += 2;
    }
    return { bytes: buffer, triCount };
  }

  function triggerDownload(buffer, name) {
    const blob = new Blob([buffer], { type: "application/octet-stream" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 0);
  }
})();
