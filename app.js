/* Willy's Task — app.js
   Activa botones, vistas, modal, calendario y guardado local.
*/
(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  const STORAGE_KEY = 'willys_task_items_v1';
  const THEME_KEY = 'willys_task_theme_v1';

  const branchNames = { trading: 'Trading', nyxar: 'Nyxar', personal: 'Personal' };
  const typeNames = {
    fija: '📌 Fija', repetitiva: '🔁 Repetitiva', urgente: '🚨 Urgente', pendiente: '⏳ Pendiente', proxima: '🔜 Próxima'
  };

  let tasks = loadTasks();
  let currentView = 'dashboard';
  let branchFilter = 'all';
  let labelFilter = 'all';
  let selectedDate = new Date();
  let calendarDate = new Date();
  let calendarView = 'month';
  let editingTaskId = null;
  let selectedTaskId = null;
  let selectedRepeatDays = new Set();

  function pad(n) { return String(n).padStart(2, '0'); }
  function toISODate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function fromISODate(str) {
    const [y, m, d] = (str || toISODate(new Date())).split('-').map(Number);
    return new Date(y, (m || 1) - 1, d || 1);
  }
  function todayISO() { return toISODate(new Date()); }
  function fmtDate(d) {
    return d.toLocaleDateString('es-SV', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }
  function fmtMonth(d) { return d.toLocaleDateString('es-SV', { month: 'long', year: 'numeric' }); }
  function saveTasks() { localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks)); }
  function loadTasks() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
    catch { return []; }
  }
  function uid() { return crypto?.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()); }

  function taskOccursOn(task, dateObj) {
    const iso = toISODate(dateObj);
    if (task.type === 'repetitiva' && task.repeatDays?.length) {
      const startDate = task.date || todayISO();
      return iso >= startDate && task.repeatDays.map(Number).includes(dateObj.getDay());
    }
    return task.date === iso;
  }

  function visibleTasksFor(dateObj = null) {
    return tasks.filter((task) => {
      if (branchFilter !== 'all' && task.branch !== branchFilter) return false;
      if (labelFilter !== 'all' && task.type !== labelFilter) return false;
      if (dateObj && !taskOccursOn(task, dateObj)) return false;
      return true;
    });
  }

  function setupTheme() {
    const saved = localStorage.getItem(THEME_KEY) || document.documentElement.dataset.theme || 'dark';
    document.documentElement.dataset.theme = saved;
  }

  function setDateFields() {
    $('#currentDate').textContent = new Date().toLocaleDateString('es-SV', { weekday: 'short', day: 'numeric', month: 'short' });
    $('#todayLabel').textContent = fmtDate(selectedDate);
  }

  function openSidebar() {
    $('#sidebar')?.classList.add('open');
    $('#overlay')?.classList.add('active');
  }
  function closeSidebar() {
    $('#sidebar')?.classList.remove('open');
    $('#overlay')?.classList.remove('active');
  }

  function switchView(view) {
    currentView = view;
    $$('.view').forEach(v => v.classList.remove('active'));
    $(`#view-${view}`)?.classList.add('active');
    $$('.nav-item').forEach(btn => btn.classList.toggle('active', btn.dataset.view === view));
    const titles = { dashboard: 'Dashboard', today: 'Hoy', calendar: 'Calendario' };
    $('#pageTitle').textContent = titles[view] || 'Dashboard';
    closeSidebar();
    render();
  }

  function openTaskModal(task = null, dateISO = null) {
    editingTaskId = task?.id || null;
    selectedRepeatDays = new Set((task?.repeatDays || []).map(String));
    $('#modalTitle').textContent = task ? 'Editar Tarea' : 'Nueva Tarea';
    $('#taskName').value = task?.name || '';
    $('#taskBranch').value = task?.branch || 'trading';
    $('#taskType').value = task?.type || 'fija';
    $('#taskDate').value = task?.date || dateISO || todayISO();
    $('#taskStart').value = task?.start || '';
    $('#taskEnd').value = task?.end || '';
    $('#taskDuration').value = task?.duration || '';
    $('#taskNotes').value = task?.notes || '';
    updateRepeatUI();
    $('#modalBackdrop').classList.add('open');
    setTimeout(() => $('#taskName').focus(), 50);
  }

  function closeTaskModal() {
    $('#modalBackdrop').classList.remove('open');
    editingTaskId = null;
  }

  function updateRepeatUI() {
    const show = $('#taskType').value === 'repetitiva';
    $('#repeatDaysGroup').style.display = show ? 'flex' : 'none';
    $$('.day-toggle').forEach(btn => btn.classList.toggle('active', selectedRepeatDays.has(btn.dataset.day)));
  }

  function saveTaskFromModal() {
    const name = $('#taskName').value.trim();
    if (!name) {
      alert('Escribe el nombre de la tarea.');
      $('#taskName').focus();
      return;
    }
    const type = $('#taskType').value;
    const repeatDays = Array.from(selectedRepeatDays).map(Number);
    if (type === 'repetitiva' && repeatDays.length === 0) {
      alert('Selecciona al menos un día para la tarea repetitiva.');
      return;
    }
    const data = {
      name,
      branch: $('#taskBranch').value,
      type,
      date: $('#taskDate').value || todayISO(),
      start: $('#taskStart').value,
      end: $('#taskEnd').value,
      duration: $('#taskDuration').value,
      notes: $('#taskNotes').value.trim(),
      repeatDays,
      status: 'pendiente'
    };
    if (editingTaskId) {
      tasks = tasks.map(t => t.id === editingTaskId ? { ...t, ...data } : t);
    } else {
      tasks.push({ id: uid(), createdAt: new Date().toISOString(), ...data });
    }
    saveTasks();
    closeTaskModal();
    render();
  }

  function openDetail(taskId) {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;
    selectedTaskId = taskId;
    $('#detailBranch').textContent = branchNames[task.branch] || task.branch;
    $('#detailBranch').className = `detail-branch-badge badge-${task.branch}`;
    $('#detailName').textContent = task.name;
    const repeatText = task.type === 'repetitiva' && task.repeatDays?.length ? ` · Repite: ${task.repeatDays.map(dayName).join(', ')}` : '';
    $('#detailMeta').innerHTML = `
      <span>🏷️ ${typeNames[task.type] || task.type}</span>
      <span>📅 ${task.date || 'Sin fecha'}${repeatText}</span>
      <span>🕒 ${timeRange(task)}</span>
      <span>Estado: ${task.status || 'pendiente'}</span>
    `;
    $('#detailNotes').textContent = task.notes || '';
    $('#detailNotes').classList.toggle('visible', Boolean(task.notes));
    $('#detailBackdrop').classList.add('open');
  }

  function closeDetail() { $('#detailBackdrop').classList.remove('open'); selectedTaskId = null; }
  function timeRange(task) {
    if (task.start && task.end) return `${task.start} - ${task.end}`;
    if (task.start) return task.start;
    if (task.duration) return `${task.duration} min`;
    return 'Sin hora';
  }
  function dayName(n) { return ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'][Number(n)] || ''; }
  function typeIcon(type) { return { fija: '📌', repetitiva: '🔁', urgente: '🚨', pendiente: '⏳', proxima: '🔜' }[type] || '•'; }
  function statusIcon(status) { return status === 'completada' ? '✓' : status === 'suspendida' ? '⊘' : '○'; }

  function taskCard(task) {
    const card = document.createElement('div');
    card.className = `task-card ${task.branch} status-${task.status || 'pendiente'} ${task.type === 'urgente' ? 'urgente-card' : ''}`;
    card.innerHTML = `
      <span class="task-status-icon">${statusIcon(task.status)}</span>
      <div class="task-info">
        <div class="task-name">${escapeHtml(task.name)}</div>
        <div class="task-meta">
          <span class="task-time">🕒 ${escapeHtml(timeRange(task))}</span>
          <span class="task-badge badge-${task.branch}">${escapeHtml(branchNames[task.branch] || task.branch)}</span>
          <span class="task-type-badge">${typeIcon(task.type)} ${escapeHtml(task.type)}</span>
        </div>
      </div>
    `;
    card.addEventListener('click', () => openDetail(task.id));
    return card;
  }

  function renderDashboard() {
    const today = new Date();
    const todaysTasks = tasks.filter(t => taskOccursOn(t, today));
    $('#stat-total').textContent = todaysTasks.length;
    $('#stat-pending').textContent = todaysTasks.filter(t => (t.status || 'pendiente') === 'pendiente').length;
    $('#stat-done').textContent = todaysTasks.filter(t => t.status === 'completada').length;
    $('#stat-urgent').textContent = todaysTasks.filter(t => t.type === 'urgente' && t.status !== 'completada').length;

    const upcoming = visibleTasksFor().filter(t => (t.status || 'pendiente') === 'pendiente' && (t.date || todayISO()) >= todayISO())
      .sort(sortByDateTime).slice(0, 8);
    const incomplete = visibleTasksFor().filter(t => (t.status || 'pendiente') === 'pendiente' && (t.date || todayISO()) < todayISO())
      .sort(sortByDateTime);
    fillList($('#upcoming-list'), upcoming, 'No hay próximas tareas.');
    fillList($('#incomplete-list'), incomplete, 'No hay tareas atrasadas.');
    $('#upcoming-count').textContent = upcoming.length;
    $('#incomplete-count').textContent = incomplete.length;
  }

  function sortByDateTime(a, b) { return `${a.date || ''} ${a.start || '99:99'}`.localeCompare(`${b.date || ''} ${b.start || '99:99'}`); }
  function fillList(container, arr, emptyText) {
    container.innerHTML = '';
    if (!arr.length) {
      container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">✦</div>${emptyText}</div>`;
      return;
    }
    arr.forEach(t => container.appendChild(taskCard(t)));
  }

  function renderToday() {
    $('#todayLabel').textContent = fmtDate(selectedDate);
    const timeline = $('#timeline');
    timeline.innerHTML = '';
    const dayTasks = visibleTasksFor(selectedDate).sort((a,b) => (a.start || '99:99').localeCompare(b.start || '99:99'));
    for (let h = 5; h <= 23; h++) {
      const hour = document.createElement('div');
      hour.className = 'timeline-hour';
      hour.innerHTML = `<div class="timeline-hour-label">${pad(h)}:00</div>`;
      dayTasks.filter(t => Number((t.start || '99:00').slice(0,2)) === h || (!t.start && h === 8)).forEach(task => {
        const item = document.createElement('div');
        item.className = `timeline-task ${task.branch}`;
        item.innerHTML = `<div class="timeline-task-name">${escapeHtml(task.name)}</div><div class="timeline-task-time">${escapeHtml(timeRange(task))} · ${escapeHtml(typeNames[task.type] || task.type)}</div>`;
        item.addEventListener('click', () => openDetail(task.id));
        hour.appendChild(item);
      });
      timeline.appendChild(hour);
    }
  }

  function renderCalendar() {
    if (calendarView === 'month') renderMonthCalendar();
    if (calendarView === 'week') renderWeekCalendar();
    if (calendarView === 'day') { selectedDate = new Date(calendarDate); switchView('today'); }
  }

  function renderMonthCalendar() {
    $('#calTitle').textContent = capitalize(fmtMonth(calendarDate));
    const body = $('#calendarBody');
    body.innerHTML = '';
    const grid = document.createElement('div');
    grid.className = 'cal-grid';
    ['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'].forEach(d => {
      const head = document.createElement('div'); head.className = 'cal-day-header'; head.textContent = d; grid.appendChild(head);
    });
    const y = calendarDate.getFullYear(), m = calendarDate.getMonth();
    const first = new Date(y, m, 1);
    const offset = (first.getDay() + 6) % 7;
    const start = new Date(y, m, 1 - offset);
    for (let i = 0; i < 42; i++) {
      const d = new Date(start); d.setDate(start.getDate() + i);
      const cell = document.createElement('div');
      cell.className = 'cal-day';
      if (d.getMonth() !== m) cell.classList.add('other-month');
      if (toISODate(d) === todayISO()) cell.classList.add('today');
      const dayTasks = visibleTasksFor(d).sort((a,b) => (a.start || '').localeCompare(b.start || '')).slice(0,3);
      cell.innerHTML = `<div class="cal-day-num">${d.getDate()}</div>`;
      dayTasks.forEach(task => {
        const mini = document.createElement('div');
        mini.className = `cal-day-mini-task ${task.branch}`;
        mini.textContent = task.name;
        mini.addEventListener('click', (e) => { e.stopPropagation(); openDetail(task.id); });
        cell.appendChild(mini);
      });
      cell.addEventListener('click', () => openTaskModal(null, toISODate(d)));
      grid.appendChild(cell);
    }
    body.appendChild(grid);
  }

  function renderWeekCalendar() {
    const body = $('#calendarBody');
    body.innerHTML = '';
    const start = startOfWeek(calendarDate);
    const end = new Date(start); end.setDate(start.getDate() + 6);
    $('#calTitle').textContent = `${start.getDate()} - ${end.getDate()} ${end.toLocaleDateString('es-SV', { month: 'short', year: 'numeric' })}`;
    const grid = document.createElement('div');
    grid.className = 'week-grid';
    grid.appendChild(document.createElement('div')).className = 'week-header-cell';
    for (let i = 0; i < 7; i++) {
      const d = new Date(start); d.setDate(start.getDate() + i);
      const head = document.createElement('div');
      head.className = 'week-header-cell';
      head.innerHTML = `<div class="week-day-name">${d.toLocaleDateString('es-SV',{weekday:'short'})}</div><div class="week-day-num ${toISODate(d) === todayISO() ? 'today-num' : ''}">${d.getDate()}</div>`;
      grid.appendChild(head);
    }
    for (let h = 6; h <= 22; h++) {
      const time = document.createElement('div'); time.className = 'week-time-col'; time.textContent = `${pad(h)}:00`; grid.appendChild(time);
      for (let i = 0; i < 7; i++) {
        const d = new Date(start); d.setDate(start.getDate() + i);
        const cell = document.createElement('div'); cell.className = 'week-cell';
        visibleTasksFor(d).filter(t => Number((t.start || '99:00').slice(0,2)) === h).slice(0,2).forEach(task => {
          const item = document.createElement('div'); item.className = `week-cell-task ${task.branch}`; item.textContent = task.name;
          item.addEventListener('click', () => openDetail(task.id)); cell.appendChild(item);
        });
        cell.addEventListener('dblclick', () => openTaskModal(null, toISODate(d)));
        grid.appendChild(cell);
      }
    }
    body.appendChild(grid);
  }

  function startOfWeek(d) {
    const out = new Date(d); const day = (out.getDay() + 6) % 7; out.setDate(out.getDate() - day); return out;
  }
  function capitalize(str) { return str.charAt(0).toUpperCase() + str.slice(1); }
  function escapeHtml(str = '') { return String(str).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }

  function render() {
    setDateFields();
    if (currentView === 'dashboard') renderDashboard();
    if (currentView === 'today') renderToday();
    if (currentView === 'calendar') renderCalendar();
  }

  function bindEvents() {
    $('#menuBtn')?.addEventListener('click', openSidebar);
    $('#sidebarClose')?.addEventListener('click', closeSidebar);
    $('#overlay')?.addEventListener('click', () => { closeSidebar(); closeTaskModal(); closeDetail(); });
    $('#addTaskBtnTop')?.addEventListener('click', () => openTaskModal());
    $('#fab')?.addEventListener('click', () => openTaskModal());
    $('#modalClose')?.addEventListener('click', closeTaskModal);
    $('#modalCancel')?.addEventListener('click', closeTaskModal);
    $('#modalSave')?.addEventListener('click', saveTaskFromModal);
    $('#detailClose')?.addEventListener('click', closeDetail);
    $('#taskType')?.addEventListener('change', updateRepeatUI);
    $$('.day-toggle').forEach(btn => btn.addEventListener('click', () => {
      selectedRepeatDays.has(btn.dataset.day) ? selectedRepeatDays.delete(btn.dataset.day) : selectedRepeatDays.add(btn.dataset.day);
      updateRepeatUI();
    }));
    $$('.nav-item').forEach(btn => btn.addEventListener('click', () => switchView(btn.dataset.view)));
    $$('.branch-btn').forEach(btn => btn.addEventListener('click', () => {
      branchFilter = btn.dataset.branch;
      $$('.branch-btn').forEach(b => b.classList.toggle('active', b === btn));
      render();
    }));
    $$('.label-filter').forEach(btn => btn.addEventListener('click', () => {
      labelFilter = btn.dataset.label;
      $$('.label-filter').forEach(b => b.classList.toggle('active', b === btn));
      render();
    }));
    $('#themeToggle')?.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      localStorage.setItem(THEME_KEY, next);
    });
    $('#prevDay')?.addEventListener('click', () => { selectedDate.setDate(selectedDate.getDate() - 1); render(); });
    $('#nextDay')?.addEventListener('click', () => { selectedDate.setDate(selectedDate.getDate() + 1); render(); });
    $$('.cal-view-btn').forEach(btn => btn.addEventListener('click', () => {
      calendarView = btn.dataset.calview;
      $$('.cal-view-btn').forEach(b => b.classList.toggle('active', b === btn));
      render();
    }));
    $('#calPrev')?.addEventListener('click', () => {
      if (calendarView === 'month') calendarDate.setMonth(calendarDate.getMonth() - 1);
      else calendarDate.setDate(calendarDate.getDate() - 7);
      render();
    });
    $('#calNext')?.addEventListener('click', () => {
      if (calendarView === 'month') calendarDate.setMonth(calendarDate.getMonth() + 1);
      else calendarDate.setDate(calendarDate.getDate() + 7);
      render();
    });
    $('#btnComplete')?.addEventListener('click', () => setSelectedStatus('completada'));
    $('#btnSuspend')?.addEventListener('click', () => setSelectedStatus('suspendida'));
    $('#btnDelete')?.addEventListener('click', () => {
      if (!selectedTaskId) return;
      if (confirm('¿Eliminar esta tarea?')) {
        tasks = tasks.filter(t => t.id !== selectedTaskId);
        saveTasks(); closeDetail(); render();
      }
    });
    $('#btnEdit')?.addEventListener('click', () => {
      const task = tasks.find(t => t.id === selectedTaskId);
      closeDetail();
      if (task) openTaskModal(task);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeSidebar(); closeTaskModal(); closeDetail(); }
    });
  }

  function setSelectedStatus(status) {
    if (!selectedTaskId) return;
    tasks = tasks.map(t => t.id === selectedTaskId ? { ...t, status } : t);
    saveTasks(); closeDetail(); render();
  }

  document.addEventListener('DOMContentLoaded', () => {
    setupTheme();
    bindEvents();
    render();
  });
})();
