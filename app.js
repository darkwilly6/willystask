/**
 * WILLY'S TASK — app.js
 * -----------------------------------------------
 * SETUP INSTRUCTIONS (read before deploying):
 *
 * 1. FIREBASE SETUP:
 *    a) Go to https://console.firebase.google.com
 *    b) Create a new project (free Spark plan)
 *    c) Add a Web App, copy the firebaseConfig object
 *    d) Enable Firestore Database (start in test mode)
 *    e) Paste your config in the FIREBASE CONFIG section below
 *
 * 2. GOOGLE CALENDAR SETUP:
 *    a) Go to https://console.cloud.google.com
 *    b) Create a project → Enable "Google Calendar API"
 *    c) Create OAuth 2.0 credentials (Web application)
 *    d) Add your domain to Authorized JS origins
 *       (for local: http://localhost, for GitHub Pages: your URL)
 *    e) Paste CLIENT_ID and API_KEY below
 *
 * 3. HOST ON GITHUB PAGES:
 *    a) Push all files to a GitHub repo
 *    b) Settings → Pages → Source: main branch / root
 *    c) Add your GitHub Pages URL to OAuth authorized origins
 * -----------------------------------------------
 */

// =============================================
// FIREBASE CONFIG — REPLACE WITH YOUR VALUES
// =============================================
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDYJMOEaP_7MzcIof2eqmNj2MblXFcd5ps",
  authDomain: "willytask.firebaseapp.com",
  projectId: "willytask",
  storageBucket: "willytask.firebasestorage.app",
  messagingSenderId: "655195112736",
  appId: "1:655195112736:web:9816d2913e731d751fc345"
};

// =============================================
// GOOGLE CALENDAR CONFIG — REPLACE WITH YOURS
// =============================================
const GCAL_CLIENT_ID = "30632309801-8ml3ohdte8k0d020mbokioa1ea7dnt65.apps.googleusercontent.com";
const GCAL_API_KEY   = "AIzaSyDk4NJZZhu3mO8PDHG-TV_T19uAGSCu5YE";
const GCAL_SCOPES    = "https://www.googleapis.com/auth/calendar";
const GCAL_DISCOVERY = "https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest";

// =============================================
// APP STATE
// =============================================
let tasks = [];           // in-memory task list
let currentView = "dashboard";
let currentBranch = "all";
let currentLabel = "all";
let editingTaskId = null;
let openDetailId = null;
let todayOffset = 0;      // days from today for "Hoy" view
let calDate = new Date();
let calViewMode = "month"; // month | week | day

// Firebase & GCal handles
let db = null;
let firestoreAvailable = false;
let gcalSignedIn = false;
let tasksUnsubscribe = null;

// =============================================
// FIREBASE INIT
// =============================================
function isFirebaseConfigured() {
  const placeholderMarkers = ["YOUR_", "TU_", "PROJECT_ID", "your-project"];
  return Object.values(FIREBASE_CONFIG).every(val => {
    if (!val || typeof val !== "string") return false;
    return !placeholderMarkers.some(marker => val.includes(marker));
  });
}

async function initFirebase() {
  if (!isFirebaseConfigured()) {
    firestoreAvailable = false;
    setIntegrationStatus("firebase", false, "Sin config");
    return; // Stay in localStorage mode -- never touch `tasks` here.
  }
  try {
    const { initializeApp } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js");
    const { getFirestore, collection, addDoc, updateDoc, deleteDoc, doc, onSnapshot, query, orderBy, getDocs }
      = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");

    const app = initializeApp(FIREBASE_CONFIG);
    db = getFirestore(app);

    // Verify we can actually reach Firestore before trusting it.
    const q = query(collection(db, "tasks"), orderBy("createdAt", "desc"));
    await getDocs(q); // throws if config/rules/network are bad

    firestoreAvailable = true;
    setIntegrationStatus("firebase", true, "Conectado");
    showToast("Firebase conectado ✓", "success");

    // One-time migration: push local-only tasks up to Firestore so nothing is lost.
    const localOnly = tasks.filter(t => !t.id || String(t.id).startsWith("local-"));
    for (const t of localOnly) {
      const { id, ...data } = t;
      await addDoc(collection(db, "tasks"), { ...data, createdAt: data.createdAt || Date.now() });
    }

    // Real-time listener -- only attached AFTER Firestore is confirmed working.
    tasksUnsubscribe = onSnapshot(q, (snapshot) => {
      const remoteTasks = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      if (remoteTasks.length > 0) {
        tasks = remoteTasks;
      }
      saveLocalTasks();
      renderAll();
    }, (err) => {
      console.error("Firestore listener error:", err);
      firestoreAvailable = false;
      setIntegrationStatus("firebase", false, "Error de sync");
      showToast("Se perdio la conexion con Firebase, usando modo local", "error");
    });

    window._fs = { collection, addDoc, updateDoc, deleteDoc, doc, db };
  } catch (e) {
    console.error("Firebase error:", e);
    firestoreAvailable = false;
    setIntegrationStatus("firebase", false, "Error");
    showToast("No se pudo conectar a Firebase, usando modo local", "error");
  }
}

// =============================================
// FIRESTORE CRUD
// =============================================
async function saveTaskToFirestore(task) {
  if (!firestoreAvailable) return { ok: false };
  const { collection, addDoc, updateDoc, doc, db } = window._fs;
  try {
    if (task.id && !String(task.id).startsWith("local-")) {
      const ref = doc(db, "tasks", task.id);
      await updateDoc(ref, task);
      return { ok: true, id: task.id };
    } else {
      const { id, ...data } = task;
      const ref = await addDoc(collection(db, "tasks"), { ...data, createdAt: Date.now() });
      return { ok: true, id: ref.id };
    }
  } catch (e) {
    console.error("Firestore save error:", e);
    // Connection dropped mid-session -- fall back to local mode from now on.
    firestoreAvailable = false;
    setIntegrationStatus("firebase", false, "Error de sync");
    return { ok: false };
  }
}

async function deleteTaskFromFirestore(taskId) {
  if (!firestoreAvailable || String(taskId).startsWith("local-")) return;
  const { deleteDoc, doc, db } = window._fs;
  try {
    await deleteDoc(doc(db, "tasks", taskId));
  } catch (e) {
    console.error("Firestore delete error:", e);
    firestoreAvailable = false;
    setIntegrationStatus("firebase", false, "Error de sync");
  }
}

// =============================================
// GOOGLE CALENDAR INIT (Google Identity Services - GIS)
// =============================================
// NOTE: gapi.auth2 (the old library) is deprecated by Google and returns
// 403 on new OAuth clients. This uses the modern Google Identity Services
// token client for auth, combined with gapi.client only for the Calendar
// API calls themselves (no auth role).
let gisTokenClient = null;
let gapiClientReady = false;
let gisReady = false;

function isGCalConfigured() {
  const placeholderMarkers = ["YOUR_GOOGLE", "YOUR_CLIENT", "YOUR_API"];
  const clientOk = GCAL_CLIENT_ID && !placeholderMarkers.some(m => GCAL_CLIENT_ID.includes(m));
  const keyOk = GCAL_API_KEY && !placeholderMarkers.some(m => GCAL_API_KEY.includes(m));
  return clientOk && keyOk;
}

function initGoogleCalendar() {
  if (!isGCalConfigured()) return;

  // 1. Load gapi.client (Calendar API calls only, no auth)
  const gapiScript = document.createElement("script");
  gapiScript.src = "https://apis.google.com/js/api.js";
  gapiScript.onload = () => {
    gapi.load("client", async () => {
      try {
        await gapi.client.init({});
        await gapi.client.load(GCAL_DISCOVERY);
        gapiClientReady = true;
        maybeRestoreGCalSession();
      } catch (e) {
        console.error("GCal gapi.client init error:", e);
        setIntegrationStatus("gcal", false, "Error");
      }
    });
  };
  document.head.appendChild(gapiScript);

  // 2. Load Google Identity Services (modern OAuth)
  const gisScript = document.createElement("script");
  gisScript.src = "https://accounts.google.com/gsi/client";
  gisScript.onload = () => {
    gisTokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GCAL_CLIENT_ID,
      scope: GCAL_SCOPES,
      callback: (tokenResponse) => {
        if (tokenResponse && tokenResponse.access_token) {
          gapi.client.setToken(tokenResponse);
          sessionStorage.setItem("willystask_gcal_token", JSON.stringify(tokenResponse));
          updateGCalStatus(true);
          showToast("Google Calendar conectado ✓", "success");
        }
      },
      error_callback: (err) => {
        console.error("GCal GIS auth error:", err);
        updateGCalStatus(false);
        showToast("Error al conectar Google Calendar", "error");
      },
    });
    gisReady = true;
    maybeRestoreGCalSession();
  };
  document.head.appendChild(gisScript);
}

function maybeRestoreGCalSession() {
  // Only attempt silent restore once both libraries are ready.
  if (!gapiClientReady || !gisReady) return;
  const saved = sessionStorage.getItem("willystask_gcal_token");
  if (saved) {
    try {
      const token = JSON.parse(saved);
      gapi.client.setToken(token);
      updateGCalStatus(true);
    } catch {
      sessionStorage.removeItem("willystask_gcal_token");
      updateGCalStatus(false);
    }
  } else {
    updateGCalStatus(false);
  }
}

function updateGCalStatus(isSignedIn) {
  gcalSignedIn = isSignedIn;
  setIntegrationStatus("gcal", isSignedIn, isSignedIn ? "Conectado" : "Desconectado");
}

async function gcalSignIn() {
  if (!isGCalConfigured()) {
    showToast("Configura el CLIENT_ID de Google Calendar primero", "error");
    return;
  }
  if (!gisReady || !gisTokenClient) {
    showToast("Google Calendar aún está cargando, intenta de nuevo en unos segundos", "error");
    return;
  }
  gisTokenClient.requestAccessToken({ prompt: "consent" });
}

const GCAL_TZ = "America/El_Salvador";

function gcalPad(n) { return String(n).padStart(2, "0"); }

function gcalAddDays(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${gcalPad(d.getMonth() + 1)}-${gcalPad(d.getDate())}`;
}

// Builds valid start/end for Google Calendar from a task.
function buildGCalTimes(task) {
  // All-day event: Google requires end date to be the NEXT day (exclusive)
  if (!task.startTime) {
    return { start: { date: task.date }, end: { date: gcalAddDays(task.date, 1) } };
  }
  let endTime = task.endTime;
  if (!endTime) {
    // No end time: use duration (default 60 min)
    const [h, m] = task.startTime.split(":").map(Number);
    const mins = Math.min(h * 60 + m + (task.duration || 60), 23 * 60 + 59);
    endTime = `${gcalPad(Math.floor(mins / 60))}:${gcalPad(mins % 60)}`;
  }
  // Crosses midnight (e.g. 18:30 -> 00:30): end goes to the next day
  const endDate = endTime <= task.startTime ? gcalAddDays(task.date, 1) : task.date;
  return {
    start: { dateTime: `${task.date}T${task.startTime}:00`, timeZone: GCAL_TZ },
    end:   { dateTime: `${endDate}T${endTime}:00`, timeZone: GCAL_TZ },
  };
}

function gcalErrorMessage(e) {
  return (e && e.result && e.result.error && e.result.error.message) || (e && e.message) || "error desconocido";
}

function buildGCalEvent(task) {
  const cat = getCategoryById(task.branch);
  const { start, end } = buildGCalTimes(task);
  const event = {
    summary: `[${String(cat.name).toUpperCase()}] ${task.name}`,
    description: task.notes || "",
    start, end,
  };
  if (task.type === "repetitiva" && task.repeatDays && task.repeatDays.length > 0) {
    const days = ["SU","MO","TU","WE","TH","FR","SA"];
    const byday = task.repeatDays.map(d => days[parseInt(d)]).join(",");
    event.recurrence = [`RRULE:FREQ=WEEKLY;BYDAY=${byday}`];
  }
  // Reminders: 5 min before and at start time (only for timed events).
  // To also get an email, add: { method: "email", minutes: 5 }
  if (task.startTime) {
    event.reminders = {
      useDefault: false,
      overrides: [
        { method: "popup", minutes: 5 },
        { method: "popup", minutes: 0 },
      ],
    };
  }
  return event;
}

async function createGCalEvent(task) {
  if (!gcalSignedIn || !task.date) return null;
  if (!window.gapi || !gapi.client || !gapi.client.calendar) {
    showToast("Google Calendar aún no terminó de cargar, reintenta", "error");
    return null;
  }
  try {
    const res = await gapi.client.calendar.events.insert({ calendarId: "primary", resource: buildGCalEvent(task) });
    return res.result.id;
  } catch (e) {
    console.error("GCal event create error:", e);
    if (e && e.status === 401) {
      updateGCalStatus(false);
      sessionStorage.removeItem("willystask_gcal_token");
      showToast("La sesión de Google expiró, vuelve a conectar", "error");
    } else {
      showToast("Google Calendar: " + gcalErrorMessage(e), "error");
    }
    return null;
  }
}

async function updateGCalEvent(task) {
  if (!gcalSignedIn || !task.gcalEventId || !task.date) return;
  try {
    await gapi.client.calendar.events.update({
      calendarId: "primary",
      eventId: task.gcalEventId,
      resource: buildGCalEvent(task),
    });
  } catch (e) {
    console.error("GCal update error:", e);
    showToast("Google Calendar: " + gcalErrorMessage(e), "error");
  }
}

async function deleteGCalEvent(gcalEventId) {
  if (!gcalSignedIn || !gcalEventId) return;
  try {
    await gapi.client.calendar.events.delete({ calendarId: "primary", eventId: gcalEventId });
  } catch (e) {
    console.error("GCal delete error:", e);
  }
}

// =============================================
// LOCAL STORAGE FALLBACK
// =============================================
function loadLocalTasks() {
  try {
    const stored = localStorage.getItem("willystask_tasks");
    if (stored) tasks = JSON.parse(stored);
  } catch {}
}

function saveLocalTasks() {
  try {
    localStorage.setItem("willystask_tasks", JSON.stringify(tasks));
  } catch {}
}

// =============================================
// CATEGORIES — dynamic branches
// =============================================
const DEFAULT_CATEGORIES = [
  { id: "trading",  name: "Trading",  color: "#f97316", emoji: "🟠" },
  { id: "nyxar",    name: "Nyxar",    color: "#a78bfa", emoji: "🟣" },
  { id: "personal", name: "Personal", color: "#34d399", emoji: "🟢" },
];
let categories = [];

function loadCategories() {
  try {
    const stored = localStorage.getItem("willystask_categories");
    categories = stored ? JSON.parse(stored) : JSON.parse(JSON.stringify(DEFAULT_CATEGORIES));
  } catch {
    categories = JSON.parse(JSON.stringify(DEFAULT_CATEGORIES));
  }
}

function saveCategories() {
  try {
    localStorage.setItem("willystask_categories", JSON.stringify(categories));
  } catch {}
}

function getCategoryById(id) {
  return categories.find(c => c.id === id) || { id, name: id, color: "#9090a8", emoji: "" };
}

function renderBranchFilters() {
  const container = document.getElementById("branchFilters");
  if (!container) return;
  let html = `<button class="branch-btn${currentBranch === "all" ? " active" : ""}" data-branch="all">
    <span class="branch-dot all"></span><span>Todas</span>
  </button>`;
  categories.forEach(cat => {
    html += `<button class="branch-btn${currentBranch === cat.id ? " active" : ""}" data-branch="${cat.id}">
      <span class="branch-dot" style="background:${cat.color};box-shadow:0 0 6px ${cat.color}40"></span>
      <span>${cat.emoji ? cat.emoji + " " : ""}${cat.name}</span>
    </button>`;
  });
  container.innerHTML = html;
  container.querySelectorAll(".branch-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      container.querySelectorAll(".branch-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      currentBranch = btn.dataset.branch;
      renderAll();
    });
  });
}

function renderBranchSelect() {
  const sel = document.getElementById("taskBranch");
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = categories.map(cat =>
    `<option value="${cat.id}">${cat.emoji ? cat.emoji + " " : ""}${cat.name}</option>`
  ).join("");
  if (current && categories.find(c => c.id === current)) sel.value = current;
}

// =============================================
// HELPERS
// =============================================
// Local-date formatter (toISOString is UTC and shifts the day after ~6pm in UTC-6)
function toLocalDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function generateId() {
  return "local-" + Math.random().toString(36).slice(2, 11);
}

function getTodayStr(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return toLocalDateStr(d);
}

function formatDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("es-ES", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

function formatDateShort(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("es-ES", { day: "2-digit", month: "short" });
}

function typeLabel(type) {
  const map = { fija: "📌 Fija", repetitiva: "🔁 Repetitiva", urgente: "🚨 Urgente", pendiente: "⏳ Pendiente", proxima: "🔜 Próxima" };
  return map[type] || type;
}

function statusIcon(status) {
  if (status === "completada") return "✓";
  if (status === "suspendida") return "⊘";
  return "";
}

function isTaskOnDate(task, dateStr) {
  if (task.type === "repetitiva" && task.repeatDays && task.repeatDays.length > 0) {
    const d = new Date(dateStr + "T00:00:00");
    return task.repeatDays.includes(String(d.getDay()));
  }
  return task.date === dateStr;
}

function getFilteredTasks() {
  return tasks.filter(t => {
    if (currentBranch !== "all" && t.branch !== currentBranch) return false;
    if (currentLabel !== "all" && t.type !== currentLabel) return false;
    return true;
  });
}

// =============================================
// INTEGRATION STATUS UI
// =============================================
function setIntegrationStatus(service, ok, label) {
  const dot = document.getElementById(service === "firebase" ? "firebaseDot" : "gcalDot");
  const state = document.getElementById(service === "firebase" ? "firebaseState" : "gcalState");
  if (dot) dot.className = "integration-dot" + (ok ? " connected" : "");
  if (state) state.textContent = label;
}

// =============================================
// RENDER: DASHBOARD
// =============================================
function renderDashboard() {
  const today = getTodayStr();
  const filtered = getFilteredTasks();

  const todayTasks = filtered.filter(t => isTaskOnDate(t, today));
  const totalToday = todayTasks.length;
  const pending = todayTasks.filter(t => !t.status || t.status === "pendiente").length;
  const done = todayTasks.filter(t => t.status === "completada").length;
  const urgent = filtered.filter(t => t.type === "urgente" && t.status !== "completada").length;

  document.getElementById("stat-total").textContent = totalToday;
  document.getElementById("stat-pending").textContent = pending;
  document.getElementById("stat-done").textContent = done;
  document.getElementById("stat-urgent").textContent = urgent;

  // Sub-labels with percentages
  const pctPending = totalToday > 0 ? Math.round((pending / totalToday) * 100) : 0;
  const pctDone    = totalToday > 0 ? Math.round((done / totalToday) * 100) : 0;
  const pSub = document.getElementById("stat-pending-pct");
  const dSub = document.getElementById("stat-done-pct");
  const uSub = document.getElementById("stat-urgent-sub");
  if (pSub) pSub.textContent = totalToday > 0 ? pctPending + "% del total" : "";
  if (dSub) dSub.textContent = totalToday > 0 ? pctDone + "% del total" : "";
  if (uSub) uSub.textContent = urgent === 0 ? "Sin tareas críticas" : urgent === 1 ? "1 tarea crítica" : urgent + " tareas críticas";

  // Dynamic greeting
  const greetEl = document.getElementById("greetingTitle");
  if (greetEl) {
    const h = new Date().getHours();
    const greet = h < 12 ? "¡Buenos días!" : h < 18 ? "¡Buenas tardes!" : "¡Buenas noches!";
    greetEl.textContent = greet + " Aquí tienes tu progreso de hoy.";
  }

  // Upcoming: next 7 days, not completed, sorted by date+time
  const upcoming = filtered
    .filter(t => {
      if (t.status === "completada") return false;
      if (!t.date && t.type !== "repetitiva") return true;
      const d = new Date(t.date + "T00:00:00");
      const now = new Date(); now.setHours(0,0,0,0);
      return d >= now;
    })
    .sort((a, b) => {
      const da = (a.date || "9999-12-31") + (a.startTime || "00:00");
      const db2 = (b.date || "9999-12-31") + (b.startTime || "00:00");
      return da.localeCompare(db2);
    })
    .slice(0, 8);

  // Incomplete: has passed or no date, not done, not suspended
  const incomplete = filtered.filter(t => {
    if (t.status === "completada" || t.status === "suspendida") return false;
    if (!t.date) return t.type === "pendiente";
    const d = new Date(t.date + "T00:00:00");
    const now = new Date(); now.setHours(0,0,0,0);
    return d < now;
  });

  document.getElementById("upcoming-count").textContent = upcoming.length;
  document.getElementById("incomplete-count").textContent = incomplete.length;

  renderTaskList("upcoming-list", upcoming);
  renderTaskList("incomplete-list", incomplete);

  // Completed today: always visible (greyed out)
  const completedToday = filtered.filter(t => t.status === "completada" && isTaskOnDate(t, today));
  const ctEl = document.getElementById("completed-today-count");
  if (ctEl) ctEl.textContent = completedToday.length;
  renderTaskList("completed-today-list", completedToday);

  // Charts (use today's tasks so they match the stat cards)
  renderDonutChart(todayTasks);
  renderBranchBars(filtered, today);
}

function renderDonutChart(filtered) {
  const canvas = document.getElementById("donutChart");
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const W = 140, H = 140;
  if (canvas.width !== W * dpr) {
    canvas.style.width = W + "px"; canvas.style.height = H + "px";
    canvas.width = W * dpr; canvas.height = H * dpr;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cx = W/2, cy = H/2, r = 55, lineW = 18;
  ctx.clearRect(0, 0, W, H);
  const counts = {};
  categories.forEach(c => { counts[c.id] = 0; });
  filtered.forEach(t => { if (counts[t.branch] !== undefined) counts[t.branch]++; else counts[t.branch] = 1; });
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const totalEl = document.getElementById("donutTotal");
  if (totalEl) totalEl.textContent = total;
  if (total === 0) {
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI*2);
    ctx.strokeStyle = "rgba(255,255,255,.06)"; ctx.lineWidth = lineW; ctx.stroke();
  } else {
    let startAngle = -Math.PI / 2;
    categories.forEach(cat => {
      const val = counts[cat.id] || 0;
      if (!val) return;
      const sweep = (val / total) * Math.PI * 2;
      ctx.beginPath(); ctx.arc(cx, cy, r, startAngle, startAngle + sweep);
      ctx.strokeStyle = cat.color; ctx.lineWidth = lineW; ctx.lineCap = "round"; ctx.stroke();
      startAngle += sweep;
    });
  }
  const legendEl = document.getElementById("donutLegend");
  if (legendEl) {
    legendEl.innerHTML = categories.map(cat => {
      const val = counts[cat.id] || 0;
      const pct = total > 0 ? Math.round((val/total)*100) : 0;
      return `<div class="donut-legend-item">
        <div class="donut-legend-dot" style="background:${cat.color}"></div>
        <span class="donut-legend-name">${cat.name}</span>
        <span class="donut-legend-val">${val} (${pct}%)</span>
      </div>`;
    }).join("");
  }
}

function renderBranchBars(filtered, today) {
  const el = document.getElementById("branchBars");
  if (!el) return;
  el.innerHTML = categories.map(cat => {
    const catTasks = filtered.filter(t => t.branch === cat.id && isTaskOnDate(t, today));
    const done = catTasks.filter(t => t.status === "completada").length;
    const total = catTasks.length;
    const pct = total > 0 ? Math.round((done/total)*100) : 0;
    return `<div class="branch-bar-item">
      <div class="branch-bar-header">
        <span class="branch-bar-label">
          <span class="branch-bar-dot" style="background:${cat.color}"></span>${cat.name}
        </span>
        <span class="branch-bar-counts">${done}/${total}</span>
      </div>
      <div class="branch-bar-track">
        <div class="branch-bar-fill" style="width:${pct}%;background:${cat.color}"></div>
      </div>
    </div>`;
  }).join("");
}

function renderTaskList(containerId, taskArr) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (taskArr.length === 0) {
    el.innerHTML = `<div class="empty-state"><div class="empty-state-icon">✦</div>No hay tareas aquí</div>`;
    return;
  }
  el.innerHTML = taskArr.map(t => taskCardHTML(t)).join("");
  el.querySelectorAll(".task-card").forEach(card => {
    card.addEventListener("click", () => openDetail(card.dataset.id));
  });
  el.querySelectorAll(".task-check").forEach(btn => {
    btn.addEventListener("click", ev => { ev.stopPropagation(); toggleComplete(btn.dataset.id); });
  });
}

function taskCardHTML(t) {
  const statusClass = t.status ? `status-${t.status}` : "";
  const urgenteClass = t.type === "urgente" && t.status !== "completada" ? "urgente-card" : "";
  const timeStr = t.startTime ? `⏱ ${t.startTime}${t.endTime ? " – " + t.endTime : ""}` : (t.date ? `📅 ${formatDateShort(t.date)}` : "");
  const cat = getCategoryById(t.branch);
  const done = t.status === "completada";

  return `
  <div class="task-card ${statusClass} ${urgenteClass}" data-id="${t.id}" style="--cat-color:${cat.color}">
    <div class="task-info">
      <div class="task-name">${escHtml(t.name)}</div>
      <div class="task-meta">
        ${timeStr ? `<span class="task-time">${timeStr}</span>` : ""}
        <span class="task-badge" style="background:${cat.color}22;color:${cat.color}">${cat.emoji ? cat.emoji + " " : ""}${escHtml(cat.name)}</span>
        <span class="task-type-badge">${typeLabel(t.type)}</span>
        ${t.status === "suspendida" ? `<span class="task-type-badge">⊘ Suspendida</span>` : ""}
      </div>
    </div>
    <button class="task-check${done ? " checked" : ""}" data-id="${t.id}" aria-label="${done ? "Marcar como pendiente" : "Marcar como completada"}">${done ? "✓" : ""}</button>
  </div>`;
}

function escHtml(str) {
  return String(str || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

// =============================================
// RENDER: TODAY TIMELINE
// =============================================
function renderToday() {
  const dateStr = getTodayStr(todayOffset);
  const d = new Date(dateStr + "T00:00:00");
  const dayNames = ["Domingo","Lunes","Martes","Miércoles","Jueves","Viernes","Sábado"];
  const monthNames = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
  document.getElementById("todayLabel").textContent =
    `${dayNames[d.getDay()]}, ${d.getDate()} de ${monthNames[d.getMonth()]} ${d.getFullYear()}`;

  const filtered = getFilteredTasks().filter(t => isTaskOnDate(t, dateStr));

  const timeline = document.getElementById("timeline");
  let html = "";
  for (let h = 0; h < 24; h++) {
    const label = `${String(h).padStart(2,"0")}:00`;
    const hourTasks = filtered.filter(t => t.startTime && t.startTime.startsWith(String(h).padStart(2,"0")));
    const unscheduled = h === 0 ? filtered.filter(t => !t.startTime) : [];

    html += `<div class="timeline-hour">
      <div class="timeline-hour-label">${label}</div>`;

    hourTasks.forEach(t => {
      const statusClass = t.status ? `status-${t.status}` : "";
      html += `<div class="timeline-task ${t.branch} ${statusClass}" data-id="${t.id}">
        <div class="timeline-task-name">${escHtml(t.name)}${t.status === "completada" ? " ✓" : ""}</div>
        <div class="timeline-task-time">${t.startTime || ""}${t.endTime ? " – "+t.endTime : ""}${t.duration ? ` · ${t.duration} min` : ""} · ${typeLabel(t.type)}</div>
      </div>`;
    });

    if (unscheduled.length > 0) {
      unscheduled.forEach(t => {
        const statusClass = t.status ? `status-${t.status}` : "";
        html += `<div class="timeline-task ${t.branch} ${statusClass}" data-id="${t.id}">
          <div class="timeline-task-name">${escHtml(t.name)}${t.status === "completada" ? " ✓" : ""}</div>
          <div class="timeline-task-time">Sin hora · ${typeLabel(t.type)}</div>
        </div>`;
      });
    }

    html += `</div>`;
  }

  timeline.innerHTML = html;
  timeline.querySelectorAll(".timeline-task").forEach(el => {
    el.addEventListener("click", () => openDetail(el.dataset.id));
  });

  // Scroll to current hour
  if (todayOffset === 0) {
    const currentHour = new Date().getHours();
    const hourEls = timeline.querySelectorAll(".timeline-hour");
    if (hourEls[currentHour]) {
      setTimeout(() => hourEls[currentHour].scrollIntoView({ behavior: "smooth", block: "start" }), 100);
    }
  }
}

// =============================================
// RENDER: CALENDAR
// =============================================
function renderCalendar() {
  const body = document.getElementById("calendarBody");
  const title = document.getElementById("calTitle");
  const months = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio","Agosto","Septiembre","Octubre","Noviembre","Diciembre"];
  const days = ["Dom","Lun","Mar","Mié","Jue","Vie","Sáb"];

  if (calViewMode === "month") {
    title.textContent = `${months[calDate.getMonth()]} ${calDate.getFullYear()}`;
    const year = calDate.getFullYear(), month = calDate.getMonth();
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today = new Date();

    let html = `<div class="cal-grid">`;
    days.forEach(d => { html += `<div class="cal-day-header">${d}</div>`; });

    for (let i = 0; i < firstDay; i++) {
      const prevDate = new Date(year, month, -firstDay + i + 1);
      html += `<div class="cal-day other-month"><div class="cal-day-num">${prevDate.getDate()}</div></div>`;
    }

    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(month+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
      const isToday = today.getFullYear()===year && today.getMonth()===month && today.getDate()===d;
      const allDayTasks = getFilteredTasks().filter(t => isTaskOnDate(t, dateStr));
      const taskCount = allDayTasks.length;

      html += `<div class="cal-day${isToday?" today-cell":""}" data-date="${dateStr}">
        <div class="cal-day-num-wrap">
          <div class="cal-day-num">${d}</div>
          ${taskCount > 0 ? `<span class="cal-day-task-count">${taskCount}</span>` : ""}
        </div>`;
      allDayTasks.slice(0, 3).forEach(t => {
        const statusClass = t.status === "completada" ? " status-completada" : "";
        const cat = getCategoryById(t.branch);
        html += `<div class="cal-day-mini-task${statusClass}" data-id="${t.id}" style="border-left-color:${cat.color};background:${cat.color}18;color:${cat.color}">${escHtml(t.name)}</div>`;
      });
      if (taskCount > 3) html += `<div class="cal-day-more">+${taskCount-3} más</div>`;
      if (taskCount > 0) {
        html += `<div class="cal-dots">${allDayTasks.slice(0, 4).map(t =>
          `<span class="cal-dot${t.status === "completada" ? " done" : ""}" style="background:${getCategoryById(t.branch).color}"></span>`
        ).join("")}</div>`;
      }
      html += `</div>`;
    }

    const remaining = 7 - ((firstDay + daysInMonth) % 7);
    if (remaining < 7) {
      for (let i = 1; i <= remaining; i++) {
        html += `<div class="cal-day other-month"><div class="cal-day-num">${i}</div></div>`;
      }
    }
    html += `</div>`;
    body.innerHTML = html;

    body.querySelectorAll(".cal-day-mini-task").forEach(el => {
      el.addEventListener("click", e => { e.stopPropagation(); openDetail(el.dataset.id); });
    });
    body.querySelectorAll(".cal-day[data-date]").forEach(el => {
      el.addEventListener("click", () => {
        const date = el.dataset.date;
        if (window.innerWidth <= 768) {
          // Mobile: open that day's agenda instead of the new-task form
          calDate = new Date(date + "T00:00:00");
          calViewMode = "day";
          document.querySelectorAll(".cal-view-btn").forEach(b => b.classList.toggle("active", b.dataset.calview === "day"));
          renderCalendar();
        } else {
          openTaskModal(null, date);
        }
      });
    });

  } else if (calViewMode === "week") {
    const startOfWeek = new Date(calDate);
    const dow = startOfWeek.getDay();
    startOfWeek.setDate(startOfWeek.getDate() - dow);
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(endOfWeek.getDate() + 6);
    title.textContent = `${formatDateShort(toLocalDateStr(startOfWeek))} – ${formatDateShort(toLocalDateStr(endOfWeek))}`;

    const today = new Date();
    let html = `<div class="week-grid">`;
    html += `<div class="week-header-cell"></div>`;

    const weekDays = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(startOfWeek);
      d.setDate(d.getDate() + i);
      weekDays.push(d);
      const isToday = d.toDateString() === today.toDateString();
      html += `<div class="week-header-cell">
        <div class="week-day-name">${days[d.getDay()]}</div>
        <div class="week-day-num${isToday?" today-num":""}">${d.getDate()}</div>
      </div>`;
    }

    for (let h = 7; h < 22; h++) {
      html += `<div class="week-time-col">${String(h).padStart(2,"0")}:00</div>`;
      weekDays.forEach(d => {
        const dateStr = toLocalDateStr(d);
        const hourTasks = getFilteredTasks().filter(t => isTaskOnDate(t, dateStr) && t.startTime && t.startTime.startsWith(String(h).padStart(2,"0")));
        html += `<div class="week-cell">`;
        hourTasks.forEach(t => {
          const statusClass = t.status ? `status-${t.status}` : "";
          html += `<div class="week-cell-task ${t.branch} ${statusClass}" data-id="${t.id}">${escHtml(t.name)}</div>`;
        });
        html += `</div>`;
      });
    }
    html += `</div>`;
    body.innerHTML = html;

    body.querySelectorAll(".week-cell-task").forEach(el => {
      el.addEventListener("click", e => { e.stopPropagation(); openDetail(el.dataset.id); });
    });

  } else if (calViewMode === "day") {
    const dateStr = toLocalDateStr(calDate);
    title.textContent = formatDate(dateStr);
    const dayTasks = getFilteredTasks().filter(t => isTaskOnDate(t, dateStr));

    let html = `<div style="padding-left:60px;position:relative">`;
    for (let h = 0; h < 24; h++) {
      const hourTasks = dayTasks.filter(t => t.startTime && t.startTime.startsWith(String(h).padStart(2,"0")));
      const unscheduled = h === 0 ? dayTasks.filter(t => !t.startTime) : [];
      html += `<div class="timeline-hour">
        <div class="timeline-hour-label">${String(h).padStart(2,"0")}:00</div>`;
      [...hourTasks, ...unscheduled].forEach(t => {
        const statusClass = t.status ? `status-${t.status}` : "";
        html += `<div class="timeline-task ${t.branch} ${statusClass}" data-id="${t.id}">
          <div class="timeline-task-name">${escHtml(t.name)}</div>
          <div class="timeline-task-time">${t.startTime||"Sin hora"}${t.endTime?" – "+t.endTime:""} · ${typeLabel(t.type)}</div>
        </div>`;
      });
      html += `</div>`;
    }
    html += `</div>`;
    body.innerHTML = html;

    body.querySelectorAll(".timeline-task").forEach(el => {
      el.addEventListener("click", () => openDetail(el.dataset.id));
    });
  }
}

// =============================================
// RENDER ALL
// =============================================
function renderAll() {
  renderDashboard();
  if (currentView === "today") renderToday();
  if (currentView === "calendar") renderCalendar();
}

// =============================================
// TASK MODAL
// =============================================
function openTaskModal(taskId = null, prefillDate = null) {
  editingTaskId = taskId;
  document.getElementById("modalTitle").textContent = taskId ? "Editar Tarea" : "Nueva Tarea";

  const today = getTodayStr();
  document.getElementById("taskName").value = "";
  document.getElementById("taskBranch").value = "trading";
  document.getElementById("taskType").value = "fija";
  document.getElementById("taskDate").value = prefillDate || today;
  document.getElementById("taskStart").value = "";
  document.getElementById("taskEnd").value = "";
  document.getElementById("taskDuration").value = "";
  document.getElementById("taskNotes").value = "";
  document.querySelectorAll(".day-toggle").forEach(b => b.classList.remove("active"));
  document.getElementById("repeatDaysGroup").style.display = "none";

  if (taskId) {
    const t = tasks.find(x => x.id === taskId);
    if (t) {
      document.getElementById("taskName").value = t.name || "";
      document.getElementById("taskBranch").value = t.branch || "trading";
      document.getElementById("taskType").value = t.type || "fija";
      document.getElementById("taskDate").value = t.date || today;
      document.getElementById("taskStart").value = t.startTime || "";
      document.getElementById("taskEnd").value = t.endTime || "";
      document.getElementById("taskDuration").value = t.duration || "";
      document.getElementById("taskNotes").value = t.notes || "";
      if (t.type === "repetitiva") {
        document.getElementById("repeatDaysGroup").style.display = "block";
        (t.repeatDays || []).forEach(day => {
          const btn = document.querySelector(`.day-toggle[data-day="${day}"]`);
          if (btn) btn.classList.add("active");
        });
      }
    }
  }

  document.getElementById("modalBackdrop").classList.add("open");
}

function closeTaskModal() {
  document.getElementById("modalBackdrop").classList.remove("open");
  editingTaskId = null;
}

async function saveTask() {
  const name = document.getElementById("taskName").value.trim();
  if (!name) { showToast("El nombre es obligatorio", "error"); return; }

  const type = document.getElementById("taskType").value;
  const repeatDays = type === "repetitiva"
    ? Array.from(document.querySelectorAll(".day-toggle.active")).map(b => b.dataset.day)
    : [];

  const taskData = {
    name,
    branch: document.getElementById("taskBranch").value,
    type,
    date: document.getElementById("taskDate").value || null,
    startTime: document.getElementById("taskStart").value || null,
    endTime: document.getElementById("taskEnd").value || null,
    duration: document.getElementById("taskDuration").value ? parseInt(document.getElementById("taskDuration").value) : null,
    notes: document.getElementById("taskNotes").value.trim() || null,
    repeatDays,
    status: null,
  };

  if (editingTaskId) {
    const idx = tasks.findIndex(t => t.id === editingTaskId);
    if (idx !== -1) {
      taskData.id = editingTaskId;
      taskData.gcalEventId = tasks[idx].gcalEventId || null;
      taskData.status = tasks[idx].status || null;
      tasks[idx] = taskData;

      // Always persist locally first -- this guarantees the task is never lost.
      saveLocalTasks();

      if (firestoreAvailable) {
        const result = await saveTaskToFirestore(taskData);
        if (!result.ok) {
          showToast("No se pudo sincronizar con la nube, guardado localmente", "error");
        }
      }
      if (gcalSignedIn && taskData.gcalEventId) {
        await updateGCalEvent(taskData);
      } else if (gcalSignedIn && taskData.date) {
        taskData.gcalEventId = await createGCalEvent(taskData) || null;
        tasks[idx] = taskData;
        saveLocalTasks();
        if (firestoreAvailable) await saveTaskToFirestore(taskData);
      }
      showToast("Tarea actualizada ✓", "success");
    }
  } else {
    taskData.id = generateId();
    taskData.createdAt = Date.now();

    // Create in GCal first to get event ID
    if (gcalSignedIn) {
      taskData.gcalEventId = await createGCalEvent(taskData) || null;
    }

    // Always add it locally immediately so the UI updates instantly and nothing is lost.
    tasks.unshift(taskData);
    saveLocalTasks();

    if (firestoreAvailable) {
      const result = await saveTaskToFirestore(taskData);
      if (result.ok && result.id) {
        // Swap the local-id task for the Firestore-id version.
        const idx = tasks.findIndex(t => t.id === taskData.id);
        if (idx !== -1) tasks[idx].id = result.id;
        saveLocalTasks();
      } else {
        showToast("No se pudo sincronizar con la nube, guardado localmente", "error");
      }
    }
    showToast("Tarea creada ✓", "success");
  }

  closeTaskModal();
  renderAll();
}

// =============================================
// DETAIL MODAL
// =============================================
function openDetail(taskId) {
  const t = tasks.find(x => x.id === taskId);
  if (!t) return;
  openDetailId = taskId;

  const badge = document.getElementById("detailBranch");
  const dcat = getCategoryById(t.branch);
  badge.textContent = (dcat.emoji ? dcat.emoji + " " : "") + dcat.name;
  badge.className = "detail-branch-badge";
  badge.style.background = dcat.color + "22";
  badge.style.color = dcat.color;
  badge.style.border = `1px solid ${dcat.color}55`;

  document.getElementById("detailName").textContent = t.name;

  const meta = [];
  if (t.date) meta.push(`<span>📅 ${formatDate(t.date)}</span>`);
  if (t.startTime) meta.push(`<span>⏱ ${t.startTime}${t.endTime ? " – "+t.endTime : ""}</span>`);
  if (t.duration) meta.push(`<span>⏳ ${t.duration} min</span>`);
  meta.push(`<span>${typeLabel(t.type)}</span>`);
  if (t.type === "repetitiva" && t.repeatDays && t.repeatDays.length > 0) {
    const dNames = ["D","L","M","X","J","V","S"];
    meta.push(`<span>🔁 ${t.repeatDays.map(d => dNames[parseInt(d)]).join(", ")}</span>`);
  }
  document.getElementById("detailMeta").innerHTML = meta.join("");

  const notesEl = document.getElementById("detailNotes");
  if (t.notes) {
    notesEl.textContent = t.notes;
    notesEl.classList.add("visible");
  } else {
    notesEl.classList.remove("visible");
  }

  // Status buttons
  const btnComplete = document.getElementById("btnComplete");
  const btnSuspend = document.getElementById("btnSuspend");
  btnComplete.classList.toggle("active-status", t.status === "completada");
  btnSuspend.classList.toggle("active-status", t.status === "suspendida");

  document.getElementById("detailBackdrop").classList.add("open");
}

function closeDetail() {
  document.getElementById("detailBackdrop").classList.remove("open");
  openDetailId = null;
}

async function setTaskStatus(status) {
  if (!openDetailId) return;
  const idx = tasks.findIndex(t => t.id === openDetailId);
  if (idx === -1) return;

  const currentStatus = tasks[idx].status;
  // Toggle off if same status
  tasks[idx].status = currentStatus === status ? null : status;

  if (firestoreAvailable) {
    await saveTaskToFirestore(tasks[idx]);
  } else {
    saveLocalTasks();
  }

  const label = tasks[idx].status === "completada" ? "Marcada como completada ✓"
    : tasks[idx].status === "suspendida" ? "Marcada como suspendida"
    : "Estado removido";
  showToast(label, "success");

  closeDetail();
  renderAll();
}

async function toggleComplete(taskId) {
  const idx = tasks.findIndex(t => t.id === taskId);
  if (idx === -1) return;
  tasks[idx].status = tasks[idx].status === "completada" ? null : "completada";
  saveLocalTasks();
  if (firestoreAvailable) await saveTaskToFirestore(tasks[idx]);
  showToast(tasks[idx].status === "completada" ? "Completada ✓" : "Marcada como pendiente", "success");
  renderAll();
}

async function deleteTask() {
  if (!openDetailId) return;
  if (!confirm("¿Eliminar esta tarea? Esta acción no se puede deshacer.")) return;
  const t = tasks.find(x => x.id === openDetailId);
  if (!t) return;

  if (gcalSignedIn && t.gcalEventId) {
    await deleteGCalEvent(t.gcalEventId);
  }
  if (firestoreAvailable) {
    await deleteTaskFromFirestore(openDetailId);
  }
  // Always remove locally too -- guarantees deletion even if Firestore lags or fails.
  tasks = tasks.filter(x => x.id !== openDetailId);
  saveLocalTasks();

  showToast("Tarea eliminada", "");
  closeDetail();
  renderAll();
}

// =============================================
// TOAST
// =============================================
let toastTimer = null;
function showToast(msg, type = "") {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = `toast ${type} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.classList.remove("show"); }, 3000);
}

// =============================================
// CATEGORY MODAL
// =============================================
const COLOR_PRESETS = ["#f97316","#a78bfa","#34d399","#f43f5e","#3b82f6","#eab308","#ec4899","#14b8a6","#8b5cf6","#06b6d4"];

function openCatModal() {
  renderCatList();
  renderColorPresets();
  document.getElementById("catName").value = "";
  document.getElementById("catEmoji").value = "";
  document.getElementById("catColor").value = "#a78bfa";
  document.getElementById("catSave").textContent = "Agregar Rama";
  document.getElementById("catSave").dataset.editId = "";
  document.getElementById("catModalBackdrop").classList.add("open");
}

function closeCatModal() {
  document.getElementById("catModalBackdrop").classList.remove("open");
}

function renderCatList() {
  const el = document.getElementById("catList");
  if (!el) return;
  if (categories.length === 0) {
    el.innerHTML = `<div class="empty-state" style="padding:12px">No hay ramas. Agrega una abajo.</div>`;
    return;
  }
  el.innerHTML = categories.map(cat => {
    const taskCount = tasks.filter(t => t.branch === cat.id).length;
    return `<div class="cat-list-item">
      <span class="cat-list-swatch" style="background:${cat.color};box-shadow:0 0 8px ${cat.color}60"></span>
      <span class="cat-list-emoji">${cat.emoji || ""}</span>
      <span class="cat-list-name">${escHtml(cat.name)}</span>
      <span style="font-size:11px;color:var(--text-3)">${taskCount} tareas</span>
      <div class="cat-list-actions">
        <button class="cat-action-btn edit" data-id="${cat.id}" title="Editar">&#9998;</button>
        <button class="cat-action-btn del" data-id="${cat.id}" title="Eliminar" ${taskCount > 0 ? 'disabled title="Tiene tareas asignadas"' : ""}>&#10005;</button>
      </div>
    </div>`;
  }).join("");

  el.querySelectorAll(".cat-action-btn.edit").forEach(btn => {
    btn.addEventListener("click", () => {
      const cat = categories.find(c => c.id === btn.dataset.id);
      if (!cat) return;
      document.getElementById("catName").value = cat.name;
      document.getElementById("catEmoji").value = cat.emoji || "";
      document.getElementById("catColor").value = cat.color;
      document.getElementById("catSave").textContent = "Guardar cambios";
      document.getElementById("catSave").dataset.editId = cat.id;
    });
  });

  el.querySelectorAll(".cat-action-btn.del:not([disabled])").forEach(btn => {
    btn.addEventListener("click", () => {
      if (!confirm("Eliminar esta rama?")) return;
      categories = categories.filter(c => c.id !== btn.dataset.id);
      saveCategories();
      renderCatList();
      renderBranchFilters();
      renderBranchSelect();
      renderAll();
      showToast("Rama eliminada", "");
    });
  });
}

function renderColorPresets() {
  const el = document.getElementById("colorPresets");
  if (!el) return;
  el.innerHTML = COLOR_PRESETS.map(c =>
    `<div class="color-preset" style="background:${c}" data-color="${c}"></div>`
  ).join("");
  el.querySelectorAll(".color-preset").forEach(dot => {
    dot.addEventListener("click", () => {
      document.getElementById("catColor").value = dot.dataset.color;
      el.querySelectorAll(".color-preset").forEach(d => d.classList.remove("selected"));
      dot.classList.add("selected");
    });
  });
}

function saveCategoryForm() {
  const name = document.getElementById("catName").value.trim();
  if (!name) { showToast("El nombre es obligatorio", "error"); return; }
  const color = document.getElementById("catColor").value;
  const emoji = document.getElementById("catEmoji").value.trim();
  const editId = document.getElementById("catSave").dataset.editId;

  if (editId) {
    const idx = categories.findIndex(c => c.id === editId);
    if (idx !== -1) {
      categories[idx] = { ...categories[idx], name, color, emoji };
      showToast("Rama actualizada", "success");
    }
  } else {
    const id = name.toLowerCase().replace(/[^a-z0-9]/g, "-") + "-" + Date.now().toString(36);
    categories.push({ id, name, color, emoji });
    showToast("Rama creada", "success");
  }

  saveCategories();
  renderCatList();
  renderBranchFilters();
  renderBranchSelect();
  renderAll();
  document.getElementById("catName").value = "";
  document.getElementById("catEmoji").value = "";
  document.getElementById("catColor").value = "#a78bfa";
  document.getElementById("catSave").textContent = "Agregar Rama";
  document.getElementById("catSave").dataset.editId = "";
}

// =============================================
// NAVIGATION
// =============================================
function switchView(view) {
  currentView = view;
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  document.getElementById(`view-${view}`).classList.add("active");
  document.querySelectorAll(".nav-item").forEach(n => {
    n.classList.toggle("active", n.dataset.view === view);
  });
  const titles = { dashboard: "Dashboard", today: "Hoy", calendar: "Calendario" };
  document.getElementById("pageTitle").textContent = titles[view] || view;
  document.querySelectorAll(".bn-item[data-view]").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  window.scrollTo(0, 0);

  if (view === "today") renderToday();
  if (view === "calendar") renderCalendar();
  if (view === "dashboard") renderDashboard();

  // Close sidebar on mobile
  if (window.innerWidth <= 768) closeSidebar();
}

function openSidebar() {
  document.getElementById("sidebar").classList.add("open");
  document.getElementById("overlay").classList.add("active");
}
function closeSidebar() {
  document.getElementById("sidebar").classList.remove("open");
  document.getElementById("overlay").classList.remove("active");
}

// =============================================
// DATE & CALENDAR NAVIGATION
// =============================================
function updateCurrentDate() {
  const now = new Date();
  document.getElementById("currentDate").textContent =
    now.toLocaleDateString("es-ES", { weekday: "short", day: "2-digit", month: "short", year: "numeric" });
}

// =============================================
// EVENT LISTENERS
// =============================================
function bindEvents() {
  // Sidebar open/close
  document.getElementById("menuBtn").addEventListener("click", openSidebar);

  // "Ver todas" upcoming link
  const seeAll = document.getElementById("seeAllUpcoming");
  if (seeAll) seeAll.addEventListener("click", e => { e.preventDefault(); switchView("today"); });
  document.getElementById("sidebarClose").addEventListener("click", closeSidebar);
  document.getElementById("overlay").addEventListener("click", closeSidebar);

  // Nav items
  document.querySelectorAll(".nav-item").forEach(btn => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });

  // Branch filters — handled inside renderBranchFilters() which recreates the DOM each time

  // Label filters
  document.querySelectorAll(".label-filter").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".label-filter").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      currentLabel = btn.dataset.label;
      renderAll();
    });
  });

  // Theme toggle
  document.getElementById("themeToggle").addEventListener("click", () => {
    const html = document.documentElement;
    const current = html.getAttribute("data-theme");
    const next = current === "dark" ? "light" : "dark";
    html.setAttribute("data-theme", next);
    localStorage.setItem("willystask_theme", next);
  });

  // Add task buttons
  document.getElementById("addTaskBtnTop").addEventListener("click", () => openTaskModal());
  document.getElementById("fab").addEventListener("click", () => openTaskModal());

  // Modal form
  document.getElementById("modalClose").addEventListener("click", closeTaskModal);
  document.getElementById("modalCancel").addEventListener("click", closeTaskModal);
  document.getElementById("modalSave").addEventListener("click", saveTask);
  document.getElementById("modalBackdrop").addEventListener("click", e => {
    if (e.target === document.getElementById("modalBackdrop")) closeTaskModal();
  });

  // Repeat days toggle
  document.getElementById("taskType").addEventListener("change", function () {
    document.getElementById("repeatDaysGroup").style.display =
      this.value === "repetitiva" ? "block" : "none";
  });

  document.querySelectorAll(".day-toggle").forEach(btn => {
    btn.addEventListener("click", () => btn.classList.toggle("active"));
  });

  // Detail modal
  document.getElementById("detailClose").addEventListener("click", closeDetail);
  document.getElementById("detailBackdrop").addEventListener("click", e => {
    if (e.target === document.getElementById("detailBackdrop")) closeDetail();
  });
  document.getElementById("btnComplete").addEventListener("click", () => setTaskStatus("completada"));
  document.getElementById("btnSuspend").addEventListener("click", () => setTaskStatus("suspendida"));
  document.getElementById("btnEdit").addEventListener("click", () => {
    const id = openDetailId;
    closeDetail();
    openTaskModal(id);
  });
  document.getElementById("btnDelete").addEventListener("click", deleteTask);

  // Today navigation
  document.getElementById("prevDay").addEventListener("click", () => { todayOffset--; renderToday(); });
  document.getElementById("nextDay").addEventListener("click", () => { todayOffset++; renderToday(); });

  // Calendar view buttons
  document.querySelectorAll(".cal-view-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".cal-view-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      calViewMode = btn.dataset.calview;
      renderCalendar();
    });
  });

  // Calendar navigation
  document.getElementById("calPrev").addEventListener("click", () => {
    if (calViewMode === "month") calDate.setMonth(calDate.getMonth() - 1);
    else if (calViewMode === "week") calDate.setDate(calDate.getDate() - 7);
    else calDate.setDate(calDate.getDate() - 1);
    renderCalendar();
  });
  document.getElementById("calNext").addEventListener("click", () => {
    if (calViewMode === "month") calDate.setMonth(calDate.getMonth() + 1);
    else if (calViewMode === "week") calDate.setDate(calDate.getDate() + 7);
    else calDate.setDate(calDate.getDate() + 1);
    renderCalendar();
  });

  // Bottom navigation (mobile)
  document.querySelectorAll(".bn-item[data-view]").forEach(b => b.addEventListener("click", () => switchView(b.dataset.view)));
  const bnAdd = document.getElementById("bnAdd");
  if (bnAdd) bnAdd.addEventListener("click", () =>
    openTaskModal(null, currentView === "calendar" && calViewMode === "day" ? toLocalDateStr(calDate) : null));
  const bnMenu = document.getElementById("bnMenu");
  if (bnMenu) bnMenu.addEventListener("click", openSidebar);

  // Category modal
  const btnManageCat = document.getElementById("btnManageCategories");
  if (btnManageCat) btnManageCat.addEventListener("click", openCatModal);
  const catClose = document.getElementById("catModalClose");
  if (catClose) catClose.addEventListener("click", closeCatModal);
  const catBackdrop = document.getElementById("catModalBackdrop");
  if (catBackdrop) catBackdrop.addEventListener("click", e => { if (e.target === catBackdrop) closeCatModal(); });
  const catSaveBtn = document.getElementById("catSave");
  if (catSaveBtn) catSaveBtn.addEventListener("click", saveCategoryForm);

  // Calendar today button
  const calTodayBtn = document.getElementById("calTodayBtn");
  if (calTodayBtn) calTodayBtn.addEventListener("click", () => { calDate = new Date(); renderCalendar(); });

  // Motive button
  const motives = [
    "Grandes resultados requieren constancia.",
    "Cada tarea completada es un paso adelante.",
    "El enfoque vence al talento cuando el talento no trabaja.",
    "Disciplina es elegir lo que quieres mas sobre lo que quieres ahora.",
    "Organizate hoy, celebra manana.",
  ];
  const motiveBtn = document.getElementById("motiveBtn");
  const motiveText = document.getElementById("motiveText");
  if (motiveBtn) motiveBtn.addEventListener("click", () => {
    if (motiveText) motiveText.textContent = motives[Math.floor(Math.random() * motives.length)];
  });

  // Google connect button
  document.getElementById("btnConnectGoogle").addEventListener("click", gcalSignIn);

  // Keyboard shortcut: Escape closes modals
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      closeTaskModal();
      closeDetail();
      closeSidebar();
    }
    // N = new task
    if (e.key === "n" && !["INPUT","TEXTAREA","SELECT"].includes(document.activeElement.tagName)) {
      openTaskModal();
    }
  });
}

// =============================================
// SAMPLE TASKS (only on the very first run, ever)
// =============================================
function loadSampleTasks() {
  // Uses a dedicated flag instead of tasks.length, so sample data
  // never reappears even if the task list is legitimately empty later.
  const alreadyInitialized = localStorage.getItem("willystask_initialized");
  if (alreadyInitialized) return;

  if (tasks.length === 0) {
    const today = getTodayStr();
    const tomorrow = getTodayStr(1);
    tasks = [
      { id: generateId(), name: "Analizar gráficos BTC/USDT", branch: "trading", type: "repetitiva", repeatDays: ["1","2","3","4","5"], startTime: "08:00", endTime: "09:00", date: today, notes: "Revisar soporte en 4H y tendencia diaria", status: null, createdAt: Date.now() },
      { id: generateId(), name: "Revisar métricas Nyxar", branch: "nyxar", type: "fija", startTime: "09:30", endTime: "10:00", date: today, notes: null, status: null, createdAt: Date.now() },
      { id: generateId(), name: "Reunión de equipo semanal", branch: "nyxar", type: "repetitiva", repeatDays: ["1"], startTime: "10:00", endTime: "11:00", date: today, notes: null, status: "completada", createdAt: Date.now() },
      { id: generateId(), name: "Ejercicio matutino", branch: "personal", type: "repetitiva", repeatDays: ["1","2","3","4","5"], startTime: "06:30", endTime: "07:30", date: today, notes: null, status: null, createdAt: Date.now() },
      { id: generateId(), name: "Actualizar pitch deck inversores", branch: "nyxar", type: "urgente", startTime: "14:00", date: tomorrow, notes: "Incluir métricas Q2", status: null, createdAt: Date.now() },
      { id: generateId(), name: "Cerrar posición swing ETH", branch: "trading", type: "proxima", date: tomorrow, startTime: "15:00", notes: null, status: null, createdAt: Date.now() },
      { id: generateId(), name: "Pago de servicios", branch: "personal", type: "pendiente", date: getTodayStr(-2), notes: null, status: null, createdAt: Date.now() },
    ];
    saveLocalTasks();
  }

  localStorage.setItem("willystask_initialized", "true");
}

// =============================================
// NOTIFICATIONS (in-app: 5 min before + at start time)
// =============================================
const NOTIF_KEY = "willystask_notif_enabled";
const NOTIFIED_KEY = "willystask_notified";
let swReg = null;

function notifSupported() { return "Notification" in window; }
function notifEnabled() {
  return notifSupported() && Notification.permission === "granted" && localStorage.getItem(NOTIF_KEY) === "1";
}

async function registerSW() {
  if (!("serviceWorker" in navigator)) return;
  try { swReg = await navigator.serviceWorker.register("sw.js"); }
  catch (e) { console.error("SW register error:", e); }
}

function updateNotifButton() {
  const btn = document.getElementById("btnNotif");
  if (!btn) return;
  btn.textContent = notifEnabled() ? "🔔 Notificaciones activas" : "🔔 Activar notificaciones";
}

async function sendNotification(title, body, tag) {
  const opts = { body, tag, icon: "favicon.png", badge: "favicon.png" };
  try {
    if (swReg && "serviceWorker" in navigator) {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification(title, opts);
      return;
    }
    new Notification(title, opts);
  } catch (e) { console.error("Notification error:", e); }
}

async function toggleNotifications() {
  if (!notifSupported()) { showToast("Este navegador no soporta notificaciones", "error"); return; }
  if (notifEnabled()) {
    localStorage.setItem(NOTIF_KEY, "0");
    updateNotifButton();
    showToast("Notificaciones desactivadas");
    return;
  }
  let perm = Notification.permission;
  if (perm !== "granted") perm = await Notification.requestPermission();
  if (perm !== "granted") {
    showToast("Permiso denegado: actívalo en los ajustes del navegador", "error");
    return;
  }
  localStorage.setItem(NOTIF_KEY, "1");
  updateNotifButton();
  showToast("Notificaciones activadas ✓", "success");
  sendNotification("Willy's Task", "Las notificaciones funcionan ✓", "test");
}

function getNotified() {
  try { return JSON.parse(localStorage.getItem(NOTIFIED_KEY) || "{}"); } catch { return {}; }
}

function checkReminders() {
  if (!notifEnabled()) return;
  const now = new Date();
  const todayStr = toLocalDateStr(now);
  const notified = getNotified();
  Object.keys(notified).forEach(k => { if (!k.includes("|" + todayStr + "|")) delete notified[k]; });

  tasks.forEach(t => {
    if (!t.startTime || t.status === "completada" || t.status === "suspendida") return;
    if (!isTaskOnDate(t, todayStr)) return;
    const [h, m] = t.startTime.split(":").map(Number);
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0);
    const diffMin = (start - now) / 60000;
    const cat = getCategoryById(t.branch);
    const k5 = `${t.id}|${todayStr}|5`;
    const k0 = `${t.id}|${todayStr}|0`;
    if (diffMin > 0 && diffMin <= 5 && !notified[k5]) {
      notified[k5] = 1;
      sendNotification(`⏰ En 5 minutos · ${cat.name}`, t.name, k5);
    } else if (diffMin <= 0 && diffMin > -5 && !notified[k0]) {
      notified[k0] = 1;
      sendNotification(`🔔 Es ahora · ${cat.name}`, t.name, k0);
    }
  });
  try { localStorage.setItem(NOTIFIED_KEY, JSON.stringify(notified)); } catch {}
}

function initNotifications() {
  registerSW();
  updateNotifButton();
  const btn = document.getElementById("btnNotif");
  if (btn) btn.addEventListener("click", toggleNotifications);
  setInterval(checkReminders, 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) checkReminders(); });
  checkReminders();
}

// =============================================
// INIT
// =============================================
async function init() {
  // Restore theme
  const savedTheme = localStorage.getItem("willystask_theme") || "dark";
  document.documentElement.setAttribute("data-theme", savedTheme);

  updateCurrentDate();
  setInterval(updateCurrentDate, 60000);

  // Load local data first for instant render
  loadLocalTasks();
  loadCategories();
  loadSampleTasks();

  bindEvents();
  renderBranchFilters();
  renderBranchSelect();
  renderAll();
  initNotifications();

  // Then attempt Firebase (async)
  await initFirebase();

  // Init Google Calendar
  initGoogleCalendar();
}

init();
