// Prospect Room web UI: vanilla ES module, no build step.
// Prospect data comes from a vendor, so everything is rendered through textContent / DOM APIs.

const STAGES = [
  ['new', 'New'],
  ['enriched', 'Enriched'],
  ['awaiting_review', 'Awaiting review'],
  ['approved', 'Approved'],
  ['skipped', 'Skipped'],
];
const STAGE_LABEL = Object.fromEntries(STAGES);
const POLL_MS = 3000;
const HOME_POLL_MS = 5000;
const DEBOUNCE_MS = 150;
const FEED_LIMIT = 100;
const HUES = [232, 168, 20, 290, 200, 340, 95, 45];
const ACTION_VERB = { claim: 'claim', handback: 'hand back', approve: 'approve', skip: 'skip', pause: 'pause', resume: 'resume', retry_job: 'retry' };

const app = document.getElementById('app');
const crumbs = document.getElementById('crumbs');
const connEl = document.getElementById('conn');
const identityEl = document.getElementById('identity');

const state = {
  roomId: null,
  as: null,
  snapshot: null,
  notFound: false,
  loadError: null,
  clockOffset: 0,
  connection: 'connecting',
  view: null,
  cards: new Map(), // prospectId -> card elements (kept across renders so inputs keep focus)
  edits: new Map(), // prospectId -> { text, baseVersion } : the user's unsent draft edit
  forms: new Map(), // prospectId -> 'handback' | 'skip'
  formText: new Map(), // prospectId -> text typed into the open form
  messages: new Map(), // prospectId | 'room' -> { id, tone, text }
  busy: new Set(),
  es: null,
  pollTimer: null,
  refreshTimer: null,
  fetching: false,
  refetch: false,
  homeTimer: null,
};
const signatures = new WeakMap();
let messageSeq = 0;

// ------------------------------------------------------------------------------------------- helpers

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'disabled' || key === 'hidden' || key === 'value' || key === 'checked') el[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  return append(el, ...children);
}

/** Appends children, dropping absent ones — el.append(null) would render the string "null". */
function append(el, ...children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === '') continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

/** Same, but replaces whatever was there. Never used on an element built with the `text` prop. */
function fill(el, ...children) {
  el.replaceChildren();
  return append(el, ...children);
}

function renderIfChanged(el, signature, render) {
  if (signatures.get(el) === signature) return;
  signatures.set(el, signature);
  render();
}

function hueFor(handle) {
  let hash = 0;
  for (const ch of handle) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return HUES[hash % HUES.length];
}

function withHue(el, handle) {
  el.style.setProperty('--hue', String(hueFor(handle)));
  return el;
}

function serverNow() {
  return Date.now() + state.clockOffset;
}

function relTime(iso) {
  const s = Math.round((serverNow() - Date.parse(iso)) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

function countdown(iso) {
  const s = Math.ceil((Date.parse(iso) - serverNow()) / 1000);
  if (s <= 0) return 'now';
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

function relSpan(iso) {
  return h('span', { dataset: { since: iso }, title: new Date(iso).toLocaleString(), text: relTime(iso) });
}

function countdownSpan(iso) {
  return h('span', { class: 'countdown', dataset: { until: iso }, title: new Date(iso).toLocaleString(), text: countdown(iso) });
}

function clip(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function str(value) {
  return value === null || value === undefined ? '' : String(value);
}

/** Vendor-supplied URLs are only linked when they are plain http(s). */
function safeUrl(url) {
  if (!url) return null;
  if (url.startsWith('/artifacts/')) return url;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch {
    return null;
  }
}

function extLink(url, text) {
  const href = safeUrl(url);
  return href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer', text }) : null;
}

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw Object.assign(new Error(`Can't reach the server (${err.message})`), { status: 0 });
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    // non-JSON error bodies fall through to the status text
  }
  if (!res.ok) {
    throw Object.assign(new Error(data?.message || `${res.status} ${res.statusText}`), { status: res.status, code: data?.error });
  }
  return data;
}

function errorText(err) {
  const label = { 0: 'Network error', 400: 'Invalid', 403: 'Not allowed', 404: 'Not found', 409: 'Conflict', 413: 'Invalid', 415: 'Invalid', 423: 'Room paused' }[err.status];
  return `${label ?? 'Error'}: ${err.message}`;
}

function btn(label, onclick, { variant = '', disabled = false, title } = {}) {
  return h('button', { type: 'button', class: `btn ${variant}`.trim(), text: label, onclick, disabled, title });
}

// ------------------------------------------------------------------------------------------- routing

function readUrl() {
  const params = new URLSearchParams(location.search);
  return { roomId: params.get('room'), as: params.get('as') };
}

function roomHref(roomId, as) {
  const params = new URLSearchParams({ room: roomId });
  if (as) params.set('as', as);
  return `?${params}`;
}

function teardown() {
  state.es?.close();
  state.es = null;
  clearInterval(state.pollTimer);
  clearInterval(state.homeTimer);
  clearTimeout(state.refreshTimer);
  Object.assign(state, { pollTimer: null, homeTimer: null, refreshTimer: null, snapshot: null, notFound: false, loadError: null, view: null });
  state.cards.clear();
  state.edits.clear();
  state.forms.clear();
  state.formText.clear();
  state.messages.clear();
}

function boot() {
  teardown();
  const { roomId, as } = readUrl();
  state.roomId = roomId;
  state.as = as;
  if (roomId) void openRoom(roomId);
  else void openHome();
}

window.addEventListener('popstate', boot);
setInterval(tick, 1000);
boot();

function tick() {
  for (const el of document.querySelectorAll('[data-until]')) el.textContent = countdown(el.dataset.until);
  for (const el of document.querySelectorAll('[data-since]')) el.textContent = relTime(el.dataset.since);
}

// ------------------------------------------------------------------------------------------- home

async function openHome() {
  document.title = 'Prospect Room';
  fill(crumbs, h('span', { class: 'current', text: 'Rooms' }));
  connEl.hidden = true;
  identityEl.hidden = true;
  const view = buildHome();
  state.view = view;
  fill(app, view.root);
  const loadRooms = async () => {
    try {
      const rooms = await api('GET', '/api/rooms');
      renderIfChanged(view.roomsBox, JSON.stringify(rooms) + Math.floor(Date.now() / 30000), () => renderRooms(view.roomsBox, rooms));
    } catch (err) {
      fill(view.roomsBox, h('p', { class: 'empty', text: `Could not load rooms. ${errorText(err)}` }));
      signatures.delete(view.roomsBox);
    }
  };
  state.homeTimer = setInterval(loadRooms, HOME_POLL_MS);
  await Promise.all([loadRooms(), loadPresets(view)]);
}

function buildHome() {
  const roomsBox = h('div', {}, h('p', { class: 'empty', text: 'Loading rooms…' }));
  const handleA = h('input', { class: 'input', value: 'alice', 'aria-label': 'First human handle', autocomplete: 'off' });
  const handleB = h('input', { class: 'input', value: 'bob', 'aria-label': 'Second human handle', autocomplete: 'off' });
  const presetsBox = h('div', { class: 'presets' }, h('p', { class: 'faint', text: 'Loading presets…' }));
  const formMsg = h('div', { class: 'form-msg', role: 'alert', hidden: true });

  const view = { roomsBox, presetsBox, formMsg, handleA, handleB, root: null };
  const form = buildCustomForm(view);
  view.root = h(
    'div',
    { class: 'home' },
    h(
      'section',
      { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', { text: 'Rooms' }), h('span', { class: 'faint', text: 'Open a room to review the agent’s work' })),
      roomsBox,
    ),
    h(
      'section',
      { class: 'panel create-panel' },
      h('h2', { text: 'New room' }),
      h('div', { class: 'field' }, h('span', { text: 'Humans in the room' }), h('div', { class: 'field-row' }, handleA, handleB)),
      formMsg,
      h('h3', { text: 'Start from a preset' }),
      presetsBox,
      h('h3', { text: 'Or define an ICP' }),
      form,
    ),
  );
  return view;
}

function humansFrom(view) {
  return [view.handleA.value, view.handleB.value]
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean)
    .map((handle) => ({ handle, displayName: handle.charAt(0).toUpperCase() + handle.slice(1) }));
}

async function createAndOpen(view, path, body, button) {
  view.formMsg.hidden = true;
  button.disabled = true;
  try {
    const { roomId } = await api('POST', path, body);
    location.href = roomHref(roomId, body.humans?.[0]?.handle);
  } catch (err) {
    view.formMsg.textContent = errorText(err);
    view.formMsg.hidden = false;
    button.disabled = false;
  }
}

async function loadPresets(view) {
  try {
    const presets = await api('GET', '/api/presets');
    fill(view.presetsBox, 
      ...presets.map((preset) => {
        const button = h(
          'button',
          { type: 'button', class: 'preset' },
          h('span', { class: 'preset-label', text: preset.label }),
          h('span', { class: 'preset-desc', text: preset.room.icp.description }),
          h('span', { class: 'preset-desc faint', text: `Target ${preset.room.targetCount ?? 10} prospects` }),
        );
        button.addEventListener('click', () =>
          createAndOpen(view, '/api/rooms/from-preset', { presetId: preset.id, humans: humansFrom(view) }, button),
        );
        return button;
      }),
    );
  } catch (err) {
    fill(view.presetsBox, h('p', { class: 'form-msg', text: `Could not load presets. ${errorText(err)}` }));
  }
}

function buildCustomForm(view) {
  const field = (label, control, hint) => h('label', { class: 'field' }, h('span', { text: label }), control, hint ? h('small', { text: hint }) : null);
  const input = (name, placeholder, extra = {}) => h('input', { class: 'input', name, placeholder, autocomplete: 'off', ...extra });
  const objective = input('objective', 'Book intro calls with…', { required: true });
  const description = h('textarea', { class: 'input', name: 'description', rows: 2, placeholder: 'Who you are looking for', required: true });
  const pitch = input('pitch', 'One-sentence value proposition');
  const titles = input('titles', 'VP of Sales, Head of Sales');
  const locations = input('locations', 'United States; Canada');
  const employees = input('employees', '51,200; 201,500');
  const keywords = input('keywords', 'SaaS');
  const target = input('target', '10', { type: 'number', min: 1, max: 100, value: '10' });
  const submit = h('button', { type: 'submit', class: 'btn primary', text: 'Create room' });

  const list = (value, separator) => value.split(separator).map((v) => v.trim()).filter(Boolean);
  const form = h(
    'form',
    { class: 'custom-form', novalidate: true },
    field('Objective', objective),
    field('ICP description', description),
    field('Pitch', pitch),
    field('Titles', titles, 'Comma-separated'),
    h('div', { class: 'field-row' }, field('Locations', locations, 'Separate with ;'), field('Employee ranges', employees, 'min,max; separate with ;')),
    h('div', { class: 'field-row' }, field('Keywords', keywords), field('Target count', target)),
    h('div', {}, submit),
  );
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const filters = {};
    const titleList = list(titles.value, ',');
    if (titleList.length) Object.assign(filters, { person_titles: titleList, include_similar_titles: true });
    const locationList = list(locations.value, ';');
    if (locationList.length) filters.person_locations = locationList;
    const ranges = list(employees.value, ';').map((r) => r.replace(/\s+/g, ''));
    if (ranges.length) filters.organization_num_employees_ranges = ranges;
    if (keywords.value.trim()) filters.q_keywords = keywords.value.trim();
    const icp = { description: description.value.trim(), filters };
    if (pitch.value.trim()) icp.pitch = pitch.value.trim();
    const body = { objective: objective.value.trim(), icp, targetCount: Number(target.value || 10), humans: humansFrom(view) };
    void createAndOpen(view, '/api/rooms', body, submit);
  });
  return form;
}

function renderRooms(box, rooms) {
  if (rooms.length === 0) {
    fill(box, h('p', { class: 'empty', text: 'No rooms yet. Create one from a preset to watch the agent work.' }));
    return;
  }
  const rows = rooms.map((room) => {
    const total = STAGES.reduce((n, [stage]) => n + room.stageCounts[stage], 0);
    const breakdown = STAGES.filter(([stage]) => room.stageCounts[stage] > 0)
      .map(([stage, label]) => `${room.stageCounts[stage]} ${label.toLowerCase()}`)
      .join(' · ');
    return h(
      'tr',
      {},
      h('td', { class: 'objective' }, h('a', { href: roomHref(room.id, room.humans[0]), text: room.objective })),
      h('td', {}, h('span', { class: `badge ${room.status}`, text: room.status })),
      h(
        'td',
        {},
        h('div', { class: 'progress-cell' }, stageBar(room.stageCounts, Math.max(total, room.targetCount), 'mini'), h('span', { class: 'faint', text: `${total}/${room.targetCount}${breakdown ? ` · ${breakdown}` : ''}` })),
      ),
      h('td', { class: 'muted', text: room.humans.join(', ') }),
      h('td', { class: 'faint' }, relSpan(room.createdAt)),
    );
  });
  fill(box, 
    h(
      'table',
      { class: 'rooms-table' },
      h('thead', {}, h('tr', {}, ...['Objective', 'Status', 'Progress', 'Humans', 'Created'].map((t) => h('th', { text: t })))),
      h('tbody', {}, rows),
    ),
  );
}

function stageBar(counts, denominator, extraClass = '') {
  const bar = h('div', { class: `bar ${extraClass}`.trim(), role: 'img', 'aria-label': STAGES.map(([s, l]) => `${l} ${counts[s]}`).join(', ') });
  for (const [stage, label] of STAGES) {
    if (!counts[stage]) continue;
    const seg = h('div', { class: `seg stage-${stage}`, title: `${label}: ${counts[stage]}` });
    seg.style.width = `${(counts[stage] / Math.max(1, denominator)) * 100}%`;
    bar.append(seg);
  }
  return bar;
}

// ------------------------------------------------------------------------------------------- room: data

async function openRoom(roomId) {
  document.title = 'Prospect Room';
  state.view = buildRoomSkeleton();
  fill(app, state.view.root);
  setConnection('connecting');
  await refresh();
  if (state.roomId === roomId && !state.notFound) connectStream(roomId);
}

function connectStream(roomId) {
  state.es?.close();
  const es = new EventSource(`/api/rooms/${encodeURIComponent(roomId)}/stream`);
  state.es = es;
  es.addEventListener('open', () => {
    setConnection('live');
    stopPolling();
    requestRefresh(0); // anything that happened while disconnected
  });
  es.addEventListener('change', () => requestRefresh(DEBOUNCE_MS));
  es.addEventListener('resync', () => requestRefresh(0));
  es.addEventListener('error', () => {
    if (state.es !== es) return;
    setConnection('reconnecting');
    startPolling();
  });
}

function startPolling() {
  if (state.pollTimer) return;
  state.pollTimer = setInterval(() => {
    requestRefresh(0);
    // The browser gives up on an EventSource after a non-200 response; try a fresh one.
    if (state.es?.readyState === EventSource.CLOSED && state.roomId && !state.notFound) connectStream(state.roomId);
  }, POLL_MS);
}

function stopPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = null;
}

function requestRefresh(delay) {
  if (state.refreshTimer && delay > 0) return; // already coming: collapse bursts of events
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(() => {
    state.refreshTimer = null;
    void refresh();
  }, delay);
}

/** Serialized: never two snapshot requests at once, and a request made meanwhile triggers one more. */
async function refresh() {
  if (!state.roomId) return;
  if (state.fetching) {
    state.refetch = true;
    return;
  }
  state.fetching = true;
  try {
    do {
      state.refetch = false;
      const roomId = state.roomId;
      try {
        const snapshot = await api('GET', `/api/rooms/${encodeURIComponent(roomId)}`);
        if (roomId !== state.roomId) return;
        state.snapshot = snapshot;
        state.clockOffset = Date.parse(snapshot.serverTime) - Date.now();
        state.loadError = null;
        if (state.connection === 'offline') setConnection(state.es?.readyState === EventSource.OPEN ? 'live' : 'reconnecting');
      } catch (err) {
        if (roomId !== state.roomId) return;
        if (err.status === 404) state.notFound = true;
        else {
          state.loadError = errorText(err);
          if (err.status === 0) setConnection('offline');
          startPolling();
        }
      }
      renderRoom();
    } while (state.refetch);
  } finally {
    state.fetching = false;
  }
}

function setConnection(value) {
  state.connection = value;
  connEl.hidden = false;
  connEl.className = `conn ${value}`;
  connEl.textContent = { connecting: 'Connecting…', live: 'Live', reconnecting: 'Reconnecting · polling every 3s', offline: 'Offline · retrying' }[value];
}

function findProspect(id) {
  return state.snapshot?.prospects.find((p) => p.id === id) ?? null;
}

// ------------------------------------------------------------------------------------------- room: actions

async function runAction(key, request, { success, after } = {}) {
  if (state.busy.has(key)) return;
  state.busy.add(key);
  clearMessage(key);
  renderRoom();
  try {
    const result = await request();
    after?.(result);
    if (success) flash(key, 'ok', typeof success === 'function' ? success(result) : success);
  } catch (err) {
    flash(key, 'error', errorText(err));
  } finally {
    state.busy.delete(key);
    renderRoom();
    requestRefresh(0);
  }
}

function flash(key, tone, text) {
  const message = { id: ++messageSeq, tone, text };
  state.messages.set(key, message);
  if (tone === 'ok') {
    setTimeout(() => {
      if (state.messages.get(key) !== message) return;
      state.messages.delete(key);
      renderRoom();
    }, 4000);
  }
}

function clearMessage(key) {
  state.messages.delete(key);
}

/** After our own successful action the version moved, but the draft the user edited did not. */
function rebaseEdit(p, newVersion) {
  const edit = state.edits.get(p.id);
  if (edit && edit.baseVersion === p.version) edit.baseVersion = newVersion;
}

function closeForm(id) {
  state.forms.delete(id);
  state.formText.delete(id);
}

const actions = {
  claim(p) {
    void runAction(p.id, () => api('POST', `/api/prospects/${p.id}/claim`, { actor: state.as, expectedVersion: p.version }), {
      success: 'Claimed. The agent will leave this task to you.',
      after: (r) => rebaseEdit(p, r.prospect.version),
    });
  },
  approve(p, card) {
    const text = card.textarea.value;
    const edited = state.edits.has(p.id) && text.trim() !== (p.draft?.body ?? '').trim();
    const body = { actor: state.as, expectedVersion: p.version, ...(edited ? { text } : {}) };
    void runAction(p.id, () => api('POST', `/api/prospects/${p.id}/approve`, body), {
      success: edited ? 'Approved with your edits' : 'Approved',
      after: () => state.edits.delete(p.id),
    });
  },
  skip(p) {
    const reason = (state.formText.get(p.id) ?? '').trim();
    const body = { actor: state.as, expectedVersion: p.version, ...(reason ? { reason } : {}) };
    void runAction(p.id, () => api('POST', `/api/prospects/${p.id}/skip`, body), {
      success: 'Skipped',
      after: () => {
        closeForm(p.id);
        state.edits.delete(p.id);
      },
    });
  },
  handback(p) {
    const note = (state.formText.get(p.id) ?? '').trim();
    const body = { actor: state.as, expectedVersion: p.version, ...(note ? { note } : {}) };
    void runAction(p.id, () => api('POST', `/api/prospects/${p.id}/handback`, body), {
      success: (r) =>
        r.prospect.draft_revision > p.draftRevision
          ? `Handed back. The agent will write revision ${r.prospect.draft_revision}.`
          : 'Handed back to the agent',
      after: (r) => {
        closeForm(p.id);
        if (r.prospect.draft_revision === p.draftRevision) rebaseEdit(p, r.prospect.version);
      },
    });
  },
  retry(job) {
    const key = job.prospectId ?? 'room';
    void runAction(key, () => api('POST', `/api/jobs/${job.id}/retry`, { actor: state.as }), { success: `Retry queued for ${job.kind}` });
  },
  setRoomStatus(action) {
    void runAction('room', () => api('POST', `/api/rooms/${state.roomId}/${action}`, { actor: state.as }), {
      success: action === 'pause' ? 'Room paused' : 'Room resumed',
    });
  },
};

function setActor(handle) {
  state.as = handle;
  const params = new URLSearchParams(location.search);
  params.set('as', handle);
  history.replaceState(null, '', `?${params}`);
  // An unsent draft edit belongs to whoever typed it: it must not follow the switch and be sent as someone else.
  state.edits.clear();
  state.forms.clear();
  state.formText.clear();
  state.messages.clear();
  renderRoom();
}

// ------------------------------------------------------------------------------------------- room: rendering

function buildRoomSkeleton() {
  const head = h('section', { class: 'panel room-head' }, h('p', { class: 'muted', text: 'Loading room…' }));
  const banner = h('div', { class: 'banner', role: 'status', hidden: true });
  const loadError = h('div', { class: 'load-error', role: 'alert', hidden: true });
  const cards = h('div', { class: 'cards' });
  const cardsEmpty = h('div', { class: 'panel empty', hidden: true });
  const tasksCount = h('span', { class: 'faint' });
  const feed = h('aside', { class: 'panel feed' });
  const root = h(
    'div',
    {},
    head,
    banner,
    loadError,
    h('div', { class: 'room-layout' }, h('section', {}, h('div', { class: 'tasks-head' }, h('h2', { text: 'Tasks' }), tasksCount), cardsEmpty, cards), feed),
  );
  return { root, head, banner, loadError, cards, cardsEmpty, tasksCount, feed };
}

function makeContext(snap) {
  const humans = snap.members.filter((m) => m.kind === 'human');
  const me = humans.find((m) => m.handle === state.as) ?? null;
  const positions = new Map(snap.prospects.map((p) => [p.id, p.position]));
  const retryEvent = snap.events.find((e) => e.type === 'job.retry_scheduled' && e.data.maxAttempts);
  return {
    snap,
    humans,
    me,
    positions,
    paused: snap.room.status === 'paused',
    maxAttempts: retryEvent ? Number(retryEvent.data.maxAttempts) : null,
  };
}

function renderRoom() {
  const view = state.view;
  if (!view || !state.roomId) return;
  if (state.notFound) {
    state.es?.close();
    stopPolling();
    connEl.hidden = true;
    identityEl.hidden = true;
    fill(app, 
      h('section', { class: 'panel empty' }, h('p', { text: 'Room not found.' }), h('p', {}, h('a', { href: '/', text: 'Back to rooms' }))),
    );
    return;
  }
  view.loadError.hidden = !state.loadError;
  view.loadError.textContent = state.loadError ? `${state.loadError}. Showing the last loaded state.` : '';
  const snap = state.snapshot;
  if (!snap) return;

  if (!state.as && snap.members.some((m) => m.kind === 'human')) {
    setActor(snap.members.find((m) => m.kind === 'human').handle);
    return;
  }
  const ctx = makeContext(snap);
  document.title = `${clip(snap.room.objective, 60)} · Prospect Room`;
  renderTopbar(ctx);
  renderIfChanged(view.head, JSON.stringify([snap.room, snap.stageCounts, snap.providers, snap.calls, snap.roomJobs, snap.prospects.length, ctx.me?.handle, ctx.maxAttempts, state.busy.has('room'), state.messages.get('room')?.id]), () =>
    renderHead(view.head, ctx),
  );
  renderIfChanged(view.banner, JSON.stringify([ctx.paused, snap.events.find((e) => e.type === 'room.paused')?.id, ctx.me?.handle, state.busy.has('room')]), () =>
    renderBanner(view.banner, ctx),
  );
  renderCards(ctx);
  renderIfChanged(view.feed, JSON.stringify([snap.events[0]?.id, snap.prospects.length, ctx.me?.handle]), () => renderFeed(view.feed, ctx));
}

function renderTopbar(ctx) {
  renderIfChanged(crumbs, ctx.snap.room.objective, () =>
    fill(crumbs, h('a', { href: '/', text: 'Rooms' }), h('span', { class: 'sep', text: '/' }), h('span', { class: 'current', text: ctx.snap.room.objective })),
  );
  renderIfChanged(identityEl, JSON.stringify([ctx.humans, state.as]), () => {
    identityEl.hidden = false;
    identityEl.classList.toggle('unknown', !ctx.me);
    const options = ctx.humans.map((m) =>
      withHue(
        h('button', {
          type: 'button',
          class: 'identity-option',
          'aria-pressed': String(m.handle === state.as),
          title: `Act as ${m.displayName} (${m.handle})`,
          onclick: () => setActor(m.handle),
        }, h('span', { class: 'dot' }), m.displayName),
        m.handle,
      ),
    );
    fill(identityEl, 
      h('span', { class: 'identity-label', text: ctx.me ? 'Acting as' : `"${state.as}" is not in this room · act as` }),
      h('div', { class: 'identity-options', role: 'group', 'aria-label': 'Acting as' }, options),
    );
  });
}

function renderHead(el, ctx) {
  const { room } = ctx.snap;
  const busy = state.busy.has('room');
  const toggle = ctx.paused
    ? btn('Resume room', () => actions.setRoomStatus('resume'), { variant: 'primary', disabled: busy || !ctx.me, title: ctx.me ? undefined : 'Pick who you are acting as' })
    : btn('Pause room', () => actions.setRoomStatus('pause'), { disabled: busy || !ctx.me, title: ctx.me ? 'Stop the agent and freeze all task actions' : 'Pick who you are acting as' });

  fill(el, 
    h(
      'div',
      { class: 'head-top' },
      h(
        'div',
        { class: 'head-text' },
        h('div', { class: 'eyebrow' }, h('span', { class: `badge ${room.status}`, text: room.status }), h('span', { text: `Room ${room.id.slice(0, 8)}` }), '·', h('span', {}, 'created ', relSpan(room.createdAt))),
        h('h1', { text: room.objective }),
        h('p', { class: 'icp', text: room.icp.description }),
        room.icp.pitch ? h('p', { class: 'pitch' }, h('span', { class: 'label', text: 'Pitch' }), room.icp.pitch) : null,
        filtersLine(room.icp.filters),
      ),
      h('div', { class: 'head-actions' }, toggle, messageEl('room')),
    ),
    h('div', { class: 'panels' }, progressPanel(ctx), providersPanel(ctx), searchPanel(ctx)),
  );
}

function filtersLine(filters = {}) {
  const parts = [
    ['Titles', filters.person_titles?.join(', ')],
    ['Locations', filters.person_locations?.join('; ')],
    ['Employees', filters.organization_num_employees_ranges?.map((r) => r.replace(',', '–')).join(', ')],
    ['Keywords', filters.q_keywords],
  ].filter(([, value]) => value);
  if (parts.length === 0) return null;
  return h('p', { class: 'filters' }, parts.flatMap(([label, value], i) => [i ? '  ' : '', h('span', { class: 'label', text: label }), value]));
}

function progressPanel(ctx) {
  const { stageCounts, room, prospects } = ctx.snap;
  const found = prospects.length;
  const decided = stageCounts.approved + stageCounts.skipped;
  return h(
    'div',
    { class: 'subpanel' },
    h('div', { class: 'subpanel-head' }, h('h3', { text: 'Progress' }), h('span', { class: 'faint', text: `${found}/${room.targetCount} found · ${decided} decided` })),
    stageBar(stageCounts, Math.max(found, room.targetCount)),
    h(
      'div',
      { class: 'legend' },
      STAGES.map(([stage, label]) =>
        h('div', { class: `legend-item stage-${stage}` }, h('span', { class: 'count', text: String(stageCounts[stage]) }), h('span', { class: 'name', text: label })),
      ),
    ),
  );
}

function providersPanel(ctx) {
  const { providers, calls } = ctx.snap;
  const shown = providers.filter((p) => p.provider === 'apollo' || p.lastHeaders || (p.blockedUntil && Date.parse(p.blockedUntil) > serverNow()));
  const rows = shown.map((p) => {
    const blocked = p.blockedUntil && Date.parse(p.blockedUntil) > serverNow();
    const headers = p.lastHeaders ?? {};
    const windows = [
      ['minute', headers['x-minute-requests-left'], headers['x-rate-limit-minute']],
      ['hour', headers['x-hourly-requests-left'], headers['x-rate-limit-hourly']],
      ['day', headers['x-24-hour-requests-left'], headers['x-rate-limit-24-hour']],
    ].filter(([, left]) => left !== undefined);
    return h(
      'div',
      { class: 'provider-row' },
      h(
        'div',
        { class: 'provider-line' },
        h('span', { class: 'provider-name', text: p.provider }),
        blocked
          ? h('span', { class: 'badge warn' }, 'Blocked · clears in ', countdownSpan(p.blockedUntil))
          : h('span', { class: 'badge ok', text: 'Available' }),
        blocked && p.reason ? h('span', { class: 'faint', text: p.reason }) : null,
      ),
      windows.length
        ? h('div', { class: 'kv' }, h('span', { class: 'faint', text: 'Requests left' }), windows.map(([name, left, limit]) => h('span', {}, `${name} `, h('b', { text: left }), limit ? `/${limit}` : '')))
        : h('div', { class: 'kv faint', text: 'No rate-limit headers seen yet' }),
    );
  });
  const byProvider = new Map();
  for (const c of calls) byProvider.set(c.provider, [...(byProvider.get(c.provider) ?? []), c]);
  const callLines = [...byProvider].map(([provider, list]) =>
    h('div', { class: 'kv' }, h('span', { class: 'provider-name', text: provider }), list.map((c) => h('span', {}, h('b', { text: String(c.count) }), ` ${c.status.replace('_', ' ')}`))),
  );
  return h(
    'div',
    { class: 'subpanel' },
    h('div', { class: 'subpanel-head' }, h('h3', { text: 'Providers' }), h('span', { class: 'faint', text: 'limits shared by all rooms' })),
    rows,
    h('h3', { text: 'External calls · this room' }),
    callLines.length ? callLines : h('div', { class: 'kv faint', text: 'None yet' }),
  );
}

function searchPanel(ctx) {
  const { roomJobs } = ctx.snap;
  return h(
    'div',
    { class: 'subpanel' },
    h('div', { class: 'subpanel-head' }, h('h3', { text: 'Apollo search' }), h('span', { class: 'faint', text: `${roomJobs.length} page${roomJobs.length === 1 ? '' : 's'}` })),
    roomJobs.length
      ? h('div', { class: 'jobs' }, roomJobs.map((job, i) => jobLine(job, ctx, null, `search p${i + 1}`)))
      : h('div', { class: 'kv faint', text: 'No search jobs' }),
  );
}

function renderBanner(el, ctx) {
  el.hidden = !ctx.paused;
  if (!ctx.paused) return fill(el);
  const pausedEvent = ctx.snap.events.find((e) => e.type === 'room.paused');
  fill(el, 
    h('strong', { text: 'Room paused' }),
    h('span', {}, pausedEvent ? [` by ${pausedEvent.actorHandle ?? 'someone'} `, relSpan(pausedEvent.createdAt)] : '', ' · the agent starts no new work and task actions are disabled.'),
    btn('Resume', () => actions.setRoomStatus('resume'), { variant: 'primary small', disabled: state.busy.has('room') || !ctx.me }),
  );
}

function messageEl(key) {
  const message = state.messages.get(key);
  if (!message) return null;
  return h(
    'div',
    { class: `${key === 'room' ? 'room-msg' : 'card-msg'} ${message.tone}`, role: message.tone === 'error' ? 'alert' : 'status' },
    h('span', { class: 'msg-text', text: message.text }),
    h('button', { type: 'button', class: 'msg-close', 'aria-label': 'Dismiss', text: '×', onclick: () => { clearMessage(key); signatures.delete(state.view.head); renderRoom(); } }),
  );
}

// ------------------------------------------------------------------------------------------- task cards

function renderCards(ctx) {
  const { cards: list, cardsEmpty, tasksCount } = state.view;
  const { prospects, room, roomJobs } = ctx.snap;
  tasksCount.textContent = prospects.length ? `${prospects.length} of ${room.targetCount} · in position order` : '';
  cardsEmpty.hidden = prospects.length > 0;
  if (!prospects.length) {
    const searching = roomJobs.some((j) => j.status === 'pending' || j.status === 'running');
    cardsEmpty.textContent = ctx.paused ? 'Room is paused before the first search finished.' : searching ? 'The agent is searching Apollo for people matching the ICP…' : 'No prospects found.';
  }

  const seen = new Set();
  let previous = null;
  for (const p of prospects) {
    let card = state.cards.get(p.id);
    if (!card) {
      card = createCard(p.id);
      state.cards.set(p.id, card);
    }
    seen.add(p.id);
    updateCard(card, p, ctx);
    const expected = previous ? previous.root.nextElementSibling : list.firstElementChild;
    if (expected !== card.root) {
      if (previous) previous.root.after(card.root);
      else list.prepend(card.root);
    }
    previous = card;
  }
  for (const [id, card] of state.cards) {
    if (seen.has(id)) continue;
    card.root.remove();
    state.cards.delete(id);
  }
}

function createCard(id) {
  const textarea = h('textarea', { class: 'draft-input', rows: 3, spellcheck: 'true', id: `draft-${id}`, name: `draft-${id}`, 'aria-label': 'Outreach note' });
  const formInput = h('textarea', { class: 'form-input', rows: 2, id: `form-${id}` });
  const card = {
    root: h('article', { class: 'card' }),
    main: h('div', { class: 'card-main' }),
    draftMeta: h('div', { class: 'draft-meta' }),
    textarea,
    notice: h('div', { class: 'notice', role: 'alert', hidden: true }),
    decision: h('div', { class: 'decision', hidden: true }),
    formLabel: h('label', { class: 'form-label', for: `form-${id}` }),
    formInput,
    formButtons: h('div', { class: 'form-buttons' }),
    actions: h('div', { class: 'card-actions' }),
    message: h('div', {}),
  };
  card.draftBox = h('div', { class: 'card-draft' }, card.draftMeta, textarea, card.notice);
  card.form = h('div', { class: 'card-form', hidden: true }, card.formLabel, formInput, card.formButtons);
  card.root.append(card.main, card.draftBox, card.decision, card.form, card.actions, card.message);

  textarea.addEventListener('input', () => onDraftInput(id, textarea));
  formInput.addEventListener('input', () => state.formText.set(id, formInput.value));
  formInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    closeForm(id);
    renderRoom();
  });
  return card;
}

function onDraftInput(id, textarea) {
  const p = findProspect(id);
  if (!p) return;
  const edit = state.edits.get(id);
  if (textarea.value === (p.draft?.body ?? '')) state.edits.delete(id);
  else if (edit) edit.text = textarea.value;
  else state.edits.set(id, { text: textarea.value, baseVersion: p.version });
  renderRoom();
}

function editState(p) {
  const edit = state.edits.get(p.id);
  if (!edit) return { edited: false, stale: false, empty: !(p.draft?.body ?? '').trim() };
  return { edited: edit.text.trim() !== (p.draft?.body ?? '').trim(), stale: edit.baseVersion !== p.version, empty: !edit.text.trim() };
}

function permissions(p, ctx) {
  const decided = p.stage === 'approved' || p.stage === 'skipped';
  const agentOwned = p.ownerKind === 'agent';
  const mine = !agentOwned && p.ownerHandle === state.as;
  const review = p.stage === 'awaiting_review';
  return {
    decided,
    mine,
    agentOwned,
    claim: !decided && agentOwned,
    handback: !decided && mine,
    decide: !decided && (mine || (agentOwned && review)),
    blockedReason: ctx.paused ? 'The room is paused' : !ctx.me ? 'Pick who you are acting as' : null,
  };
}

function updateCard(card, p, ctx) {
  const perms = permissions(p, ctx);
  const edit = editState(p);
  const form = state.forms.get(p.id);
  const message = state.messages.get(p.id);
  const busy = state.busy.has(p.id);
  const decisionEvent = perms.decided ? ctx.snap.events.find((e) => e.prospectId === p.id && (e.type === 'task.approved' || e.type === 'task.skipped')) : null;
  const signature = JSON.stringify([p, state.as, ctx.paused, !!ctx.me, ctx.maxAttempts, edit, form, message?.id, busy, decisionEvent?.id]);
  if (signatures.get(card.root) === signature) return;
  signatures.set(card.root, signature);

  card.root.id = `task-${p.position}`;
  card.root.className = `card stage-${p.stage}${perms.mine ? ' mine' : ''}${perms.decided ? ' decided' : ''}`;
  if (!perms.agentOwned) withHue(card.root, p.ownerHandle);

  fill(card.main, cardHead(p, ctx), jobsBlock(p, ctx), lastErrorLine(p), factsBlock(p), linkedinBlock(p), feedbackBlock(p, perms));
  renderDraft(card, p, perms, edit, ctx);
  renderDecision(card, p, perms, decisionEvent);
  renderForm(card, p, perms, form, busy);
  renderActions(card, p, perms, edit, form, busy, ctx);
  fill(card.message, messageEl(p.id) ?? '');
}

function cardHead(p, ctx) {
  const name = p.enrichment?.name || p.displayName;
  const title = p.enrichment?.title || p.title;
  const company = p.enrichment?.organization?.name || p.company;
  const role = [title, company].filter(Boolean).join(' @ ');
  return h(
    'div',
    { class: 'card-head' },
    h('span', { class: 'pos', text: `#${p.position}` }),
    h('div', { class: 'who' }, h('div', { class: 'name', text: name }), role ? h('div', { class: 'role', text: role }) : null),
    h('div', { class: 'card-badges' }, h('span', { class: `stage stage-${p.stage}`, text: STAGE_LABEL[p.stage] }), ownerChip(p, ctx)),
  );
}

function ownerChip(p) {
  if (p.ownerKind === 'agent') return h('span', { class: 'chip agent', title: 'Owned by the agent', text: 'Agent' });
  const you = p.ownerHandle === state.as;
  return withHue(h('span', { class: `chip human${you ? ' you' : ''}`, title: `Claimed by ${p.ownerHandle}`, text: you ? `You · ${p.ownerHandle}` : p.ownerHandle }), p.ownerHandle);
}

function jobsBlock(p, ctx) {
  const open = p.jobs.filter((j) => j.status === 'pending' || j.status === 'running' || j.status === 'dead');
  if (open.length === 0) return null;
  return h('div', { class: 'jobs' }, open.map((job) => jobLine(job, ctx, p)));
}

/** One live status line for a job, e.g. "enrich · retrying (attempt 2/8) · next try in 12s · Apollo 500…". */
function jobLine(job, ctx, p, label = job.kind) {
  const parts = [label];
  let tone = 'waiting';
  let countdownAt = null;
  const inFuture = Date.parse(job.runAfter) > serverNow() + 500;
  const attempt = `attempt ${job.attempts + 1}${ctx.maxAttempts ? `/${ctx.maxAttempts}` : ''}`;

  if (job.status === 'succeeded' || job.status === 'cancelled') {
    tone = job.status === 'succeeded' ? 'done' : 'waiting';
    parts.push(job.status === 'succeeded' ? 'done' : 'cancelled');
  } else if (job.status === 'running') {
    tone = 'running';
    parts.push(job.attempts > 0 ? `running (${attempt})` : 'running');
  } else if (job.status === 'dead') {
    tone = 'dead';
    parts.push(job.attempts > 0 ? `failed after ${job.attempts} attempt${job.attempts === 1 ? '' : 's'}` : 'failed');
  } else if (ctx.paused) {
    tone = 'hold';
    parts.push('paused');
  } else if (p && p.ownerKind === 'human') {
    tone = 'hold';
    parts.push(`on hold while ${p.ownerHandle} owns the task`);
  } else if (inFuture && job.attempts > 0) {
    tone = 'retrying';
    parts.push(`retrying (${attempt})`);
    countdownAt = job.runAfter;
  } else if (inFuture && job.deferrals > 0) {
    tone = 'limited';
    parts.push(`rate limited (deferred ${job.deferrals}×)`);
    countdownAt = job.runAfter;
  } else if (inFuture) {
    parts.push('scheduled');
    countdownAt = job.runAfter;
  } else {
    parts.push(job.attempts > 0 ? `waiting (${attempt})` : 'waiting');
  }

  const text = h('span', { class: 'job-text', title: job.lastError ?? '' }, parts.join(' · '));
  if (countdownAt) text.append(' · next try in ', countdownSpan(countdownAt));
  if (job.lastError && job.status !== 'running') text.append(` · ${clip(job.lastError, 90)}`);
  const retry =
    job.status === 'dead'
      ? btn('Retry', () => actions.retry(job), {
          variant: 'small',
          disabled: state.busy.has(job.prospectId ?? 'room') || ctx.paused || !ctx.me,
          title: ctx.paused ? 'The room is paused' : !ctx.me ? 'Pick who you are acting as' : 'Queue this job again',
        })
      : null;
  return h('div', { class: `job ${tone}` }, text, retry);
}

function lastErrorLine(p) {
  if (!p.lastError) return null;
  const shownByJob = p.jobs.some((j) => j.status !== 'succeeded' && j.status !== 'cancelled' && j.lastError && p.lastError === `${j.kind}: ${j.lastError}`);
  if (shownByJob) return null;
  return h('div', { class: 'last-error', title: p.lastError, text: `Last error: ${clip(p.lastError, 160)}` });
}

function factsBlock(p) {
  const e = p.enrichment;
  if (!e) return h('div', { class: 'facts faint', text: p.stage === 'new' ? 'Not enriched yet' : 'No enrichment data' });
  const fact = (k, v) => (v ? h('span', { class: 'fact' }, h('span', { class: 'k', text: k }), h('span', { class: 'v' }, v)) : null);
  const org = e.organization;
  const email = e.email ? `${e.email}${e.emailStatus ? ` (${e.emailStatus})` : ''}` : e.emailStatus;
  return h(
    'div',
    { class: 'card-facts' },
    h(
      'div',
      { class: 'facts' },
      fact('Location', e.location),
      fact('Industry', org?.industry),
      fact('Size', org?.employees ? `${Number(org.employees).toLocaleString()} employees` : null),
      fact('Email', email),
      fact('Web', extLink(org?.website, clip(str(org?.website).replace(/^https?:\/\/(www\.)?/, ''), 40))),
      fact('LinkedIn', extLink(e.linkedinUrl, 'profile ↗')),
    ),
    e.headline ? h('div', { class: 'headline', text: e.headline }) : null,
  );
}

function linkedinBlock(p) {
  const li = p.linkedin;
  if (!li) return null;
  const tone = li.outcome === 'ok' ? 'ok' : li.outcome === 'error' ? 'error' : 'warn';
  return h(
    'div',
    { class: 'linkedin' },
    h('span', { class: 'label', text: 'LinkedIn lookup' }),
    h('span', { class: `badge ${tone}`, text: li.outcome.replace('_', ' ') }),
    li.headline ? h('span', { class: 'li-headline', text: `“${li.headline}”` }) : null,
    li.source ? h('span', { class: 'faint', text: `via ${li.source}` }) : null,
    extLink(li.finalUrl || li.url, 'page ↗'),
    extLink(li.screenshotUrl, 'screenshot ↗'),
  );
}

function feedbackBlock(p, perms) {
  if (!p.handbackNote || perms.decided) return null;
  return h('blockquote', { class: 'feedback' }, h('span', { class: 'label', text: 'Feedback' }), p.handbackNote);
}

function renderDraft(card, p, perms, edit, ctx) {
  const { textarea, draftMeta, notice, draftBox } = card;
  draftBox.hidden = perms.decided;
  if (perms.decided) return;

  const draft = p.draft;
  const editable = perms.decide && !!ctx.me;
  const userEdit = state.edits.get(p.id);
  textarea.hidden = !editable && !draft && !userEdit;
  textarea.readOnly = !editable;
  textarea.classList.toggle('is-edited', edit.edited);
  textarea.placeholder = editable && !draft ? 'No draft yet. Write the note yourself, or hand the task back to the agent.' : '';
  // Never overwrite what the user typed; only follow the server while they have no edit.
  const wanted = userEdit ? userEdit.text : (draft?.body ?? '');
  if (textarea.value !== wanted && !(userEdit && document.activeElement === textarea)) textarea.value = wanted;

  const requested = p.draftRevision > (draft?.revision ?? 0) ? `rev ${p.draftRevision} requested` : null;
  fill(draftMeta, 
    h('span', { class: 'label', text: 'Draft' }),
    draft ? h('span', { text: `rev ${draft.revision} · ${draft.generator}` }) : h('span', { text: perms.agentOwned ? 'the agent will draft after enrichment' : 'none yet' }),
    requested && draft ? h('span', { class: 'faint', text: requested }) : null,
    edit.edited ? h('span', { class: 'edited', text: 'edited · not sent' }) : null,
  );

  notice.hidden = !edit.stale;
  if (edit.stale) {
    fill(notice, 
      h('span', { text: 'This task changed — review before approving.' }),
      h('span', { class: 'spacer' }),
      btn('Use latest draft', () => {
        state.edits.delete(p.id);
        textarea.value = p.draft?.body ?? '';
        renderRoom();
      }, { variant: 'small' }),
      btn('Keep my text', () => {
        const current = state.edits.get(p.id);
        if (current) current.baseVersion = p.version;
        renderRoom();
      }, { variant: 'small' }),
    );
  }
}

function renderDecision(card, p, perms, decisionEvent) {
  card.decision.hidden = !perms.decided;
  if (!perms.decided) return fill(card.decision);
  const approved = p.stage === 'approved';
  const edited = approved && decisionEvent?.data?.edited;
  const reason = !approved ? str(decisionEvent?.data?.reason) : '';
  fill(card.decision, 
    h(
      'div',
      { class: 'decision-head' },
      h('strong', { text: approved ? 'Approved' : 'Skipped' }),
      ` by ${p.decidedByHandle ?? 'unknown'} · `,
      p.decidedAt ? relSpan(p.decidedAt) : '',
      edited ? ' · note edited by a human' : approved && decisionEvent ? ' · agent draft as written' : '',
    ),
    approved && p.finalNote ? h('p', { class: 'final-note', text: p.finalNote }) : null,
    reason ? h('p', { class: 'muted', text: `Reason: ${reason}` }) : null,
  );
}

function renderForm(card, p, perms, form, busy) {
  const allowed = form === 'handback' ? perms.handback : form === 'skip' ? perms.decide : false;
  card.form.hidden = !allowed;
  if (!allowed) return;
  const handback = form === 'handback';
  card.formLabel.textContent = handback
    ? p.stage === 'awaiting_review'
      ? 'Feedback for the agent (optional). With feedback, the agent writes a new draft revision.'
      : 'Note for the agent (optional)'
    : 'Reason for skipping (optional)';
  card.formInput.placeholder = handback ? 'e.g. Mention their recent Series B, keep it under 40 words' : 'e.g. Not a decision maker';
  const wanted = state.formText.get(p.id) ?? '';
  if (card.formInput.value !== wanted && document.activeElement !== card.formInput) card.formInput.value = wanted;
  fill(card.formButtons, 
    handback
      ? btn('Hand back to agent', () => actions.handback(p), { variant: 'primary small', disabled: busy })
      : btn('Skip task', () => actions.skip(p), { variant: 'primary small', disabled: busy }),
    btn('Cancel', () => {
      closeForm(p.id);
      renderRoom();
    }, { variant: 'ghost small' }),
  );
}

function renderActions(card, p, perms, edit, form, busy, ctx) {
  const blocked = perms.blockedReason;
  const disabled = busy || !!blocked;
  const title = blocked ?? undefined;
  const openForm = (name) => {
    state.forms.set(p.id, name);
    renderRoom();
    card.formInput.focus();
  };
  const buttons = [];
  if (perms.claim) buttons.push(btn('Claim', () => actions.claim(p), { variant: perms.decide ? '' : 'primary', disabled, title: title ?? 'Take this task from the agent' }));
  if (perms.decide) {
    const noText = edit.empty;
    buttons.push(
      btn(edit.edited ? 'Approve edited note' : 'Approve', () => actions.approve(p, card), {
        variant: 'primary',
        disabled: disabled || edit.stale || noText,
        title: title ?? (edit.stale ? 'Review the change first' : noText ? 'Write the note first' : undefined),
      }),
    );
    if (form !== 'skip') buttons.push(btn('Skip…', () => openForm('skip'), { disabled, title }));
  }
  if (perms.handback && form !== 'handback') buttons.push(btn('Hand back…', () => openForm('handback'), { disabled, title }));
  if (!perms.decided && !perms.agentOwned && !perms.mine) buttons.push(h('span', { class: 'hint', text: `${p.ownerHandle} is working on this task` }));
  if (perms.agentOwned && !perms.decide && !perms.decided) buttons.push(h('span', { class: 'hint', text: 'Claim to write the note yourself' }));
  if (blocked && buttons.length && ctx.paused) buttons.push(h('span', { class: 'hint', text: 'Paused' }));
  fill(card.actions, ...buttons);
}

// ------------------------------------------------------------------------------------------- activity feed

function renderFeed(el, ctx) {
  const events = ctx.snap.events.slice(0, FEED_LIMIT);
  fill(el, 
    h('div', { class: 'panel-head' }, h('h2', { text: 'Activity' }), h('span', { class: 'faint', text: `latest ${events.length}` })),
    events.length
      ? h(
          'ol',
          { class: 'feed-list' },
          events.map((event) => {
            const { tone, text } = describeEvent(event, ctx);
            return h(
              'li',
              { class: `ev ${tone}` },
              h('span', { class: 'ev-time', dataset: { since: event.createdAt }, title: new Date(event.createdAt).toLocaleString(), text: relTime(event.createdAt) }),
              h('span', { class: 'ev-text', text }),
            );
          }),
        )
      : h('p', { class: 'empty', text: 'Nothing yet' }),
  );
}

function describeEvent(event, ctx) {
  const d = event.data ?? {};
  const who = event.actorHandle ?? 'agent';
  const position = event.prospectId ? ctx.positions.get(event.prospectId) : undefined;
  const ref = position ? `#${position}` : '';
  const kindRef = (kind) => [str(kind), ref].filter(Boolean).join(' ');
  const say = (tone, text) => ({ tone, text: text.replace(/\s+/g, ' ').trim() });
  const secondsUntil = (iso) => Math.max(0, Math.round((Date.parse(iso) - Date.parse(event.createdAt)) / 1000));

  switch (event.type) {
    case 'room.created':
      return say('agent', `room created · target ${str(d.targetCount)} · humans ${Array.isArray(d.humans) ? d.humans.join(', ') : ''}`);
    case 'room.paused':
      return say('warn', `${who} paused the room`);
    case 'room.resumed':
      return say('human', `${who} resumed the room`);
    case 'search.completed':
      return say('agent', `agent: search page ${str(d.page)} → ${str(d.returned)} people, ${str(d.added)} new (${str(d.totalProspects)} total)`);
    case 'prospect.discovered':
      return say('agent', `agent: found ${ref} ${str(d.name)}${d.title ? `, ${d.title}` : ''}${d.company ? ` @ ${d.company}` : ''}`);
    case 'enrich.completed':
      return say('agent', `agent: enriched ${ref} ${str(d.name)}${d.emailStatus ? ` · email ${d.emailStatus}` : ''}`);
    case 'search.in_doubt_retry':
    case 'enrich.in_doubt_retry':
    case 'draft.in_doubt_retry':
      return say('warn', `agent: ${event.type.split('.')[0]} ${ref} retried after an interrupted call (outcome in doubt)`);
    case 'draft.created':
      return say('agent', `agent: drafted ${ref} (rev ${str(d.revision)}, ${str(d.generator)})${d.fallbackReason ? ` · fallback: ${d.fallbackReason}` : ''}`);
    case 'linkedin.completed':
      return say('agent', `agent: LinkedIn ${ref} → ${str(d.outcome)}${d.headline ? `: “${clip(d.headline, 80)}”` : ''}`);
    case 'task.claimed':
      return say('human', `${who} claimed ${ref}`);
    case 'task.handed_back':
      return say('human', `${who} handed ${ref} back to the agent${d.redraft ? ` with feedback → rev ${str(d.revision)}` : ''}`);
    case 'task.approved':
      return say('ok', `${who} approved ${ref}${d.edited ? ' (edited)' : ''}`);
    case 'task.skipped':
      return say('human', `${who} skipped ${ref}${d.reason ? ` · ${d.reason}` : ''}`);
    case 'job.rate_limited':
      return d.source === '429'
        ? say('warn', `agent: ${d.provider === 'apollo' ? 'Apollo' : str(d.provider)} 429 · ${kindRef(d.kind)} deferred ${str(d.retryAfterSeconds)}s`)
        : say('warn', `agent: ${kindRef(d.kind)} deferred ${d.runAfter ? `${secondsUntil(d.runAfter)}s` : ''} · ${str(d.reason)}`);
    case 'job.retry_scheduled':
      return say('warn', `agent: ${kindRef(d.kind)} failed (attempt ${str(d.attempt)}/${str(d.maxAttempts)}) · retry in ${Math.round(Number(d.delayMs) / 1000)}s · ${clip(d.error, 90)}`);
    case 'job.dead':
      return say('error', `agent: ${kindRef(d.kind)} gave up${d.permanent ? ' (permanent error)' : ` after ${str(d.attempt)} attempts`} · ${clip(d.error, 90)}`);
    case 'job.reclaimed':
      return say('warn', `agent: resumed ${kindRef(d.kind)} from a stopped worker`);
    case 'job.cancelled':
      return say('agent', `agent: ${kindRef(d.kind)} cancelled · ${str(d.reason)}`);
    case 'job.retried_by_human':
      return say('human', `${who} retried ${kindRef(d.kind)}`);
    case 'action.rejected':
      return say('error', `action rejected: ${str(d.actor) || who} ${ACTION_VERB[d.action] ?? str(d.action)}${ref ? ` ${ref}` : ''} · ${str(d.message)}`);
    default:
      return say('agent', `${event.type}${ref ? ` ${ref}` : ''}`);
  }
}
