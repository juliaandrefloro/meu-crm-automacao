// ── SVG Icons ──────────────────────────────────────────
const ICON = {
  paperclip: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:18px;height:18px;pointer-events:none;"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>`,
  send:      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;pointer-events:none;"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`,
  mic:       `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;pointer-events:none;"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`,
  stop:      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" style="width:14px;height:14px;pointer-events:none;"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>`,
  wave:      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:15px;height:15px;flex-shrink:0;"><path d="M3 12h2l2-6 2 12 2-8 2 4 2-2h2"/></svg>`,
};

// ── State ──────────────────────────────────────────────
const socket = io();
let currentPage = 'dashboard';
let pendingQRId  = null;
let _rules = [], _leads = [], _chats = [];
let _selectedConnectionId = null;
let _selectedChatId       = null;
let _pendingFile           = null;
let _transcriptionEnabled  = false;

// Recording
let _mediaRecorder     = null;
let _audioChunks       = [];
let _recInterval       = null;
let _recSeconds        = 0;
let _isRecording       = false;
let _pendingVoiceBlob  = null;
let _pendingVoiceBlobUrl = null;

// Media & transcription caches
const _transcriptions = new Map(); // messageId -> text
const _mediaUrls      = new Map(); // messageId -> url

// ── Socket ─────────────────────────────────────────────
socket.on('transcription-status', ({ enabled }) => { _transcriptionEnabled = enabled; });

socket.on('connections-update', (connections) => {
  if (currentPage === 'connections') renderConnections(connections);
  if (currentPage === 'dashboard')   loadDashboard();
  if (pendingQRId) {
    const conn = connections.find(c => c.id === pendingQRId);
    if (conn && conn.status === 'connected') {
      pendingQRId = null;
      document.getElementById('modal-content').innerHTML = `
        <div style="text-align:center;padding:16px 0 8px;">
          <div style="font-size:56px;">✅</div>
          <div class="modal-title" style="margin-top:16px;margin-bottom:8px;">${esc(conn.name)} Conectado!</div>
          <p style="color:#6b7280;font-size:13px;margin-bottom:24px;">Pronta para receber mensagens.</p>
          <button class="btn btn-primary" onclick="closeModal()">Fechar</button>
        </div>`;
    }
  }
});

socket.on('qr', ({ id, qrImage }) => {
  if (id !== pendingQRId) return;
  const el = document.getElementById('qr-display');
  if (el) el.innerHTML = qrImgHTML(qrImage);
});

socket.on('new-message', ({ connectionId, chatId, message }) => {
  if (currentPage !== 'chat' || connectionId !== _selectedConnectionId) return;
  const idx = _chats.findIndex(c => c.id === chatId);
  if (idx > -1) {
    _chats[idx].lastMessage = { body: message.body, timestamp: message.timestamp, fromMe: message.fromMe };
    const [chat] = _chats.splice(idx, 1);
    _chats.unshift(chat);
    renderContactList();
  }
  if (chatId === _selectedChatId) appendMessage(message);
});

socket.on('media-ready', ({ connectionId, chatId, messageId, mediaUrl, type }) => {
  _mediaUrls.set(messageId, mediaUrl);
  if (currentPage !== 'chat' || connectionId !== _selectedConnectionId) return;

  // Audio: update placeholder player src
  const audioPlaceholder = document.querySelector(`[data-audio-id="${messageId}"]`);
  if (audioPlaceholder) {
    audioPlaceholder.outerHTML = audioPlayerHTML(messageId, mediaUrl);
  }

  // Image / video / sticker: replace loading placeholder
  const mediaPlaceholder = document.querySelector(`[data-media-id="${messageId}"]`);
  if (mediaPlaceholder) {
    const mtype = mediaPlaceholder.dataset.mediaType || type;
    mediaPlaceholder.outerHTML = mediaElementHTML(mtype, mediaUrl);
  }
});

socket.on('voice-transcription', ({ connectionId, chatId, messageId, text }) => {
  _transcriptions.set(messageId, text);
  if (connectionId !== _selectedConnectionId) return;
  const pending = document.querySelector(`[data-transcribe="${messageId}"]`);
  if (pending) {
    pending.className = 'transcription';
    pending.innerHTML = `${transcriptionBadge()}"${esc(text)}"`;
  }
});

// ── Navigation ─────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    item.classList.add('active');
    navigate(item.dataset.page);
  });
});

function navigate(page) {
  currentPage = page;
  setContent('<div class="spinner"></div>');
  if (page === 'dashboard')   loadDashboard();
  if (page === 'connections') loadConnections();
  if (page === 'rules')       loadRules();
  if (page === 'leads')       loadLeads();
  if (page === 'chat')        loadChatPage();
}
function setContent(html) { document.getElementById('page-content').innerHTML = html; }

// ── Dashboard ──────────────────────────────────────────
async function loadDashboard() {
  const s = await get('/api/stats');
  setContent(`
    <div class="page-header"><div><div class="page-title">Dashboard</div><div class="page-subtitle">Visão geral do seu CRM</div></div></div>
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-icon" style="background:#f0ebff;">👥</div><div><div class="stat-value">${s.leads}</div><div class="stat-label">Total de Leads</div></div></div>
      <div class="stat-card"><div class="stat-icon" style="background:#dcfce7;">📱</div><div><div class="stat-value">${s.activeConnections}</div><div class="stat-label">Conexões Ativas</div></div></div>
      <div class="stat-card"><div class="stat-icon" style="background:#fef9c3;">🤖</div><div><div class="stat-value">${s.rules}</div><div class="stat-label">Regras do Chatbot</div></div></div>
      <div class="stat-card"><div class="stat-icon" style="background:#e0f2fe;">🔗</div><div><div class="stat-value">${s.totalConnections}</div><div class="stat-label">Total de Conexões</div></div></div>
    </div>`);
}

// ── Connections ────────────────────────────────────────
async function loadConnections() { renderConnections(await get('/api/connections')); }

function renderConnections(list) {
  const statusLabel = { connected:'Conectado', qr:'Aguardando QR', initializing:'Iniciando', auth_failure:'Falha', disconnected:'Desconectado' };
  const statusClass  = { connected:'badge-green', qr:'badge-yellow', initializing:'badge-gray', auth_failure:'badge-red', disconnected:'badge-red' };
  const cardsHTML = list.length === 0
    ? `<div class="empty"><div class="empty-icon">📱</div><div class="empty-title">Nenhuma conexão ainda</div></div>`
    : `<div class="connections-grid">${list.map(c => `
        <div class="conn-card">
          <div class="conn-card-top"><div><div class="conn-name">${esc(c.name)}</div><div class="conn-id">${c.id}</div></div>
            <span class="badge ${statusClass[c.status]||'badge-gray'}">${statusLabel[c.status]||c.status}</span></div>
          <div class="conn-icon">📱</div>
          <div class="conn-actions">
            ${c.status==='qr'?`<button class="btn btn-sm btn-primary" onclick="openQRModal('${c.id}','${esc(c.name)}')">Ver QR</button>`:''}
            <button class="btn btn-sm btn-danger" onclick="deleteConnection('${c.id}')">Remover</button>
          </div></div>`).join('')}</div>`;
  setContent(`
    <div class="page-header"><div><div class="page-title">Conexões</div><div class="page-subtitle">Gerencie suas instâncias do WhatsApp</div></div>
      <button class="btn btn-primary" onclick="showNewConnectionModal()">+ Nova Conexão</button></div>${cardsHTML}`);
}

function showNewConnectionModal() {
  openModal(`<div class="modal-title">Nova Conexão WhatsApp</div>
    <div class="form-group"><label>Nome da conexão</label><input type="text" id="conn-name" placeholder="Ex: Vendas, Suporte..." autofocus></div>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Cancelar</button><button class="btn btn-primary" onclick="createConnection()">Criar e gerar QR</button></div>`);
}

async function createConnection() {
  const name = document.getElementById('conn-name').value.trim();
  if (!name) return;
  document.getElementById('modal-content').innerHTML = `
    <div class="modal-title">Conectar — ${esc(name)}</div>
    <div class="qr-wrap"><div id="qr-display"><div class="spinner"></div><p style="color:#9ca3af;font-size:12.5px;margin-top:14px;">Gerando QR...</p></div></div>
    <div style="text-align:center;margin-top:20px;"><button class="btn btn-ghost" onclick="closeModal()">Fechar</button></div>`;
  const conn = await post('/api/connections', { name });
  pendingQRId = conn.id;
}

async function openQRModal(id, name) {
  pendingQRId = id;
  openModal(`<div class="modal-title">QR Code — ${esc(name)}</div>
    <div class="qr-wrap"><div id="qr-display"><div class="spinner"></div></div></div>
    <div style="text-align:center;margin-top:20px;"><button class="btn btn-ghost" onclick="closeModal()">Fechar</button></div>`);
  const res = await fetch(`/api/connections/${id}/qr`);
  if (res.ok) { const { qrImage } = await res.json(); const el = document.getElementById('qr-display'); if (el) el.innerHTML = qrImgHTML(qrImage); }
}

async function deleteConnection(id) {
  if (!confirm('Remover esta conexão?')) return;
  await fetch(`/api/connections/${id}`, { method: 'DELETE' }); loadConnections();
}
function qrImgHTML(src) {
  return `<img src="${src}" alt="QR Code"><div class="qr-hint">WhatsApp → Dispositivos vinculados → Vincular dispositivo</div>`;
}

// ── Chatbot Rules ──────────────────────────────────────
async function loadRules() { _rules = await get('/api/rules'); renderRules(); }

function renderRules() {
  const rows = _rules.length === 0
    ? `<tr><td colspan="3" style="text-align:center;padding:40px;color:#9ca3af;">Nenhuma regra</td></tr>`
    : _rules.map(r => `<tr>
        <td><span class="kw-tag">${esc(r.keyword)}</span></td>
        <td style="color:#374151;">${esc(r.response)}</td>
        <td><div style="display:flex;gap:6px;">
          <button class="btn btn-sm btn-ghost" onclick="showEditRuleModal(${r.id})">Editar</button>
          <button class="btn btn-sm btn-danger" onclick="deleteRule(${r.id})">Excluir</button>
        </div></td></tr>`).join('');
  setContent(`
    <div class="page-header"><div><div class="page-title">Regras do Chatbot</div><div class="page-subtitle">Respostas automáticas por palavra-chave</div></div>
      <button class="btn btn-primary" onclick="showNewRuleModal()">+ Nova Regra</button></div>
    <div class="card"><div class="card-header"><span class="card-title">Regras Ativas</span>
      <span style="font-size:12.5px;color:#6b7280;">${_rules.length} regra${_rules.length!==1?'s':''}</span></div>
      <table class="table"><thead><tr><th>Se contiver</th><th>Responder com</th><th style="width:150px;">Ações</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`);
}

function showNewRuleModal() {
  openModal(`<div class="modal-title">Nova Regra</div>
    <div class="form-group"><label>Se a mensagem contiver...</label><input type="text" id="rule-keyword" placeholder="Ex: oi, preço" autofocus></div>
    <div class="form-group"><label>Responder com...</label><textarea id="rule-response" placeholder="Ex: Olá! Como posso ajudar?"></textarea></div>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Cancelar</button><button class="btn btn-primary" onclick="saveRule()">Salvar</button></div>`);
}

function showEditRuleModal(id) {
  const rule = _rules.find(r => r.id === id); if (!rule) return;
  openModal(`<div class="modal-title">Editar Regra</div>
    <div class="form-group"><label>Se a mensagem contiver...</label><input type="text" id="rule-keyword" value="${esc(rule.keyword)}" autofocus></div>
    <div class="form-group"><label>Responder com...</label><textarea id="rule-response">${esc(rule.response)}</textarea></div>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Cancelar</button><button class="btn btn-primary" onclick="updateRule(${id})">Atualizar</button></div>`);
}

async function saveRule() {
  const keyword = document.getElementById('rule-keyword').value.trim();
  const response = document.getElementById('rule-response').value.trim();
  if (!keyword || !response) return;
  await post('/api/rules', { keyword, response }); closeModal(); loadRules();
}
async function updateRule(id) {
  const keyword = document.getElementById('rule-keyword').value.trim();
  const response = document.getElementById('rule-response').value.trim();
  if (!keyword || !response) return;
  await fetch(`/api/rules/${id}`, { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({keyword,response}) });
  closeModal(); loadRules();
}
async function deleteRule(id) {
  if (!confirm('Excluir esta regra?')) return;
  await fetch(`/api/rules/${id}`, { method:'DELETE' }); loadRules();
}

// ── Leads ──────────────────────────────────────────────
async function loadLeads() { _leads = await get('/api/leads'); renderLeads(); }

function renderLeads() {
  const total = _leads.reduce((s,l) => s + l.investment, 0);
  const rows = _leads.length === 0
    ? `<tr><td colspan="4" style="text-align:center;padding:40px;color:#9ca3af;">Nenhum lead</td></tr>`
    : _leads.map(l => `<tr>
        <td style="font-weight:600;">${esc(l.name)}</td>
        <td style="color:#16a34a;font-weight:700;">R$ ${l.investment.toLocaleString('pt-BR',{minimumFractionDigits:2})}</td>
        <td style="color:#6b7280;">${new Date(l.createdAt).toLocaleDateString('pt-BR')}</td>
        <td><button class="btn btn-sm btn-danger" onclick="deleteLead(${l.id})">Excluir</button></td></tr>`).join('');
  setContent(`
    <div class="page-header"><div><div class="page-title">Leads</div><div class="page-subtitle">Clientes em potencial</div></div>
      <button class="btn btn-primary" onclick="showNewLeadModal()">+ Novo Lead</button></div>
    <div class="stats-grid" style="margin-bottom:24px;">
      <div class="stat-card"><div class="stat-icon" style="background:#f0ebff;">👥</div><div><div class="stat-value">${_leads.length}</div><div class="stat-label">Total de Leads</div></div></div>
      <div class="stat-card"><div class="stat-icon" style="background:#dcfce7;">💰</div><div><div class="stat-value" style="font-size:20px;">R$ ${total.toLocaleString('pt-BR',{minimumFractionDigits:2})}</div><div class="stat-label">Potencial Total</div></div></div>
    </div>
    <div class="card"><div class="card-header"><span class="card-title">Todos os Leads</span></div>
      <table class="table"><thead><tr><th>Nome</th><th>Investimento</th><th>Data</th><th style="width:100px;">Ações</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`);
}

function showNewLeadModal() {
  openModal(`<div class="modal-title">Novo Lead</div>
    <div class="form-group"><label>Nome do Cliente</label><input type="text" id="lead-name" placeholder="Ex: Maria Silva" autofocus></div>
    <div class="form-group"><label>Valor de Investimento (R$)</label><input type="number" id="lead-investment" placeholder="Ex: 5000" min="0" step="0.01"></div>
    <div class="modal-actions"><button class="btn btn-ghost" onclick="closeModal()">Cancelar</button><button class="btn btn-primary" onclick="saveLead()">Cadastrar</button></div>`);
}
async function saveLead() {
  const name = document.getElementById('lead-name').value.trim();
  const investment = document.getElementById('lead-investment').value;
  if (!name || !investment) return;
  await post('/api/leads', { name, investment }); closeModal(); loadLeads();
}
async function deleteLead(id) {
  if (!confirm('Excluir este lead?')) return;
  await fetch(`/api/leads/${id}`, { method:'DELETE' }); loadLeads();
}

// ── Live Chat ──────────────────────────────────────────
async function loadChatPage() {
  const connections = await get('/api/connections');
  const connected = connections.filter(c => c.status === 'connected');
  if (connected.length === 0) {
    setContent(`<div class="page-header"><div><div class="page-title">Live Chat</div></div></div>
      <div class="card"><div class="empty"><div class="empty-icon">📱</div><div class="empty-title">Nenhuma conexão ativa</div>
      <div class="empty-desc">Conecte um WhatsApp na página de Conexões primeiro.</div></div></div>`);
    return;
  }
  if (!_selectedConnectionId || !connected.find(c => c.id === _selectedConnectionId))
    _selectedConnectionId = connected[0].id;

  setContent(`
    <div class="chat-layout">
      <div class="chat-sidebar">
        <div class="chat-sidebar-header">
          <div style="font-size:15px;font-weight:700;color:#0f0a23;">Live Chat</div>
          <select id="conn-selector" class="conn-select" onchange="switchChatConnection(this.value)">
            ${connected.map(c => `<option value="${c.id}" ${c.id===_selectedConnectionId?'selected':''}>${esc(c.name)}</option>`).join('')}
          </select>
        </div>
        <div class="chat-search"><input type="text" placeholder="🔍 Buscar..." oninput="filterContacts(this.value)"></div>
        <div id="contacts-list" class="contacts-list"><div class="spinner" style="margin-top:40px;"></div></div>
      </div>
      <div class="chat-main" id="chat-main">
        <div class="chat-empty-state">
          <div style="font-size:48px;">💬</div>
          <div style="font-size:15px;font-weight:600;color:#6b7280;margin-top:12px;">Selecione uma conversa</div>
        </div>
      </div>
    </div>`);
  fetchChatList();
}

async function fetchChatList() {
  _chats = await get(`/api/chats?connectionId=${_selectedConnectionId}`);
  renderContactList();
}

// Profile pic cache: chatId -> url (or null)
const _profilePics = new Map();

function renderContactList(filtered) {
  const el = document.getElementById('contacts-list'); if (!el) return;
  const list = filtered || _chats;
  if (list.length === 0) { el.innerHTML = `<div style="text-align:center;padding:40px 16px;color:#9ca3af;font-size:13px;">Nenhuma conversa</div>`; return; }
  el.innerHTML = list.map(chat => {
    const initial = (chat.name||'?')[0].toUpperCase();
    const lastMsg = chat.lastMessage ? esc(chat.lastMessage.body.substring(0,38)) : '';
    const time = chat.lastMessage ? chatTime(chat.lastMessage.timestamp) : '';
    const picUrl = _profilePics.get(chat.id);
    const avatarHTML = picUrl
      ? `<img class="contact-avatar-img" src="${picUrl}" alt="${initial}" onerror="this.outerHTML='<div class=\\'contact-avatar\\'>${initial}</div>'">`
      : `<div class="contact-avatar">${initial}</div>`;
    return `<div class="contact-item ${chat.id===_selectedChatId?'active':''}" data-chat-id="${esc(chat.id)}" data-chat-name="${esc(chat.name||chat.id)}">
      ${avatarHTML}
      <div style="flex:1;min-width:0;">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;">
          <div class="contact-name">${esc(chat.name||chat.id)}</div>
          <div class="contact-time">${time}</div>
        </div>
        <div class="contact-last">${lastMsg}</div>
      </div>
      ${chat.unreadCount>0?`<span class="unread-badge">${chat.unreadCount}</span>`:''}
    </div>`;
  }).join('');
  el.querySelectorAll('.contact-item').forEach(item => {
    item.addEventListener('click', () => openConversation(item.dataset.chatId, item.dataset.chatName));
  });
  // Fetch profile pics for contacts that haven't been loaded yet
  list.forEach(chat => {
    if (!_profilePics.has(chat.id)) {
      _profilePics.set(chat.id, null); // mark as loading
      fetch(`/api/contacts/${encodeURIComponent(chat.id)}/photo?connectionId=${encodeURIComponent(_selectedConnectionId||'')}`)
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (data?.url) {
            _profilePics.set(chat.id, data.url);
            // Update avatar in DOM without full re-render
            const item = el.querySelector(`[data-chat-id="${CSS.escape(chat.id)}"]`);
            if (item) {
              const avatar = item.querySelector('.contact-avatar');
              if (avatar) avatar.outerHTML = `<img class="contact-avatar-img" src="${data.url}" alt="${(chat.name||'?')[0].toUpperCase()}" onerror="this.style.display='none'">`;
            }
          }
        }).catch(() => {});
    }
  });
}

function filterContacts(q) {
  if (!q) return renderContactList();
  renderContactList(_chats.filter(c => (c.name||'').toLowerCase().includes(q.toLowerCase())));
}

async function switchChatConnection(id) {
  _selectedConnectionId = id; _selectedChatId = null;
  document.getElementById('chat-main').innerHTML = `<div class="chat-empty-state"><div style="font-size:48px;">💬</div></div>`;
  document.getElementById('contacts-list').innerHTML = '<div class="spinner" style="margin-top:40px;"></div>';
  fetchChatList();
}

async function openConversation(chatId, chatName) {
  _selectedChatId = chatId;
  renderContactList();

  const headerInitial = (chatName[0]||'?').toUpperCase();
  const headerPic = _profilePics.get(chatId);
  const headerAvatarHTML = headerPic
    ? `<img class="contact-avatar-img" src="${headerPic}" alt="${headerInitial}" style="width:38px;height:38px;" onerror="this.outerHTML='<div class=\\'contact-avatar\\'style=\\'width:38px;height:38px;font-size:15px;\\'>${headerInitial}</div>'">`
    : `<div class="contact-avatar" style="width:38px;height:38px;font-size:15px;">${headerInitial}</div>`;
  document.getElementById('chat-main').innerHTML = `
    <div class="chat-main-header" id="chat-header">
      ${headerAvatarHTML}
      <div>
        <div style="font-weight:700;font-size:14px;color:#0f0a23;">${esc(chatName)}</div>
        <div style="font-size:11.5px;color:#9ca3af;">WhatsApp${_transcriptionEnabled?' · ✦ Transcrição ativa':''}</div>
      </div>
    </div>
    <div class="chat-messages" id="chat-messages"><div class="spinner" style="margin:auto;"></div></div>
    ${chatInputHTML()}`;

  // Fetch profile pic for header if not cached
  if (!_profilePics.has(chatId)) {
    fetch(`/api/contacts/${encodeURIComponent(chatId)}/photo?connectionId=${encodeURIComponent(_selectedConnectionId||'')}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.url) {
          _profilePics.set(chatId, data.url);
          const header = document.getElementById('chat-header');
          if (header) {
            const avatar = header.querySelector('.contact-avatar');
            if (avatar) avatar.outerHTML = `<img class="contact-avatar-img" src="${data.url}" alt="${headerInitial}" style="width:38px;height:38px;" onerror="this.style.display='none'">`;
          }
        }
      }).catch(() => {});
  }

  const messages = await get(`/api/chats/${encodeURIComponent(chatId)}/messages?connectionId=${_selectedConnectionId}`);
  const el = document.getElementById('chat-messages'); if (!el) return;
  if (messages.length === 0) {
    el.innerHTML = `<div style="margin:auto;text-align:center;color:#9ca3af;font-size:13px;">Nenhuma mensagem ainda</div>`;
  } else {
    el.innerHTML = messages.map(m => msgBubbleHTML(m)).join('');
    el.scrollTop = el.scrollHeight;
  }
}

// ── Chat Input HTML (three zones) ──────────────────────
function chatInputHTML() {
  return `
    <div class="chat-input-area" id="chat-input-area">

      <!-- Zone: Normal -->
      <div id="zone-normal" class="input-zone">
        <label class="attach-btn" for="file-input" title="Anexar arquivo">
          ${ICON.paperclip}
          <input type="file" id="file-input" style="display:none;"
                 accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.zip,.mp4,.mp3"
                 onchange="handleFileSelect(this)">
        </label>
        <div style="flex:1;display:flex;flex-direction:column;gap:4px;min-width:0;">
          <input type="text" class="chat-input" id="msg-input" placeholder="Digite uma mensagem..."
                 onkeydown="if(event.key==='Enter'&&!event.shiftKey){sendChatMessage();event.preventDefault();}">
          <div id="file-preview-bar" style="display:none;"></div>
        </div>
        <button id="mic-btn" class="mic-btn" onclick="startRecording()" title="Gravar mensagem de voz">
          ${ICON.mic}
        </button>
        <button class="send-btn" onclick="sendChatMessage()">
          ${ICON.send}
        </button>
      </div>

      <!-- Zone: Recording -->
      <div id="zone-recording" class="input-zone" style="display:none;">
        <div class="recording-bar" style="flex:1;">
          <div class="rec-dot"></div>
          <span id="rec-timer">00:00</span>
          <span style="color:#ef4444;font-size:12px;font-weight:400;">Gravando...</span>
        </div>
        <button class="mic-btn recording" onclick="stopRecording()" title="Parar gravação">
          ${ICON.stop}
        </button>
      </div>

      <!-- Zone: Preview (listen before sending) -->
      <div id="zone-preview" class="input-zone" style="display:none;">
        <div class="voice-preview-bar">
          <audio id="preview-audio" controls preload="auto" style="flex:1;height:32px;"></audio>
        </div>
        <button class="btn btn-sm btn-primary" onclick="confirmSendVoice()">Enviar</button>
        <button class="btn btn-sm btn-ghost" onclick="discardVoice()">Descartar</button>
      </div>

    </div>`;
}

function showInputZone(zone) {
  ['normal','recording','preview'].forEach(z => {
    const el = document.getElementById(`zone-${z}`);
    if (el) el.style.display = z === zone ? 'flex' : 'none';
  });
}

// ── Message Rendering ──────────────────────────────────
function appendMessage(msg) {
  const el = document.getElementById('chat-messages'); if (!el) return;
  el.insertAdjacentHTML('beforeend', msgBubbleHTML(msg));
  el.scrollTop = el.scrollHeight;
}

function msgBubbleHTML(msg) {
  const time = new Date(msg.timestamp * 1000).toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' });
  return `
    <div class="msg-wrap ${msg.fromMe?'msg-out':'msg-in'}">
      <div class="msg-bubble ${msg.fromMe?'msg-bubble-out':'msg-bubble-in'}">
        ${msgBodyHTML(msg)}<span class="msg-time">${time}</span>
      </div>
    </div>`;
}

function msgBodyHTML(msg) {
  const isVoice = msg.type === 'ptt' || msg.type === 'audio';

  if (isVoice) {
    const cachedUrl = _mediaUrls.get(msg.id);
    // Build the fallback URL with connectionId + chatId so server can fetch on demand
    const fallbackUrl = `/api/media/${encodeURIComponent(msg.id)}?connectionId=${encodeURIComponent(_selectedConnectionId||'')}&chatId=${encodeURIComponent(_selectedChatId||'')}`;
    const url = cachedUrl || fallbackUrl;

    const cachedTx = _transcriptions.get(msg.id);
    const txHTML = cachedTx
      ? `<div class="transcription">${transcriptionBadge()}"${esc(cachedTx)}"</div>`
      : _transcriptionEnabled
        ? `<div class="transcription-loading" data-transcribe="${msg.id}">Transcrevendo...</div>`
        : '';

    return `
      <div class="msg-audio">
        <div style="display:flex;align-items:center;gap:6px;font-size:12.5px;opacity:0.75;margin-bottom:2px;">
          ${ICON.wave} Mensagem de voz
        </div>
        ${audioPlayerHTML(msg.id, url)}
      </div>${txHTML}`;
  }

  if (msg.type === 'image' || msg.type === 'video' || msg.type === 'sticker') {
    const cachedUrl = _mediaUrls.get(msg.id);
    if (cachedUrl) return mediaElementHTML(msg.type, cachedUrl);
    // Placeholder while media loads
    const icon = msg.type === 'sticker' ? '🎭' : msg.type === 'video' ? '🎥' : '📷';
    return `<div data-media-id="${msg.id}" data-media-type="${msg.type}" class="msg-media-placeholder">
      <span style="font-size:12px;opacity:0.6;">${icon} Carregando...</span>
    </div>`;
  }
  if (msg.type === 'document') return `📄 ${esc(msg.body||'Arquivo')}`;
  return esc(msg.body || '');
}

function audioPlayerHTML(messageId, src) {
  return `<audio controls preload="none" src="${src}" data-audio-id="${messageId}"
    style="width:100%;height:36px;border-radius:8px;outline:none;display:block;"
    onerror="this.parentElement.innerHTML='<span style=\\'font-size:12px;opacity:0.6;\\'>⚠️ Áudio indisponível</span>'">
  </audio>`;
}

function mediaElementHTML(type, src) {
  if (type === 'video') {
    return `<video class="msg-video" controls preload="metadata" src="${src}"
      onerror="this.outerHTML='<span style=\\'font-size:12px;opacity:0.6;\\'>⚠️ Vídeo indisponível</span>'">
    </video>`;
  }
  // image and sticker
  return `<img class="msg-image" src="${src}" alt="${type === 'sticker' ? 'Sticker' : 'Imagem'}"
    onclick="window.open('${src}','_blank')"
    onerror="this.outerHTML='<span style=\\'font-size:12px;opacity:0.6;\\'>⚠️ Imagem indisponível</span>'">`;
}

function transcriptionBadge() {
  return `<span class="transcription-badge">✦ Whisper</span> `;
}

// ── File Attachment ────────────────────────────────────
function handleFileSelect(input) {
  _pendingFile = input.files[0]; if (!_pendingFile) return;
  const bar = document.getElementById('file-preview-bar');
  bar.style.display = 'flex';
  bar.innerHTML = `<div class="file-preview-bar" style="display:flex;align-items:center;gap:6px;width:100%;">
    <span>📎 ${esc(_pendingFile.name)}</span>
    <button onclick="clearPendingFile()" style="border:none;background:none;cursor:pointer;color:#764ba2;font-weight:700;margin-left:auto;">✕</button>
  </div>`;
}
function clearPendingFile() {
  _pendingFile = null;
  const bar = document.getElementById('file-preview-bar'); if (bar) bar.style.display = 'none';
  const input = document.getElementById('file-input'); if (input) input.value = '';
}

async function sendChatMessage() {
  if (!_selectedChatId) return;
  if (_pendingFile) { await sendMediaFile(); return; }
  const input = document.getElementById('msg-input');
  const text = input.value.trim(); if (!text) return;
  input.value = '';
  await fetch(`/api/chats/${encodeURIComponent(_selectedChatId)}/send`, {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ connectionId: _selectedConnectionId, text }),
  });
}

async function sendMediaFile() {
  if (!_pendingFile || !_selectedChatId) return;
  const fd = new FormData();
  fd.append('file', _pendingFile);
  fd.append('connectionId', _selectedConnectionId);
  clearPendingFile();
  await fetch(`/api/chats/${encodeURIComponent(_selectedChatId)}/send-media`, { method:'POST', body:fd });
}

// ── Voice Recording ────────────────────────────────────
async function startRecording() {
  if (!_selectedChatId) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    _audioChunks = []; _recSeconds = 0;

    // Pick the best supported format
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';

    _mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    _mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) _audioChunks.push(e.data); };

    _mediaRecorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(_audioChunks, { type: _mediaRecorder.mimeType || 'audio/webm' });
      _pendingVoiceBlob = blob;
      if (_pendingVoiceBlobUrl) URL.revokeObjectURL(_pendingVoiceBlobUrl);
      _pendingVoiceBlobUrl = URL.createObjectURL(blob);
      showInputZone('preview');
      const audio = document.getElementById('preview-audio');
      if (audio) { audio.src = _pendingVoiceBlobUrl; audio.load(); }
    };

    _mediaRecorder.start(100);
    showInputZone('recording');
    _isRecording = true;

    _recInterval = setInterval(() => {
      _recSeconds++;
      const mm = String(Math.floor(_recSeconds/60)).padStart(2,'0');
      const ss = String(_recSeconds%60).padStart(2,'0');
      const el = document.getElementById('rec-timer'); if (el) el.textContent = `${mm}:${ss}`;
    }, 1000);

  } catch (e) { alert('Não foi possível acessar o microfone.\n' + e.message); }
}

function stopRecording() {
  clearInterval(_recInterval);
  _isRecording = false;
  if (_mediaRecorder && _mediaRecorder.state !== 'inactive') _mediaRecorder.stop();
  // UI switches to 'preview' zone inside onstop handler
}

async function confirmSendVoice() {
  if (!_pendingVoiceBlob || !_selectedChatId) return;
  showInputZone('normal');
  const blob = _pendingVoiceBlob;
  _pendingVoiceBlob = null;

  const fd = new FormData();
  fd.append('audio', blob, 'voice.webm');
  fd.append('connectionId', _selectedConnectionId);
  fd.append('mimeType', blob.type || 'audio/webm');

  // Optimistically show a "sending..." indicator
  const el = document.getElementById('chat-messages');
  const tempId = `temp_${Date.now()}`;
  if (el) {
    el.insertAdjacentHTML('beforeend', `
      <div class="msg-wrap msg-out" id="${tempId}">
        <div class="msg-bubble msg-bubble-out" style="opacity:0.5;font-size:12.5px;">
          ${ICON.wave} Enviando áudio...
        </div>
      </div>`);
    el.scrollTop = el.scrollHeight;
  }

  await fetch(`/api/chats/${encodeURIComponent(_selectedChatId)}/send-voice`, { method:'POST', body:fd });

  // Remove placeholder (real bubble arrives via socket new-message)
  const temp = document.getElementById(tempId);
  if (temp) temp.remove();
}

function discardVoice() {
  _pendingVoiceBlob = null;
  if (_pendingVoiceBlobUrl) { URL.revokeObjectURL(_pendingVoiceBlobUrl); _pendingVoiceBlobUrl = null; }
  const audio = document.getElementById('preview-audio'); if (audio) { audio.pause(); audio.src = ''; }
  showInputZone('normal');
}

// ── Modal ──────────────────────────────────────────────
function openModal(html) {
  document.getElementById('modal-content').innerHTML = html;
  document.getElementById('modal').classList.remove('hidden');
}
function closeModal() {
  document.getElementById('modal').classList.add('hidden');
  pendingQRId = null;
}
document.getElementById('modal').addEventListener('click', (e) => {
  if (e.target === document.getElementById('modal')) closeModal();
});

// ── Utils ──────────────────────────────────────────────
function chatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000), now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit' })
    : d.toLocaleDateString('pt-BR', { day:'2-digit', month:'2-digit' });
}
function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
async function get(url)        { return fetch(url).then(r => r.json()); }
async function post(url, body) { return fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) }).then(r => r.json()); }

// ── Boot ───────────────────────────────────────────────
navigate('dashboard');
