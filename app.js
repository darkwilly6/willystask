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
  apiKey: "AIzaSyDWEaP_7MzcIof2egmNj2MblXFCd5ps",
  authDomain: "willytask.firebaseapp.com",
  projectId: "willytask",
  storageBucket: "willytask.firebasestorage.app",
  messagingSenderId: "655195112736",
  appId: "1:655195112736:web:9816d2913e731d751fc345"
};

// =============================================
// GOOGLE CALENDAR CONFIG — REPLACE WITH YOURS
// =============================================
const GCAL_CLIENT_ID = "14150128019-6uam085u6ksh9hdi8ioq1qce2bip0bo5.apps.googleusercontent.com";
const GCAL_API_KEY   = "AIzaSyDA01VM11plenU8w-7Ch3o_QBhp8qzWNys";
const GCAL_SCOPES    = "https://www.googleapis.com/auth/calendar.events";
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
async function initFirebase() {
  const { apiKey } = FIREBASE_CONFIG;
  if (!apiKey || apiKey === "YOUR_FIREBASE_API_KEY") {
    setIntegrationStatus("firebase", false, "Sin config");
    return;
  }
  try {
    const { initializeApp } = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js");
    const { getFirestore, collection, addDoc, updateDoc, deleteDoc, doc, onSnapshot, query, orderBy }
      = await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");

    const app = initializeApp(FIREBASE_CONFIG);
    db = getFirestore(app);
    firestoreAvailable = true;
    setIntegrationStatus("firebase", true, "Conectado");
    showToast("Firebase conectado ✓", "success");

    // Real-time listener
    const q = query(collection(db, "tasks"), orderBy("createdAt", "desc"));
    tasksUnsubscribe = onSnapshot(q, (snapshot) => {
      tasks = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      renderAll();
    });

    // Expose Firestore helpers globally
    window._fs = { collection, addDoc, updateDoc, deleteDoc, doc, db };
  } catch (e) {
    console.error("Firebase error:", e);
    setIntegrationStatus("firebase", false, "Error");
  }
}

// =============================================
// FIRESTORE CRUD
// =============================================
async function saveTaskToFirestore(task) {
  if (!firestoreAvailable) return;
  const { collection, addDoc, updateDoc, doc, db } = window._fs;
  try {
    if (task.id && !task.id.startsWith("local-")) {
      const ref = doc(db, "tasks", task.id);
      await updateDoc(ref, task);
    } else {
      const { id, ...data } = task;
      const ref = await addDoc(collection(db, "tasks"), { ...data, createdAt: Date.now() });
      return ref.id;
    }
  } catch (e) {
    console.error("Firestore save error:", e);
  }
}

async function deleteTaskFromFirestore(taskId) {
  if (!firestoreAvailable || taskId.startsWith("local-")) return;
  const { deleteDoc, doc, db } = window._fs;
  try {
    await deleteDoc(doc(db, "tasks", taskId));
  } catch (e) {
    console.error("Firestore delete error:", e);
  }
}

// =============================================
// GOOGLE CALENDAR INIT
// =============================================
function initGoogleCalendar() {
  if (!GCAL_CLIENT_ID || GCAL_CLIENT_ID === "YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com") return;
  const script = document.createElement("script");
  script.src = "https://apis.google.com/js/api.js";
  script.onload = () => {
    gapi.load("client:auth2", async () => {
      try {
        await gapi.client.init({
          apiKey: GCAL_API_KEY,
          clientId: GCAL_CLIENT_ID,
          discoveryDocs: [GCAL_DISCOVERY],
          scope: GCAL_SCOPES,
        });
        gapi.auth2.getAuthInstance().isSignedIn.listen(updateGCalStatus);
        updateGCalStatus(gapi.auth2.getAuthInstance().isSignedIn.get());
      } catch (e) {
        console.error("GCal init error:", e);
        setIntegrationStatus("gcal", false, "Error");
      }
    });
  };
  document.head.appendChild(script);
}

function updateGCalStatus(isSignedIn) {
  gcalSignedIn = isSignedIn;
  setIntegrationStatus("gcal", isSignedIn, isSignedIn ? "Conectado" : "Desconectado");
}

async function gcalSignIn() {
  if (!window.gapi) {
    showToast("Google Calendar aún no cargó. Recarga la página.", "error");
    return;
  }

  try {
    await gapi.auth2.getAuthInstance().signIn();
    showToast("Google Calendar conectado ✓", "success");
  } catch (e) {
    console.error("Error real al conectar Google Calendar:", e);
    showToast("Error Google: " + (e.error || e.details || e.message || "ver consola"), "error");
  }
}

async function createGCalEvent(task) {
  if (!gcalSignedIn || !task.date) return;
  try {
    const start = task.startTime
      ? `${task.date}T${task.startTime}:00`
      : task.date;
    const end = task.endTime
      ? `${task.date}T${task.endTime}:00`
      : task.startTime
        ? `${task.date}T${task.startTime}:00`
        : task.date;

    const event = {
      summary: `[${task.branch.toUpperCase()}] ${task.name}`,
      description: task.notes || "",
      start: task.startTime ? { dateTime: start, timeZone: "America/El_Salvador" } : { date: task.date },
      end: task.endTime ? { dateTime: end, timeZone: "America/El_Salvador" } : { date: task.date },
      colorId: task.branch === "trading" ? "6" : task.branch === "nyxar" ? "3" : "2",
    };

    if (task.type === "repetitiva" && task.repeatDays && task.repeatDays.length > 0) {
      const days = ["SU","MO","TU","WE","TH","FR","SA"];
      const byday = task.repeatDays.map(d => days[parseInt(d)]).join(",");
      event.recurrence = [`RRULE:FREQ=WEEKLY;BYDAY=${byday}`];
    }

    const res = await gapi.client.calendar.events.insert({ calendarId: "primary", resource: event });
    return res.result.id;
  } catch (e) {
    console.error("GCal event create error:", e);
  }
}

async function updateGCalEvent(task) {
  if (!gcalSignedIn || !task.gcalEventId) return;
  try {
    const start = task.startTime ? `${task.date}T${task.startTime}:00` : task.date;
    const end = task.endTime ? `${task.date}T${task.endTime}:00` : start;
    await gapi.client.calendar.events.update({
      calendarId: "primary",
      eventId: task.gcalEventId,
      resource: {
        summary: `[${task.branch.toUpperCase()}] ${task.name}`,
        description: task.notes || "",
        start: task.startTime ? { dateTime: start, timeZone: "America/El_Salvador" } : { date: task.date },
        end: task.endTime ? { dateTime: end, timeZone: "America/El_Salvador" } : { date: task.date },
      }
    });
  } catch (e) {
    console.error("GCal update error:", e);
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
// HELPERS
// =============================================
function generateId() {
  return "local-" + Math.random().toString(36).slice(2, 11);
}

function getTodayStr(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().split("T")[0];
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
}

function taskCardHTML(t) {
  const statusClass = t.status ? `status-${t.status}` : "";
  const urgenteClass = t.type === "urgente" && t.status !== "completada" ? "urgente-card" : "";
  const timeStr = t.startTime ? `⏱ ${t.startTime}${t.endTime ? " – " + t.endTime : ""}` : (t.date ? `📅 ${formatDateShort(t.date)}` : "");
  const icon = statusIcon(t.status);

  return `
  <div class="task-card ${t.branch} ${statusClass} ${urgenteClass}" data-id="${t.id}">
    <div class="task-info">
      <div class="task-name">${escHtml(t.name)}</div>
      <div class="task-meta">
        ${timeStr ? `<span class="task-time">${timeStr}</span>` : ""}
        <span class="task-badge badge-${t.branch}">${t.branch}</span>
        <span class="task-type-badge">${typeLabel(t.type)}</span>
        ${t.status === "completada" ? `<span class="task-type-badge" style="color:var(--green)">✓ Completada</span>` : ""}
        ${t.status === "suspendida" ? `<span class="task-type-badge" style="color:var(--text-3)">⊘ Suspendida</span>` : ""}
      </div>
    </div>
    ${icon ? `<div class="task-status-icon">${icon}</div>` : ""}
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
      const dayTasks = getFilteredTasks().filter(t => isTaskOnDate(t, dateStr)).slice(0, 3);

      html += `<div class="cal-day${isToday?" today-cell":""}" data-date="${dateStr}">
        <div class="cal-day-num">${d}</div>`;
      dayTasks.forEach(t => {
        const statusClass = t.status === "completada" ? " status-completada" : "";
        html += `<div class="cal-day-mini-task ${t.branch}${statusClass}" data-id="${t.id}">${escHtml(t.name)}</div>`;
      });

      const total = getFilteredTasks().filter(t => isTaskOnDate(t, dateStr)).length;
      if (total > 3) html += `<div class="cal-day-more">+${total-3} más</div>`;
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
        openTaskModal(null, date);
      });
    });

  } else if (calViewMode === "week") {
    const startOfWeek = new Date(calDate);
    const dow = startOfWeek.getDay();
    startOfWeek.setDate(startOfWeek.getDate() - dow);
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(endOfWeek.getDate() + 6);
    title.textContent = `${formatDateShort(startOfWeek.toISOString().split("T")[0])} – ${formatDateShort(endOfWeek.toISOString().split("T")[0])}`;

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
        const dateStr = d.toISOString().split("T")[0];
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
    const dateStr = calDate.toISOString().split("T")[0];
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

      if (firestoreAvailable) {
        await saveTaskToFirestore(taskData);
      } else {
        saveLocalTasks();
      }
      if (gcalSignedIn && taskData.gcalEventId) {
        await updateGCalEvent(taskData);
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

    if (firestoreAvailable) {
      const firestoreId = await saveTaskToFirestore(taskData);
      if (firestoreId) taskData.id = firestoreId;
    } else {
      tasks.unshift(taskData);
      saveLocalTasks();
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
  badge.textContent = t.branch;
  badge.className = `detail-branch-badge ${t.branch}`;

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
  } else {
    tasks = tasks.filter(x => x.id !== openDetailId);
    saveLocalTasks();
  }

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
  document.getElementById("sidebarClose").addEventListener("click", closeSidebar);
  document.getElementById("overlay").addEventListener("click", closeSidebar);

  // Nav items
  document.querySelectorAll(".nav-item").forEach(btn => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });

  // Branch filters
  document.querySelectorAll(".branch-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".branch-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      currentBranch = btn.dataset.branch;
      renderAll();
    });
  });

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
// SAMPLE TASKS (only if no data exists)
// =============================================
function loadSampleTasks() {
  if (tasks.length > 0) return;
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
  loadSampleTasks();

  bindEvents();
  renderAll();

  // Then attempt Firebase (async)
  await initFirebase();

  // Init Google Calendar
  initGoogleCalendar();
}

init();
