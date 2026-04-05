require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const WhatsAppManager = require('./whatsapp-manager');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = 3000;

const LEADS_PATH       = path.join(__dirname, 'leads.json');
const RULES_PATH       = path.join(__dirname, 'rules.json');
const CONNECTIONS_PATH = path.join(__dirname, 'connections.json');
const UPLOADS_DIR      = path.join(__dirname, 'uploads');
const MEDIA_DIR        = path.join(__dirname, 'uploads', 'media');

// Ensure directories exist
[UPLOADS_DIR, MEDIA_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

const upload = multer({ dest: UPLOADS_DIR });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const readJSON  = (p) => JSON.parse(fs.readFileSync(p, 'utf-8'));
const writeJSON = (p, d) => fs.writeFileSync(p, JSON.stringify(d, null, 2));

// ── Whisper ────────────────────────────────────────────
let openaiClient = null;
if (process.env.OPENAI_API_KEY) {
  const { OpenAI } = require('openai');
  openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  console.log('✅ OpenAI Whisper habilitado — transcrições automáticas ativas');
} else {
  console.log('ℹ️  OPENAI_API_KEY não configurada — transcrições desativadas');
}

async function transcribeAudio(buffer, filename) {
  if (!openaiClient) return null;
  const tmpPath = path.join(UPLOADS_DIR, `whisper_${Date.now()}_${filename}`);
  try {
    fs.writeFileSync(tmpPath, buffer);
    const result = await openaiClient.audio.transcriptions.create({
      file: fs.createReadStream(tmpPath),
      model: 'whisper-1',
      language: 'pt',
    });
    return result.text || null;
  } catch (e) {
    console.error('Whisper API error:', e.message);
    return null;
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

// ── Manager ────────────────────────────────────────────
const manager = new WhatsAppManager(io, RULES_PATH, transcribeAudio);

io.on('connection', (socket) => {
  socket.emit('connections-update', manager.getAll());
  socket.emit('transcription-status', { enabled: !!openaiClient });
});

// ── Stats ──────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const connections = manager.getAll();
  res.json({
    leads: readJSON(LEADS_PATH).length,
    rules: readJSON(RULES_PATH).length,
    activeConnections: connections.filter(c => c.status === 'connected').length,
    totalConnections: connections.length,
  });
});

// ── Connections ────────────────────────────────────────
app.get('/api/connections', (req, res) => res.json(manager.getAll()));

app.post('/api/connections', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Nome obrigatório' });
  const id = `conn_${Date.now()}`;
  const connections = readJSON(CONNECTIONS_PATH);
  connections.push({ id, name, createdAt: new Date().toISOString() });
  writeJSON(CONNECTIONS_PATH, connections);
  manager.createClient(id, name);
  res.json({ id, name, status: 'initializing' });
});

app.get('/api/connections/:id/qr', (req, res) => {
  const qrImage = manager.getLastQR(req.params.id);
  if (!qrImage) return res.status(404).json({ error: 'QR não disponível' });
  res.json({ qrImage });
});

app.delete('/api/connections/:id', async (req, res) => {
  const { id } = req.params;
  await manager.destroyClient(id);
  writeJSON(CONNECTIONS_PATH, readJSON(CONNECTIONS_PATH).filter(c => c.id !== id));
  io.emit('connections-update', manager.getAll());
  res.json({ ok: true });
});

// ── Rules ──────────────────────────────────────────────
app.get('/api/rules', (req, res) => res.json(readJSON(RULES_PATH)));

app.post('/api/rules', (req, res) => {
  const { keyword, response } = req.body;
  if (!keyword || !response) return res.status(400).json({ error: 'Campos obrigatórios' });
  const rules = readJSON(RULES_PATH);
  const rule = { id: Date.now(), keyword: keyword.trim(), response: response.trim(), createdAt: new Date().toISOString() };
  rules.push(rule);
  writeJSON(RULES_PATH, rules);
  res.json(rule);
});

app.put('/api/rules/:id', (req, res) => {
  const rules = readJSON(RULES_PATH);
  const idx = rules.findIndex(r => r.id == req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Não encontrado' });
  rules[idx] = { ...rules[idx], keyword: req.body.keyword.trim(), response: req.body.response.trim() };
  writeJSON(RULES_PATH, rules);
  res.json(rules[idx]);
});

app.delete('/api/rules/:id', (req, res) => {
  writeJSON(RULES_PATH, readJSON(RULES_PATH).filter(r => r.id != req.params.id));
  res.json({ ok: true });
});

// ── Leads ──────────────────────────────────────────────
app.get('/api/leads', (req, res) => res.json(readJSON(LEADS_PATH)));

app.post('/api/leads', (req, res) => {
  const { name, investment } = req.body;
  if (!name || !investment) return res.status(400).json({ error: 'Campos obrigatórios' });
  const leads = readJSON(LEADS_PATH);
  const lead = { id: Date.now(), name: name.trim(), investment: parseFloat(investment), createdAt: new Date().toISOString() };
  leads.push(lead);
  writeJSON(LEADS_PATH, leads);
  res.json(lead);
});

app.delete('/api/leads/:id', (req, res) => {
  writeJSON(LEADS_PATH, readJSON(LEADS_PATH).filter(l => l.id != req.params.id));
  res.json({ ok: true });
});

// ── Media (serve cached audio) ─────────────────────────
app.get('/api/media/:messageId', async (req, res) => {
  const { connectionId, chatId } = req.query;
  const messageId = decodeURIComponent(req.params.messageId);

  try {
    const media = await manager.getMessageMedia(connectionId, chatId, messageId);
    if (!media) return res.status(404).send('Media not found');
    const buffer = Buffer.from(media.data, 'base64');
    // Normalise MIME: browsers need a clean type to decode audio
    let mime = media.mimetype || 'audio/ogg';
    if (mime.startsWith('audio/ogg')) mime = 'audio/ogg';
    else if (mime.startsWith('audio/webm')) mime = 'audio/webm';
    else if (mime.startsWith('audio/mpeg') || mime.startsWith('audio/mp3')) mime = 'audio/mpeg';
    else if (mime.startsWith('audio/mp4')) mime = 'audio/mp4';
    res.set('Content-Type', mime);
    res.set('Content-Length', buffer.length);
    res.set('Accept-Ranges', 'bytes');
    res.set('Cache-Control', 'private, max-age=3600');
    res.send(buffer);
  } catch (e) {
    res.status(500).send(e.message);
  }
});

// ── Profile Pictures ───────────────────────────────────
app.get('/api/contacts/:chatId/photo', async (req, res) => {
  const { connectionId } = req.query;
  const chatId = decodeURIComponent(req.params.chatId);
  const url = await manager.getProfilePicUrl(connectionId, chatId);
  if (!url) return res.status(404).json({ error: 'No photo' });
  res.json({ url });
});

// ── Live Chat ──────────────────────────────────────────
app.get('/api/chats', async (req, res) => {
  const { connectionId } = req.query;
  if (!connectionId) return res.status(400).json({ error: 'connectionId required' });
  res.json(await manager.getChats(connectionId));
});

app.get('/api/chats/:chatId/messages', async (req, res) => {
  const { connectionId } = req.query;
  if (!connectionId) return res.status(400).json({ error: 'connectionId required' });
  res.json(await manager.getMessages(connectionId, req.params.chatId));
});

app.post('/api/chats/:chatId/send', async (req, res) => {
  const { connectionId, text } = req.body;
  try {
    await manager.sendText(connectionId, req.params.chatId, text);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/chats/:chatId/send-media', upload.single('file'), async (req, res) => {
  const { connectionId } = req.body;
  try {
    await manager.sendMedia(connectionId, req.params.chatId, req.file.path, req.file.mimetype, req.file.originalname);
    fs.unlinkSync(req.file.path);
    res.json({ ok: true });
  } catch (e) {
    try { fs.unlinkSync(req.file.path); } catch {}
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/chats/:chatId/send-voice', upload.single('audio'), async (req, res) => {
  const { connectionId, mimeType } = req.body;
  const chatId = req.params.chatId;
  const actualMime = mimeType || 'audio/webm';
  try {
    const audioBuffer = fs.readFileSync(req.file.path);
    const sentMsg = await manager.sendVoice(connectionId, chatId, audioBuffer, 'voice.ogg', actualMime);

    if (sentMsg) {
      const messageId = sentMsg.id._serialized;

      // Cache the original audio so the browser can play it back immediately
      manager.cacheMedia(messageId, { data: audioBuffer.toString('base64'), mimetype: actualMime });
      io.emit('media-ready', {
        connectionId,
        chatId,
        messageId,
        mediaUrl: `/api/media/${encodeURIComponent(messageId)}`,
        type: 'ptt',
      });

      // Transcribe async
      if (openaiClient) {
        const ext = actualMime.includes('webm') ? 'webm' : 'ogg';
        transcribeAudio(audioBuffer, `voice.${ext}`).then(text => {
          if (text) io.emit('voice-transcription', { connectionId, chatId, messageId, text });
        }).catch(e => console.error('Transcription error (outgoing):', e.message));
      }
    }

    fs.unlinkSync(req.file.path);
    res.json({ ok: true });
  } catch (e) {
    try { fs.unlinkSync(req.file.path); } catch {}
    res.status(500).json({ error: e.message });
  }
});

// ── Boot ───────────────────────────────────────────────
readJSON(CONNECTIONS_PATH).forEach(c => manager.createClient(c.id, c.name));

server.listen(PORT, () => {
  console.log(`CRM da Júlia rodando em http://localhost:${PORT}`);
});
