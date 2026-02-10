const state = {
  accountId: null,
  activeContact: null,
};

const accountSelect = document.getElementById('accountSelect');
const chatList = document.getElementById('chatList');
const messages = document.getElementById('messages');
const contactInput = document.getElementById('contactInput');
const messageInput = document.getElementById('messageInput');

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Unbekannter Fehler');
  }
  return data;
}

function trimPreview(text) {
  return text.length > 75 ? `${text.slice(0, 75)}...` : text;
}

async function loadAccounts() {
  const accounts = await api('/api/accounts');
  accountSelect.innerHTML = '';
  if (!accounts.length) {
    const option = document.createElement('option');
    option.textContent = 'Kein Konto vorhanden';
    option.value = '';
    accountSelect.append(option);
    state.accountId = null;
    chatList.innerHTML = '';
    messages.innerHTML = '<p>Bitte zuerst ein E-Mail-Konto hinzufügen.</p>';
    return;
  }

  accounts.forEach((account) => {
    const option = document.createElement('option');
    option.value = account.id;
    option.textContent = `${account.name} (${account.email})`;
    accountSelect.append(option);
  });

  if (!state.accountId) {
    state.accountId = Number(accounts[0].id);
  }
  accountSelect.value = String(state.accountId);
  await loadChats();
}

async function loadChats() {
  if (!state.accountId) return;
  const chats = await api(`/api/chats?account_id=${state.accountId}`);
  chatList.innerHTML = '';

  chats.forEach((chat) => {
    const li = document.createElement('li');
    li.className = state.activeContact === chat.contact_email ? 'active' : '';
    li.innerHTML = `<strong>${chat.contact_email}</strong><div class="preview">${trimPreview(chat.last_body || '')}</div>`;
    li.addEventListener('click', async () => {
      state.activeContact = chat.contact_email;
      contactInput.value = chat.contact_email;
      await loadMessages();
      await loadChats();
    });
    chatList.append(li);
  });
}

async function loadMessages() {
  if (!state.accountId || !state.activeContact) {
    messages.innerHTML = '<p>Wähle links einen Kontakt oder gib oben eine E-Mail ein.</p>';
    return;
  }
  const data = await api(`/api/messages?account_id=${state.accountId}&contact=${encodeURIComponent(state.activeContact)}`);
  messages.innerHTML = '';
  data.forEach((msg) => {
    const div = document.createElement('div');
    div.className = `bubble ${msg.direction}`;
    div.textContent = msg.body;
    messages.append(div);
  });
  messages.scrollTop = messages.scrollHeight;
}

document.getElementById('newAccountBtn').addEventListener('click', () => {
  document.getElementById('accountDialog').showModal();
});

document.getElementById('closeDialogBtn').addEventListener('click', () => {
  document.getElementById('accountDialog').close();
});

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

accountSelect.addEventListener('change', async (e) => {
  state.accountId = Number(e.target.value);
  state.activeContact = null;
  await loadChats();
  await loadMessages();
});

document.getElementById('syncBtn').addEventListener('click', async () => {
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
});

document.getElementById('openChatBtn').addEventListener('click', async () => {
  const value = contactInput.value.trim();
  if (!value) return;
  state.activeContact = value;
  await loadMessages();
  await loadChats();
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
      body: JSON.stringify({ account_id: state.accountId, to_email: toEmail, body }),
    });
    state.activeContact = toEmail;
    messageInput.value = '';
    await loadMessages();
    await loadChats();
  } catch (err) {
    alert(err.message);
  }
});

loadAccounts().catch((err) => {
  messages.innerHTML = `<p>Fehler beim Laden: ${err.message}</p>`;
});
