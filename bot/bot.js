// ============================================================
// SEW QUEEN WHATSAPP BOT
// Modular command system + Website QR/Pairing support
// Baileys: @whiskeysockets/baileys 7.x
// ============================================================

const fs = require('fs');
const path = require('path');
const axios = require('axios'); // HTTP Requests සඳහා අලුතින් එකතු කළා

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    proto,
    generateWAMessageFromContent,
    prepareWAMessageMedia
} = require('@whiskeysockets/baileys');

const QRCode = require('qrcode');
const pino = require('pino');

require('dotenv').config();

// ============================================================
// CONFIG
// ============================================================

const ROOT_DIR = __dirname;
const AUTH_DIR = path.join(ROOT_DIR, 'auth_info');
const COMMANDS_DIR = path.join(ROOT_DIR, 'commands');

// 🌟 ඔබේ වෙබ්සයිට් එකේ URL එක මෙතනට දාන්න
const WEBSITE_URL = 'https://sewqueen.freedev.app';

const RECONNECT_DELAY = Number(process.env.RECONNECT_DELAY || 5000);
const PAIR_POLL_INTERVAL = Number(process.env.PAIR_POLL_INTERVAL || 15000);
const MENU_COOLDOWN = Number(process.env.MENU_COOLDOWN || 30000);

// ============================================================
// GLOBAL STATE
// ============================================================

let sock = null;
let authState = null;
let isReady = false;
let reconnectTimer = null;
let pairingTimer = null;
let pairingInProgress = false;
let stopping = false;

const userSessions = new Map();
const commandRegistry = new Map();
const buttonRegistry = new Map();
const buttonPrefixRegistry = [];
const buttonLabelMap = new Map();

// ============================================================
// DATABASE (HTTP API මගින් වෙබ්සයිට් එකට සම්බන්ධ වීම)
// ============================================================

// Settings කියවීම (වෙබ්සයිට් එකෙන්)
async function getSetting(settingName, defaultValue = null) {
    try {
        const res = await axios.get(`${WEBSITE_URL}/api.php?action=get_setting&name=${settingName}`);
        return res.data.value !== null ? res.data.value : defaultValue;
    } catch (error) {
        console.error(`⚠️ getSetting(${settingName}) failed:`, error.message);
        return defaultValue;
    }
}

// Settings ලිවීම (වෙබ්සයිට් එකට)
async function updateSetting(settingName, settingValue) {
    try {
        await axios.post(`${WEBSITE_URL}/api.php?action=update_setting`, {
            name: settingName,
            value: settingValue
        });
    } catch (error) {
        console.error(`⚠️ updateSetting(${settingName}) failed:`, error.message);
    }
}

// QR Code එක Save කිරීම
async function saveQRCode(base64Data) {
    try {
        await axios.post(`${WEBSITE_URL}/api.php?action=save_qr`, { qr_code: base64Data });
        console.log('📱 QR Code updated in website database.');
    } catch (error) {
        console.error('❌ QR save error:', error.message);
    }
}

// Pairing Code එක Save කිරීම
async function savePairingCode(code) {
    try {
        await axios.post(`${WEBSITE_URL}/api.php?action=save_pair`, { pairing_code: code });
        console.log(`🔐 Pairing code saved: ${code}`);
    } catch (error) {
        console.error('❌ Pairing code save error:', error.message);
    }
}

// වෙබ්සයිට් එකෙන් අංකය ලබා ගැනීම
async function getPendingPhone() {
    try {
        const response = await axios.get(`${WEBSITE_URL}/api.php?action=get_phone`);
        return response.data.phone ? String(response.data.phone) : null;
    } catch (error) {
        console.error('⚠️ Pending phone read error:', error.message);
        return null;
    }
}

// දත්ත ඉවත් කිරීම (Clear)
async function clearQRCode() { try { await axios.post(`${WEBSITE_URL}/api.php?action=clear`); } catch (e) {} }
async function clearPairingCode() { try { await axios.post(`${WEBSITE_URL}/api.php?action=clear`); } catch (e) {} }
async function clearPendingPhone() { try { await axios.post(`${WEBSITE_URL}/api.php?action=clear`); } catch (e) {} }

// ============================================================
// COMMAND LOADER (ඔබේ මුල් කෝඩ් එකේ තිබ්බ විදියමයි)
// ============================================================

function safeRequire(filePath) {
    try {
        delete require.cache[require.resolve(filePath)];
        return require(filePath);
    } catch (error) {
        console.error(`❌ Failed to load command: ${path.basename(filePath)}`);
        console.error(error.stack || error.message);
        return null;
    }
}

function registerCommand(command) {
    if (Array.isArray(command)) { command.forEach(registerCommand); return; }
    if (!command || typeof command !== 'object') return;

    const name = String(command.name || '').trim().toLowerCase();
    if (!name || typeof command.execute !== 'function') {
        console.error('⚠️ Skipping invalid command module. It needs name + execute().');
        return;
    }

    const aliases = Array.isArray(command.aliases) ? command.aliases : [];
    const names = [name, ...aliases].map(v => String(v).trim().toLowerCase()).filter(Boolean);

    for (const commandName of names) commandRegistry.set(commandName, command);

    if (Array.isArray(command.buttonIds)) {
        for (const buttonId of command.buttonIds) {
            if (buttonId) {
                const id = String(buttonId);
                if (buttonRegistry.has(id)) {
                    console.warn(`⚠️ Button ID already used, skipping: ${id} (${name})`);
                    continue;
                }
                buttonRegistry.set(id, command);
            }
        }
    }

    if (Array.isArray(command.buttonPrefixes)) {
        for (const prefix of command.buttonPrefixes) {
            if (prefix) buttonPrefixRegistry.push({ prefix: String(prefix), command });
        }
    }
    console.log(`✅ Command loaded: ${name}`);
}

function loadCommands() {
    commandRegistry.clear();
    buttonRegistry.clear();
    buttonPrefixRegistry.length = 0;
    buttonLabelMap.clear();

    if (!fs.existsSync(COMMANDS_DIR)) {
        fs.mkdirSync(COMMANDS_DIR, { recursive: true });
        console.log('📁 Created commands folder. Add command files inside it.');
        return;
    }

    const files = collectCommandFiles(COMMANDS_DIR);
    for (const file of files) {
        const command = safeRequire(file);
        if (command) registerCommand(command);
    }
    console.log(`📦 Commands ready: ${commandRegistry.size}`);
}

function collectCommandFiles(dir) {
    const files = [];
    if (!fs.existsSync(dir)) return files;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) files.push(...collectCommandFiles(fullPath));
        else if (entry.name.endsWith('.js') && entry.name !== 'index.js' && !entry.name.startsWith('_')) files.push(fullPath);
    }
    return files.sort();
}

function normalizeLabel(text) {
    return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function rememberButtonLabel(displayText, id) {
    if (!displayText || !id) return;
    buttonLabelMap.set(normalizeLabel(displayText), String(id));
}

// ============================================================
// MESSAGE CONTEXT
// ============================================================

function createContext(message, selectedButtonId = null) {
    const jid = message?.key?.remoteJid || '';
    const sender = message?.key?.participant || jid;
    const content = unwrapMessage(message?.message);
    const quoted = content?.extendedTextMessage?.contextInfo?.quotedMessage || content?.imageMessage?.contextInfo?.quotedMessage || null;

    return {
        sock, msg: message, jid, sender,
        text: extractText(message),
        buttonId: selectedButtonId, quoted,
        isGroup: String(jid).endsWith('@g.us'),
        userSessions, commandRegistry, buttonRegistry,

        async sendText(text, options = {}) { return sock.sendMessage(jid, { text, ...options }); },
        async sendMessage(content) { return sock.sendMessage(jid, content); },
        async sendMenu() {
            const menuCommand = commandRegistry.get('menu');
            if (menuCommand?.execute) return menuCommand.execute(createContext(message));
            return sendDefaultMenu(jid);
        },
        async sendInteractiveMenu(options) { return sendInteractiveMenu(jid, options); },
        db: { getSetting, updateSetting },
        async runCommand(name, args = []) {
            const command = commandRegistry.get(String(name).toLowerCase());
            if (!command) return false;
            await command.execute({ ...createContext(message), args });
            return true;
        }
    };
}

// ============================================================
// EXTRACT TEXT / UNWRAP MESSAGE
// ============================================================

function extractText(msg) {
    if (!msg?.message) return '';
    const content = unwrapMessage(msg.message);
    return content.conversation || content.extendedTextMessage?.text || content.imageMessage?.caption || content.videoMessage?.caption || content.documentMessage?.caption || '';
}

function unwrapMessage(message) {
    let current = message || {};
    for (let i = 0; i < 5; i++) {
        if (current?.ephemeralMessage?.message) current = current.ephemeralMessage.message;
        else if (current?.viewOnceMessage?.message) current = current.viewOnceMessage.message;
        else if (current?.viewOnceMessageV2?.message) current = current.viewOnceMessageV2.message;
        else if (current?.documentWithCaptionMessage?.message) current = current.documentWithCaptionMessage.message;
        else break;
    }
    return current;
}

// ============================================================
// INTERACTIVE BUTTONS
// ============================================================

function quickReplyButton(displayText, id) {
    return { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: displayText, id }) };
}

function getPrivacyModeTs() {
    const OFFSET = 77980457;
    return (Math.floor(Date.now() / 1000) - OFFSET).toString();
}

function buildNativeFlowBizNode() {
    return {
        tag: 'biz',
        attrs: { actual_actors: '2', host_storage: '2', privacy_mode_ts: getPrivacyModeTs() },
        content: [
            { tag: 'interactive', attrs: { type: 'native_flow', v: '1' }, content: [{ tag: 'native_flow', attrs: { v: '9', name: 'mixed' } }] },
            { tag: 'quality_control', attrs: { source_type: 'third_party' } }
        ]
    };
}

async function sendInteractiveMenu(jid, options) {
    const { headerTitle = '', bodyText = '', footerText = '© SEW QUEEN', buttons = [], image = null } = options || {};
    const safeButtons = (buttons || []).slice(0, 3);

    for (const button of safeButtons) {
        try { const parsed = JSON.parse(button.buttonParamsJson || '{}'); rememberButtonLabel(parsed.display_text, parsed.id); } catch {}
    }

    if (!safeButtons.length) return sock.sendMessage(jid, { text: bodyText });

    const fallbackText = () => {
        const lines = safeButtons.map((button, index) => {
            try { const parsed = JSON.parse(button.buttonParamsJson || '{}'); return `${index + 1}. ${parsed.display_text}`; }
            catch { return `${index + 1}. option`; }
        }).join('\n');
        return (headerTitle ? `*${headerTitle}*\n\n` : '') + bodyText + '\n\n' + lines + '\n\n_බොත්තම් නොපෙනේ නම් ඉහත නම type කරන්න._';
    };

    try {
        const nativeFlowButtons = safeButtons.map(button =>
            proto.Message.InteractiveMessage.NativeFlowMessage.NativeFlowButton.create({
                name: button.name || 'quick_reply', buttonParamsJson: button.buttonParamsJson
            })
        );

        let header = proto.Message.InteractiveMessage.Header.create({ title: headerTitle, subtitle: '', hasMediaAttachment: false });
        const imageUrl = typeof image === 'string' ? image : image?.url;

        if (imageUrl && sock.waUploadToServer) {
            try {
                const media = await prepareWAMessageMedia({ image: { url: imageUrl } }, { upload: sock.waUploadToServer });
                if (media?.imageMessage) {
                    header = proto.Message.InteractiveMessage.Header.create({ title: headerTitle, subtitle: '', hasMediaAttachment: true, imageMessage: media.imageMessage });
                }
            } catch (mediaError) { console.warn('⚠️ Menu image upload skipped:', mediaError.message); }
        }

        const interactiveMessage = proto.Message.InteractiveMessage.create({
            header,
            body: proto.Message.InteractiveMessage.Body.create({ text: bodyText }),
            footer: proto.Message.InteractiveMessage.Footer.create({ text: footerText }),
            nativeFlowMessage: proto.Message.InteractiveMessage.NativeFlowMessage.create({
                buttons: nativeFlowButtons,
                messageParamsJson: JSON.stringify({ from: 'sewqueen', templateId: Date.now().toString() }),
                messageVersion: 1
            }),
            contextInfo: { mentionedJid: [], forwardingScore: 0, isForwarded: false }
        });

        const message = generateWAMessageFromContent(jid, {
            viewOnceMessage: {
                message: { messageContextInfo: { deviceListMetadata: {}, deviceListMetadataVersion: 2 }, interactiveMessage }
            }
        }, { userJid: sock.user?.id || '' });

        const isGroup = String(jid).endsWith('@g.us');
        const additionalNodes = isGroup ? [buildNativeFlowBizNode()] : [{ tag: 'bot', attrs: { biz_bot: '1' } }, buildNativeFlowBizNode()];

        await sock.relayMessage(jid, message.message, { messageId: message.key.id, additionalNodes });
        console.log(`✅ Interactive menu sent to ${jid}`);
        return message;
    } catch (error) {
        console.error('❌ Interactive menu error:', error.stack || error.message);
        return sock.sendMessage(jid, { text: fallbackText() });
    }
}

async function sendDefaultMenu(jid) {
    return sendInteractiveMenu(jid, {
        headerTitle: '🏠 ප්‍රධාන මෙනුව',
        bodyText: '╔═══════════════════════════════╗\n║       ✨ *SEW QUEEN BOT* ✨     ║\n╠═══════════════════════════════╣\n║ 👋 *ආයුබෝවන්!*                ║\n║ ඔබට අවශ්‍ය කාර්යය තෝරන්න     ║\n╚═══════════════════════════════╝',
        footerText: '© SEW QUEEN',
        buttons: [
            quickReplyButton('🛠️ සේවා', 'main_services'),
            quickReplyButton('📞 සහය', 'main_support'),
            quickReplyButton('👤 ගිණුම', 'main_account'),
            quickReplyButton('📊 පැනලය', 'main_panel'),
            quickReplyButton('ℹ️ තොරතුරු', 'main_about')
        ]
    });
}

// ============================================================
// BUTTON DISPATCH / EXTRACT BUTTON ID
// ============================================================

async function dispatchButton(message, buttonId) {
    let command = buttonRegistry.get(buttonId);
    if (!command) {
        const prefixed = buttonPrefixRegistry.find(entry => buttonId.startsWith(entry.prefix));
        if (prefixed) command = prefixed.command;
    }
    if (!command || typeof command.onButton !== 'function') {
        console.log(`⚠️ No command registered for button: ${buttonId}`);
        return false;
    }
    await command.onButton({ ...createContext(message, buttonId), buttonId });
    return true;
}

function extractButtonId(message) {
    const content = unwrapMessage(message?.message);
    const interactive = content?.interactiveResponseMessage;
    if (interactive) {
        const native = interactive.nativeFlowResponseMessage;
        const raw = native?.paramsJson ?? native?.params ?? '';
        if (typeof raw === 'string' && raw.trim()) {
            try { const parsed = JSON.parse(raw); return parsed?.id || parsed?.selectedId || parsed?.selected_id || null; }
            catch { return null; }
        }
        if (raw && typeof raw === 'object') return raw.id || raw.selectedId || raw.selected_id || null;
    }
    const legacy = content?.buttonsResponseMessage;
    if (legacy?.selectedButtonId) return legacy.selectedButtonId;
    const template = content?.templateButtonReplyMessage;
    if (template?.selectedId) return template.selectedId;
    const list = content?.listResponseMessage?.singleSelectReply?.selectedRowId;
    if (list) return list;
    return null;
}

// ============================================================
// TEXT COMMAND DISPATCH
// ============================================================

async function dispatchTextCommand(message) {
    const text = extractText(message).trim();
    if (!text) return false;

    const prefix = String(await getSetting('prefix', '.')) || '.';
    const prefixLower = prefix.toLowerCase();
    let commandLine = text;

    if (text.toLowerCase().startsWith(prefixLower)) {
        commandLine = text.slice(prefix.length).trim();
    }

    const parts = commandLine.split(/\s+/).filter(Boolean);
    if (!parts.length) return false;

    const commandName = parts[0].toLowerCase();
    const args = parts.slice(1);
    const command = commandRegistry.get(commandName);
    if (!command) return false;

    const ctx = createContext(message);
    ctx.args = args;

    try {
        await command.execute(ctx);
        return true;
    } catch (error) {
        console.error(`❌ Command error [${commandName}]:`, error.stack || error.message);
        try { await ctx.sendText('⚠️ Command එකේ දෝෂයක් සිදු විය.'); } catch {}
        return true;
    }
}

// ============================================================
// INCOMING MESSAGE HANDLER
// ============================================================

async function handleIncomingMessage(message) {
    if (!message?.message) return;
    const jid = message.key?.remoteJid;
    if (!jid || jid === 'status@broadcast') return;

    const buttonId = extractButtonId(message);
    if (buttonId) {
        console.log(`🖱️ Button clicked: ${buttonId}`);
        userSessions.set(jid, 'menu');
        try {
            const handled = await dispatchButton(message, buttonId);
            if (!handled) console.log(`ℹ️ Ignoring unknown button: ${buttonId}`);
        } catch (error) {
            console.error('❌ Button handler error:', error.stack || error.message);
            try { await sock.sendMessage(jid, { text: '⚠️ දෝෂයක් සිදු විය. කරුණාකර නැවත උත්සාහ කරන්න.' }); } catch {}
        }
        return;
    }

    const text = extractText(message);
    console.log(`📩 Message from ${jid}: "${text}"`);

    const labelButtonId = buttonLabelMap.get(normalizeLabel(text));
    if (labelButtonId) {
        console.log(`🖱️ Button label matched: ${labelButtonId}`);
        try {
            const handled = await dispatchButton(message, labelButtonId);
            if (handled) return;
        } catch (error) { console.error('❌ Label button error:', error.stack || error.message); }
    }

    const handled = await dispatchTextCommand(message);
    if (handled) return;

    const triggers = ['menu', 'start', 'hi', 'hello', 'හෙලෝ', 'ආයුබෝවන්', '.menu', '.start', 'help', '.help'];
    const normalized = text.toLowerCase().trim();
    const isTrigger = triggers.some(word => normalized.includes(word)) || text.length < 3;
    if (!isTrigger) return;

    const key = `${jid}_menu_time`;
    const last = userSessions.get(key) || 0;
    const now = Date.now();

    if (now - last > MENU_COOLDOWN) {
        userSessions.set(key, now);
        try {
            const menuCommand = commandRegistry.get('menu');
            if (menuCommand?.execute) await menuCommand.execute(createContext(message));
            else await sendDefaultMenu(jid);
        } catch (error) { console.error('❌ Menu error:', error.stack || error.message); }
    }
}

// ============================================================
// PAIRING CODE PROCESS
// ============================================================

async function processPairingRequest() {
    if (!sock || isReady || stopping || pairingInProgress) return;
    if (authState?.creds?.registered) { await clearPendingPhone(); await clearPairingCode(); return; }

    const phone = await getPendingPhone();
    if (!phone) return;

    let cleanNumber = String(phone).replace(/\D/g, '');
    if (cleanNumber.startsWith('0')) cleanNumber = cleanNumber.slice(1);

    if (!/^\d{8,15}$/.test(cleanNumber)) {
        console.error(`❌ Invalid phone number for pairing: ${phone}`);
        await clearPendingPhone();
        return;
    }

    pairingInProgress = true;
    console.log(`📞 Requesting pairing code for: ${cleanNumber}`);

    try {
        await clearPairingCode();
        const code = await sock.requestPairingCode(cleanNumber);
        await savePairingCode(code);
        await clearPendingPhone();
        console.log(`🔐 ✅ Pairing code: ${code}`);
    } catch (error) {
        console.error('❌ Pairing error:', error.stack || error.message);
    } finally {
        pairingInProgress = false;
    }
}

// ============================================================
// TIMERS & RECONNECT
// ============================================================

async function stopTimers() {
    if (pairingTimer) { clearInterval(pairingTimer); pairingTimer = null; }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
}

function scheduleReconnect() {
    if (stopping || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        startBot().catch(error => {
            console.error('❌ Reconnect start failed:', error.stack || error.message);
            scheduleReconnect();
        });
    }, RECONNECT_DELAY);
}

// ============================================================
// START BOT
// ============================================================

async function startBot() {
    if (stopping) return;
    await stopTimers();
    loadCommands();

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    authState = state;

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: ['Windows', 'Edge', '120.0.0.0'],
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 10000,
        markOnlineOnConnect: false,
        logger: pino({ level: 'silent' })
    });

    sock.__sqContext = jid => ({ sendInteractiveMenu: options => sendInteractiveMenu(jid, options) });
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async update => {
        const { qr, connection, lastDisconnect } = update;

        if (qr) {
            try {
                const qrImage = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
                const base64 = qrImage.replace(/^data:image\/png;base64,/, '');
                await saveQRCode(base64);
            } catch (error) { console.error('❌ QR processing error:', error.message); }
        }

        if (!isReady && (connection === 'connecting' || !!qr) && !authState?.creds?.registered) {
            if (!pairingTimer) pairingTimer = setInterval(processPairingRequest, PAIR_POLL_INTERVAL);
            await processPairingRequest();
        }

        if (connection === 'open') {
            isReady = true;
            await updateSetting('bot_status', 'online');
            await clearQRCode(); await clearPairingCode(); await clearPendingPhone();
            console.log('✅ Bot is ONLINE!');

            const ownerNumber = await getSetting('owner_number', process.env.OWNER_NUMBER || null);
            if (ownerNumber) {
                try {
                    const cleanOwner = ownerNumber.replace(/\D/g, '') + '@s.whatsapp.net';
                    await sock.sendMessage(cleanOwner, {
                        image: { url: 'https://i.ibb.co/vGN2vVz/IMG-20260908-232029.jpg' },
                        caption: '╔══════════════════════╗\n║  ✨ *SEW QUEEN BOT* ✨ ║\n╠══════════════════════╣\n║ ✅ *Bot is now ONLINE!* 🚀\n║ 👋 ඔබගේ බොට් සාර්ථකව \n║    සම්බන්ධ විය!\n╚══════════════════════╝'
                    });
                    await sendInteractiveMenu(cleanOwner, {
                        headerTitle: '⚙️ පාලක මෙනුව',
                        bodyText: 'ඔබට අවශ්‍ය විධානය පහතින් තෝරන්න 👇',
                        footerText: '© SEW QUEEN',
                        buttons: [quickReplyButton('📊 Dashboard', 'main_panel'), quickReplyButton('🛠️ Menu', 'menu')]
                    });
                } catch (error) { console.error('⚠️ Owner notify error:', error.message); }
            }
        }

        if (connection === 'close') {
            isReady = false;
            await updateSetting('bot_status', 'offline');
            if (pairingTimer) { clearInterval(pairingTimer); pairingTimer = null; }

            const statusCode = lastDisconnect?.error?.output?.statusCode ?? lastDisconnect?.error?.statusCode;
            const loggedOut = statusCode === DisconnectReason.loggedOut;
            console.log(`🔌 Connection closed. Code: ${statusCode ?? 'unknown'}`);

            if (!stopping && !loggedOut) {
                console.log(`🔄 Reconnecting in ${RECONNECT_DELAY}ms...`);
                scheduleReconnect();
            } else if (loggedOut) {
                console.log('❌ WhatsApp logged out. Delete auth_info only when you intentionally want a new login.');
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const message of messages || []) {
            try { await handleIncomingMessage(message); }
            catch (error) { console.error('❌ Message processing error:', error.stack || error.message); }
        }
    });

    return sock;
}

// ============================================================
// MAIN & SHUTDOWN
// ============================================================

async function main() {
    try {
        console.log('⏳ Bot is starting... (Database is handled via Website API)');
        // Database එකට connect වෙනවා වෙනුවට, වෙබ්සයිට් එකේ api.php එකට ping එකක් යවලා බලමු
        await axios.get(`${WEBSITE_URL}/api.php?action=ping`).catch(() => console.log('⚠️ Website API is not reachable yet.'));
        await startBot();
    } catch (error) {
        console.error('❌ Bot startup error:', error.stack || error.message);
        process.exitCode = 1;
    }
}

async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    console.log(`\n🛑 ${signal} received. Shutting down...`);
    await stopTimers();
    try { await updateSetting('bot_status', 'offline'); } catch {}
    try { if (sock?.ws?.readyState !== undefined) sock.ws.close(); } catch {}
    process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', error => { console.error('❌ Unhandled promise rejection:', error?.stack || error); });
process.on('uncaughtException', error => { console.error('❌ Uncaught exception:', error?.stack || error); });

// ============================================================
// START
// ============================================================

main();
