const state = {
  accountId: null,
  activeContact: null,
  activeGroup: null,
  mobileMode: false,
  pollingHandle: null,
  settings: null,
  contactNames: new Map(),
  chatLastId: new Map(),
  isSending: false,
  isPolling: false,
  openChatToken: 0,
  replyToMessageId: null,
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
  sendButton: document.querySelector('#sendForm button[type="submit"]'),
  attachmentInput: document.getElementById('attachmentInput'),
  attachmentBtn: document.getElementById('attachmentBtn'),
  emojiBtn: document.getElementById('emojiBtn'),
  chatContextMenu: document.getElementById('chatContextMenu'),
  ctxDeleteBtn: document.getElementById('ctxDeleteBtn'),
  emojiPickerWrap: document.getElementById('emojiPickerWrap'),
  emojiPicker: document.getElementById('emojiPicker'),
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

function setModeLabel() {
  el.modeSwitchBtn.textContent = state.mobileMode ? '🖥️ Desktop' : '📱 Mobile';
}

function appendBubble(msg) {
  const bubble = document.createElement('article');
  bubble.className = `bubble ${msg.direction}`;
  bubble.dataset.messageId = String(msg.id || '');
  const content = document.createElement('div');
  content.className = 'content';
  if (msg.body_html) content.innerHTML = sanitizeHtml(msg.body_html);
  else content.textContent = msg.body;
  if (Array.isArray(msg.attachments) && msg.attachments.length) {
    const att = document.createElement('div');
    att.className = 'attachments';
    att.innerHTML = msg.attachments.map((a) => `📎 ${a.name} (${Math.max(1, Math.round((a.size || 0) / 1024))} KB)`).join('<br>');
    content.append(att);
  }
  const meta = document.createElement('time');
  meta.className = 'meta';
  const status = msg.direction === 'outbound'
    ? (msg.delivery_status === 'read' ? '✓✓ gelesen' : '✓ gesendet')
    : (msg.is_read ? 'gelesen' : 'ungelesen');
  meta.textContent = `${fmt(msg.sent_at)} • ${status}`;
  const actions = document.createElement('div');
  actions.className = 'bubble-actions';
  const replyBtn = document.createElement('button');
  replyBtn.type = 'button';
  replyBtn.className = 'ghost';
  replyBtn.textContent = '↩ Antworten';
  replyBtn.onclick = () => {
    state.replyToMessageId = msg.external_message_id || null;
    el.messageInput.focus();
  };
  actions.append(replyBtn);
  if (msg.direction === 'inbound' && !asBool(state.settings?.mark_read_on_open) && !msg.is_read) {
    const readBtn = document.createElement('button');
    readBtn.type = 'button';
    readBtn.className = 'ghost';
    readBtn.textContent = 'Als gelesen';
    readBtn.onclick = async () => {
      await api('/api/messages/read', { method: 'POST', body: JSON.stringify({ account_id: state.accountId, id: msg.id }) });
      await refreshSidebars();
      await openContactChat(state.activeContact);
    };
    actions.append(readBtn);
  }
  bubble.append(content, meta, actions);
  const kind = msg.__kind || 'message';
  addDeleteMenuHandlers(bubble, kind, msg.id);
  el.messages.append(bubble);
}

function renderBubbles(rows) {
  el.messages.innerHTML = '';
  rows.forEach(appendBubble);
  el.messages.scrollTop = el.messages.scrollHeight;
}

function hideContextMenu() {
  el.chatContextMenu.hidden = true;
  el.chatContextMenu.dataset.kind = '';
  el.chatContextMenu.dataset.id = '';
}

function openContextMenu(kind, id, x, y) {
  el.chatContextMenu.dataset.kind = kind;
  el.chatContextMenu.dataset.id = String(id || '');
  el.chatContextMenu.style.left = `${x}px`;
  el.chatContextMenu.style.top = `${y}px`;
  el.chatContextMenu.hidden = false;
}

function addDeleteMenuHandlers(node, kind, id) {
  let longPressTimer = null;
  node.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openContextMenu(kind, id, e.clientX, e.clientY);
  });
  node.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    longPressTimer = setTimeout(() => openContextMenu(kind, id, e.clientX, e.clientY), 550);
  });
  const cancel = () => {
    if (longPressTimer) clearTimeout(longPressTimer);
    longPressTimer = null;
  };
  node.addEventListener('pointerup', cancel);
  node.addEventListener('pointercancel', cancel);
  node.addEventListener('pointerleave', cancel);
}

async function initEmojiPicker() {
  try {
    await import('https://cdn.jsdelivr.net/npm/emoji-picker-element@^1/index.js');
    el.emojiPicker.addEventListener('emoji-click', (ev) => {
      const emoji = ev?.detail?.unicode;
      if (!emoji) return;
      el.messageInput.value += `${emoji}`;
      el.messageInput.focus();
      el.emojiPickerWrap.hidden = true;
    });
  } catch {
    // fallback handled in button click
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Datei konnte nicht gelesen werden'));
    reader.onload = () => {
      const result = String(reader.result || '');
      const b64 = result.includes(',') ? result.split(',')[1] : '';
      resolve(b64);
    };
    reader.readAsDataURL(file);
  });
}

async function loadSettings() {
  state.settings = await api('/api/settings');
  const f = document.getElementById('settingsForm');
  f.poll_interval_ms.value = state.settings.poll_interval_ms || 1000;
  f.auto_sync_enabled.checked = asBool(state.settings.auto_sync_enabled);
  f.filter_noreply.checked = asBool(state.settings.filter_noreply);
  f.filter_info_addresses.checked = asBool(state.settings.filter_info_addresses);
  f.filter_promotions.checked = asBool(state.settings.filter_promotions);
  f.strip_replies.checked = asBool(state.settings.strip_replies);
  f.mark_read_on_open.checked = asBool(state.settings.mark_read_on_open);
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
  await refreshSidebars();
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
    li.className = state.activeContact === chat.contact_email && !state.activeGroup ? 'active' : '';
    const badge = Number(chat.unread_count || 0) > 0 ? `<span class="badge">${chat.unread_count}</span>` : '';
    li.classList.toggle('has-unread', Number(chat.unread_count || 0) > 0);
    li.innerHTML = `<div class="row"><strong>${chat.display_name}</strong>${badge}</div><div class="preview">${(chat.last_body || '').slice(0, 80)}</div>`;
    li.onclick = async () => { await openContactChat(chat.contact_email); };
    addDeleteMenuHandlers(li, 'contact', chat.contact_email);
    el.chatList.append(li);
  });
}

async function loadGroups() {
  if (!state.accountId) return;
  const groups = await api(`/api/groups?account_id=${state.accountId}`);
  el.groupList.innerHTML = '';
  groups.forEach((g) => {
    const li = document.createElement('li');
    li.className = state.activeGroup === g.id ? 'active' : '';
    li.innerHTML = `<strong>👥 ${g.name}</strong><div class="preview">${g.members} Mitglieder</div>`;
    li.onclick = async () => { await openGroupChat(g.id, g.name, g.members); };
    addDeleteMenuHandlers(li, 'group', g.id);
    el.groupList.append(li);
  });
}

async function refreshSidebars() {
  await loadContacts();
  await loadChats();
  await loadGroups();
}

async function openContactChat(email) {
  if (!email) return;
  const token = ++state.openChatToken;
  state.activeGroup = null;
  state.activeContact = email;
  el.contactInfo.textContent = `${displayName(email)} • ${email}`;
  if (state.mobileMode) el.shell.classList.add('chat-open');

  const markRead = asBool(state.settings?.mark_read_on_open) ? 1 : 0;
  const rows = await api(`/api/messages?account_id=${state.accountId}&contact=${encodeURIComponent(state.activeContact)}&since_id=0&mark_read=${markRead}`);
  rows.forEach((r) => { r.__kind = 'message'; });
  if (token !== state.openChatToken || state.activeContact !== email) return;
  renderBubbles(rows);
  state.chatLastId.set(`contact:${state.activeContact}`, rows.at(-1)?.id || 0);
  await loadChats();
}

async function openGroupChat(groupId, name, members) {
  const token = ++state.openChatToken;
  state.activeContact = null;
  state.activeGroup = groupId;
  el.contactInfo.textContent = `👥 ${name} • ${members} Mitglieder`;
  if (state.mobileMode) el.shell.classList.add('chat-open');

  const rows = await api(`/api/group_messages?account_id=${state.accountId}&group_id=${state.activeGroup}&since_id=0`);
  rows.forEach((r) => { r.__kind = 'group_message'; });
  if (token !== state.openChatToken || state.activeGroup !== groupId) return;
  renderBubbles(rows);
  state.chatLastId.set(`group:${state.activeGroup}`, rows.at(-1)?.id || 0);
  await loadGroups();
}

async function addContactAndOpen() {
  if (!state.accountId) return alert('Bitte erst ein Konto hinzufügen.');
  const email = el.quickContactInput.value.trim().toLowerCase();
  const name = el.quickContactNameInput.value.trim();
  if (!email) return;
  await api('/api/contacts', { method: 'POST', body: JSON.stringify({ account_id: state.accountId, email, display_name: name }) });
  el.quickContactInput.value = '';
  el.quickContactNameInput.value = '';
  await refreshSidebars();
  await openContactChat(email);
}

async function createGroup() {
  if (!state.accountId) return;
  const name = el.groupNameInput.value.trim();
  if (!name) return;
  const membersCsv = prompt('Mitglieder E-Mails (mit Komma getrennt):', '');
  const members = (membersCsv || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const created = await api('/api/groups', { method: 'POST', body: JSON.stringify({ account_id: state.accountId, name, members }) });
  el.groupNameInput.value = '';
  await refreshSidebars();
  await openGroupChat(created.id, name, members.length);
}

async function sendCurrentMessage(e) {
  e.preventDefault();
  if (state.isSending) return;
  if (!state.accountId) return alert('Bitte zuerst ein Konto hinzufügen.');
  const body = el.messageInput.value.trim();
  if (!body) return;
  const isHtml = document.getElementById('htmlMode').checked;
  const files = await Promise.all(Array.from(el.attachmentInput.files || []).map(async (file) => ({
    name: file.name,
    content_type: file.type || 'application/octet-stream',
    data: await fileToBase64(file),
  })));
  state.isSending = true;
  el.sendButton.disabled = true;

  try {
    if (state.activeGroup) {
      const resp = await api('/api/send_group', { method: 'POST', body: JSON.stringify({ account_id: state.accountId, group_id: state.activeGroup, body, is_html: isHtml, attachments: files, reply_to_message_id: state.replyToMessageId }) });
      if (resp.message) {
        appendBubble(resp.message);
        state.chatLastId.set(`group:${state.activeGroup}`, resp.message.id);
        el.messages.scrollTop = el.messages.scrollHeight;
      }
    } else if (state.activeContact) {
      const resp = await api('/api/send', { method: 'POST', body: JSON.stringify({ account_id: state.accountId, to_email: state.activeContact, body, is_html: isHtml, attachments: files, reply_to_message_id: state.replyToMessageId }) });
      if (resp.message) {
        appendBubble(resp.message);
        state.chatLastId.set(`contact:${state.activeContact}`, resp.message.id);
        el.messages.scrollTop = el.messages.scrollHeight;
      }
      await loadChats();
    } else {
      return alert('Bitte zuerst einen Kontakt oder eine Gruppe auswählen.');
    }
    el.messageInput.value = '';
    el.attachmentInput.value = '';
    el.attachmentBtn.textContent = '📎';
    state.replyToMessageId = null;
  } finally {
    state.isSending = false;
    el.sendButton.disabled = false;
  }
}

async function updateActiveChatIncremental() {
  if (!state.accountId) return;

  if (state.activeContact) {
    const key = `contact:${state.activeContact}`;
    const since = state.chatLastId.get(key) || 0;
    const rows = await api(`/api/messages?account_id=${state.accountId}&contact=${encodeURIComponent(state.activeContact)}&since_id=${since}`);
    rows.forEach((r) => { r.__kind = 'message'; });
    if (rows.length) {
      rows.forEach(appendBubble);
      state.chatLastId.set(key, rows.at(-1).id);
      el.messages.scrollTop = el.messages.scrollHeight;
      rows.filter((r) => r.direction === 'inbound').forEach((r) => notify(displayName(state.activeContact), r.body));
      await loadChats();
    }
  } else if (state.activeGroup) {
    const key = `group:${state.activeGroup}`;
    const since = state.chatLastId.get(key) || 0;
    const rows = await api(`/api/group_messages?account_id=${state.accountId}&group_id=${state.activeGroup}&since_id=${since}`);
    rows.forEach((r) => { r.__kind = 'group_message'; });
    if (rows.length) {
      rows.forEach(appendBubble);
      state.chatLastId.set(key, rows.at(-1).id);
      el.messages.scrollTop = el.messages.scrollHeight;
    }
  }
}

async function pollRealtime() {
  if (state.isPolling) return;
  if (!state.accountId) return;
  state.isPolling = true;
  try {
    if (asBool(state.settings?.auto_sync_enabled)) {
      await api('/api/sync', { method: 'POST', body: JSON.stringify({ account_id: state.accountId }) });
      await refreshSidebars();
    }
    await updateActiveChatIncremental();
  } finally {
    state.isPolling = false;
  }
}

function restartPolling() {
  if (state.pollingHandle) clearInterval(state.pollingHandle);
  const ms = Math.max(500, Number(state.settings?.poll_interval_ms || 1000));
  state.pollingHandle = setInterval(() => pollRealtime().catch(() => {}), ms);
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
    await refreshSidebars();
    el.messages.innerHTML = '<p class="empty">Wähle links einen Kontakt oder eine Gruppe.</p>';
  };

  document.getElementById('syncBtn').onclick = async () => {
    if (!state.accountId) return;
    await api('/api/sync', { method: 'POST', body: JSON.stringify({ account_id: state.accountId }) });
    await refreshSidebars();
    await updateActiveChatIncremental();
  };

  document.getElementById('quickAddContactBtn').onclick = addContactAndOpen;
  document.getElementById('createGroupBtn').onclick = createGroup;
  document.getElementById('deleteContactBtn').onclick = async () => {
    if (!state.accountId || !state.activeContact) return;
    await api(`/api/contacts?account_id=${state.accountId}&email=${encodeURIComponent(state.activeContact)}`, { method: 'DELETE' });
    state.activeContact = null;
    el.messages.innerHTML = '<p class="empty">Kontakt gelöscht.</p>';
    await refreshSidebars();
  };
  document.getElementById('deleteGroupBtn').onclick = async () => {
    if (!state.accountId || !state.activeGroup) return;
    await api(`/api/groups?account_id=${state.accountId}&id=${state.activeGroup}`, { method: 'DELETE' });
    state.activeGroup = null;
    el.messages.innerHTML = '<p class="empty">Gruppe gelöscht.</p>';
    await refreshSidebars();
  };
  el.emojiBtn.onclick = () => {
    el.messageInput.focus();
    if (customElements.get('emoji-picker')) {
      el.emojiPickerWrap.hidden = !el.emojiPickerWrap.hidden;
      return;
    }
    const ua = navigator.userAgent || '';
    const hint = /Mac/.test(ua) ? '⌃⌘ Leertaste' : (/Windows/.test(ua) ? 'Win + .' : 'System-Emoji-Shortcut');
    alert(`Emoji-Picker konnte nicht geladen werden. Nutze das System-Emoji-Feld mit: ${hint}`);
  };
  el.attachmentBtn.onclick = () => el.attachmentInput.click();
  el.attachmentInput.onchange = () => {
    const count = (el.attachmentInput.files || []).length;
    el.attachmentBtn.textContent = count ? `📎 ${count}` : '📎';
  };

  el.ctxDeleteBtn.onclick = async () => {
    const kind = el.chatContextMenu.dataset.kind;
    const id = el.chatContextMenu.dataset.id;
    hideContextMenu();
    if (kind === 'contact' && id && state.accountId) {
      await api(`/api/contacts?account_id=${state.accountId}&email=${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (state.activeContact === id) {
        state.activeContact = null;
        el.messages.innerHTML = '<p class="empty">Chat gelöscht.</p>';
      }
      await refreshSidebars();
    }
    if (kind === 'group' && id && state.accountId) {
      await api(`/api/groups?account_id=${state.accountId}&id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (String(state.activeGroup) === String(id)) {
        state.activeGroup = null;
        el.messages.innerHTML = '<p class="empty">Gruppe gelöscht.</p>';
      }
      await refreshSidebars();
    }
    if (kind === 'message' && id && state.accountId) {
      await api(`/api/messages?account_id=${state.accountId}&id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (state.activeContact) await openContactChat(state.activeContact);
    }
    if (kind === 'group_message' && id && state.accountId) {
      await api(`/api/group_messages?account_id=${state.accountId}&id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (state.activeGroup) {
        const rows = await api(`/api/group_messages?account_id=${state.accountId}&group_id=${state.activeGroup}&since_id=0`);
        rows.forEach((r) => { r.__kind = 'group_message'; });
        renderBubbles(rows);
      }
    }
  };

  window.addEventListener('pointerdown', (e) => {
    if (!el.chatContextMenu.hidden && !el.chatContextMenu.contains(e.target)) hideContextMenu();
    if (!el.emojiPickerWrap.hidden && !el.emojiPickerWrap.contains(e.target) && e.target !== el.emojiBtn) {
      el.emojiPickerWrap.hidden = true;
    }
  });
  window.addEventListener('scroll', hideContextMenu, true);
  window.addEventListener('resize', hideContextMenu);

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
        poll_interval_ms: Number(f.get('poll_interval_ms') || 1000),
        auto_sync_enabled: f.get('auto_sync_enabled') === 'on' ? '1' : '0',
        filter_noreply: f.get('filter_noreply') === 'on' ? '1' : '0',
        filter_info_addresses: f.get('filter_info_addresses') === 'on' ? '1' : '0',
        filter_promotions: f.get('filter_promotions') === 'on' ? '1' : '0',
        strip_replies: f.get('strip_replies') === 'on' ? '1' : '0',
        mark_read_on_open: f.get('mark_read_on_open') === 'on' ? '1' : '0',
      }),
    });
    el.settingsDialog.close();
    await loadSettings();
  });

  window.addEventListener('focus', () => pollRealtime().catch(() => {}));
}

Promise.all([ensureNotificationPermission(), loadSettings()])
  .then(() => loadAccounts())
  .then(() => {
    initEmojiPicker();
    bindUi();
    setModeLabel();
  })
  .catch((err) => {
    el.messages.innerHTML = `<p class="empty">Fehler: ${err.message}</p>`;
  });
