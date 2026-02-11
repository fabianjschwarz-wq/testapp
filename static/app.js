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
  errors: [],
  activeAvatar: '',
  accounts: [],
  addressBook: new Map(),
  syncTick: 0,
  eventSource: null,
};

const el = {
  shell: document.getElementById('shell'),
  accountSelect: document.getElementById('accountSelect'),
  accountSyncDot: document.getElementById('accountSyncDot'),
  editAccountBtn: document.getElementById('editAccountBtn'),
  chatList: document.getElementById('chatList'),
  groupList: document.getElementById('groupList'),
  messages: document.getElementById('messages'),
  messageInput: document.getElementById('messageInput'),
  contactInfo: document.getElementById('contactInfo'),
  addToBookBtn: document.getElementById('addToBookBtn'),
  settingsTopBtn: document.getElementById('settingsTopBtn'),
  replyBanner: document.getElementById('replyBanner'),
  replyBannerText: document.getElementById('replyBannerText'),
  clearReplyBtn: document.getElementById('clearReplyBtn'),
  modeSwitchBtn: document.getElementById('modeSwitchBtn'),
  newEntityBtn: document.getElementById('newEntityBtn'),
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
  ctxEditBtn: document.getElementById('ctxEditBtn'),
  ctxDeleteBtn: document.getElementById('ctxDeleteBtn'),
  emojiPickerWrap: document.getElementById('emojiPickerWrap'),
  emojiPicker: document.getElementById('emojiPicker'),
  splitter: document.getElementById('splitter'),
  profileDialog: document.getElementById('profileDialog'),
  newEntityDialog: document.getElementById('newEntityDialog'),
  errorDialog: document.getElementById('errorDialog'),
  errorLogOutput: document.getElementById('errorLogOutput'),
};

function setSyncState(stateName) {
  el.accountSyncDot.classList.remove('sync-red', 'sync-yellow', 'sync-green');
  el.accountSyncDot.classList.add(stateName === 'syncing' ? 'sync-yellow' : stateName === 'ok' ? 'sync-green' : 'sync-red');
}

function fileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file) return resolve('');
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Datei konnte nicht gelesen werden'));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsDataURL(file);
  });
}

function pushError(err) {
  const msg = `[${new Date().toLocaleTimeString('de-DE')}] ${err?.message || String(err)}`;
  state.errors.unshift(msg);
  state.errors = state.errors.slice(0, 200);
  document.getElementById('errorBtn').title = `Fehler (${state.errors.length})`;
  el.errorLogOutput.textContent = state.errors.join('\n') || 'Keine Fehler';
}

function updateReplyBanner() {
  if (!state.replyToMessageId) {
    el.replyBanner.hidden = true;
    el.replyBannerText.textContent = '';
    return;
  }
  el.replyBanner.hidden = false;
  el.replyBannerText.textContent = `Antwort auf Nachricht ${state.replyToMessageId.slice(0, 22)}…`;
}

function autoGrowMessageInput() {
  el.messageInput.style.height = 'auto';
  el.messageInput.style.height = `${Math.min(160, Math.max(38, el.messageInput.scrollHeight))}px`;
}

async function api(path, options = {}) {
  try {
    const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
    const raw = await res.text();
    const data = raw ? JSON.parse(raw) : {};
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  } catch (err) {
    pushError(err);
    throw err;
  }
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
    msg.attachments.forEach((a) => {
      const line = document.createElement('div');
      const link = document.createElement('a');
      link.textContent = `📎 ${a.name} (${Math.max(1, Math.round((a.size || 0) / 1024))} KB)`;
      link.href = a.preview_url || '#';
      link.target = '_blank';
      link.rel = 'noopener';
      link.download = a.name || 'download';
      line.append(link);
      att.append(line);
    });
    content.append(att);
    msg.attachments.forEach((a) => {
      const ct = String(a.content_type || '').toLowerCase();
      const data = a.data || a.preview_url || '';
      if (!data) return;
      if (ct.startsWith('image/')) {
        const wrap = document.createElement('div');
        wrap.className = 'media-preview';
        const img = document.createElement('img');
        img.src = data;
        img.alt = a.name || 'Bild';
        wrap.append(img);
        content.append(wrap);
      } else if (ct === 'application/pdf') {
        const wrap = document.createElement('div');
        wrap.className = 'media-preview';
        const frame = document.createElement('iframe');
        frame.src = data;
        wrap.append(frame);
        content.append(wrap);
      }
    });
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
    updateReplyBanner();
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
  const canEdit = ['contact', 'group', 'top_contact', 'top_group'].includes(kind);
  el.ctxEditBtn.hidden = !canEdit;
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

function openProfileEditor(kind, payload = {}) {
  const f = document.getElementById('profileForm');
  f.kind.value = kind;
  f.email.value = payload.email || '';
  f.group_id.value = payload.group_id || '';
  f.display_name.value = payload.display_name || payload.name || '';
  f.new_email.value = payload.email || '';
  f.avatar_url.value = payload.avatar_url || '';
  if (f.avatar_file) f.avatar_file.value = '';
  if (kind === 'group') {
    f.new_email.closest('label').style.display = 'none';
  } else {
    f.new_email.closest('label').style.display = '';
  }
  el.profileDialog.showModal();
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

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Datei konnte nicht gelesen werden'));
    reader.onload = () => resolve(String(reader.result || ''));
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
  f.os_contact_sync_enabled.checked = asBool(state.settings.os_contact_sync_enabled);
  f.send_custom_read_receipts.checked = asBool(state.settings.send_custom_read_receipts);
  f.enter_sends_message.checked = asBool(state.settings.enter_sends_message);
  restartPolling();
}

async function loadAccounts() {
  const accounts = await api('/api/accounts');
  state.accounts = accounts;
  el.accountSelect.innerHTML = '';
  if (!accounts.length) {
    el.accountSelect.innerHTML = '<option>Kein Konto vorhanden</option>';
    state.accountId = null;
    el.messages.innerHTML = '<p class="empty">Bitte zuerst ein E-Mail-Konto hinzufügen.</p>';
    setSyncState('idle');
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
  setSyncState('idle');
  await refreshSidebars();
  restartEventStream();
}

async function loadContacts() {
  if (!state.accountId) return;
  state.contactNames.clear();
  const rows = await api(`/api/contacts?account_id=${state.accountId}`);
  rows.forEach((r) => state.contactNames.set(r.email, r.display_name || r.email));
}

async function loadAddressBook() {
  if (!state.accountId) return;
  const rows = await api(`/api/address_book?account_id=${state.accountId}`);
  state.addressBook.clear();
  rows.forEach((r) => state.addressBook.set(r.email, r));
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
    li.dataset.displayName = chat.display_name || '';
    li.dataset.avatarUrl = chat.avatar_url || '';
    li.onclick = async () => { await openContactChat(chat.contact_email); };
    const row = li.querySelector('.row');
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'ghost mini-edit';
    editBtn.textContent = '✎';
    editBtn.title = 'Profil bearbeiten';
    editBtn.onclick = async (ev) => {
      ev.stopPropagation();
      const rows = await api(`/api/contacts?account_id=${state.accountId}`);
      const c = rows.find((r) => r.email === chat.contact_email) || { email: chat.contact_email, display_name: chat.display_name };
      openProfileEditor('contact', c);
    };
    row.append(editBtn);
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
    li.innerHTML = `<div class="row"><strong>👥 ${g.name}</strong></div><div class="preview">${g.members} Mitglieder</div>`;
    li.dataset.name = g.name || '';
    li.dataset.avatarUrl = g.avatar_url || '';
    li.onclick = async () => { await openGroupChat(g.id, g.name, g.members); };
    const row = li.querySelector('.row');
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'ghost mini-edit';
    editBtn.textContent = '✎';
    editBtn.title = 'Gruppe bearbeiten';
    editBtn.onclick = async (ev) => {
      ev.stopPropagation();
      openProfileEditor('group', { group_id: g.id, name: g.name, avatar_url: g.avatar_url || '' });
    };
    row.append(editBtn);
    addDeleteMenuHandlers(li, 'group', g.id);
    el.groupList.append(li);
  });
}

async function refreshSidebars() {
  await loadAddressBook();
  await loadContacts();
  await loadChats();
  await loadGroups();
}

function updateAddToBookVisibility() {
  if (!state.activeContact) {
    el.addToBookBtn.hidden = true;
    return;
  }
  el.addToBookBtn.hidden = state.addressBook.has(state.activeContact);
}

async function openContactChat(email) {
  if (!email) return;
  const token = ++state.openChatToken;
  state.activeGroup = null;
  state.activeContact = email;
  el.contactInfo.textContent = `${displayName(email)} • ${email}`;
  updateAddToBookVisibility();
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
  updateAddToBookVisibility();
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
  const isHtml = document.getElementById('htmlMode').checked;
  const files = await Promise.all(Array.from(el.attachmentInput.files || []).map(async (file) => {
    const [b64, dataUrl] = await Promise.all([fileToBase64(file), fileToDataUrl(file)]);
    return {
      name: file.name,
      content_type: file.type || 'application/octet-stream',
      data: b64,
      preview_url: dataUrl,
    };
  }));
  if (!body && !files.length) return;
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
    autoGrowMessageInput();
    el.attachmentInput.value = '';
    el.attachmentBtn.textContent = '📎';
    state.replyToMessageId = null;
    updateReplyBanner();
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
      state.syncTick += 1;
      const doSync = state.syncTick % 5 === 0 || !document.hidden;
      if (doSync) {
        setSyncState('syncing');
        await api('/api/sync', { method: 'POST', body: JSON.stringify({ account_id: state.accountId }) });
        await refreshSidebars();
        setSyncState('ok');
      }
    }
    await updateActiveChatIncremental();
  } finally {
    state.isPolling = false;
  }
}

function restartPolling() {
  if (state.pollingHandle) clearInterval(state.pollingHandle);
  const ms = Math.max(300, Number(state.settings?.poll_interval_ms || 1000));
  state.pollingHandle = setInterval(() => pollRealtime().catch(() => {}), ms);
  pollRealtime().catch(() => {});
  restartEventStream();
}

function restartEventStream() {
  if (state.eventSource) state.eventSource.close();
  if (!state.accountId) return;
  try {
    const es = new EventSource('/api/events');
    es.addEventListener('tick', () => {
      pollRealtime().catch(() => {});
    });
    es.onerror = () => {
      try { es.close(); } catch {}
      setTimeout(restartEventStream, 1200);
    };
    state.eventSource = es;
  } catch {
    // browser unsupported; fallback polling remains
  }
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
  document.getElementById('newAccountBtn').onclick = () => {
    const form = document.getElementById('accountForm');
    form.reset();
    form.account_id.value = '';
    document.getElementById('accountDialog').showModal();
  };
  document.getElementById('closeDialogBtn').onclick = () => document.getElementById('accountDialog').close();
  document.getElementById('settingsBtn').onclick = () => el.settingsDialog.showModal();
  el.settingsTopBtn.onclick = () => el.settingsDialog.showModal();
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
    updateAddToBookVisibility();
    loadChats();
    loadGroups();
  };

  el.clearReplyBtn.onclick = () => {
    state.replyToMessageId = null;
    updateReplyBanner();
  };

  el.addToBookBtn.onclick = async () => {
    if (!state.activeContact) return;
    await api('/api/address_book', {
      method: 'POST',
      body: JSON.stringify({ account_id: state.accountId, email: state.activeContact, display_name: displayName(state.activeContact), source: 'chat' }),
    });
    await loadAddressBook();
    updateAddToBookVisibility();
    if (asBool(state.settings?.os_contact_sync_enabled) && navigator.contacts?.select) {
      try {
        await navigator.contacts.select(['name', 'email'], { multiple: true });
      } catch {
        // user canceled or unsupported
      }
    }
  };

  el.accountSelect.onchange = async (e) => {
    state.accountId = Number(e.target.value);
    state.activeContact = null;
    state.activeGroup = null;
    state.chatLastId.clear();
    await refreshSidebars();
    restartEventStream();
    el.messages.innerHTML = '<p class="empty">Wähle links einen Kontakt oder eine Gruppe.</p>';
  };

  document.getElementById('syncBtn').onclick = async () => {
    if (!state.accountId) return;
    setSyncState('syncing');
    try {
      await api('/api/sync', { method: 'POST', body: JSON.stringify({ account_id: state.accountId }) });
      await refreshSidebars();
      await updateActiveChatIncremental();
      setSyncState('ok');
    } catch {
      setSyncState('idle');
      throw new Error('Synchronisierung fehlgeschlagen');
    }
  };

  el.newEntityBtn.onclick = () => {
    if (!state.accountId) return alert('Bitte zuerst ein Konto hinzufügen.');
    el.newEntityDialog.showModal();
  };
  document.getElementById('closeNewEntityBtn').onclick = () => el.newEntityDialog.close();
  const newTypeSel = document.querySelector('#newEntityForm [name="type"]');
  const emailLabel = document.getElementById('newEntityEmailLabel');
  const membersLabel = document.getElementById('newEntityMembersLabel');
  const membersList = document.getElementById('newEntityMembersList');
  const memberSearch = document.getElementById('newEntityMemberSearch');
  const addMemberEmailBtn = document.getElementById('addMemberEmailBtn');
  const upsertAddressBookEntry = (email, displayName = '') => {
    const normalized = String(email || '').trim().toLowerCase();
    if (!normalized || state.addressBook.has(normalized)) return;
    state.addressBook.set(normalized, { email: normalized, display_name: displayName || normalized });
  };
  const rebuildMembersList = () => {
    membersList.innerHTML = '';
    const filter = String(memberSearch?.value || '').trim().toLowerCase();
    [...state.addressBook.values()]
      .filter((c) => !filter || String(c.email).toLowerCase().includes(filter) || String(c.display_name || '').toLowerCase().includes(filter))
      .forEach((c) => {
        const row = document.createElement('label');
        row.innerHTML = `<input type="checkbox" value="${c.email}" /><span>${c.display_name || c.email}</span>`;
        membersList.append(row);
      });
  };
  const syncTypeUi = () => {
    const isGroup = newTypeSel.value === 'group';
    emailLabel.hidden = isGroup;
    membersLabel.hidden = !isGroup;
    if (isGroup) rebuildMembersList();
  };
  syncTypeUi();
  newTypeSel.onchange = syncTypeUi;
  memberSearch.oninput = () => rebuildMembersList();
  addMemberEmailBtn.onclick = async () => {
    if (newTypeSel.value !== 'group') return;
    const raw = String(memberSearch.value || '').trim().toLowerCase();
    if (!raw || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) return;
    upsertAddressBookEntry(raw);
    await api('/api/address_book', { method: 'POST', body: JSON.stringify({ account_id: state.accountId, email: raw, display_name: raw, source: 'manual' }) });
    rebuildMembersList();
    const cb = membersList.querySelector(`input[value="${CSS.escape(raw)}"]`);
    if (cb) cb.checked = true;
    memberSearch.value = '';
  };
  document.getElementById('newEntityForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const type = String(f.get('type'));
    if (type === 'contact') {
      const email = String(f.get('email') || '').trim().toLowerCase();
      const name = String(f.get('name') || '').trim();
      if (!email) return;
      await api('/api/contacts', { method: 'POST', body: JSON.stringify({ account_id: state.accountId, email, display_name: name }) });
      el.newEntityDialog.close();
      await refreshSidebars();
      await openContactChat(email);
      return;
    }
    const name = String(f.get('name') || '').trim();
    const members = [...membersList.querySelectorAll('input[type="checkbox"]:checked')].map((n) => n.value.toLowerCase());
    const created = await api('/api/groups', { method: 'POST', body: JSON.stringify({ account_id: state.accountId, name, members }) });
    el.newEntityDialog.close();
    await refreshSidebars();
    await openGroupChat(created.id, name, members.length);
  });

  el.editAccountBtn.onclick = () => {
    const account = state.accounts.find((a) => Number(a.id) === Number(state.accountId));
    if (!account) return;
    const form = document.getElementById('accountForm');
    form.account_id.value = account.id;
    form.name.value = account.name;
    form.email.value = account.email;
    form.imap_host.value = account.imap_host;
    form.imap_port.value = account.imap_port;
    form.smtp_host.value = account.smtp_host;
    form.smtp_port.value = account.smtp_port;
    form.smtp_security.value = account.smtp_security || 'auto';
    form.password.value = '';
    form.use_ssl.checked = Number(account.use_ssl || 0) === 1;
    document.getElementById('accountDialog').showModal();
  };
  el.emojiBtn.onclick = () => {
    el.messageInput.focus();
    if (customElements.get('emoji-picker')) {
      const r = el.emojiBtn.getBoundingClientRect();
      const pickerWidth = 352;
      const left = Math.max(8, Math.min(window.innerWidth - pickerWidth - 8, r.left + (r.width / 2) - (pickerWidth / 2)));
      const top = Math.max(8, r.top - 420);
      el.emojiPickerWrap.style.left = `${left}px`;
      el.emojiPickerWrap.style.top = `${top}px`;
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

  el.ctxEditBtn.onclick = async () => {
    const kind = el.chatContextMenu.dataset.kind;
    const id = el.chatContextMenu.dataset.id;
    hideContextMenu();
    if (kind === 'contact' || kind === 'top_contact') {
      const rows = await api(`/api/contacts?account_id=${state.accountId}`);
      const c = rows.find((r) => r.email === id || r.email === state.activeContact) || { email: id || state.activeContact };
      openProfileEditor('contact', c);
    }
    if (kind === 'group' || kind === 'top_group') {
      const rows = await api(`/api/groups?account_id=${state.accountId}`);
      const gid = Number(id || state.activeGroup);
      const g = rows.find((r) => Number(r.id) === gid) || { id: gid, name: '' };
      openProfileEditor('group', { group_id: gid, name: g.name, avatar_url: g.avatar_url || '' });
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

  el.contactInfo.addEventListener('contextmenu', (e) => {
    if (state.activeContact) {
      e.preventDefault();
      openContextMenu('top_contact', state.activeContact, e.clientX, e.clientY);
    } else if (state.activeGroup) {
      e.preventDefault();
      openContextMenu('top_group', state.activeGroup, e.clientX, e.clientY);
    }
  });

  document.getElementById('errorBtn').onclick = () => {
    el.errorLogOutput.textContent = state.errors.join('\n') || 'Keine Fehler';
    el.errorDialog.showModal();
  };
  document.getElementById('clearErrorsBtn').onclick = () => {
    state.errors = [];
    document.getElementById('errorBtn').textContent = '⚠️';
    el.errorLogOutput.textContent = 'Keine Fehler';
  };

  document.getElementById('profileForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    const avatarFile = form.get('avatar_file');
    const avatarFromFile = avatarFile && avatarFile.size ? await fileAsDataUrl(avatarFile) : '';
    await api('/api/profile', {
      method: 'POST',
      body: JSON.stringify({
        account_id: state.accountId,
        kind: form.get('kind'),
        email: form.get('email'),
        new_email: form.get('new_email'),
        display_name: form.get('display_name'),
        avatar_url: avatarFromFile || form.get('avatar_url'),
        group_id: form.get('group_id'),
        name: form.get('display_name'),
      }),
    });
    el.profileDialog.close();
    await refreshSidebars();
    if (state.activeContact) await openContactChat(state.activeContact);
    if (state.activeGroup) {
      const rows = await api(`/api/groups?account_id=${state.accountId}`);
      const g = rows.find((r) => Number(r.id) === Number(state.activeGroup));
      if (g) el.contactInfo.textContent = `👥 ${g.name} • ${g.members} Mitglieder`;
    }
  });
  document.getElementById('closeProfileBtn').onclick = () => el.profileDialog.close();

  let dragging = false;
  const shell = el.shell;
  el.splitter?.addEventListener('pointerdown', (e) => {
    dragging = true;
    el.splitter.setPointerCapture(e.pointerId);
  });
  window.addEventListener('pointermove', (e) => {
    if (!dragging || window.innerWidth < 900) return;
    const width = Math.max(280, Math.min(720, e.clientX));
    shell.style.gridTemplateColumns = `${width}px 8px 1fr`;
  });
  window.addEventListener('pointerup', () => { dragging = false; });

  document.getElementById('sendForm').addEventListener('submit', sendCurrentMessage);
  el.messageInput.addEventListener('input', autoGrowMessageInput);
  el.messageInput.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' || ev.shiftKey) return;
    if (!asBool(state.settings?.enter_sends_message)) return;
    ev.preventDefault();
    sendCurrentMessage(ev).catch((err) => pushError(err));
  });
  autoGrowMessageInput();

  document.getElementById('accountForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    const payload = {
      id: form.get('account_id'),
      name: form.get('name'), email: form.get('email'), imap_host: form.get('imap_host'), imap_port: form.get('imap_port'),
      smtp_host: form.get('smtp_host'), smtp_port: form.get('smtp_port'), smtp_security: form.get('smtp_security'),
      password: form.get('password'), use_ssl: form.get('use_ssl') === 'on',
    };
    const isEdit = Boolean(payload.id);
    await api(isEdit ? '/api/accounts/update' : '/api/accounts', {
      method: 'POST',
      body: JSON.stringify(payload),
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
        os_contact_sync_enabled: f.get('os_contact_sync_enabled') === 'on' ? '1' : '0',
        send_custom_read_receipts: f.get('send_custom_read_receipts') === 'on' ? '1' : '0',
        enter_sends_message: f.get('enter_sends_message') === 'on' ? '1' : '0',
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
