const state = {
  accountId: null,
  activeContact: null,
  activeGroup: null,
  mobileMode: false,
  pollingHandle: null,
  settings: null,
  contactNames: new Map(),
  chatLastId: new Map(),
};

const el = {
  shell: document.getElementById('shell'),
  accountSelect: document.getElementById('accountSelect'),
  chatList: document.getElementById('chatList'),
  groupList: document.getElementById('groupList'),
  messages: document.getElementById('messages'),
  messageInput: document.getElementById('messageInput'),
  contactInfo: document.getElementById('contactInfo'),
  modeSwitchBtn: document.getElementById('modeSwitchBtn'),
  mobileBackBtn: document.getElementById('mobileBackBtn'),
  quickContactInput: document.getElementById('quickContactInput'),
  quickContactNameInput: document.getElementById('quickContactNameInput'),
  groupNameInput: document.getElementById('groupNameInput'),
  settingsDialog: document.getElementById('settingsDialog'),
};

async function api(path, options = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Unbekannter Fehler');
  return data;
}

const asBool = (v) => ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
const fmt = (d) => new Date(d).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });

function sanitizeHtml(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html || '', 'text/html');
  doc.querySelectorAll('script, iframe, object, embed, style').forEach((n) => n.remove());
  doc.querySelectorAll('*').forEach((node) => {
    [...node.attributes].forEach((a) => {
      if (a.name.startsWith('on')) node.removeAttribute(a.name);
      if (['src', 'href'].includes(a.name) && a.value.toLowerCase().startsWith('javascript:')) node.removeAttribute(a.name);
    });
  });
  return doc.body.innerHTML;
}

function displayName(email) {
  return state.contactNames.get(email) || email;
}

async function loadSettings() {
  state.settings = await api('/api/settings');
  const form = document.getElementById('settingsForm');
  form.poll_interval_ms.value = state.settings.poll_interval_ms || 2000;
  form.auto_sync_enabled.checked = asBool(state.settings.auto_sync_enabled);
  form.filter_noreply.checked = asBool(state.settings.filter_noreply);
  form.filter_info_addresses.checked = asBool(state.settings.filter_info_addresses);
  form.filter_promotions.checked = asBool(state.settings.filter_promotions);
  form.strip_replies.checked = asBool(state.settings.strip_replies);
  restartPolling();
}

async function loadAccounts() {
  const accounts = await api('/api/accounts');
  el.accountSelect.innerHTML = '';
  if (!accounts.length) {
    el.accountSelect.innerHTML = '<option>Kein Konto vorhanden</option>';
    state.accountId = null;
    el.messages.innerHTML = '<p class="empty">Bitte zuerst ein E-Mail-Konto hinzufügen.</p>';
    return;
  }
  accounts.forEach((a) => {
    const o = document.createElement('option');
    o.value = a.id;
    o.textContent = `${a.name} (${a.email})`;
    el.accountSelect.append(o);
  });
  if (!state.accountId) state.accountId = Number(accounts[0].id);
  el.accountSelect.value = String(state.accountId);
  await Promise.all([loadContacts(), loadChats(), loadGroups()]);
}

async function loadContacts() {
  if (!state.accountId) return;
  state.contactNames.clear();
  const rows = await api(`/api/contacts?account_id=${state.accountId}`);
  rows.forEach((r) => state.contactNames.set(r.email, r.display_name || r.email));
}

async function loadChats() {
  if (!state.accountId) return;
  const chats = await api(`/api/chats?account_id=${state.accountId}`);
  el.chatList.innerHTML = '';
  chats.forEach((chat) => {
    const li = document.createElement('li');
    const active = state.activeContact === chat.contact_email && !state.activeGroup;
    li.className = active ? 'active' : '';
    li.innerHTML = `<strong>${chat.display_name}</strong><div class="preview">${(chat.last_body || '').slice(0, 80)}</div>`;
    li.onclick = () => openContactChat(chat.contact_email);
    el.chatList.append(li);
  });
}

async function loadGroups() {
  if (!state.accountId) return;
  const groups = await api(`/api/groups?account_id=${state.accountId}`);
  el.groupList.innerHTML = '';
  groups.forEach((g) => {
    const li = document.createElement('li');
    const active = state.activeGroup === g.id;
    li.className = active ? 'active' : '';
    li.innerHTML = `<strong>👥 ${g.name}</strong><div class="preview">${g.members} Mitglieder</div>`;
    li.onclick = () => openGroupChat(g.id, g.name, g.members);
    el.groupList.append(li);
  });
}

function openContactChat(email) {
  state.activeGroup = null;
  state.activeContact = email;
  el.contactInfo.textContent = `${displayName(email)} • ${email}`;
  if (state.mobileMode) el.shell.classList.add('chat-open');
  loadMessages();
  loadChats();
}

function openGroupChat(groupId, name, members) {
  state.activeContact = null;
  state.activeGroup = groupId;
  el.contactInfo.textContent = `👥 ${name} • ${members} Mitglieder`;
  if (state.mobileMode) el.shell.classList.add('chat-open');
  loadGroupMessages();
  loadGroups();
}

function renderBubbles(rows) {
  el.messages.innerHTML = '';
  rows.forEach((msg) => {
    const bubble = document.createElement('article');
    bubble.className = `bubble ${msg.direction}`;
    const content = document.createElement('div');
    content.className = 'content';
    if (msg.body_html) content.innerHTML = sanitizeHtml(msg.body_html);
    else content.textContent = msg.body;
    const meta = document.createElement('time');
    meta.className = 'meta';
    meta.textContent = fmt(msg.sent_at);
    bubble.append(content, meta);
    el.messages.append(bubble);
  });
  el.messages.scrollTop = el.messages.scrollHeight;
}

async function loadMessages() {
  if (!state.accountId || !state.activeContact) {
    el.messages.innerHTML = '<p class="empty">Wähle links einen Kontakt oder eine Gruppe.</p>';
    return;
  }
  const rows = await api(`/api/messages?account_id=${state.accountId}&contact=${encodeURIComponent(state.activeContact)}`);
  renderBubbles(rows);
  const last = rows.at(-1)?.id || 0;
  const key = `contact:${state.activeContact}`;
  const prev = state.chatLastId.get(key) || 0;
  if (last > prev && prev > 0) {
    const newInbound = rows.filter((r) => r.id > prev && r.direction === 'inbound');
    newInbound.forEach((r) => notify(`${displayName(state.activeContact)}`, r.body));
  }
  state.chatLastId.set(key, last);
}

async function loadGroupMessages() {
  if (!state.accountId || !state.activeGroup) return;
  const rows = await api(`/api/group_messages?account_id=${state.accountId}&group_id=${state.activeGroup}`);
  renderBubbles(rows);
}

async function addContactAndOpen() {
  if (!state.accountId) return alert('Bitte erst ein Konto hinzufügen.');
  const email = el.quickContactInput.value.trim().toLowerCase();
  const name = el.quickContactNameInput.value.trim();
  if (!email) return;
  await api('/api/contacts', { method: 'POST', body: JSON.stringify({ account_id: state.accountId, email, display_name: name }) });
  el.quickContactInput.value = '';
  el.quickContactNameInput.value = '';
  await loadContacts();
  openContactChat(email);
}

async function createGroup() {
  if (!state.accountId) return;
  const name = el.groupNameInput.value.trim();
  if (!name) return;
  const membersCsv = prompt('Mitglieder E-Mails (mit Komma getrennt):', '');
  const members = (membersCsv || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const created = await api('/api/groups', { method: 'POST', body: JSON.stringify({ account_id: state.accountId, name, members }) });
  el.groupNameInput.value = '';
  await loadGroups();
  openGroupChat(created.id, name, members.length);
}

async function sendCurrentMessage(e) {
  e.preventDefault();
  if (!state.accountId) return alert('Bitte zuerst ein Konto hinzufügen.');
  const body = el.messageInput.value.trim();
  if (!body) return;
  const isHtml = document.getElementById('htmlMode').checked;

  if (state.activeGroup) {
    await api('/api/send_group', { method: 'POST', body: JSON.stringify({ account_id: state.accountId, group_id: state.activeGroup, body, is_html: isHtml }) });
    await loadGroupMessages();
  } else if (state.activeContact) {
    await api('/api/send', { method: 'POST', body: JSON.stringify({ account_id: state.accountId, to_email: state.activeContact, body, is_html: isHtml }) });
    await loadMessages();
    await loadChats();
  } else {
    return alert('Bitte zuerst einen Kontakt oder eine Gruppe auswählen.');
  }
  el.messageInput.value = '';
}

async function pollRealtime() {
  if (!state.accountId) return;
  if (asBool(state.settings?.auto_sync_enabled)) {
    await api('/api/sync', { method: 'POST', body: JSON.stringify({ account_id: state.accountId }) });
  }
  await loadContacts();
  await loadChats();
  await loadGroups();
  if (state.activeGroup) await loadGroupMessages();
  else if (state.activeContact) await loadMessages();
}

function restartPolling() {
  if (state.pollingHandle) clearInterval(state.pollingHandle);
  const ms = Math.max(500, Number(state.settings?.poll_interval_ms || 2000));
  state.pollingHandle = setInterval(() => pollRealtime().catch(() => {}), ms);
}

function setModeLabel() {
  el.modeSwitchBtn.textContent = state.mobileMode ? '🖥️ Desktop' : '📱 Mobile';
}

async function ensureNotificationPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') await Notification.requestPermission();
}

function notify(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  new Notification(`Neue Nachricht von ${title}`, { body: (body || '').slice(0, 140) });
}

function bindUi() {
  document.getElementById('newAccountBtn').onclick = () => document.getElementById('accountDialog').showModal();
  document.getElementById('closeDialogBtn').onclick = () => document.getElementById('accountDialog').close();
  document.getElementById('settingsBtn').onclick = () => el.settingsDialog.showModal();
  document.getElementById('closeSettingsBtn').onclick = () => el.settingsDialog.close();

  el.modeSwitchBtn.onclick = () => {
    state.mobileMode = !state.mobileMode;
    setModeLabel();
    el.shell.classList.toggle('mobile-mode', state.mobileMode);
    if (!state.mobileMode) el.shell.classList.remove('chat-open');
  };

  el.mobileBackBtn.onclick = () => {
    el.shell.classList.remove('chat-open');
    state.activeContact = null;
    state.activeGroup = null;
    el.contactInfo.textContent = 'Kein Chat ausgewählt';
    el.messages.innerHTML = '<p class="empty">Wähle links einen Kontakt oder eine Gruppe.</p>';
    loadChats();
    loadGroups();
  };

  el.accountSelect.onchange = async (e) => {
    state.accountId = Number(e.target.value);
    state.activeContact = null;
    state.activeGroup = null;
    state.chatLastId.clear();
    await Promise.all([loadContacts(), loadChats(), loadGroups()]);
    el.messages.innerHTML = '<p class="empty">Wähle links einen Kontakt oder eine Gruppe.</p>';
  };

  document.getElementById('syncBtn').onclick = () => pollRealtime();
  document.getElementById('quickAddContactBtn').onclick = addContactAndOpen;
  document.getElementById('createGroupBtn').onclick = createGroup;
  document.getElementById('sendForm').addEventListener('submit', sendCurrentMessage);

  document.getElementById('accountForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    await api('/api/accounts', {
      method: 'POST',
      body: JSON.stringify({
        name: form.get('name'), email: form.get('email'), imap_host: form.get('imap_host'), imap_port: form.get('imap_port'),
        smtp_host: form.get('smtp_host'), smtp_port: form.get('smtp_port'), smtp_security: form.get('smtp_security'),
        password: form.get('password'), use_ssl: form.get('use_ssl') === 'on',
      }),
    });
    e.target.reset();
    document.getElementById('accountDialog').close();
    await loadAccounts();
  });

  document.getElementById('settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({
        poll_interval_ms: Number(f.get('poll_interval_ms') || 2000),
        auto_sync_enabled: f.get('auto_sync_enabled') === 'on' ? '1' : '0',
        filter_noreply: f.get('filter_noreply') === 'on' ? '1' : '0',
        filter_info_addresses: f.get('filter_info_addresses') === 'on' ? '1' : '0',
        filter_promotions: f.get('filter_promotions') === 'on' ? '1' : '0',
        strip_replies: f.get('strip_replies') === 'on' ? '1' : '0',
      }),
    });
    el.settingsDialog.close();
    await loadSettings();
  });

  window.addEventListener('focus', () => pollRealtime().catch(() => {}));
}

Promise.all([ensureNotificationPermission(), loadSettings()])
  .then(() => loadAccounts())
  .then(() => bindUi())
  .catch((err) => {
    el.messages.innerHTML = `<p class="empty">Fehler: ${err.message}</p>`;
  });
