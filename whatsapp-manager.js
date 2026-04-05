const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

const MEDIA_DIR = path.join(__dirname, 'uploads', 'media');

// Ensure media directory exists
if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

function mimeToExt(mime) {
  if (!mime) return 'bin';
  if (mime.startsWith('audio/ogg'))  return 'ogg';
  if (mime.startsWith('audio/webm')) return 'webm';
  if (mime.startsWith('audio/mpeg') || mime.startsWith('audio/mp3')) return 'mp3';
  if (mime.startsWith('audio/mp4'))  return 'mp4';
  if (mime.startsWith('image/jpeg')) return 'jpg';
  if (mime.startsWith('image/png'))  return 'png';
  if (mime.startsWith('image/gif'))  return 'gif';
  if (mime.startsWith('image/webp')) return 'webp';
  if (mime.startsWith('video/mp4'))  return 'mp4';
  if (mime.startsWith('video/webm')) return 'webm';
  return mime.split('/')[1]?.split(';')[0] || 'bin';
}

function saveMediaToDisk(messageId, data, mimetype) {
  try {
    const ext = mimeToExt(mimetype);
    const filePath = path.join(MEDIA_DIR, `${messageId}.${ext}`);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, Buffer.from(data, 'base64'));
    }
    return filePath;
  } catch (e) {
    console.error('saveMediaToDisk error:', e.message);
    return null;
  }
}

class WhatsAppManager {
  constructor(io, rulesPath, transcribe = null) {
    this.io = io;
    this.rulesPath = rulesPath;
    this.transcribe = transcribe;
    this.clients = new Map();
    this.lastQR = new Map();
    this.mediaCache = new Map(); // messageId -> { data: base64, mimetype }
  }

  createClient(id, name) {
    const client = new Client({
      authStrategy: new LocalAuth({ clientId: id }),
      puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] },
    });

    const info = { client, status: 'initializing', name };
    this.clients.set(id, info);

    client.on('qr', async (qr) => {
      info.status = 'qr';
      const qrImage = await qrcode.toDataURL(qr);
      this.lastQR.set(id, qrImage);
      this.io.emit('qr', { id, qrImage });
      this.io.emit('connections-update', this.getAll());
    });

    client.on('ready', () => {
      info.status = 'connected';
      this.lastQR.delete(id);
      this.io.emit('connections-update', this.getAll());
    });

    client.on('auth_failure', () => {
      info.status = 'auth_failure';
      this.io.emit('connections-update', this.getAll());
    });

    client.on('disconnected', () => {
      info.status = 'disconnected';
      this.io.emit('connections-update', this.getAll());
    });

    // Chatbot: keyword-based auto-reply
    client.on('message', (msg) => this.handleMessage(msg));

    // Live Chat + media caching + transcription
    client.on('message_create', async (msg) => {
      const chatId = msg.fromMe ? msg.to : msg.from;
      const msgData = {
        id: msg.id._serialized,
        body: msg.body || '',
        timestamp: msg.timestamp,
        fromMe: msg.fromMe,
        type: msg.type,
        hasMedia: msg.hasMedia,
      };

      this.io.emit('new-message', { connectionId: id, chatId, message: msgData });

      // Download and cache all incoming media types
      const mediaTypes = ['ptt', 'audio', 'image', 'video', 'sticker', 'document'];
      if (!msg.fromMe && msg.hasMedia && mediaTypes.includes(msg.type)) {
        try {
          const media = await msg.downloadMedia();
          if (media) {
            this.mediaCache.set(msg.id._serialized, { data: media.data, mimetype: media.mimetype });
            saveMediaToDisk(msg.id._serialized, media.data, media.mimetype);

            this.io.emit('media-ready', {
              connectionId: id,
              chatId,
              messageId: msg.id._serialized,
              mediaUrl: `/api/media/${encodeURIComponent(msg.id._serialized)}`,
              type: msg.type,
            });

            // Transcribe voice messages
            if ((msg.type === 'ptt' || msg.type === 'audio') && this.transcribe) {
              try {
                const buffer = Buffer.from(media.data, 'base64');
                const ext = mimeToExt(media.mimetype);
                const text = await this.transcribe(buffer, `voice.${ext}`);
                if (text) {
                  this.io.emit('voice-transcription', {
                    connectionId: id, chatId,
                    messageId: msg.id._serialized, text,
                  });
                }
              } catch (e) {
                console.error('Transcription error (incoming):', e.message);
              }
            }
          }
        } catch (e) {
          console.error('Media download error:', e.message);
        }
      }
    });

    client.initialize();
  }

  handleMessage(msg) {
    try {
      const rules = JSON.parse(fs.readFileSync(this.rulesPath, 'utf-8'));
      for (const rule of rules) {
        if (msg.body && msg.body.toLowerCase().includes(rule.keyword.toLowerCase())) {
          msg.reply(rule.response);
          break;
        }
      }
    } catch (e) {
      console.error('Chatbot error:', e.message);
    }
  }

  // ── Media cache ──────────────────────────────────────
  cacheMedia(messageId, media) {
    this.mediaCache.set(messageId, media);
  }

  getMediaFromCache(messageId) {
    return this.mediaCache.get(messageId) || null;
  }

  getMediaFromDisk(messageId) {
    try {
      const files = fs.readdirSync(MEDIA_DIR);
      const match = files.find(f => f.startsWith(messageId + '.') || f.startsWith(messageId));
      if (!match) return null;
      const filePath = path.join(MEDIA_DIR, match);
      const ext = path.extname(match).slice(1);
      const mimeMap = { ogg:'audio/ogg', webm:'audio/webm', mp3:'audio/mpeg', mp4:'video/mp4',
        jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif', webp:'image/webp' };
      const mimetype = mimeMap[ext] || 'application/octet-stream';
      return { data: fs.readFileSync(filePath).toString('base64'), mimetype };
    } catch { return null; }
  }

  async getMessageMedia(connectionId, chatId, messageId) {
    // 1. Memory cache
    const cached = this.mediaCache.get(messageId);
    if (cached) return cached;

    // 2. Disk cache
    const fromDisk = this.getMediaFromDisk(messageId);
    if (fromDisk) {
      this.mediaCache.set(messageId, fromDisk);
      return fromDisk;
    }

    // 3. Fetch from WhatsApp on demand
    const info = this.clients.get(connectionId);
    if (!info || info.status !== 'connected') return null;
    try {
      const chat = await info.client.getChatById(chatId);
      const messages = await chat.fetchMessages({ limit: 60 });
      const msg = messages.find(m => m.id._serialized === messageId);
      if (!msg || !msg.hasMedia) return null;
      const media = await msg.downloadMedia();
      if (media) {
        this.mediaCache.set(messageId, { data: media.data, mimetype: media.mimetype });
        saveMediaToDisk(messageId, media.data, media.mimetype);
        return { data: media.data, mimetype: media.mimetype };
      }
    } catch (e) {
      console.error('getMessageMedia error:', e.message);
    }
    return null;
  }

  // ── Profile pictures ─────────────────────────────────
  async getProfilePicUrl(connectionId, chatId) {
    const info = this.clients.get(connectionId);
    if (!info || info.status !== 'connected') return null;
    try {
      return await info.client.getProfilePicUrl(chatId);
    } catch { return null; }
  }

  // ── Chat helpers ─────────────────────────────────────
  async getChats(connectionId) {
    const info = this.clients.get(connectionId);
    if (!info || info.status !== 'connected') return [];
    try {
      const chats = await info.client.getChats();
      return chats.slice(0, 50).map(chat => ({
        id: chat.id._serialized,
        name: chat.name || chat.id.user,
        lastMessage: chat.lastMessage ? {
          body: chat.lastMessage.body || '',
          timestamp: chat.lastMessage.timestamp,
          fromMe: chat.lastMessage.fromMe,
        } : null,
        unreadCount: chat.unreadCount,
        isGroup: chat.isGroup,
      }));
    } catch (e) {
      console.error('getChats error:', e.message);
      return [];
    }
  }

  async getMessages(connectionId, chatId, limit = 40) {
    const info = this.clients.get(connectionId);
    if (!info || info.status !== 'connected') return [];
    try {
      const chat = await info.client.getChatById(chatId);
      const messages = await chat.fetchMessages({ limit });
      return messages.map(msg => ({
        id: msg.id._serialized,
        body: msg.body || '',
        timestamp: msg.timestamp,
        fromMe: msg.fromMe,
        type: msg.type,
        hasMedia: msg.hasMedia,
      }));
    } catch (e) {
      console.error('getMessages error:', e.message);
      return [];
    }
  }

  async sendText(connectionId, chatId, text) {
    const info = this.clients.get(connectionId);
    if (!info || info.status !== 'connected') throw new Error('Conexão não disponível');
    return info.client.sendMessage(chatId, text);
  }

  async sendMedia(connectionId, chatId, filePath, mimetype, filename) {
    const info = this.clients.get(connectionId);
    if (!info || info.status !== 'connected') throw new Error('Conexão não disponível');
    const media = MessageMedia.fromFilePath(filePath);
    media.filename = filename;
    return info.client.sendMessage(chatId, media);
  }

  async sendVoice(connectionId, chatId, audioBuffer, filename, mimeType) {
    const info = this.clients.get(connectionId);
    if (!info || info.status !== 'connected') throw new Error('Conexão não disponível');
    const base64 = audioBuffer.toString('base64');
    // Use the actual MIME type from the browser (audio/webm) — WhatsApp will re-encode it
    const mime = mimeType || 'audio/webm';
    const media = new MessageMedia(mime, base64, filename || 'voice.ogg');
    return info.client.sendMessage(chatId, media, { sendAudioAsVoice: true });
  }

  async destroyClient(id) {
    if (this.clients.has(id)) {
      try { await this.clients.get(id).client.destroy(); } catch {}
      this.clients.delete(id);
      this.lastQR.delete(id);
    }
  }

  getAll() {
    return Array.from(this.clients.entries()).map(([id, d]) => ({
      id, name: d.name, status: d.status,
    }));
  }

  getLastQR(id) { return this.lastQR.get(id) || null; }
}

module.exports = WhatsAppManager;
