const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
});

client.on('qr', (qr) => {
  console.log('\n📱 Escaneie o QR Code abaixo com o WhatsApp:\n');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('✅ WhatsApp conectado com sucesso! CRM pronto para enviar mensagens.');
});

client.on('auth_failure', () => {
  console.error('❌ Falha na autenticação. Tente novamente.');
});

client.on('disconnected', (reason) => {
  console.warn('⚠️  Cliente desconectado:', reason);
});

client.initialize();
