/* global AWS */
const API = "/api";
const PAGE_SIZE = 6;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const BUCKET_LIMIT_DEFAULT = 50;
const UPLOAD_CONCURRENCY = 4;
const KEY_PREFIX = "assets/";

const $ = (id) => document.getElementById(id);

const loginView = $("login-view");
const mainView = $("main-view");
const loginForm = $("login-form");
const loginError = $("login-error");
const userLabel = $("user-label");
const roleBadge = $("role-badge");

const uploadSection = $("upload-section");
const dropZone = $("drop-zone");
const fileInput = $("file-input");
const selectedFiles = $("selected-files");
const uploadActions = $("upload-actions");
const uploadBtn = $("upload-btn");
const uploadCount = $("upload-count");
const clearBtn = $("clear-btn");
const uploadStatus = $("upload-status");
const capacityLabel = $("capacity-label");
const bucketFullBanner = $("bucket-full-banner");

const accessSection = $("access-section");
const accessContent = $("access-content");
const accessRefreshBtn = $("access-refresh-btn");

const gallery = $("gallery");
const galleryCount = $("gallery-count");
const refreshBtn = $("refresh-btn");
const pagination = $("pagination");
const prevBtn = $("prev-btn");
const nextBtn = $("next-btn");
const pageLabel = $("page-label");

const modal = $("detail-modal");
const detailImg = $("detail-img");
const detailNoPreview = $("detail-no-preview");
const detailNoPreviewExt = $("detail-no-preview-ext");
const detailName = $("detail-name");
const detailSize = $("detail-size");
const detailModified = $("detail-modified");
const detailKey = $("detail-key");
const detailOpen = $("detail-open");
const detailClose = $("detail-close");
const detailDelete = $("detail-delete");

const IMAGE_EXTS = /\.(jpe?g|png|gif|webp|svg|avif|bmp|ico)$/i;

const state = {
  appToken: null,
  user: null,
  role: null,
  aws: null,    // { region, bucket, credentials: { accessKeyId, secretAccessKey, sessionToken, expiration } }
  s3: null,
  pendingFiles: [],
  images: [],
  page: 1,
  detailImg: null,
  bucketCount: 0,
  bucketLimit: BUCKET_LIMIT_DEFAULT,
  bucketFull: false,
  blobCache: new Map(),     // cacheKey -> blobUrl
  refreshTimer: null,
};

restoreSession();

// =============== auth ===============
loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.textContent = "";
  try {
    const res = await fetch(`${API}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: $("username").value,
        password: $("password").value,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || "login failed");
    }
    const data = await res.json();
    saveSession(data);
    showMain();
  } catch (err) {
    loginError.textContent = err.message;
  }
});

$("logout").addEventListener("click", async () => {
  if (state.appToken) {
    await fetch(`${API}/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${state.appToken}` },
    }).catch(() => {});
  }
  clearSession();
  showLogin();
});

function saveSession({ appToken, user, role, aws }) {
  state.appToken = appToken;
  state.user = user;
  state.role = role;
  state.aws = aws;
  rebuildS3Client();
  scheduleCredsRefresh();
  sessionStorage.setItem("session", JSON.stringify({ appToken, user, role, aws }));
}

function restoreSession() {
  const raw = sessionStorage.getItem("session");
  if (!raw) return;
  try {
    const s = JSON.parse(raw);
    const exp = s.aws?.credentials?.expiration;
    if (!exp || new Date(exp).getTime() - Date.now() < 60 * 1000) return; // expired/expiring
    state.appToken = s.appToken;
    state.user = s.user;
    state.role = s.role;
    state.aws = s.aws;
    rebuildS3Client();
    scheduleCredsRefresh();
  } catch { /* ignore */ }
}

function clearSession() {
  if (state.refreshTimer) { clearTimeout(state.refreshTimer); state.refreshTimer = null; }
  revokeAllBlobs();
  state.appToken = state.user = state.role = state.aws = state.s3 = null;
  state.pendingFiles = []; state.images = []; state.page = 1;
  state.bucketCount = 0; state.bucketFull = false;
  sessionStorage.clear();
}

function showLogin() {
  loginView.hidden = false;
  mainView.hidden = true;
  loginForm.reset();
}

function showMain() {
  loginView.hidden = true;
  mainView.hidden = false;
  userLabel.textContent = state.user;
  roleBadge.textContent = state.role;
  roleBadge.className = `badge ${state.role}`;
  uploadSection.hidden = state.role !== "admin";
  accessSection.hidden = state.role !== "admin";
  loadImages();
  if (state.role === "admin") loadAccessList();
}

// =============== AWS SDK plumbing ===============
function rebuildS3Client() {
  if (!state.aws) { state.s3 = null; return; }
  const c = state.aws.credentials;
  state.s3 = new AWS.S3({
    apiVersion: "2006-03-01",
    region: state.aws.region,
    credentials: new AWS.Credentials({
      accessKeyId: c.accessKeyId,
      secretAccessKey: c.secretAccessKey,
      sessionToken: c.sessionToken,
    }),
    params: { Bucket: state.aws.bucket },
  });
}

function scheduleCredsRefresh() {
  if (state.refreshTimer) { clearTimeout(state.refreshTimer); }
  if (!state.aws?.credentials?.expiration) return;
  const expMs = new Date(state.aws.credentials.expiration).getTime();
  // refresh 2 minutes before expiry
  const delay = Math.max(10_000, expMs - Date.now() - 2 * 60 * 1000);
  state.refreshTimer = setTimeout(refreshCreds, delay);
}

async function refreshCreds() {
  try {
    const res = await fetch(`${API}/refresh-creds`, {
      method: "POST",
      headers: { Authorization: `Bearer ${state.appToken}` },
    });
    if (!res.ok) throw new Error("session expired");
    const { credentials } = await res.json();
    state.aws.credentials = credentials;
    rebuildS3Client();
    sessionStorage.setItem("session", JSON.stringify({
      appToken: state.appToken, user: state.user, role: state.role, aws: state.aws,
    }));
    scheduleCredsRefresh();
  } catch (err) {
    console.warn("creds refresh failed", err);
    clearSession();
    showLogin();
  }
}

// =============== drop zone ===============
dropZone.addEventListener("click", () => {
  if (state.bucketFull) return;
  fileInput.click();
});

["dragenter", "dragover"].forEach((evt) => {
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault(); e.stopPropagation();
    if (state.bucketFull) return;
    dropZone.classList.add("is-dragover");
  });
});
["dragleave", "drop"].forEach((evt) => {
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault(); e.stopPropagation();
    if (evt === "dragleave" && dropZone.contains(e.relatedTarget)) return;
    dropZone.classList.remove("is-dragover");
  });
});
dropZone.addEventListener("drop", (e) => {
  if (state.bucketFull) return;
  addFiles(e.dataTransfer.files);
});
fileInput.addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
clearBtn.addEventListener("click", () => {
  state.pendingFiles = [];
  renderChips();
  uploadStatus.textContent = "";
});

function addFiles(fileList) {
  const existing = new Set(state.pendingFiles.map((f) => f.name + ":" + f.size));
  const errors = [];
  for (const f of fileList) {
    if (f.size > MAX_FILE_BYTES) { errors.push(`${f.name}: > 10MB`); continue; }
    const id = f.name + ":" + f.size;
    if (existing.has(id)) continue;
    existing.add(id);
    state.pendingFiles.push(f);
  }
  const remaining = state.bucketLimit - state.bucketCount;
  if (state.pendingFiles.length > remaining) {
    const dropped = state.pendingFiles.length - remaining;
    state.pendingFiles = state.pendingFiles.slice(0, remaining);
    errors.push(`solo caben ${remaining} archivo(s) más; descartados ${dropped}`);
  }
  if (errors.length) {
    uploadStatus.className = "error";
    uploadStatus.textContent = errors.join("; ");
  } else {
    uploadStatus.textContent = "";
  }
  renderChips();
}

function renderChips() {
  if (state.pendingFiles.length === 0) {
    selectedFiles.hidden = true; selectedFiles.innerHTML = "";
    uploadActions.hidden = true; return;
  }
  selectedFiles.hidden = false;
  uploadActions.hidden = false;
  uploadCount.textContent = state.pendingFiles.length;
  selectedFiles.innerHTML = "";
  state.pendingFiles.forEach((f, idx) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.innerHTML = `
      <span class="chip-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
      <span class="chip-size">${fmtSize(f.size)}</span>
      <button type="button" class="chip-x" aria-label="Quitar ${escapeHtml(f.name)}">&times;</button>
    `;
    chip.querySelector(".chip-x").addEventListener("click", (e) => {
      e.stopPropagation();
      state.pendingFiles.splice(idx, 1);
      renderChips();
    });
    selectedFiles.appendChild(chip);
  });
}

// =============== upload (direct to S3 with admin temp creds) ===============
uploadBtn.addEventListener("click", async () => {
  if (state.pendingFiles.length === 0) return;
  if (state.bucketCount + state.pendingFiles.length > state.bucketLimit) {
    uploadStatus.className = "error";
    uploadStatus.textContent = `excedería el límite (${state.bucketLimit}). Elimina recursos primero.`;
    return;
  }

  uploadBtn.disabled = true; clearBtn.disabled = true;
  uploadStatus.className = "";
  uploadStatus.textContent = `subiendo ${state.pendingFiles.length} archivo(s)…`;

  const queue = [...state.pendingFiles];
  const results = [];
  const workers = Array.from({ length: Math.min(UPLOAD_CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      const f = queue.shift();
      try {
        const key = await s3PutObject(f);
        results.push({ name: f.name, ok: true, key });
      } catch (err) {
        results.push({ name: f.name, ok: false, error: err.message || String(err) });
      }
    }
  });
  await Promise.all(workers);

  const failed = results.filter((r) => !r.ok);
  uploadStatus.className = failed.length ? "error" : "success";
  if (failed.length) {
    const detail = failed.map((f) => f.name + " (" + f.error + ")").join(", ");
    uploadStatus.textContent = `${results.length - failed.length}/${results.length} subidos. fallidos: ${detail}`;
  } else {
    uploadStatus.textContent = `${results.length}/${results.length} subidos correctamente`;
  }

  state.pendingFiles = [];
  renderChips();
  uploadBtn.disabled = false; clearBtn.disabled = false;
  await loadImages();
});

async function s3PutObject(file) {
  const safeName = file.name.replaceAll(/[^A-Za-z0-9._-]/g, "_");
  const key = `${KEY_PREFIX}${safeName}`;
  await state.s3.putObject({
    Key: key,
    Body: file,
    ContentType: file.type || "application/octet-stream",
  }).promise();
  return key;
}

async function s3DeleteObject(key) {
  await state.s3.deleteObject({ Key: key }).promise();
}

async function s3ListObjects() {
  const res = await state.s3.listObjectsV2({ Prefix: KEY_PREFIX }).promise();
  return (res.Contents || [])
    .filter((o) => o.Size > 0)
    .map((o) => ({
      key: o.Key,
      name: o.Key.startsWith(KEY_PREFIX) ? o.Key.slice(KEY_PREFIX.length) : o.Key,
      size: o.Size,
      lastModified: o.LastModified,
    }));
}

async function s3GetBlob(item) {
  const res = await state.s3.getObject({ Key: item.key }).promise();
  // Body is a Uint8Array in the browser
  return new Blob([res.Body], { type: res.ContentType || "application/octet-stream" });
}

// =============== blob URL cache ===============
function cacheKeyOf(item) { return `${item.key}|${item.lastModified}`; }

async function getBlobUrl(item) {
  const ck = cacheKeyOf(item);
  const cached = state.blobCache.get(ck);
  if (cached) return cached;
  const blob = await s3GetBlob(item);
  const url = URL.createObjectURL(blob);
  state.blobCache.set(ck, url);
  return url;
}

function revokeOrphans(currentItems) {
  const valid = new Set(currentItems.map(cacheKeyOf));
  for (const [k, url] of state.blobCache.entries()) {
    if (!valid.has(k)) { URL.revokeObjectURL(url); state.blobCache.delete(k); }
  }
}

function revokeAllBlobs() {
  for (const url of state.blobCache.values()) URL.revokeObjectURL(url);
  state.blobCache.clear();
}

// =============== gallery + pagination ===============
refreshBtn.addEventListener("click", () => loadImages());
prevBtn.addEventListener("click", () => { state.page = Math.max(1, state.page - 1); renderGallery(); });
nextBtn.addEventListener("click", () => {
  const total = Math.max(1, Math.ceil(state.images.length / PAGE_SIZE));
  state.page = Math.min(total, state.page + 1);
  renderGallery();
});

async function loadImages() {
  gallery.innerHTML = '<p class="empty">Cargando…</p>';
  pagination.hidden = true;
  galleryCount.textContent = "";
  try {
    const items = await s3ListObjects();
    revokeOrphans(items);
    state.images = items.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
    state.bucketCount = items.length;
    state.bucketFull = state.bucketCount >= state.bucketLimit;
    state.page = 1;
    updateCapacityUI();
    renderGallery();
  } catch (err) {
    gallery.innerHTML = `<p class="empty error">${escapeHtml(err.message || String(err))}</p>`;
  }
}

function updateCapacityUI() {
  capacityLabel.textContent = `${state.bucketCount} / ${state.bucketLimit}`;
  if (state.bucketFull) {
    dropZone.classList.add("is-disabled");
    dropZone.setAttribute("aria-disabled", "true");
    bucketFullBanner.hidden = false;
  } else {
    dropZone.classList.remove("is-disabled");
    dropZone.removeAttribute("aria-disabled");
    bucketFullBanner.hidden = true;
  }
}

function renderGallery() {
  const total = state.images.length;
  galleryCount.textContent = total;
  if (total === 0) {
    gallery.innerHTML = '<p class="empty">No hay archivos en el bucket aún.</p>';
    pagination.hidden = true;
    return;
  }
  const totalPages = Math.ceil(total / PAGE_SIZE);
  if (state.page > totalPages) state.page = totalPages;
  const start = (state.page - 1) * PAGE_SIZE;
  const slice = state.images.slice(start, start + PAGE_SIZE);

  gallery.innerHTML = "";
  slice.forEach((img) => gallery.appendChild(renderRow(img)));

  if (total > PAGE_SIZE) {
    pagination.hidden = false;
    pageLabel.textContent = `Página ${state.page} de ${totalPages}`;
    prevBtn.disabled = state.page === 1;
    nextBtn.disabled = state.page === totalPages;
  } else {
    pagination.hidden = true;
  }
}

function renderRow(img) {
  const row = document.createElement("div");
  row.className = "asset-row";

  const click = document.createElement("button");
  click.type = "button";
  click.className = "asset-click";
  click.appendChild(buildThumb(img));
  const meta = document.createElement("div");
  meta.className = "asset-meta";
  meta.innerHTML = `
    <div class="asset-name">${escapeHtml(img.name)}</div>
    <div class="asset-sub">${fmtSize(img.size)} &middot; ${fmtDate(img.lastModified)}</div>
  `;
  click.appendChild(meta);
  click.addEventListener("click", () => openDetail(img));
  row.appendChild(click);

  const chev = document.createElement("span");
  chev.className = "asset-chevron";
  chev.setAttribute("aria-hidden", "true");
  chev.textContent = "›";
  row.appendChild(chev);

  if (state.role === "admin") {
    const del = document.createElement("button");
    del.type = "button";
    del.className = "row-delete";
    del.setAttribute("aria-label", `Eliminar ${img.name}`);
    del.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      Eliminar
    `;
    del.addEventListener("click", () => deleteAsset(img, del));
    row.appendChild(del);
  }
  return row;
}

function buildThumb(img) {
  if (!isImage(img.name)) {
    const div = document.createElement("div");
    div.className = "asset-thumb file-icon";
    div.textContent = (extOf(img.name) || "file").toUpperCase().slice(0, 4);
    return div;
  }
  const el = document.createElement("img");
  el.className = "asset-thumb";
  el.alt = "";
  el.loading = "lazy";
  getBlobUrl(img)
    .then((url) => { el.src = url; })
    .catch((err) => {
      console.warn("thumb load failed", img.name, err);
      const fallback = document.createElement("div");
      fallback.className = "asset-thumb file-icon";
      fallback.textContent = "ERR";
      el.replaceWith(fallback);
    });
  return el;
}

// =============== detail modal ===============
function openDetail(img) {
  state.detailImg = img;
  detailName.textContent = img.name;
  detailSize.textContent = fmtSize(img.size);
  detailModified.textContent = fmtDate(img.lastModified);
  detailKey.textContent = img.key;
  detailOpen.removeAttribute("href");
  detailOpen.setAttribute("download", img.name);
  detailDelete.hidden = state.role !== "admin";
  detailDelete.disabled = false;

  if (isImage(img.name)) {
    detailImg.removeAttribute("src");
    detailImg.alt = img.name;
    detailImg.hidden = false;
    detailNoPreview.hidden = true;
  } else {
    detailImg.removeAttribute("src");
    detailImg.hidden = true;
    detailNoPreview.hidden = false;
    detailNoPreviewExt.textContent = (extOf(img.name) || "file").toUpperCase();
  }

  if (typeof modal.showModal === "function") modal.showModal();
  else modal.setAttribute("open", "");

  getBlobUrl(img)
    .then((url) => {
      if (state.detailImg !== img) return;
      detailOpen.href = url;
      if (isImage(img.name)) detailImg.src = url;
    })
    .catch((err) => { console.warn("detail load failed", err); });
}

function closeDetail() {
  if (typeof modal.close === "function" && modal.open) modal.close();
  else modal.removeAttribute("open");
  detailImg.removeAttribute("src");
  state.detailImg = null;
}

detailClose.addEventListener("click", closeDetail);
modal.addEventListener("click", (e) => { if (e.target === modal) closeDetail(); });
modal.addEventListener("close", () => { detailImg.removeAttribute("src"); state.detailImg = null; });

detailDelete.addEventListener("click", () => {
  if (state.detailImg) deleteAsset(state.detailImg, detailDelete);
});

async function deleteAsset(img, button) {
  const name = img.key.replace(/^assets\//, "");
  if (!confirm(`¿Eliminar "${name}" del bucket? Esta acción es irreversible.`)) return;
  if (button) button.disabled = true;
  try {
    await s3DeleteObject(img.key);
    if (modal.open && state.detailImg && state.detailImg.key === img.key) closeDetail();
    uploadStatus.className = "success";
    uploadStatus.textContent = `eliminado: ${name}`;
    await loadImages();
  } catch (err) {
    alert(`Error eliminando: ${err.message || err}`);
    if (button) button.disabled = false;
  }
}

// =============== access list (admin only) ===============
accessRefreshBtn.addEventListener("click", () => loadAccessList());

async function loadAccessList() {
  accessContent.innerHTML = '<p class="empty">Cargando…</p>';
  try {
    const res = await fetch(`${API}/access-list`, {
      headers: { Authorization: `Bearer ${state.appToken}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderAccessList(data);
  } catch (err) {
    accessContent.innerHTML = `<p class="empty error">${escapeHtml(err.message)}</p>`;
  }
}

function renderAccessList(d) {
  const rows = (d.principals || []).map((p) => `
    <tr>
      <td><span class="kind-pill ${p.kind}">${p.kind}</span></td>
      <td><strong>${escapeHtml(p.name)}</strong></td>
      <td class="${p.canRead ? "cap-yes" : "cap-no"}">${p.canRead ? "✓" : "—"}</td>
      <td class="${p.canWrite ? "cap-yes" : "cap-no"}">${p.canWrite ? "✓" : "—"}</td>
      <td>${escapeHtml(p.purpose || "")}</td>
      <td class="arn">${escapeHtml(p.arn)}</td>
    </tr>
  `).join("");

  const groupMembers = (d.readersGroup?.members || [])
    .map((u) => escapeHtml(u.name))
    .join(", ") || "—";

  const bpa = d.publicAccessBlock || {};
  const bpaAll = bpa.BlockPublicAcls && bpa.IgnorePublicAcls && bpa.BlockPublicPolicy && bpa.RestrictPublicBuckets;

  const corsOrigins = (d.cors?.[0]?.AllowedOrigins || []).map(escapeHtml).join(", ") || "—";

  accessContent.innerHTML = `
    <table class="access-table">
      <thead>
        <tr>
          <th>Tipo</th>
          <th>Nombre</th>
          <th>Read</th>
          <th>Write</th>
          <th>Propósito</th>
          <th>ARN</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>

    <div class="access-meta">
      <div class="access-meta-card">
        <h4>Bucket</h4>
        <div class="v v-mono">${escapeHtml(d.bucket)}</div>
      </div>
      <div class="access-meta-card">
        <h4>Block Public Access</h4>
        <div class="v">${bpaAll ? "✓ ALL ON" : "⚠ partial / off"}</div>
      </div>
      <div class="access-meta-card">
        <h4>TLS enforced</h4>
        <div class="v">${d.tlsEnforced ? "✓ HTTPS only" : "⚠ no"}</div>
      </div>
      <div class="access-meta-card">
        <h4>CORS origins</h4>
        <div class="v v-mono">${corsOrigins}</div>
      </div>
      <div class="access-meta-card">
        <h4>Reader IAM group (${escapeHtml(d.readersGroup?.name || "")})</h4>
        <div class="v">${groupMembers}</div>
      </div>
    </div>
  `;
}

// =============== utils ===============
const HTML_ESCAPES = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};
function escapeHtml(s) {
  return String(s ?? "").replaceAll(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}
function isImage(name) { return IMAGE_EXTS.test(name); }
function extOf(name) {
  const m = /\.([^.]+)$/.exec(name);
  return m ? m[1] : "";
}
function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("es-ES", {
    year: "numeric", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

// initial view
if (state.appToken && state.user && state.role && state.aws) showMain();
else showLogin();
