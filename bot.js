require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const NodeCache = require('node-cache');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const http = require('http');

const QRCode = require('qrcode');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON);
const GROUP_ALLOWED = process.env.GROUP_ONLY === 'true';
const SERVER_IP = process.env.SERVER_IP || 'play.klitikcraft.web.id';
const ADMIN_NUMBERS = ['6285771093400', '6285722659927', '6285885575754'];
const SERVER_NAME = process.env.SERVER_NAME || 'KlitikCraft Indonesia';
const SERVER_ID = parseInt(process.env.SERVER_ID) || 1;
const DISCORD_URL = process.env.DISCORD_URL || 'https://discord.gg/klitikcraft';
const WEBSITE_URL = process.env.WEBSITE_URL || 'https://www.klitikcraft.web.id';

const httpServer = http.createServer((req, res) => {
    if (req.url === '/qr') {
        const qrPath = path.join(__dirname, 'qr.png');
        if (fs.existsSync(qrPath)) {
            res.writeHead(200, { 'Content-Type': 'image/png' });
            fs.createReadStream(qrPath).pipe(res);
        } else {
            res.writeHead(404);
            res.end('QR not ready');
        }
    } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('WA Bot Running. Visit /qr for QR code.');
    }
});
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log('HTTP server on port ' + PORT));

const RULES = [
    '1. Dilarang cheating/hacking',
    '2. Dilarang griefing rumah player lain',
    '3. Dilarang spam chat',
    '4. Dilarang scamming/menipu',
    '5. Hormati player lain',
    '6. Ikuti kata admin',
    '7. Dilarang toxic/rasis',
    '8. Dilarang AFK farming'
];

function normalizePhone(raw) {
    if (!raw) return '';
    const digits = String(raw).replace(/\D/g, '');
    if (!digits) return '';
    if (digits.startsWith('62')) return digits;
    if (digits.startsWith('0')) return `62${digits.slice(1)}`;
    return digits;
}

const OWNER_NUMBER = normalizePhone(process.env.OWNER_NUMBER);
const msgRetryCounterCache = new NodeCache();
const useStore = !process.env.USE_STORE || process.env.USE_STORE !== 'false';

let lastAlertTime = 0;
let lastServerOnline = null;
const ALERT_COOLDOWN = 300000;

async function getServerStatus() {
    try {
        const { data, error } = await supabase.from('server_state').select('*').eq('id', SERVER_ID).single();
        if (error || !data) return null;
        return data;
    } catch { return null; }
}

async function getPlayerList() {
    try {
        const { data, error } = await supabase.from('server_state').select('players').eq('id', SERVER_ID).single();
        if (error || !data || !Array.isArray(data.players)) return [];
        return data.players;
    } catch { return []; }
}

async function sendCommandToServer(command) {
    try {
        const { error } = await supabase.from('admin_commands').insert({ command: command });
        return !error;
    } catch { return false; }
}

function formatStatus(data) {
    if (!data) return '❌ Gagal mengambil data server.';
    const online = data.online ? '🟢 Online' : '🔴 Offline';
    const players = `${data.players_online || 0}/${data.players_max || 0}`;
    const tps = typeof data.tps === 'number' ? data.tps.toFixed(2) : '-';
    const ping = data.server_ping_ms || 0;
    const version = data.minecraft_version || '-';
    const world = data.world_name || '-';

    let uptime = '-';
    if (data.uptime_start) {
        const diff = Date.now() - new Date(data.uptime_start).getTime();
        const days = Math.floor(diff / 86400000);
        const hours = Math.floor((diff % 86400000) / 3600000);
        const mins = Math.floor((diff % 3600000) / 60000);
        uptime = `${days}h ${hours}j ${mins}m`;
    }

    return [
        `*${SERVER_NAME}*`,
        '',
        `Status: ${online}`,
        `Players: ${players}`,
        `TPS: ${tps}`,
        `Ping: ${ping}ms`,
        `Version: ${version}`,
        `World: ${world}`,
        `Uptime: ${uptime}`,
        '',
        `IP: ${SERVER_IP}`
    ].join('\n');
}

function formatPlayerList(players) {
    if (!players || players.length === 0) return '😴 Tidak ada pemain online.';
    const list = players.map(p => `• ${p.name || p}`).join('\n');
    return `*Pemain Online (${players.length})*\n\n${list}`;
}

function formatHelp() {
    return [
        `*${SERVER_NAME} - Commands*`,
        '',
        '📌 *Info Server*',
        `  !status  - Status server`,
        `  !players - List pemain online`,
        `  !ping    - Cek latency bot`,
        '',
        '📌 *Tentang Server*',
        `  !rules   - Peraturan server`,
        `  !info    - Info server & links`,
        '',
        '📌 *Admin Only*',
        `  !restart  - Restart server`,
        `  !kick @user - Kick player`,
        `  !ban @user  - Ban player`,
        `  !broadcast pesan - Broadcast`,
        '',
        `🌐 Website: ${WEBSITE_URL}`,
        `💬 Discord: ${DISCORD_URL}`
    ].join('\n');
}

function formatRules() {
    return [
        `*${SERVER_NAME} - Rules*`,
        '',
        ...RULES,
        '',
        'Pelanggaran = kick/ban tanpa peringatan!'
    ].join('\n');
}

function formatInfo() {
    return [
        `*${SERVER_NAME}*`,
        '',
        `🌐 Website: ${WEBSITE_URL}`,
        `💬 Discord: ${DISCORD_URL}`,
        `🎮 IP Server: ${SERVER_IP}`,
        `📦 Version: 1.20.4`,
        '',
        'Join sekarang dan bermain bersama!'
    ].join('\n');
}

function isAdmin(msg) {
    const rawSender = msg.key.participant || msg.key.remoteJid || '';
    const sender = normalizePhone(rawSender.replace(/@.+/, ''));
    return sender && (ADMIN_NUMBERS.includes(sender) || sender === OWNER_NUMBER);
}

async function checkPerformanceAlerts(sock) {
    if (!process.env.ALERT_GROUP_JID) return;
    const now = Date.now();
    if (now - lastAlertTime < ALERT_COOLDOWN) return;

    const status = await getServerStatus();
    if (!status || !status.online) return;

    const tps = status.tps || 20;
    const ping = status.server_ping_ms || 0;

    let alert = null;
    if (tps < 18) alert = `⚠️ *PERINGATAN TPS RENDAH*\n\nTPS: ${tps.toFixed(2)} ( minimum 18)\nServer mungkin lag.`;
    else if (ping > 200) alert = `⚠️ *PERINGATAN PING TINGGI*\n\nPing: ${ping}ms (maks 200ms)\nServer mungkin lag.`;

    if (alert) {
        try {
            await sock.sendMessage(process.env.ALERT_GROUP_JID, { text: alert });
            lastAlertTime = now;
        } catch (e) { console.error('Alert error:', e.message); }
    }
}

async function checkServerStatus(sock) {
    const groupJid = process.env.ANNOUNCE_GROUP_JID;
    if (!groupJid) return;

    const status = await getServerStatus();
    if (!status) return;

    const isOnline = status.online;
    if (lastServerOnline === isOnline) return;
    lastServerOnline = isOnline;

    const players = status.players_online || 0;
    const max = status.players_max || 0;

    let msg;
    if (isOnline) {
        msg = `🟢 *SERVER ONLINE*\n\nServer ${SERVER_NAME} sudah menyala!\nPlayers: ${players}/${max}\nIP: ${SERVER_IP}`;
    } else {
        msg = `🔴 *SERVER OFFLINE*\n\nServer ${SERVER_NAME} sedang mati.\nNantikan kembali!`;
    }

    try {
        await sock.sendMessage(groupJid, { text: msg });
    } catch (e) {
        console.error('Announce error:', e.message);
    }
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'auth_info'));
    const { version, isLatest } = await fetchLatestBaileysVersion();

    console.log(`Using WA v${version.join('.')}, isLatest: ${isLatest}`);

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
        },
        msgRetryCounterCache,
        generateHighQualityLinkPreview: false,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            const qrPath = path.join(__dirname, 'qr.png');
            await QRCode.toFile(qrPath, qr, { width: 300, margin: 2 });
            console.log('QR code saved to qr.png');
            console.log('Scan this QR with WhatsApp.');
        }
        if (connection === 'close') {
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            if (reason === DisconnectReason.loggedOut) {
                console.log('Logged out. Delete auth_info and restart.');
                process.exit(1);
            }
            console.log('Reconnecting...');
            startBot();
        } else if (connection === 'open') {
            console.log('WhatsApp bot connected!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            if (!msg.message) continue;
            if (msg.key.fromMe) continue;
            if (msg.key.remoteJid === 'status@broadcast') continue;

            const from = msg.key.remoteJid;
            const isGroup = from.endsWith('@g.us');
            const sender = msg.key.participant || msg.key.remoteJid;
            const body = msg.message.conversation || msg.message.extendedTextMessage?.text || '';

            if (!body) continue;
            const cmd = body.toLowerCase().trim();
            const args = body.slice(body.indexOf(' ') + 1).trim();

            try {
                if (cmd === '!ping') {
                    const start = Date.now();
                    await sock.sendMessage(from, { text: 'Pinging...' });
                    const ms = Date.now() - start;
                    await sock.sendMessage(from, { text: `*Pong!* ${ms}ms` });
                    continue;
                }

                if (cmd === '!status') {
                    await sock.sendMessage(from, { text: '⏳ Mengambil data server...' });
                    const status = await getServerStatus();
                    await sock.sendMessage(from, { text: formatStatus(status) });
                    continue;
                }

                if (cmd === '!players') {
                    await sock.sendMessage(from, { text: '⏳ Mengambil data pemain...' });
                    const players = await getPlayerList();
                    await sock.sendMessage(from, { text: formatPlayerList(players) });
                    continue;
                }

                if (cmd === '!help') {
                    await sock.sendMessage(from, { text: formatHelp() });
                    continue;
                }

                if (cmd === '!rules') {
                    await sock.sendMessage(from, { text: formatRules() });
                    continue;
                }

                if (cmd === '!info') {
                    await sock.sendMessage(from, { text: formatInfo() });
                    continue;
                }

                if (cmd === '!restart') {
                    if (!isAdmin(msg)) {
                        await sock.sendMessage(from, { text: '❌ Hanya admin yang bisa pakai command ini.' });
                        continue;
                    }
                    await sock.sendMessage(from, { text: '🔄 Restarting server...' });
                    const ok = await sendCommandToServer('RESTART');
                    if (ok) await sock.sendMessage(from, { text: '✅ Perintah restart dikirim.' });
                    else await sock.sendMessage(from, { text: '❌ Gagal mengirim perintah restart.' });
                    continue;
                }

                if (cmd === '!kick' && args) {
                    if (!isAdmin(msg)) {
                        await sock.sendMessage(from, { text: '❌ Hanya admin yang bisa pakai command ini.' });
                        continue;
                    }
                    const target = args.replace(/@/g, '').split(' ')[0];
                    await sendCommandToServer(`KICK|${target}`);
                    await sock.sendMessage(from, { text: `✅ Kick request: ${target}` });
                    continue;
                }

                if (cmd === '!ban' && args) {
                    if (!isAdmin(msg)) {
                        await sock.sendMessage(from, { text: '❌ Hanya admin yang bisa pakai command ini.' });
                        continue;
                    }
                    const target = args.replace(/@/g, '').split(' ')[0];
                    await sendCommandToServer(`BAN|${target}`);
                    await sock.sendMessage(from, { text: `✅ Ban request: ${target}` });
                    continue;
                }

                if (cmd.startsWith('!broadcast ') && args) {
                    if (!isAdmin(msg)) {
                        await sock.sendMessage(from, { text: '❌ Hanya admin yang bisa pakai command ini.' });
                        continue;
                    }
                    const message = args;
                    await sendCommandToServer(`ATTENTION_ALL|📢 BROADCAST\n${message}`);
                    await sock.sendMessage(from, { text: `✅ Broadcast dikirim: ${message}` });
                    continue;
                }

                if (isGroup && !GROUP_ALLOWED) continue;

            } catch (err) {
                console.error('Message error:', err.message);
            }
        }
    });

    setInterval(() => checkPerformanceAlerts(sock), 60000);
    setInterval(() => checkServerStatus(sock), 30000);
    console.log('Bot started. Waiting for QR code...');
}

startBot().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
