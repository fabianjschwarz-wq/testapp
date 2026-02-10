const state = {
  accountId: null,
  activeContact: null,
  mobileMode: false,
  knownContacts: new Set(),
  lastSeenMessageIdByContact: new Map(),
  pollingHandle: null,
};

const accountSelect = document.getElementById('accountSelect');
const chatList = document.getElementById('chatList');
const messages = document.getElementById('messages');
const contactInput = document.getElementById('contactInput');
const messageInput = document.getElementById('messageInput');
const quickContactInput = document.getElementById('quickContactInput');
const knownContacts = document.getElementById('knownContacts');
const shell = document.getElementById('shell');

async function api(path, options = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Unbekannter Fehler');
  return data;
}

function formatDate(isoString) {
  try {
    return new Date(isoString).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return isoString || '';
  }
}

function sanitizeHtml(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  doc.querySelectorAll('script, iframe, object, embed, style').forEach((el) => el.remove());
  doc.querySelectorAll('*').forEach((el) => {
    [...el.attributes].forEach((a) => {
      if (a.name.startsWith('on')) el.removeAttribute(a.name);
      if ((a.name === 'href' || a.name === 'src') && a.value.trim().toLowerCase().startsWith('javascript:')) {
        el.removeAttribute(a.name);
      }
    });
  });
  return doc.body.innerHTML;
}

function renderKnownContacts() {
  knownContacts.innerHTML = '';
  [...state.knownContacts].sort().forEach((mail) => {
    const option = document.createElement('option');
    option.value = mail;
    knownContacts.append(option);
  });
}

async function ensureNotificationPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    try {
      await Notification.requestPermission();
    } catch (_) {
      // ignore
    }
  }
}

function notifyInbound(contact, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const snippet = (body || '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Neue Nachricht';
  new Notification(`Neue Nachricht von ${contact}`, { body: snippet });
}

async function loadAccounts() {
  const accounts = await api('/api/accounts');
  accountSelect.innerHTML = '';

  if (!accounts.length) {
    accountSelect.innerHTML = '<option value="">Kein Konto vorhanden</option>';
    state.accountId = null;
    state.activeContact = null;
    messages.innerHTML = '<p class="empty">Bitte zuerst ein E-Mail-Konto hinzufügen.</p>';
    chatList.innerHTML = '';
    state.knownContacts.clear();
    renderKnownContacts();
    return;
  }

  accounts.forEach((a) => {
    const option = document.createElement('option');
    option.value = a.id;
    option.textContent = `${a.name} (${a.email})`;
    accountSelect.append(option);
  });

  if (!state.accountId) state.accountId = Number(accounts[0].id);
  accountSelect.value = String(state.accountId);
  await loadChats();
}

async function loadChats() {
  if (!state.accountId) return;

  const chats = await api(`/api/chats?account_id=${state.accountId}`);
  chatList.innerHTML = '';
  state.knownContacts.clear();

  chats.forEach((chat) => {
    state.knownContacts.add(chat.contact_email);
    const li = document.createElement('li');
    li.className = state.activeContact === chat.contact_email ? 'active' : '';
    li.innerHTML = `<strong>${chat.contact_email}</strong><div class="preview">${(chat.last_body || '').slice(0, 70)}</div>`;
    li.onclick = async () => openChat(chat.contact_email);
    chatList.append(li);
  });

  renderKnownContacts();
}

async function openChat(email) {
  const value = (email || '').trim();
  if (!value) return;

  state.activeContact = value;
  state.knownContacts.add(value);
  renderKnownContacts();

  contactInput.value = value;
  quickContactInput.value = '';

  await loadMessages();
  await loadChats();

  if (state.mobileMode) shell.classList.add('chat-open');
}

async function loadMessages({ silent = false } = {}) {
  if (!state.accountId || !state.activeContact) {
    messages.innerHTML = '<p class="empty">Wähle einen Chat oder gib eine E-Mail ein.</p>';
    return;
  }

  const data = await api(`/api/messages?account_id=${state.accountId}&contact=${encodeURIComponent(state.activeContact)}`);
  if (!silent) messages.innerHTML = '';

  if (!silent) {
    data.forEach((msg) => {
      const bubble = document.createElement('article');
      bubble.className = `bubble ${msg.direction}`;

      const content = document.createElement('div');
      content.className = 'content';
      if (msg.body_html) content.innerHTML = sanitizeHtml(msg.body_html);
      else content.textContent = msg.body;

      const meta = document.createElement('time');
      meta.className = 'meta';
      meta.textContent = formatDate(msg.sent_at);

      bubble.append(content, meta);
      messages.append(bubble);
    });
    messages.scrollTop = messages.scrollHeight;
  }

  const last = data[data.length - 1];
  if (last?.id) {
    const previous = state.lastSeenMessageIdByContact.get(state.activeContact) || 0;
    if (last.id > previous) {
      if (previous > 0) {
        const newInbound = data.filter((m) => m.id > previous && m.direction === 'inbound');
        newInbound.forEach((m) => notifyInbound(state.activeContact, m.body));
      }
      state.lastSeenMessageIdByContact.set(state.activeContact, last.id);
    }
  }
}

async function pollRealtimeUpdates() {
  if (!state.accountId) return;
  try {
    await api('/api/sync', {
      method: 'POST',
      body: JSON.stringify({ account_id: state.accountId }),
    });

    const currentChat = state.activeContact;
    await loadChats();

    if (currentChat) {
      state.activeContact = currentChat;
      await loadMessages({ silent: false });
    }
  } catch (_) {
    // silent polling error
  }
}

function startPolling() {
  if (state.pollingHandle) clearInterval(state.pollingHandle);
  state.pollingHandle = setInterval(() => {
    pollRealtimeUpdates();
  }, 8000);
}

document.getElementById('newAccountBtn').onclick = () => document.getElementById('accountDialog').showModal();
document.getElementById('closeDialogBtn').onclick = () => document.getElementById('accountDialog').close();

document.getElementById('mobileSwitchBtn').onclick = () => {
  state.mobileMode = !state.mobileMode;
  shell.classList.toggle('mobile-mode', state.mobileMode);
  shell.classList.remove('chat-open');
};

document.getElementById('mobileBackBtn').onclick = () => {
  shell.classList.remove('chat-open');
  state.activeContact = null;
  loadChats();
  loadMessages();
};

document.getElementById('quickAddContactBtn').onclick = async () => {
  await openChat(quickContactInput.value);
};

document.getElementById('accountForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  try {
    await api('/api/accounts', {
      method: 'POST',
      body: JSON.stringify({
        name: form.get('name'),
        email: form.get('email'),
        imap_host: form.get('imap_host'),
        imap_port: form.get('imap_port'),
        smtp_host: form.get('smtp_host'),
        smtp_port: form.get('smtp_port'),
        smtp_security: form.get('smtp_security'),
        password: form.get('password'),
        use_ssl: form.get('use_ssl') === 'on',
      }),
    });
    e.target.reset();
    document.getElementById('accountDialog').close();
    await loadAccounts();
  } catch (err) {
    alert(err.message);
  }
});

accountSelect.onchange = async (e) => {
  state.accountId = Number(e.target.value);
  state.activeContact = null;
  state.lastSeenMessageIdByContact.clear();
  await loadChats();
  await loadMessages();
};

document.getElementById('syncBtn').onclick = async () => {
  if (!state.accountId) return;
  try {
    const result = await api('/api/sync', {
      method: 'POST',
      body: JSON.stringify({ account_id: state.accountId }),
    });
    await loadChats();
    await loadMessages();
    alert(`${result.saved} neue Nachrichten geladen.`);
  } catch (err) {
    alert(err.message);
  }
};

document.getElementById('openChatBtn').onclick = async () => {
  await openChat(contactInput.value);
};

contactInput.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    await openChat(contactInput.value);
  }
});

document.getElementById('sendForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const toEmail = contactInput.value.trim();
  const body = messageInput.value.trim();
  if (!state.accountId) return alert('Bitte zuerst ein Konto hinzufügen.');
  if (!toEmail || !body) return;

  try {
    await api('/api/send', {
      method: 'POST',
      body: JSON.stringify({
        account_id: state.accountId,
        to_email: toEmail,
        body,
        is_html: document.getElementById('htmlMode').checked,
      }),
    });
    state.activeContact = toEmail;
    messageInput.value = '';
    await loadMessages();
    await loadChats();
  } catch (err) {
    alert(err.message);
  }
});

window.addEventListener('focus', () => pollRealtimeUpdates());

Promise.all([ensureNotificationPermission(), loadAccounts()])
  .then(() => {
    startPolling();
    return loadMessages();
  })
  .catch((err) => {
    messages.innerHTML = `<p class="empty">Fehler: ${err.message}</p>`;
  });
