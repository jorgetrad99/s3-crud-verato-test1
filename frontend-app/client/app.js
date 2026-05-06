const API = "/api";
const PAGE_SIZE = 6;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

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
  token: sessionStorage.getItem("token") || null,
  user: sessionStorage.getItem("user") || null,
  role: sessionStorage.getItem("role") || null,
  pendingFiles: [],
  images: [],
  page: 1,
  detailImg: null,
  bucketCount: 0,
  bucketLimit: 50,
  bucketFull: false,
};

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
    const { token, user, role } = await res.json();
    saveSession(token, user, role);
    showMain();
  } catch (err) {
    loginError.textContent = err.message;
  }
});

$("logout").addEventListener("click", async () => {
  if (state.token) {
    await fetch(`${API}/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${state.token}` },
    }).catch(() => {});
  }
  clearSession();
  showLogin();
});

function saveSession(token, user, role) {
  state.token = token; state.user = user; state.role = role;
  sessionStorage.setItem("token", token);
  sessionStorage.setItem("user", user);
  sessionStorage.setItem("role", role);
}
function clearSession() {
  state.token = state.user = state.role = null;
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
  loadImages();
}

// =============== drop zone ===============
dropZone.addEventListener("click", () => {
  if (state.bucketFull) return;
  fileInput.click();
});

["dragenter", "dragover"].forEach((evt) => {
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (state.bucketFull) return;
    dropZone.classList.add("is-dragover");
  });
});

["dragleave", "drop"].forEach((evt) => {
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (evt === "dragleave" && dropZone.contains(e.relatedTarget)) return;
    dropZone.classList.remove("is-dragover");
  });
});

dropZone.addEventListener("drop", (e) => {
  if (state.bucketFull) return;
  addFiles(e.dataTransfer.files);
});

fileInput.addEventListener("change", (e) => {
  addFiles(e.target.files);
  e.target.value = "";
});

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

  // client-side capacity guard
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
    selectedFiles.hidden = true;
    selectedFiles.innerHTML = "";
    uploadActions.hidden = true;
    return;
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

// =============== upload ===============
uploadBtn.addEventListener("click", async () => {
  if (state.pendingFiles.length === 0) return;
  if (state.bucketCount + state.pendingFiles.length > state.bucketLimit) {
    uploadStatus.className = "error";
    uploadStatus.textContent = `excedería el límite (${state.bucketLimit}). Elimina recursos primero.`;
    return;
  }

  const fd = new FormData();
  for (const f of state.pendingFiles) fd.append("files", f);

  uploadBtn.disabled = true;
  clearBtn.disabled = true;
  uploadStatus.className = "";
  uploadStatus.textContent = `subiendo ${state.pendingFiles.length} archivo(s)...`;

  try {
    const res = await fetch(`${API}/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${state.token}` },
      body: fd,
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    const failed = (body.results || []).filter((r) => !r.ok);
    uploadStatus.className = failed.length ? "error" : "success";
    if (failed.length) {
      const detail = failed.map((f) => f.name + " (" + f.error + ")").join(", ");
      uploadStatus.textContent = `${body.uploaded}/${body.total} subidos. fallidos: ${detail}`;
    } else {
      uploadStatus.textContent = `${body.uploaded}/${body.total} subidos correctamente`;
    }
    state.pendingFiles = [];
    renderChips();
    await loadImages();
  } catch (err) {
    uploadStatus.className = "error";
    uploadStatus.textContent = err.message;
  } finally {
    uploadBtn.disabled = false;
    clearBtn.disabled = false;
  }
});

// =============== gallery + pagination ===============
refreshBtn.addEventListener("click", () => loadImages());
prevBtn.addEventListener("click", () => { state.page = Math.max(1, state.page - 1); renderGallery(); });
nextBtn.addEventListener("click", () => {
  const total = Math.max(1, Math.ceil(state.images.length / PAGE_SIZE));
  state.page = Math.min(total, state.page + 1);
  renderGallery();
});

async function loadImages() {
  gallery.innerHTML = '<p class="empty">Cargando...</p>';
  pagination.hidden = true;
  galleryCount.textContent = "";
  try {
    const res = await fetch(`${API}/images`, {
      headers: { Authorization: `Bearer ${state.token}` },
    });
    if (res.status === 401) { clearSession(); showLogin(); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { images, count, limit, full } = await res.json();
    state.images = images.sort(
      (a, b) => new Date(b.lastModified) - new Date(a.lastModified)
    );
    state.bucketCount = count ?? state.images.length;
    state.bucketLimit = limit ?? state.bucketLimit;
    state.bucketFull = !!full || state.bucketCount >= state.bucketLimit;
    state.page = 1;
    updateCapacityUI();
    renderGallery();
  } catch (err) {
    gallery.innerHTML = `<p class="empty error">${escapeHtml(err.message)}</p>`;
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
  click.innerHTML = `
    ${thumbHtml(img)}
    <div class="asset-meta">
      <div class="asset-name">${escapeHtml(img.name)}</div>
      <div class="asset-sub">${fmtSize(img.size)} &middot; ${fmtDate(img.lastModified)}</div>
    </div>
  `;
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

function thumbHtml(img) {
  if (isImage(img.name)) {
    return `<img class="asset-thumb" src="${img.url}" alt="" loading="lazy" />`;
  }
  const ext = (extOf(img.name) || "file").toUpperCase().slice(0, 4);
  return `<div class="asset-thumb file-icon">${escapeHtml(ext)}</div>`;
}

// =============== detail modal ===============
function openDetail(img) {
  state.detailImg = img;
  detailName.textContent = img.name;
  detailSize.textContent = fmtSize(img.size);
  detailModified.textContent = fmtDate(img.lastModified);
  detailKey.textContent = img.key;
  detailOpen.href = img.url;
  detailDelete.hidden = state.role !== "admin";
  detailDelete.disabled = false;

  if (isImage(img.name)) {
    detailImg.src = img.url;
    detailImg.alt = img.name;
    detailImg.hidden = false;
    detailNoPreview.hidden = true;
  } else {
    detailImg.src = "";
    detailImg.hidden = true;
    detailNoPreview.hidden = false;
    detailNoPreviewExt.textContent = (extOf(img.name) || "file").toUpperCase();
  }

  if (typeof modal.showModal === "function") modal.showModal();
  else modal.setAttribute("open", "");
}

function closeDetail() {
  if (typeof modal.close === "function" && modal.open) modal.close();
  else modal.removeAttribute("open");
  detailImg.src = "";
  state.detailImg = null;
}

detailClose.addEventListener("click", closeDetail);
modal.addEventListener("click", (e) => { if (e.target === modal) closeDetail(); });
modal.addEventListener("close", () => { detailImg.src = ""; state.detailImg = null; });

detailDelete.addEventListener("click", () => {
  if (state.detailImg) deleteAsset(state.detailImg, detailDelete);
});

async function deleteAsset(img, button) {
  const name = img.key.replace(/^assets\//, "");
  if (!confirm(`¿Eliminar "${name}" del bucket? Esta acción es irreversible.`)) return;
  if (button) button.disabled = true;
  try {
    const res = await fetch(`${API}/delete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${state.token}`,
      },
      body: JSON.stringify({ key: img.key }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    if (modal.open && state.detailImg && state.detailImg.key === img.key) closeDetail();
    uploadStatus.className = "success";
    uploadStatus.textContent = `eliminado: ${name}`;
    await loadImages();
  } catch (err) {
    alert(`Error eliminando: ${err.message}`);
    if (button) button.disabled = false;
  }
}

// =============== utils ===============
const HTML_ESCAPES = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};
function escapeHtml(s) {
  return String(s).replaceAll(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

function isImage(name) {
  return IMAGE_EXTS.test(name);
}

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

// auto-resume
if (state.token && state.user && state.role) showMain();
else showLogin();
