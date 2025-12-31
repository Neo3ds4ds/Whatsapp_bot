console.log("[debug] Whatsapp Bot wird gestartet...");
process.on('uncaughtException', (err) => { console.error('[error] uncaughtException:', err); });
process.on('unhandledRejection', (reason, p) => { console.error('[error] unhandledRejection:', reason); });

const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const econ = require('./economy/economy');

// Robustness: Override LocalAuth.logout to handle Windows EBUSY (file locked) errors
if (LocalAuth && LocalAuth.prototype && typeof LocalAuth.prototype.logout === 'function') {
    const originalLogout = LocalAuth.prototype.logout;
    LocalAuth.prototype.logout = async function(...args) {
        try {
            await originalLogout.apply(this, args);
            return;
        } catch (e) {
            const msg = e && (e.message || e.toString());
            if (msg && (msg.includes('EBUSY') || msg.includes('resource busy') || msg.includes('locked'))) {
                console.warn('[warn] LocalAuth.logout encountered EBUSY/locked file. Will retry manual removal with backoff.');
                const dir = this.userDataDir;
                if (!dir) return;

                // Try manual remove with exponential backoff
                for (let i = 0; i < 6; i++) {
                    try {
                        await fs.promises.rm(dir, { recursive: true, force: true });
                        console.warn('[warn] Session dir removed after retry');
                        return;
                    } catch (err) {
                        if (err && err.code === 'EBUSY') {
                            const wait = 100 * Math.pow(2, i); // 100,200,400...
                            await new Promise(r => setTimeout(r, wait));
                            continue;
                        }
                        console.error('[error] Unexpected error while removing session dir:', err);
                        throw err;
                    }
                }

                console.warn('[warn] Could not remove session dir due to persistent EBUSY; ignoring');
                return;
            }

            // rethrow other errors
            throw e;
        }
    };
}

let prefix = "/";
let warns = {};
let config = { prefix };

// Spam settings
const spamConfig = {
    windowMs: 7000, // time window in ms
    max: 5,         // max messages in window to consider as spam
    warnCooldownMs: 10000 // don't warn same user again within this cooldown
};
const spamTracker = {}; // { [groupId]: { [userId]: { timestamps: [], lastWarnAt: 0 } } }

// Config laden (persistenter Prefix)
if (fs.existsSync("config.json")) {
    try {
        const rawConfig = fs.readFileSync("config.json", "utf8");
        const parsed = rawConfig.trim() ? JSON.parse(rawConfig) : {};
        if (parsed.prefix) prefix = parsed.prefix;
        config = { ...config, ...parsed };
        // ensure groupPrefixes exists to support per-group prefixes
        if (!config.groupPrefixes) config.groupPrefixes = {};
        console.log('[debug] Lädt Datei config.json, prefix ist auf=', prefix);
    } catch (err) {
        console.error('[warn] Failed to parse config.json, resetting to default:', err);
        config = { prefix };
        fs.writeFileSync("config.json", JSON.stringify(config, null, 2));
    }
} else {
    // write default config
    fs.writeFileSync("config.json", JSON.stringify(config, null, 2));
} 

// Ensure default: in groups the bot only responds when mentioned unless disabled
if (typeof config.requireMentionInGroup === 'undefined') {
    config.requireMentionInGroup = true;
    saveConfig();
} 
// Ensure groupPrefixes exists (per-group prefix mapping)
if (typeof config.groupPrefixes === 'undefined') {
    config.groupPrefixes = {};
    saveConfig();
} 
// Ensure groupAutospam exists (per-group toggle for autospam)
if (typeof config.groupAutospam === 'undefined') {
    config.groupAutospam = {};
    saveConfig();
} 

// Warns laden (sicheres Laden, falls Datei leer/korrupt)
if (fs.existsSync("warns.json")) {
    try {
        const raw = fs.readFileSync("warns.json", "utf8");
        warns = raw.trim() ? JSON.parse(raw) : {};
    } catch (err) {
        console.error('[warn] Failed to parse warns.json, resetting to {}:', err);
        warns = {};
        fs.writeFileSync("warns.json", JSON.stringify(warns, null, 2));
    }
}

function saveWarns() {
    fs.writeFileSync("warns.json", JSON.stringify(warns, null, 2));
}

// Bot-level warns persistence (global, not per-group)
let botWarns = {}; // { [userId]: count }
if (fs.existsSync("botwarns.json")) {
    try {
        const raw = fs.readFileSync("botwarns.json", "utf8");
        botWarns = raw.trim() ? JSON.parse(raw) : {};
    } catch (err) {
        console.error('[warn] Failed to parse botwarns.json, resetting to {}:', err);
        botWarns = {};
        fs.writeFileSync("botwarns.json", JSON.stringify(botWarns, null, 2));
    }
} else {
    fs.writeFileSync("botwarns.json", JSON.stringify(botWarns, null, 2));
}

function saveBotWarns() {
    fs.writeFileSync("botwarns.json", JSON.stringify(botWarns, null, 2));
}

function saveConfig() {
    fs.writeFileSync("config.json", JSON.stringify(config, null, 2));
} 

// Registry persistence (registered users)
let registry = {}; // { [userId]: { name, registeredAt } }
if (fs.existsSync("registry.json")) {
    try {
        const raw = fs.readFileSync("registry.json", "utf8");
        registry = raw.trim() ? JSON.parse(raw) : {};
    } catch (err) {
        console.error('[warn] Failed to parse registry.json, resetting to {}:', err);
        registry = {};
        fs.writeFileSync("registry.json", JSON.stringify(registry, null, 2));
    }
} else {
    fs.writeFileSync("registry.json", JSON.stringify(registry, null, 2));
}
function saveRegistry() {
    fs.writeFileSync("registry.json", JSON.stringify(registry, null, 2));
}

// cached bot self id (lazy-resolved)
let botSelfId = null;

// Tempban-Persistenz und Scheduler (group-level tempbans) 
let tempbans = {}; // { [groupId]: [ { userId, unbanAt, attempts } ] }
const tempbanTimers = {}; // key: `${groupId}|${userId}` -> timeout

// Bot-level permanent bans (maintained in config.botBanned array)
// Bot-level temporary bans persisted separately
let botTempBans = []; // [ { userId, unbanAt } ]
const botTempTimers = {}; // key: userId -> timeout

// Lade tempbans sicher
if (fs.existsSync("tempbans.json")) {
    try {
        const raw = fs.readFileSync("tempbans.json", "utf8");
        tempbans = raw.trim() ? JSON.parse(raw) : {};
    } catch (err) {
        console.error('[warn] Failed to parse tempbans.json, resetting to {}:', err);
        tempbans = {};
        fs.writeFileSync("tempbans.json", JSON.stringify(tempbans, null, 2));
    }
} else {
    fs.writeFileSync("tempbans.json", JSON.stringify(tempbans, null, 2));
}

// Bot-tempbans persistent file
function loadBotTempBans() {
    try {
        if (fs.existsSync("bottempbans.json")) {
            const raw = fs.readFileSync("bottempbans.json", "utf8");
            botTempBans = raw.trim() ? JSON.parse(raw) : [];
        } else {
            fs.writeFileSync("bottempbans.json", JSON.stringify(botTempBans, null, 2));
        }
    } catch (e) {
        console.error('[warn] Failed to load bottempbans.json, resetting:', e && (e.message || e));
        botTempBans = [];
        fs.writeFileSync("bottempbans.json", JSON.stringify(botTempBans, null, 2));
    }
}

function saveBotTempBans() {
    fs.writeFileSync("bottempbans.json", JSON.stringify(botTempBans, null, 2));
}

function scheduleBotUnban(userId, unbanAt) {
    const key = userId;
    const delay = Math.max(0, unbanAt - Date.now());
    if (botTempTimers[key]) clearTimeout(botTempTimers[key]);
    botTempTimers[key] = setTimeout(() => {
        botTempBans = botTempBans.filter(b => b.userId !== userId);
        delete botTempTimers[key];
        saveBotTempBans();
        console.log('[info] Bot-tempban expired and removed for', userId);
    }, delay);
}

// load existing bot tempbans and schedule unbans
loadBotTempBans();
for (const b of botTempBans) {
    if (b && b.userId && b.unbanAt) {
        if (Date.now() >= b.unbanAt) {
            // expired; will be cleaned next save or at schedule
            continue;
        }
        scheduleBotUnban(b.userId, b.unbanAt);
    }
}

function saveTempbans() {
    fs.writeFileSync("tempbans.json", JSON.stringify(tempbans, null, 2));
}

// Mutes (stummgeschaltete Nutzer) mit Persistenz
let mutes = {}; // { [groupId]: [ { userId, unmuteAt } ] }
const muteTimers = {}; // key: `${groupId}|${userId}` -> timeout

if (fs.existsSync("mutes.json")) {
    try {
        const raw = fs.readFileSync("mutes.json", "utf8");
        mutes = raw.trim() ? JSON.parse(raw) : {};
    } catch (err) {
        console.error('[warn] Failed to parse mutes.json, resetting to {}:', err);
        mutes = {};
        fs.writeFileSync("mutes.json", JSON.stringify(mutes, null, 2));
    }
} else {
    fs.writeFileSync("mutes.json", JSON.stringify(mutes, null, 2));
}

function saveMutes() {
    fs.writeFileSync("mutes.json", JSON.stringify(mutes, null, 2));
}

function scheduleUnmute(groupId, userId, unmuteAt) {
    const key = `${groupId}|${userId}`;
    if (muteTimers[key]) clearTimeout(muteTimers[key]);
    const delay = Math.max(0, unmuteAt - Date.now());
    muteTimers[key] = setTimeout(async () => {
        try {
            // remove from store
            if (mutes[groupId]) {
                mutes[groupId] = mutes[groupId].filter(e => e.userId !== userId);
                if (mutes[groupId].length === 0) delete mutes[groupId];
                saveMutes();
            }
            // try to notify group
            const chat = await client.getChatById(groupId);
            try {
                const r = await resolveMention(userId);
                await chat.sendMessage(`🔊 @${r.name} wurde entsperrt (Mute abgelaufen).`, { mentions: r.contact ? [r.contact] : [] });
            } catch (e) {
                const fb = registry[userId] && registry[userId].name ? ('@'+registry[userId].name) : ('<@'+userId+'>');
                await chat.sendMessage(`🔊 ${fb} wurde entsperrt (Mute abgelaufen).`);
            }
        } catch (e) {
            console.error('[error] scheduleUnmute failed:', e);
        } finally {
            delete muteTimers[key];
        }
    }, delay);
}

const TEMPBAN_MAX_RETRIES = 5;
const TEMPBAN_RETRY_INTERVAL_MS = 60 * 1000; // 1 minute

function scheduleUnban(groupId, userId, unbanAt, attempts = 0) {
    const key = `${groupId}|${userId}`;
    if (tempbanTimers[key]) {
        clearTimeout(tempbanTimers[key]);
    }

    const now = Date.now();
    let delay = unbanAt - now;
    if (delay < 0) delay = 0;

    tempbanTimers[key] = setTimeout(async () => {
        try {
            const chat = await client.getChatById(groupId);
            // Try to add participant
            try {
                const res = await chat.addParticipants([userId]);
                // consider success if no exception and res not a string error
                console.log('[debug] tempban unban addParticipants result:', res);
                try {
                    await chat.sendMessage(`✅ <@${userId}> wurde nach temporärem Bann wieder zur Gruppe hinzugefügt.`);
                } catch (e) {
                    await chat.sendMessage(`✅ <@${userId}> wurde nach temporärem Bann wieder zur Gruppe hinzugefügt.`);
                }
                // remove from tempbans
                if (tempbans[groupId]) {
                    tempbans[groupId] = tempbans[groupId].filter(e => e.userId !== userId);
                    if (tempbans[groupId].length === 0) delete tempbans[groupId];
                    saveTempbans();
                }
                clearTimeout(tempbanTimers[key]);
                delete tempbanTimers[key];
            } catch (err) {
                console.error('[error] tempban unban add failed:', err);
                if (attempts < TEMPBAN_MAX_RETRIES) {
                    // update attempts in store
                    tempbans[groupId] = tempbans[groupId] || [];
                    const entry = tempbans[groupId].find(e => e.userId === userId);
                    if (entry) { entry.attempts = attempts + 1; saveTempbans(); }
                    // retry later
                    tempbanTimers[key] = setTimeout(() => scheduleUnban(groupId, userId, Date.now() + TEMPBAN_RETRY_INTERVAL_MS, attempts + 1), TEMPBAN_RETRY_INTERVAL_MS);
                } else {
                    console.warn('[warn] tempban unban failed after max retries, giving up for', userId, groupId);
                }
            }
        } catch (e) {
            console.error('[error] tempban unban failed to get chat:', e);
            if (attempts < TEMPBAN_MAX_RETRIES) {
                tempbanTimers[key] = setTimeout(() => scheduleUnban(groupId, userId, Date.now() + TEMPBAN_RETRY_INTERVAL_MS, attempts + 1), TEMPBAN_RETRY_INTERVAL_MS);
            }
        }
    }, delay);
}


const client = new Client({
    authStrategy: new LocalAuth()
});

client.on("qr", qr => {
    qrcode.generate(qr, { small: true });
});

client.on("ready", () => {
    console.log("WhatsApp Bot ist bereit!");
    // Schedule any pending tempbans loaded from disk
    try {
        for (const [gid, entries] of Object.entries(tempbans)) {
            for (const e of entries) {
                if (e && e.userId && e.unbanAt) {
                    scheduleUnban(gid, e.userId, e.unbanAt, e.attempts || 0);
                }
            }
        }
    } catch (e) {
        console.error('[error] scheduling pending tempbans failed:', e);
    }

    // Schedule pending mutes
    try {
        for (const [gid, entries] of Object.entries(mutes)) {
            for (const e of entries) {
                if (e && e.userId && e.unmuteAt) {
                    scheduleUnmute(gid, e.userId, e.unmuteAt);
                }
            }
        }
    } catch (e) {
        console.error('[error] scheduling pending mutes failed:', e);
    }
});

client.on("message", async msg => {
    const chat = await msg.getChat();

    // Allow private chats too (process messages from both groups and private chats)

    // Command Parsing: accept configured prefix or common alternate prefixes (so users can use $, !, . as well)
    const rawBody = (typeof msg.body === 'string') ? msg.body : '';
    // Determine group id for per-group prefix lookup
    const groupId = chat && chat.id && chat.id._serialized ? chat.id._serialized : (chat.id ? String(chat.id) : '');
    // effective prefix: group-specific if set, otherwise global config or fallback
    const effectivePrefix = (chat.isGroup && config.groupPrefixes && config.groupPrefixes[groupId]) ? config.groupPrefixes[groupId] : (config.prefix || prefix);

    let usedPrefix = null;
    let isCommand = false;
    let args = [];
    let command = null;

    // primary: configured (effective) prefix ONLY - do not accept alternative prefixes
    if (rawBody.startsWith(effectivePrefix)) {
        usedPrefix = effectivePrefix;
        isCommand = true;
    }

    if (isCommand && usedPrefix) {
        args = rawBody.slice(usedPrefix.length).trim().split(/ +/);
        command = (args.shift() || '').toLowerCase();
    }

    // Track whether a command handler sent a reply; wrap msg.reply for this message to set handled=true
    let __handled = false;
    try {
        const __originalReply = msg.reply.bind(msg);
        msg.reply = async (...a) => {
            __handled = true;
            try { return await __originalReply(...a); } catch (e) { __handled = true; throw e; }
        };
    } catch (e) {
        console.error('[error] failed to wrap msg.reply for handled detection:', e);
    }

    // Debug: log incoming message type
    console.debug('[debug] New message:', { fromMe: msg.fromMe, isCommand, author: msg.author, from: msg.from });

    // groupId was computed earlier above for prefix handling

    // If this is a private chat, ensure no leftover spam-tracker entry exists for this id
    try {
        if (!chat.isGroup && spamTracker[groupId]) delete spamTracker[groupId];
    } catch (e) {}

    // Gruppe initialisieren
    if (!warns[groupId]) warns[groupId] = {};

    // ping handling moved to centralized dispatch (below) to respect mention settings



    // helper: Prüfe, ob Absender Gruppenadmin ist (robust, mehrere Teilnehmer-Formate)
    const normalizeId = (id) => {
        if (!id) return '';
        if (typeof id === 'string') return id;
        if (id._serialized) return id._serialized;
        if (id.id && id.id._serialized) return id.id._serialized;
        return '';
    };

    // Versuche, Kontaktinfo des Absenders zu holen (wichtig, weil msg.author manchmal '@lid' ist)
    let authorContact = null;
    try {
        authorContact = await msg.getContact();
    } catch (e) {
        console.warn('[warn] msg.getContact() failed:', e && (e.message || e));
    }

    // Hilfs-Funktion: löst eine @lid ID auf eine @c.us ID im Browser-Kontext (falls möglich)
    const resolveLidToCjid = async (lid) => {
        if (!lid || !lid.includes('@lid')) return null;
        try {
            const res = await client.pupPage.evaluate((lid) => {
                try {
                    const wid = window.Store.WidFactory.createWid(lid);
                    const phone = window.Store.LidUtils.getPhoneNumber(wid);
                    if (!phone) return null;
                    if (typeof phone === 'string') return phone.endsWith('@c.us') ? phone : phone + '@c.us';
                    if (phone._serialized) return phone._serialized;
                    if (phone.id && phone.id._serialized) return phone.id._serialized;
                    return null;
                } catch (e) {
                    return null;
                }
            }, lid);
            return res;
        } catch (e) {
            return null;
        }
    };

    // Helper: resolve a jid to a human-friendly name and Contact object for mentions
    async function resolveMention(jid) {
        if (!jid || typeof jid !== 'string') return { name: String(jid || ''), contact: null };
        try {
            // Normalize simple numeric IDs and try to resolve known @lid values
            let normalized = jid;
            if (/^\d+$/.test(normalized)) normalized = normalized + '@c.us';
            if (normalized.includes('@lid')) {
                const resolved = await resolveLidToCjid(normalized).catch(() => null);
                if (resolved) normalized = resolved;
            }

            // Try to resolve via client API
            let contact = await client.getContactById(normalized).catch(() => null);

            // If the contact cannot be found, create a minimal fallback contact object
            // that still allows the WhatsApp engine to render an actual mention in group messages.
            if (!contact) {
                contact = { id: { _serialized: normalized } };
            }

            const name = contact ? (contact.pushname || contact.shortName || contact.name || normalized.replace(/@.*/, '')) : normalized.replace(/@.*/, '');
            return { name, contact };
        } catch (e) {
            // As a last-resort fallback, expose the bare id as a name and provide a minimal contact
            const fallbackId = (typeof jid === 'string') ? jid : String(jid);
            return { name: fallbackId.replace(/@.*/, ''), contact: { id: { _serialized: fallbackId } } };
        }
    }

    // Convenience: reply mentioning a single jid if possible
    async function replyMention(msgObj, jid, text) {
        try {
            const r = await resolveMention(jid);
            const mentions = r.contact ? [r.contact] : [];
            await msgObj.reply(text.replace(/<@\$\{(.*?)\}>/g, r.name), { mentions });
        } catch (e) {
            // fallback
            await msgObj.reply(text.replace(/<@\$\{(.*?)\}>/g, jid));
        }
    }

    // Bestimme authorId; bevorzugt Kontakt-ID wenn vorhanden (z.B. '491...'@c.us)
    let authorId = normalizeId(authorContact && authorContact.id) || normalizeId(msg.author) || normalizeId(msg.from);

    // Wenn wir eine @lid haben, versuche sie in eine @c.us umzuwandeln
    if (authorId && authorId.includes('@lid')) {
        const resolved = await resolveLidToCjid(authorId);
        if (resolved) {
            console.log('[debug] resolved author @lid ->', resolved);
            authorId = resolved;
        } else {
            console.log('[debug] could not resolve author @lid to c.us');
        }
    }

    // Falls die Nachricht von diesem Gerät gesendet wurde (du bist "der Bot"), verwende die eigene ID
    if (msg.fromMe) {
        try {
            let selfId = (client.info && client.info.wid && client.info.wid._serialized) || null;
            if (!selfId) {
                const wid = await client.pupPage.evaluate(() => {
                    try {
                        return window.Store.User.getMaybeMePnUser() || window.Store.User.getMaybeMeLidUser();
                    } catch (e) { return null; }
                });
                if (wid) selfId = (wid._serialized) ? wid._serialized : (typeof wid === 'string' ? wid : null);
            }

            if (selfId) {
                console.log('[debug] message.fromMe detected, using selfId:', selfId);
                authorId = selfId;
                // Versuche, Kontaktinfo des eigenen Accounts zu holen
                try {
                    authorContact = await client.getContactById(selfId).catch(() => null);
                } catch (e) {
                    authorContact = null;
                }
            } else {
                console.log('[debug] message.fromMe but could not determine selfId');
            }
        } catch (e) {
            console.error('[error] Fehler beim Ermitteln der eigenen ID für msg.fromMe:', e);
        }
    }

    // participants kann verschiedene Formen haben (Array, Collection, Objekt)
    let participants = chat.participants || chat.groupMetadata?.participants;
    try {
        if (participants && typeof participants.serialize === 'function') {
            participants = participants.serialize();
        }
        if (participants && !Array.isArray(participants) && typeof participants === 'object') {
            participants = Object.values(participants);
        }
    } catch (e) {
        console.error('[error] beim Normalisieren der Teilnehmer:', e);
    }

    let isGroupAdmin = false;

    const jidToNumber = (jid) => {
        const s = normalizeId(jid);
        return s ? s.replace(/[^0-9]/g, '') : '';
    };

    const authorBare = jidToNumber(authorId);

    // Primary: check participants array (match by full jid or bare number)
    if (participants && Array.isArray(participants)) {
        isGroupAdmin = participants.some(p => {
            const pid = normalizeId(p.id || p);
            const pidBare = jidToNumber(pid);
            const matches = (pid === authorId) || (pidBare && authorBare && pidBare === authorBare);
            const adminFlag = p.isAdmin || p.isSuperAdmin || p.admin === 'admin' || p.role === 'admin' || p.admin === 'superadmin';
            if (matches && adminFlag) {
                console.log('[debug] Admin-Check: matched participant entry', { pid, pidBare, authorId, authorBare, adminFlag });
                return true;
            }
            return false;
        });
    }

    // Secondary: try groupMetadata map lookup (some versions expose a Map keyed by serialized ids)
    if (!isGroupAdmin) {
        try {
            const gmParts = chat.groupMetadata && chat.groupMetadata.participants;
            if (gmParts && typeof gmParts.get === 'function') {
                // direct key lookup
                const direct = gmParts.get(authorId) || gmParts.get(authorBare) || gmParts.get(authorBare + '@c.us');
                if (direct) {
                    const adminFlag = direct.isAdmin || direct.isSuperAdmin || direct.admin === 'admin' || direct.role === 'admin' || direct.admin === 'superadmin';
                    if (adminFlag) {
                        console.log('[debug] Admin-Check: matched groupMetadata.get(authorId)');
                        isGroupAdmin = true;
                    }
                } else {
                    // iterate and compare bare numbers
                    for (const v of gmParts.values()) {
                        const pid = normalizeId(v.id || v);
                        const pidBare = jidToNumber(pid);
                        if (pidBare && authorBare && pidBare === authorBare) {
                            const adminFlag = v.isAdmin || v.isSuperAdmin || v.admin === 'admin' || v.role === 'admin' || v.admin === 'superadmin';
                            if (adminFlag) {
                                console.log('[debug] Admin-Check: matched groupMetadata iteration', { pid, pidBare });
                                isGroupAdmin = true;
                                break;
                            }
                        }
                    }
                }
            }
        } catch (e) {
            console.error('[error] Error reading groupMetadata participants for admin check:', e);
        }
    }

    // Tertiary fallback: compare author's number to chat.owner
    if (!isGroupAdmin) {
        try {
            if (chat.owner) {
                const ownerId = normalizeId(chat.owner);
                const ownerBare = jidToNumber(ownerId);
                if (ownerId === authorId || (ownerBare && authorBare && ownerBare === authorBare)) {
                    console.log('[debug] Admin-Check: matched chat.owner');
                    isGroupAdmin = true;
                }
            }
        } catch (e) {
            console.error('[error] Fallback check (chat.owner) failed:', e);
        }
    }

    // Owner override: config.owner grants full access regardless of group admin
    let isOwner = false;
    let isCoOwner = false;
    let isModerator = false;
    try {
        if (config && config.owner) {
            let confOwner = config.owner;
            if (typeof confOwner !== 'string') confOwner = String(confOwner);
            confOwner = confOwner.trim();
            // if bare digits, append @c.us
            if (/^\d+$/.test(confOwner)) confOwner = confOwner + '@c.us';
            const ownerNormalized = normalizeId(confOwner) || confOwner;
            const ownerBare = jidToNumber(ownerNormalized);
            if (ownerNormalized === authorId || (ownerBare && authorBare && ownerBare === authorBare)) {
                isOwner = true;
                isGroupAdmin = true; // owner may act as admin anywhere
                console.log('[debug] Owner-Check: matched owner, granting admin rights', { owner: ownerNormalized, authorId });
            }
        }

        // Co-owner support: config.coOwner can be a string or array
        if (config && config.coOwner) {
            let confCo = config.coOwner;
            const arr = Array.isArray(confCo) ? confCo : [confCo];
            for (let co of arr) {
                try {
                    if (typeof co !== 'string') co = String(co);
                    co = co.trim();
                    if (/^\d+$/.test(co)) co = co + '@c.us';
                    const coNormalized = normalizeId(co) || co;
                    const coBare = jidToNumber(coNormalized);
                    if (coNormalized === authorId || (coBare && authorBare && coBare === authorBare)) {
                        isCoOwner = true;
                        console.log('[debug] CoOwner-Check: matched co-owner', { co: coNormalized, authorId });
                        break;
                    }
                } catch (e2) {
                    console.error('[error] co-owner normalization failed:', e2 && (e2.message || e2));
                }
            }
        }

        // Moderator support: config.moderators is an array of ids
        if (config && config.moderators) {
            let confMods = config.moderators;
            const arr = Array.isArray(confMods) ? confMods : [confMods];
            for (let mod of arr) {
                try {
                    if (typeof mod !== 'string') mod = String(mod);
                    mod = mod.trim(); if (/^\d+$/.test(mod)) mod = mod + '@c.us';
                    const modNormalized = normalizeId(mod) || mod;
                    const modBare = jidToNumber(modNormalized);
                    if (modNormalized === authorId || (modBare && authorBare && modBare === authorBare)) {
                        isModerator = true;
                        console.log('[debug] Moderator-Check: matched moderator', { mod: modNormalized, authorId });
                        break;
                    }
                } catch (e3) {
                    console.error('[error] moderator normalization failed:', e3 && (e3.message || e3));
                }
            }
        }
    } catch (e) {
        console.error('[error] owner/co-owner/moderator check failed:', e);
    }

    if (!isGroupAdmin) {
        // Ausführliche Debug-Info für den Fall, dass Admin nicht erkannt wird
        try {
            console.log('[debug] Admin-Check fehlgeschlagen. msg.author=', msg.author, 'msg.from=', msg.from, 'msg.fromMe=', msg.fromMe, 'authorId=', authorId, 'authorBare=', authorBare, 'chat.id=', normalizeId(chat.id));
            console.log('[debug] raw participants:', participants);
            const partInfo = (participants && Array.isArray(participants)) ? participants.map(p => ({ id: normalizeId(p.id||p), rawId: p.id, isAdmin: !!p.isAdmin, isSuperAdmin: !!p.isSuperAdmin, adminField: p.admin, roleField: p.role })) : [];
            console.log('[debug] normalized participants:', partInfo);
        } catch (e) {
            console.error('[error] Admin-Check failed to log participants:', e);
        }
    }

    // VERBOSE DEBUG: log parsed command, args, authorId and admin state for troubleshooting
    try {
        console.debug('[debug] parsed_command', { isCommand, usedPrefix, command, args, authorId, authorBare, isGroupAdmin, chatIsGroup: !!chat.isGroup, mentionedIds: msg.mentionedIds, body: rawBody });
    } catch (e) {
        console.error('[error] failed to log parsed_command:', e);
    }

    // --- Mention / command normalization ---
    try {
        // lazily determine and cache our own WhatsApp id for mention checks
        if (!botSelfId) {
            try {
                botSelfId = (client.info && client.info.wid && client.info.wid._serialized) || null;
                if (!botSelfId) {
                    const wid = await client.pupPage.evaluate(() => {
                        try { return window.Store.User.getMaybeMePnUser() || window.Store.User.getMaybeMeLidUser(); } catch (e) { return null; }
                    });
                    if (wid) botSelfId = (wid._serialized) ? wid._serialized : (typeof wid === 'string' ? wid : null);
                }
            } catch (e) {
                console.debug('[debug] failed to determine botSelfId:', e && (e.message || e));
            }
        }

        const mentions = msg.mentionedIds || [];
        const botMentioned = botSelfId && mentions && mentions.includes(botSelfId);

        // If configured, require that group commands mention the bot explicitly
        if (chat.isGroup && config.requireMentionInGroup) {
            if (!botMentioned) {
                // If the message used a prefix, allow it (prefix implies command intent); otherwise ignore
                if (isCommand) {
                    console.debug('[debug] Prefix used without mention; accepting command because prefix present', { cmd: command, authorId, body: rawBody });
                } else {
                    console.debug('[debug] Ignoring message: requireMentionInGroup active and bot not mentioned', { authorId, body: rawBody });
                    isCommand = false;
                    command = null;
                    args = [];
                }
            } else {
                // If bot was mentioned and no explicit prefix was used, allow mention-style commands like "@Bot ping"
                if (!isCommand) {
                    const cleaned = rawBody.replace(/@\S+/g, '').trim();
                    if (cleaned.length > 0) {
                        args = cleaned.split(/ +/);
                        command = (args.shift() || '').toLowerCase();
                        isCommand = !!command;
                    }
                }
            }
        }


    } catch (e) {
        console.error('[error] failed during mention/command normalization:', e);
    }

    // ENFORCE: require registration before using any commands (must register via /register)
    try {
        // Always allow register/unregister. In private chats allow /menu and /me as well so users can register and view info there.
        const allowedIfUnregistered = ['register','unregister','runtime','ping'];
        if (!chat.isGroup) {
            allowedIfUnregistered.push('menu','me','runtime','ping');
        }
        const uid = authorId || normalizeId(msg.author) || normalizeId(msg.from);
        // Block any recognized command for unregistered users (including commands handled outside main switch)
        if (command && uid && !registry[uid] && !allowedIfUnregistered.includes(command)) {
            console.debug('[debug] registration block (strict):', { uid, command, body: rawBody, allowedIfUnregistered });
            try {
                await msg.reply(`<@${uid}> Du bist noch nicht registriert. Bitte registriere dich zuerst mit /register`);
            } catch (e) {
                try { await msg.reply(`<@${uid}> Du bist noch nicht registriert. Bitte registriere dich zuerst mit /register`); } catch (e2) { /* ignore */ }
            }
            return;
        }
    } catch (e) {
        console.error('[error] registration check failed:', e && (e.stack || e));
    }

    // --- BOT BAN CHECKS (permanent & temp) - block commands from banned users ---
    try {
        let uid = authorId || normalizeId(msg.author) || normalizeId(msg.from);
        // normalize to canonical JID if possible
        if (typeof uid === 'string' && /^\d+$/.test(uid)) uid = uid + '@c.us';

        // normalize config.botBanned to canonical JIDs and ensure array
        config.botBanned = config.botBanned || [];
        const confBanned = (Array.isArray(config.botBanned) ? config.botBanned : [config.botBanned]).map(b => {
            if (typeof b !== 'string') b = String(b);
            b = b.trim(); if (/^\d+$/.test(b)) return b + '@c.us'; return b;
        });

        if (confBanned.includes(uid)) {
            // permanent ban
            if (isCommand) return msg.reply('⚠️ Du wurdest vom Bot gesperrt und kannst keine Befehle verwenden.');
            return; // don't process any messages
        }
        // check temp bans
        const tb = (botTempBans || []).find(b => b && b.userId === uid);
        if (tb && tb.unbanAt && Date.now() < tb.unbanAt) {
            if (isCommand) return msg.reply('⚠️ Du wurdest vorübergehend vom Bot gesperrt.');
            return;
        }
        if (tb && tb.unbanAt && Date.now() >= tb.unbanAt) {
            // expired - remove it
            botTempBans = (botTempBans || []).filter(b => b && b.userId !== uid);
            saveBotTempBans();
        }
    } catch (e) {
        console.debug('[debug] bot ban check failed:', e && (e.message || e));
    }

    // MUTE CHECK - lösche Nachrichten von stummgeschalteten Nutzern
    try {
        const gid = groupId;
        let uid = authorId || normalizeId(msg.author) || normalizeId(msg.from);

        // debug: show current mutes for group
        console.debug('[debug] Mute check start. gid=', gid, 'raw uid=', uid, 'mutesForGroup=', mutes[gid] || []);

        // If uid looks like @lid and we have no direct match, try to resolve to @c.us
        let resolvedUid = uid;
        if (uid && uid.includes('@lid')) {
            try {
                const resolved = await resolveLidToCjid(uid);
                if (resolved) {
                    resolvedUid = resolved;
                    console.log('[debug] Resolved mute-check author @lid ->', resolvedUid);
                } else {
                    console.log('[debug] Could not resolve author @lid during mute check:', uid);
                }
            } catch (e) {
                console.error('[error] resolveLidToCjid failed during mute check:', e && (e.stack || e));
            }
        }

        console.debug('[debug] Mute check compare. resolvedUid=', resolvedUid);

        if (resolvedUid && mutes[gid]) {
            const entry = mutes[gid].find(e => {
                if (!e || !e.userId) return false;
                if (e.userId === resolvedUid) return true;
                // compare bare numbers
                const a = (e.userId || '').replace(/[^0-9]/g, '');
                const b = (resolvedUid || '').replace(/[^0-9]/g, '');
                return a && b && a === b;
            });

            console.debug('[debug] Mute check result entry=', entry);

            if (entry) {
                const now = Date.now();
                if (entry.unmuteAt > now) {
                    console.log('[debug] Mute active - deleting message from', resolvedUid, 'in', gid, 'entry=', entry);
                    // delete message
                    let deleted = false;
                    try {
                        await msg.delete(true);
                        deleted = true;
                        console.log('[debug] Message deleted for everyone (mute)');
                    } catch (errDel) {
                        console.debug('[debug] delete for everyone failed (mute):', errDel && (errDel.stack || errDel));
                        try {
                            await msg.delete(false);
                            deleted = true;
                            console.log('[debug] Message deleted locally (mute)');
                        } catch (errLoc) {
                            console.error('[error] local delete failed (mute):', errLoc && (errLoc.stack || errLoc));
                        }
                    }
                    // do not process further if deletion attempted
                    if (deleted) return;
                    else return; // either way stop processing this message
                } else {
                    // expired - clean up
                    console.log('[debug] Mute expired for', entry.userId, '- cleaning');
                    mutes[gid] = mutes[gid].filter(e => e.userId !== entry.userId);
                    if (mutes[gid].length === 0) delete mutes[gid];
                    saveMutes();
                }
            }
        }
    } catch (e) {
        console.error('[error] Mute check failed:', e && (e.stack || e));
    }

    // SPECIAL: Allow bare 'prefix' keyword to show current group prefix even without using the command prefix
    try {
        const _cleanedLower = (rawBody || '').trim().toLowerCase();
        if (_cleanedLower === 'prefix' || _cleanedLower.startsWith('prefix ')) {
            if (!chat.isGroup) {
                try {
                    await msg.reply('🛑 Diesen Befehl kannst du nur in Gruppen nutzen.');
                } catch (e) {
                    console.error('[error] failed to send prefix-private reply:', e && (e.stack || e));
                }
                return;
            }

            try {
                const grpPrefix = (config.groupPrefixes && config.groupPrefixes[chat.id._serialized]) ? config.groupPrefixes[chat.id._serialized] : (config.prefix || prefix);
                await msg.reply(`Der aktuelle Prefix für diese Gruppe ist: \`${grpPrefix}\``);
            } catch (e) {
                console.error('[error] failed to send prefix reply:', e && (e.stack || e));
            }
            return;
        }
    } catch (e) {
        console.error('[error] prefix keyword handler failed:', e && (e.stack || e));
    }



    // DISPATCH: Economy commands (robust switch - placed after mute check to respect mutes)
    try {
        if (isCommand) {
            const cmd = command;
            console.debug('[debug] dispatching economy command', { cmd, args, authorId, usedPrefix });
            switch (cmd) {
                case 'balance':
                case 'bal': {
                    console.debug('[debug] handling balance');
                    let target = authorId;
                    if (msg.mentionedIds && msg.mentionedIds.length > 0) target = msg.mentionedIds[0];
                    const bal = econ.getBalance(target);
                    try {
                        await msg.reply(`💰 Kontostand von <@${target}>: ${bal} Coins`);
                    } catch (e) {
                        try {
                            const rr = await resolveMention(target);
                            await msg.reply(`💰 Kontostand von @${rr.name}: ${bal} Coins`, { mentions: rr.contact ? [rr.contact] : [] });
                        } catch (e2) {
                            const fallback = registry[target] && registry[target].name ? ('@'+registry[target].name) : (`<@${target}>`);
                            await msg.reply(`💰 Kontostand von ${fallback}: ${bal} Coins`);
                        }
                    }
                    break;
                }
                case 'daily': {
                    console.debug('[debug] handling daily');
                    const res = econ.claimDaily(authorId);
                    if (!res.ok) {
                        await msg.reply(`⏳ Du kannst dein Daily in ${res.remaining} Sekunden erneut abholen.`);
                    } else {
                        await msg.reply(`✅ Du hast ${res.amount} Coins erhalten. Aktueller Kontostand: ${econ.getBalance(authorId)}`);
                    }
                    break;
                }
                case 'work': {
                    console.debug('[debug] handling work');
                    const res = econ.work(authorId);
                    console.debug('[debug] work result', res);
                    if (!res.ok) {
                        if (res.error === 'no job') return await msg.reply('Du hast keinen Job. Sieh dir /jobs an und nimm einen an.');
                        if (res.error === 'cooldown') return await msg.reply(`⏳ Du musst noch ${res.remaining} Sekunden warten, bevor du wieder arbeiten kannst.`);
                        if (res.error === 'invalid job') return await msg.reply('⚠️ Dein Job ist ungültig. Bitte kündige mit `/job quit` und nimm einen neuen Job an.');
                        return await msg.reply('❌ Fehler beim Arbeiten: ' + (res.error || 'Unbekannter Fehler'));
                    }
                    await msg.reply(`💼 Du hast gearbeitet und ${res.pay} Coins verdient. Aktueller Kontostand: ${econ.getBalance(authorId)}`);
                    break;
                }
                case 'pay': {
                    console.debug('[debug] handling pay', { args });
                    if (!msg.mentionedIds || msg.mentionedIds.length === 0) return await msg.reply('Bitte markiere eine Person, an die du zahlen möchtest.');
                    const to = msg.mentionedIds[0];
                    const num = args.find(a => /^\d+(?:\.\d+)?$/.test(a));
                    if (!num) return await msg.reply('❌ Bitte gib einen Betrag an, z.B. `/pay @user 50`');
                    const amount = Number(num);
                    if (amount <= 0) return await msg.reply('❌ Ungültiger Betrag.');
                    try {
                        const r = econ.transfer(authorId, to, amount, 'pay');
                        try {
                            const rr = await resolveMention(to);
                            await msg.reply(`✅ Du hast ${amount} Coins an ${rr.name} überwiesen. Steuer: ${r.tax} Coins (${r.taxPercent}%). Empfänger erhielt ${r.net} Coins.`, { mentions: rr.contact ? [rr.contact] : [] });
                        } catch (e) {
                            const fallback = registry[to] && registry[to].name ? registry[to].name : (`<@${to}>`);
                            await msg.reply(`✅ Du hast ${amount} Coins an ${fallback} überwiesen. Steuer: ${r.tax} Coins (${r.taxPercent}%). Empfänger erhielt ${r.net} Coins.`);
                        }
                    } catch (errPay) {
                        await msg.reply('❌ Fehler: ' + (errPay.message || 'Überweisung fehlgeschlagen'));
                    }
                    break;
                }
                case 'leaderboard':
                case 'leaderbord': {
                    console.debug('[debug] handling leaderboard');
                    const rows = econ.leaderboard(10);
                    if (!rows || rows.length === 0) return await msg.reply('❌ Keine Einträge in der Bestenliste.');
                    const mentions = [];
                    const lines = [];
                    for (const [idx, row] of (rows||[]).entries()) {
                        try {
                            const rr = await resolveMention(row.id);
                            lines.push(`${idx+1}. ${rr.name} — ${Math.round(row.balance*100)/100} Coins`);
                            if (rr.contact) mentions.push(rr.contact);
                        } catch (e) {
                            const fallback = registry[row.id] && registry[row.id].name ? registry[row.id].name : (`<@${row.id}>`);
                            lines.push(`${idx+1}. ${fallback} — ${Math.round(row.balance*100)/100} Coins`);
                        }
                    }
                    try {
                        await msg.reply(`🏆 Bestenliste:\n${lines.join('\n')}`, { mentions });
                    } catch (e) {
                        await msg.reply(`🏆 Bestenliste:\n${lines.join('\n')}`);
                    }
                    break;
                }
                case 'menu': {
                    console.debug('[debug] handling menu');

                    const menu = [
                        '📋 *Hauptmenü*',
                        '',
                        '💼 *Wirtschaft*:',
                        ' - /balance [@user] — Zeige Kontostand',
                        ' - /daily — Hole dein Daily',
                        ' - /work — Arbeite (Cooldown 5min)',
                        ' - /pay @user <betrag> — Zahle Coins',
                        ' - /leaderboard — Bestenliste',
                        '',
                        '🎮 *Spiele*:',
                        ' - /coinflip <betrag> <kopf|zahl>',
                        ' - /dice <betrag> <1-6>',
                        ' - /slots <betrag>',
                        ' - /lotto buy [n1,n2,..] | /lotto draw (Admin)',
                        '',
                        '🛒 *Shop & Inventar*:',
                        ' - /shop — Liste im Shop',
                        ' - /buy <itemId> — Kauf',
                        ' - /inventory — Inventar',
                        ' - /sell <itemId> — Verkauf',
                        ' - /use <itemId> — Verwenden',
                        '',
                        '🔨 *Jobs*:',
                        ' - /jobs — Verfügbare Jobs',
                        ' - /job — Zeige deinen Job',
                        ' - /job take <jobId> — Job annehmen',
                        ' - /job quit — Job kündigen',
                        '',
                        '🏠 *Häuser*:',
                        ' - /house list — Häuser anzeigen',
                        ' - /house buy <houseId>',
                        ' - /house info — Deine Hausinfo',
                        '',
                        '🔧 *Sonstiges*:',
                        ' - /menu — Dieses Menü',
                        ' - /me — Zeige deine persönlichen Infos',
                        ' - /register [nickname] — Registriere dich (erforderlich für Befehle)',
                        ' - /unregister — Abmelden',
                        ' - /dsgvo — Zeigt die DSGVO-konforme Datenschutzerklärung',
                        ' - /agb — Zeigt die AGB (öffentlich)',
                        ' - /runtime — Zeigt die Bot-Ping/Latenz in ms',
                        ''
                    ];

                    // Moderation section only for group admins or the bot owner
                    if (isGroupAdmin || isOwner) {
                        menu.push('🛡️ *Moderation*:');
                        menu.push(' - /warn @user <reason> — Verwarnen');
                        menu.push(' - /warn list — Zeigt alle Verwarnungen in der Gruppe');
                        menu.push(' - /delwarn @user <warnId> — Verwarnung löschen');
                        menu.push(' - /kick @user — Kick aus der Gruppe');
                        menu.push(' - /promote @user — Promote to admin');
                        menu.push(' - /demote @user — Demote from admin');
                        menu.push(' - /lock — Gruppe sperren');
                        menu.push(' - /unlock — Gruppe entsperren');
                        menu.push(' - /setprefix <prefix|reset> — Setze gruppenspezifischen Prefix (Admin)');
                        menu.push(' - /autospam (an|aus) — Autospam aktivieren/deaktivieren (nur Gruppenadmins)');
                        menu.push(' - /tempban @user <minutes> — Temporärer Bann');
                        menu.push(' - /mute @user <minutes> — Stummschalten');
                        menu.push(' - /unmute @user — Stummschaltung aufheben');
                        menu.push(' - /mutes — Liste stummgeschalteter Nutzer');
                        menu.push('');
                        menu.push('🔒 *Owner / Admin* (sichtbar für Admins/Owner):');
                        menu.push(' - /owner — Zeige aktuellen Bot-Owner');
                        menu.push('');
                    } else {
                        menu.push('🔒 Moderationsbefehle sind nur für Gruppenadmins sichtbar.');
                        menu.push('🔒 /owner zeigt den Bot-Owner an. Änderungen müssen in `config.json` vorgenommen werden.');
                        menu.push('');
                    }

                    menu.push('Viel Spaß! 🎉');

                    // keep raw JID placeholders in the menu (show LID/JID as <@...>)
                    const menuText = menu.join('\n');
                    await msg.reply(menuText);
                    break;
                }
                case 'setowner': {
                    // Disabled: setting owner via command is not allowed. Owner must be set in config.json manually.
                    await msg.reply('⚠️ Dieser Befehl ist deaktiviert. Setze den Bot-Owner in der Datei `config.json` (Eigenschaft `owner`).');
                    break;
                }
                case 'owner': {
                    console.debug('[debug] handling owner', { args });
                    const sub = args[0] ? args[0].toLowerCase() : null;
                    if (!sub) {
                        let lines = [];
                        if (config.owner) lines.push(`🔒 Bot-Owner: <@${config.owner}>`);
                        if (config.coOwner) lines.push(`🔒 Bot-Co-Owner: <@${config.coOwner}>`);
                        if (lines.length === 0) return await msg.reply('⚠️ Es ist kein Bot-Owner oder Co-Owner gesetzt.');

                        let text = lines.join('\n');
                        const ments = [];
                        try {
                            if (config.owner) {
                                const r = await resolveMention(config.owner);
                                text = text.replace(`<@${config.owner}>`, r.name);
                                if (r.contact) ments.push(r.contact);
                            }
                        } catch (e) {}
                        try {
                            if (config.coOwner) {
                                const r = await resolveMention(config.coOwner);
                                text = text.replace(`<@${config.coOwner}>`, r.name);
                                if (r.contact) ments.push(r.contact);
                            }
                        } catch (e) {}

                        return await msg.reply(text, { mentions: ments.filter(Boolean) });
                    }
                    if (sub === 'clear' || sub === 'remove') {
                        // Disabled: require manual removal in config.json to avoid accidental or unauthorized clears
                        return await msg.reply('❌ Dieser Befehl ist deaktiviert. Entferne den Bot-Owner manuell aus der Datei `config.json` (Property `owner`).');
                    }
                    if (sub === 'set') {
                        if (!isGroupAdmin) return await msg.reply('🛑 Keine Berechtigung.');
                        const target = (msg.mentionedIds && msg.mentionedIds[0]) || args[1];
                        if (!target) return await msg.reply('Usage: /owner set @user');
                        let ownerId = normalizeId(target) || String(target);
                        if (/^\d+$/.test(ownerId)) ownerId = ownerId + '@c.us';
                        if (ownerId && ownerId.includes('@lid')) {
                            try { const resolved = await resolveLidToCjid(ownerId); if (resolved) ownerId = resolved; } catch (e) { console.error('[error] resolveLidToCjid failed in owner set', e); }
                        }
                        // allow setting both owner and co-owner via owner command
                        const sub2 = args[1] ? args[1].toLowerCase() : null;
                        if (sub2 === 'co' || sub2 === 'coowner') {
                            // Disabled: setting co-owner via command is not allowed. Require manual edit in config.json
                            return await msg.reply('❌ Dieser Befehl ist deaktiviert. Setze den Bot-Co-Owner manuell in der Datei `config.json` (Property `coOwner`).');
                        }
                        config.owner = ownerId; saveConfig();
                        try {
                            const r = await resolveMention(ownerId);
                            return await msg.reply(`✅ Bot-Owner gesetzt auf ${r.name}`, { mentions: r.contact ? [r.contact] : [] });
                        } catch (e) {
                            const fallback = registry[ownerId] && registry[ownerId].name ? ('@'+registry[ownerId].name) : ('@' + String(ownerId).replace(/@.*/, ''));
                            return await msg.reply(`✅ Bot-Owner gesetzt auf ${fallback}`);
                        }
                    }
                    return await msg.reply('Usage: /owner | /owner set @user | /owner clear');
                    break;
                }
                case 'setprefix': {
                    // setprefix <prefix> | setprefix reset - only in groups and only for group admins
                    if (!chat.isGroup) return await msg.reply('🛑 Dieser Befehl ist nur in Gruppen verfügbar.');
                    if (!isGroupAdmin) return await msg.reply('🛑 Keine Berechtigung. Nur Gruppenadmins können den Prefix der Gruppe ändern.');
                    const newp = args[0];
                    if (!newp) return await msg.reply('Usage: /setprefix <prefix> | /setprefix reset');
                    if (newp.toLowerCase() === 'reset' || newp.toLowerCase() === 'clear') {
                        if (config.groupPrefixes && config.groupPrefixes[groupId]) {
                            delete config.groupPrefixes[groupId];
                            saveConfig();
                            return await msg.reply(`✅ Gruppenspezifischer Prefix wurde zurückgesetzt. Der Bot verwendet jetzt globalen Prefix \`${config.prefix || prefix}\`.`);
                        } else {
                            return await msg.reply('⚠️ Es ist kein gruppenspezifischer Prefix gesetzt.');
                        }
                    }
                    if (/\s/.test(newp)) return await msg.reply('❌ Prefix darf keine Leerzeichen enthalten.');
                    if (newp.length > 3) return await msg.reply('❌ Prefix darf maximal 3 Zeichen lang sein.');
                    config.groupPrefixes = config.groupPrefixes || {};
                    config.groupPrefixes[groupId] = newp;
                    saveConfig();
                    return await msg.reply(`✅ Neuer Prefix für diese Gruppe: \`${newp}\``);
                }
                case 'register': {
                    // /register [nickname] - register yourself
                    try {
                        const uid = authorId || normalizeId(msg.author) || normalizeId(msg.from);
                        if (!uid) return await msg.reply('❌ Konnte deine ID nicht bestimmen. Versuche es später erneut.');
                        const provided = args.join(' ').trim();
                        let name = provided || null;
                        if (!name) {
                            try {
                                const c = await msg.getContact().catch(() => null);
                                name = c ? (c.pushname || c.shortName || c.name) : null;
                            } catch (e) { /* ignore */ }
                        }
                        if (!name) name = uid.replace(/[^0-9]/g, '');
                        registry[uid] = { name: name, registeredAt: Date.now() };
                        saveRegistry();
                        try {
                            const r = await resolveMention(uid);
                            await msg.reply(`✅ @${r.name} Du bist nun registriert als: ${name}`, { mentions: r.contact ? [r.contact] : [] });
                        } catch (e) {
                            try {
                                const r = await resolveMention(uid);
                                await msg.reply(`✅ @${r.name} Du bist nun registriert als: ${name}`, { mentions: r.contact ? [r.contact] : [] });
                            } catch (e) {
                                const fallbackName = registry[uid] && registry[uid].name ? ('@'+registry[uid].name) : ('@' + String(uid).replace(/@.*/, ''));
                                await msg.reply(`✅ ${fallbackName} Du bist nun registriert als: ${name}`);
                            }
                        }
                    } catch (e) {
                        console.error('[error] /register failed:', e && (e.stack || e));
                        await msg.reply('❌ Registrierung fehlgeschlagen.');
                    }
                    break;
                }
                case 'unregister': {
                    // /unregister - remove your registration
                    try {
                        const uid = authorId || normalizeId(msg.author) || normalizeId(msg.from);
                        if (!uid) return await msg.reply('❌ Konnte deine ID nicht bestimmen. Versuche es später erneut.');
                        if (!registry[uid]) {
                            try {
                                const r = await resolveMention(uid);
                                return await msg.reply(`⚠️ ${r.name} Du bist nicht registriert.`, { mentions: r.contact ? [r.contact] : [] });
                            } catch (e) {
                                try {
                                    const r = await resolveMention(uid);
                                    return await msg.reply(`⚠️ ${r.name} Du bist nicht registriert.`, { mentions: r.contact ? [r.contact] : [] });
                                } catch (e) {
                                    const fallback = registry[uid] && registry[uid].name ? ('@'+registry[uid].name) : ('@' + String(uid).replace(/@.*/, ''));
                                    return await msg.reply(`⚠️ ${fallback} Du bist nicht registriert.`);
                                }
                            }
                        }
                        delete registry[uid];
                        saveRegistry();
                        try {
                            const r = await resolveMention(uid);
                            await msg.reply(`✅ ${r.name} Du wurdest abgemeldet.`, { mentions: r.contact ? [r.contact] : [] });
                        } catch (e) {
                            try {
                                const r = await resolveMention(uid);
                                await msg.reply(`✅ ${r.name} Du wurdest abgemeldet.`, { mentions: r.contact ? [r.contact] : [] });
                            } catch (e) {
                                const fallbackName = registry[uid] && registry[uid].name ? registry[uid].name : uid;
                                await msg.reply(`✅ ${fallbackName} Du wurdest abgemeldet.`);
                            }
                        }
                    } catch (e) {
                        console.error('[error] /unregister failed:', e && (e.stack || e));
                        await msg.reply('❌ Fehler beim Abmelden.');
                    }
                    break;
                }
                case 'coinflip': {
                    console.debug('[debug] handling coinflip', { args });
                    const num = args.find(a => /^\d+(?:\.\d+)?$/.test(a));
                    const choice = args.find(a => /^(kopf|zahl)$/i.test(a));
                    if (!num || !choice) return await msg.reply('Usage: /coinflip <betrag> <kopf|zahl>');
                    const bet = Number(num);
                    try {
                        const r = econ.coinflip(authorId, bet, choice.toLowerCase());
                        if (r.win) await msg.reply(`🎉 Gewinn! Die Münze zeigte ${r.flip}. Du gewinnst ${r.payout} Coins!`);
                        else await msg.reply(`😢 Verloren. Die Münze zeigte ${r.flip}. Besser Glück beim nächsten Mal.`);
                    } catch (errGame) { await msg.reply('❌ Fehler: ' + (errGame.message || 'Spiel fehlgeschlagen')); }
                    break;
                }
                case 'dice': {
                    console.debug('[debug] handling dice', { args });
                    const num = args.find(a => /^\d+(?:\.\d+)?$/.test(a));
                    const guess = args.find(a => /^[1-6]$/.test(a));
                    if (!num || !guess) return await msg.reply('Usage: /dice <betrag> <1-6>');
                    const bet = Number(num);
                    const g = Number(guess);
                    try {
                        const r = econ.dice(authorId, bet, g);
                        if (r.win) await msg.reply(`🎉 Richtig! Die Zahl war ${r.roll}. Du gewinnst ${r.payout} Coins!`);
                        else await msg.reply(`😢 Falsch. Die Zahl war ${r.roll}.`);
                    } catch (errGame) { await msg.reply('❌ Fehler: ' + (errGame.message || 'Spiel fehlgeschlagen')); }
                    break;
                }
                case 'slots': {
                    console.debug('[debug] handling slots', { args });
                    const num = args.find(a => /^\d+(?:\.\d+)?$/.test(a));
                    if (!num) return await msg.reply('Usage: /slots <betrag>');
                    const bet = Number(num);
                    try {
                        const r = econ.slots(authorId, bet);
                        const board = `${r.a} | ${r.b} | ${r.c}`;
                        if (r.win) await msg.reply(`🎰 ${board}\n🎉 Triple! Du gewinnst ${r.payout} Coins!`);
                        else await msg.reply(`🎰 ${board}\n😢 Leider verloren.`);
                    } catch (errGame) { await msg.reply('❌ Fehler: ' + (errGame.message || 'Slots fehlgeschlagen')); }
                    break;
                }
                case 'lotto': {
                    console.debug('[debug] handling lotto', { args });
                    const sub = (args && args[0]) ? args[0].toLowerCase() : '';
                    if (sub === 'buy') {
                        const nums = args[1] || null;
                        try { econ.buyLottoTicket(groupId, authorId, nums || []); await msg.reply('🎟️ Lotto-Ticket gekauft. Viel Glück!'); } catch (errL) { console.error('[error] /lotto buy failed:', errL); await msg.reply('Fehler beim Kaufen des Lotto-Tickets.'); }
                    } else if (sub === 'draw') {
                        if (!isGroupAdmin) return await msg.reply('🛑 Keine Berechtigung.');
                        try { const res = econ.drawLotto(groupId); await msg.reply(`🎉 Lotto gezogen: Zahlen ${res.numbers.join(', ')}\nGewinner: ${res.winners.length ? res.winners.join(', ') : 'Keine Gewinner'}\nPott: ${res.pot} Coins`); } catch (errD) { console.error('[error] /lotto draw failed:', errD); await msg.reply('Fehler beim Ziehen des Lottos.'); }
                    } else { await msg.reply('Usage: /lotto buy [n1,n2,...]  oder /lotto draw (nur Admins)'); }
                    break;
                }
                case 'shop': {
                    console.debug('[debug] handling shop');
                    const items = econ.listShop();
                    if (!items || items.length === 0) return await msg.reply('🛒 Shop ist leer.');
                    const lines = items.map(i => `${i.id}: ${i.name} — ${i.price} Coins — ${i.description}`);
                    await msg.reply(`🛒 Shop:\n${lines.join('\n')}`);
                    break;
                }
                case 'buy': {
                    console.debug('[debug] handling buy', { args });
                    const itemId = args[0];
                    if (!itemId) return await msg.reply('Usage: /buy <itemId>');
                    try { const item = econ.buyItem(authorId, itemId); await msg.reply(`✅ Du hast ${item.name} gekauft für ${item.price} Coins.`); } catch (errB) { await msg.reply('Fehler: ' + (errB.message || 'Kauf fehlgeschlagen')); }
                    break;
                }
                case 'inventory':
                case 'inv': {
                    console.debug('[debug] handling inventory');
                    const inv = econ.getInventory(authorId);
                    if (!inv || inv.length === 0) return await msg.reply('⚠️ Dein Inventar ist leer.');
                    const lines = inv.map((it, idx) => `${idx+1}. ${it.name} (${it.id})`);
                    await msg.reply(`🎒 Dein Inventar:\n${lines.join('\n')}`);
                    break;
                }
                case 'id': {
                    console.debug('[debug] handling id');
                    try {
                        let target = null;
                        if (msg.mentionedIds && msg.mentionedIds.length > 0) {
                            target = msg.mentionedIds[0];
                        } else if (msg.hasQuotedMsg) {
                            const quoted = await msg.getQuotedMessage();
                            target = (quoted && (quoted.author || quoted.from)) || null;
                        }
                        if (!target) return await msg.reply('❌ Bitte antworte auf eine Nachricht oder markiere einen Nutzer mit @, z.B. `/id @user`.');
                        try {
                            const r = await resolveMention(target);
                            await msg.reply(`✅ Die ID von ${r.name} ist: ${target}`, { mentions: r.contact ? [r.contact] : [] });
                        } catch (e) {
                            const fallback = registry[target] && registry[target].name ? ('@'+registry[target].name) : (`<@${target}>`);
                            await msg.reply(`✅ Die ID von ${fallback} ist: ${target}`);
                        }
                    } catch (e) {
                        console.error('[error] /id failed:', e && (e.stack || e));
                        await msg.reply('❌ Fehler beim Abrufen der ID.');
                    }
                    break;
                }
                case 'me': {
                    console.debug('[debug] handling me');
                    try {
                        const u = econ.getUser(authorId) || {};
                        const balance = econ.getBalance(authorId);
                        const inv = econ.getInventory(authorId) || [];
                        const job = u.job ? econ.getJob(u.job) : null;
                        const house = u.house ? econ.houseInfo(authorId) : null;
                        // Safe resolved registration name (avoid ReferenceError if undefined)
                        const regName = (registry && registry[authorId] && registry[authorId].name) ? registry[authorId].name : null;

                        const lastDaily = u.daily_last ? new Date(Number(u.daily_last) * 1000).toUTCString() : 'Nie';
                        const lastWork = u.work_last ? new Date(Number(u.work_last) * 1000).toUTCString() : 'Nie';
                        let workRemaining = null;
                        try {
                            if (u.work_last) {
                                const now = Date.now();
                                const last = Number(u.work_last) * 1000;
                                const cooldownMs = 5 * 60 * 1000;
                                if (now - last < cooldownMs) workRemaining = Math.ceil((cooldownMs - (now - last)) / 1000);
                            }
                        } catch (e) { /* ignore */ }

                        const lines = [];
                        lines.push(`👤 *Deine Infos*`);
                        lines.push('');
                        if (regName) lines.push(`Name: ${regName}`);
                        lines.push(`ID: ${authorId}`);
                        lines.push(`💰 Kontostand: ${balance} Coins`);
                        lines.push(`💼 Job: ${job ? `${job.name} (${job.id}) — ${job.pay_min}-${job.pay_max} Coins` : 'Kein Job'}`);
                        lines.push(`🏠 Haus: ${house ? `${house.name} (${house.id})` : 'Keins'}`);
                        lines.push(`🎒 Inventar: ${inv.length} Gegenstände${inv.length>0 ? ' — ' + inv.slice(0,8).map(i => i.name).join(', ') : ''}`);
                        lines.push(`📅 Daily zuletzt: ${lastDaily}`);
                        lines.push(`🕒 Letztes Work: ${lastWork}${workRemaining ? ` — Wartezeit: ${workRemaining}s` : ''}`);
                        lines.push(`🔒 Admin in dieser Gruppe: ${isGroupAdmin ? 'Ja' : 'Nein'}`);
                        lines.push(`⭐ Bot-Owner: ${isOwner ? 'Ja' : 'Nein'}`);

                        try {
                            const r = await resolveMention(authorId);
                            await msg.reply(lines.join('\n'), { mentions: r.contact ? [r.contact] : [] });
                        } catch (e) {
                            await msg.reply(lines.join('\n'));
                        }
                    } catch (e) {
                        console.error('[error] /me failed:', e);
                        await msg.reply('❌ Fehler beim Abrufen deiner Infos.');
                    }
                    break;
                }
                case 'sell': {
                    console.debug('[debug] handling sell', { args });
                    const itemId = args[0];
                    if (!itemId) return await msg.reply('Usage: /sell <itemId>');
                    try { const gain = econ.sellItem(authorId, itemId); await msg.reply(`✅ Du hast ${gain} Coins erhalten (Verkauf).`); } catch (errS) { await msg.reply('Fehler: ' + (errS.message || 'Verkauf fehlgeschlagen')); }
                    break;
                }
                case 'use': {
                    console.debug('[debug] handling use', { args });
                    const itemId = args[0];
                    if (!itemId) return await msg.reply('Usage: /use <itemId>');
                    try { const it = econ.useItem(authorId, itemId); await msg.reply(`✅ Du hast ${it.name} verwendet.`); } catch (errU) { await msg.reply('Fehler: ' + (errU.message || 'Gebrauch fehlgeschlagen')); }
                    break;
                }
                case 'jobs': {
                    console.debug('[debug] handling jobs');
                    const jobs = econ.listJobs();
                    if (!jobs || jobs.length === 0) return await msg.reply('❌ Keine Jobs verfügbar.');
                    const lines = jobs.map(j => `${j.id}: ${j.name} — ${j.pay_min}-${j.pay_max} Coins — ${j.description}`);
                    await msg.reply(`🔨 Verfügbare Jobs:\n${lines.join('\n')}`);
                    break;
                }
                case 'job': {
                    console.debug('[debug] handling job', { args });
                    const sub = args[0] ? args[0].toLowerCase() : null;
                    // show current job
                    if (!sub) {
                        try {
                            const dbInfo = econ.getUser(authorId);
                            if (!dbInfo || !dbInfo.job) return await msg.reply('Du hast aktuell keinen Job.');
                            console.debug('[debug] /job show', { authorId, storedJob: dbInfo.job });
                            const job = econ.getJob(dbInfo.job);
                            console.debug('[debug] /job show resolved job', { authorId, storedJob: dbInfo.job, job });
                            if (!job) return await msg.reply('Du hast einen ungültigen Job. Bitte kündige mit `/job quit` und nimm einen neuen Job an.');
                            return await msg.reply(`💼 Dein Job: ${job.name} — ${job.pay_min}-${job.pay_max} Coins`);
                        } catch (e) {
                            console.error('[error] /job show failed:', e);
                            return await msg.reply('❌ Fehler beim Abrufen deines Jobs.');
                        }
                    }

                    // take a job
                    if (sub === 'take') {
                        const jobId = args[1];
                        if (!jobId) return await msg.reply('Usage: /job take <jobId>');
                        try {
                            const after = await econ.takeJob(authorId, jobId);
                            const jobObjInput = econ.getJob(jobId);
                            const jobObjStored = econ.getJob(after && after.job ? after.job : jobId);
                            console.debug('[debug] /job take success', { authorId, jobId, stored: after && after.job, jobObjInput, jobObjStored });
                            if (jobObjStored) await msg.reply(`✅ Job ${jobObjStored.name} (${jobObjStored.id}) angenommen.`);
                            else if (jobObjInput) await msg.reply(`✅ Job ${jobObjInput.name} (${jobObjInput.id}) angenommen.`);
                            else await msg.reply(`✅ Job ${jobId} angenommen.`);
                        } catch (errJ) {
                            console.error('[error] /job take failed:', errJ);
                            await msg.reply('❌ Fehler: ' + (errJ.message || 'Job konnte nicht angenommen werden'));
                        }
                        return;
                    }

                    // quit job
                    if (sub === 'quit') {
                        try {
                            await econ.quitJob(authorId);
                            console.debug('[debug] /job quit success', { authorId });
                            await msg.reply('✅ Du hast deinen Job gekündigt.');
                        } catch (errJ) {
                            console.error('[error] /job quit failed:', errJ);
                            await msg.reply('❌ Fehler: ' + (errJ.message || 'Kündigung fehlgeschlagen'));
                        }
                        return;
                    }

                    // unknown subcommand
                    await msg.reply('Usage: /job | /job take <jobId> | /job quit');
                    break;
                }
                case 'house': {
                    console.debug('[debug] handling house', { args });
                    const sub = args[0] ? args[0].toLowerCase() : null;
                            if (sub === 'list') {
                        console.debug('[debug] handling house list');
                        try {
                            const houses = econ.listHouses();
                            if (!houses || houses.length === 0) return await msg.reply('Keine Häuser im Shop.');
                            const lines = houses.map(h => `${h.id}: ${h.name} — ${h.price} Coins`);
                            await msg.reply(`🏠 Verfügbare Häuser:\n${lines.join('\n')}`);
                        } catch (errL) {
                            console.error('[error] /house list failed:', errL);
                            await msg.reply('❌ Fehler beim Anzeigen der Häuser.');
                        }
                    } else if (sub === 'buy') {
                        const idHouse = args[1];
                        if (!idHouse) return await msg.reply('Usage: /house buy <houseId>');
                        try { const h = econ.buyHouse(authorId, idHouse); await msg.reply(`🏠 Du hast ein Haus gekauft: ${h.name}`); } catch (errH) { await msg.reply('Fehler: ' + (errH.message || 'Haus-Kauf fehlgeschlagen')); }
                    } else if (sub === 'info') {
                        try { const info = econ.houseInfo(authorId); if (!info) return await msg.reply('❌ Du besitzt kein Haus.'); await msg.reply(`🏠 Haus: ${info.name} — ${info.description} — Preis: ${info.price} Coins`); } catch (e) { console.error('[error] /house info failed:', e); await msg.reply('Fehler beim Abrufen der Haus-Info.'); }
                    } else { await msg.reply('Usage: /house list | /house buy <houseId>  oder /house info'); }
                    break;
                }
                case 'take': {
                    // accept "take job <jobId>" as a convenience
                    if (args && args[0] && args[0].toLowerCase() === 'job') {
                        const jobId = args[1];
                        if (!jobId) return await msg.reply('Usage: take job <jobId>');
                        try {
                            const after = await econ.takeJob(authorId, jobId);
                            const jobObj = econ.getJob(after && after.job ? after.job : jobId);
                            if (jobObj) await msg.reply(`✅ Job ${jobObj.name} (${jobObj.id}) angenommen.`);
                            else await msg.reply(`✅ Job ${jobId} angenommen.`);
                        } catch (err) {
                            console.error('[error] take job failed:', err);
                            await msg.reply('❌ Fehler: ' + (err && (err.message || 'Job konnte nicht angenommen werden')));
                        }
                    }
                    break;
                }
                default: {
                    // unknown command: suggest similar commands
                    try {
                        // If this command is handled by other handlers (outside the economy switch), skip the "unknown" suggestion
                        const EXTERNALLY_HANDLED = ['warn','delwarn','kick','promote','demote','lock','unlock','tempban','mute','unmute','mutes','del','whoami','setprefix','setowner','owner','dsgvo','agb','autospam','runtime','ping','allcmds','me','menu','botban','botunban','bottempban','id','fixjobs','botwarn','botdelwarn'];
                        if (EXTERNALLY_HANDLED.includes(command)) {
                            console.debug('[debug] skipping unknown suggestion for externally-handled command', { command });
                            break;
                        }

                        const KNOWN_COMMANDS = ['ping','menu','me','balance','bal','daily','work','pay','leaderboard','leaderbord','coinflip','dice','slots','lotto','shop','buy','inventory','inv','sell','use','jobs','job','house','take','warn','delwarn','kick','promote','demote','lock','unlock','tempban','mute','unmute','mutes','del','fixjobs','allcmds','botwarn','botdelwarn'];

                        function levenshtein(a, b) {
                            if (a === b) return 0;
                            if (a.length === 0) return b.length;
                            if (b.length === 0) return a.length;
                            let v0 = new Array(b.length + 1).fill(0);
                            let v1 = new Array(b.length + 1).fill(0);
                            for (let i = 0; i <= b.length; i++) v0[i] = i;
                            for (let i = 0; i < a.length; i++) {
                                v1[0] = i + 1;
                                for (let j = 0; j < b.length; j++) {
                                    const cost = a[i] === b[j] ? 0 : 1;
                                    v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
                                }
                                for (let k = 0; k < v0.length; k++) v0[k] = v1[k];
                            }
                            return v0[b.length];
                        }

                        function getSuggestions(input, candidates, max = 3) {
                            if (!input) return [];
                            const inLower = input.toLowerCase();
                            // prioritize prefix and contains matches
                            const prefixMatches = candidates.filter(c => c.startsWith(inLower));
                            const containsMatches = candidates.filter(c => !c.startsWith(inLower) && c.includes(inLower));
                            const scored = candidates
                                .filter(c => !prefixMatches.includes(c) && !containsMatches.includes(c))
                                .map(c => ({ c, d: levenshtein(inLower, c) }))
                                .sort((a, b) => a.d - b.d)
                                .map(x => x.c);

                            const merged = [...prefixMatches, ...containsMatches, ...scored];
                            // compute normalized similarity and filter
                            const uniq = [...new Set(merged)].slice(0, 10);
                            const withScore = uniq.map(c => {
                                const d = levenshtein(inLower, c);
                                const score = 1 - (d / Math.max(inLower.length, c.length));
                                return { c, score };
                            }).filter(x => x.score >= 0.3).sort((a, b) => b.score - a.score).slice(0, max).map(x => x.c);
                            return withScore;
                        }

                        const suggestions = getSuggestions(command, KNOWN_COMMANDS, 4);
                        if (suggestions && suggestions.length > 0) {
                            const line = suggestions.map(s => `${usedPrefix}${s}`).join(', ');
                            await msg.reply(`❌ Diesen Command gibt es nicht. Meintest du vielleicht: ${line}`);
                        } else {
                            await msg.reply('❌ Diesen Command gibt es nicht. Nutze `/menu` für eine Liste der Befehle.');
                        }
                    } catch (e) {
                        console.error('[error] unknown-command suggestion failed:', e);
                    }
                    break;
                }
            }
        }
    } catch (e) {
        console.error('[error] economy dispatch failed:', e);
    }

    // AUTOSPAM - prüfe, ob Nutzer viele Nachrichten in kurzer Zeit sendet (nur Gruppen)
    try {
        if (!msg.fromMe && chat.isGroup) {
            const gid = groupId;
            spamTracker[gid] = spamTracker[gid] || {};
            let uid = authorId || normalizeId(msg.author) || normalizeId(msg.from);
            // normalize uid to consistent form for warns map
            try {
                if (uid && typeof uid === 'string') {
                    if (/^\d+$/.test(uid)) uid = uid + '@c.us';
                    if (uid.includes('@lid')) {
                        const resolved = await resolveLidToCjid(uid).catch(() => null);
                        if (resolved) uid = resolved;
                    }
                } else {
                    uid = normalizeId(uid) || uid;
                }
            } catch (e) { console.debug('[debug] autospam uid normalization failed', e && (e.message || e)); }

            if (uid) {
                // per-group autospam toggle - default: enabled
                const autoSpamEnabled = (config.groupAutospam && typeof config.groupAutospam[gid] !== 'undefined') ? config.groupAutospam[gid] : true;
                if (autoSpamEnabled) {
                    const now = Date.now();
                    spamTracker[gid][uid] = spamTracker[gid][uid] || { timestamps: [], lastWarnAt: 0 };
                    const entry = spamTracker[gid][uid];
                    entry.timestamps.push(now);
                    const cutoff = now - spamConfig.windowMs;
                    entry.timestamps = entry.timestamps.filter(t => t >= cutoff);

                    if (entry.timestamps.length >= spamConfig.max && (!entry.lastWarnAt || now - entry.lastWarnAt > spamConfig.warnCooldownMs)) {
                        entry.lastWarnAt = now;
                        // Issue automatic warn
                        warns[gid] = warns[gid] || {};
                        const prev = warns[gid][uid] || 0;
                        warns[gid][uid] = prev + 1;
                        saveWarns();
                        try {
                            await msg.reply(`⚠️ Automatische Verwarnung wegen Spam: <@${uid}> (${warns[gid][uid]}/3)`);
                        } catch (e) {
                            msg.reply(`⚠️ Automatische Verwarnung wegen Spam: <@${uid}> (${warns[gid][uid]}/3)`);
                        }

                        // If reaches 3, kick
                        if (warns[gid][uid] >= 3) {
                            try {
                                const r = await resolveMention(uid);
                                await msg.reply(`❌ @${r.name} hat 3 Warns erreicht und wird aus der Gruppe entfernt.`, { mentions: r.contact ? [r.contact] : [] });
                            } catch (e) {
                                const fallback = registry[uid] && registry[uid].name ? ('@'+registry[uid].name) : (`<@${uid}>`);
                                msg.reply(`❌ ${fallback} hat 3 Warns erreicht und wird aus der Gruppe entfernt.`);
                            }
                            try {
                                await chat.removeParticipants([uid]);
                                msg.reply('✅ Person wurde entfernt.');
                                delete warns[gid][uid];
                                saveWarns();
                            } catch (err) {
                                msg.reply('❌ Fehler: Bot muss Admin sein.');
                            }
                        }
                    }
                }
            }
        }
    } catch (e) {
        console.error('[error] Autospam check failed:', e);
    }

    // /ping - simple ping (für alle)
    if (command === 'ping') {
        try {
            const t0 = Date.now();
            await msg.reply(`🏓 Pong — ${Date.now() - t0} ms`);
            return;
        } catch (e) {
            console.error('[error] /ping failed:', e && (e.stack || e));
            return msg.reply('⚠️ Fehler beim Messen der Ping-Latenz.');
        }
    }

    // /runtime - Zeigt die aktuellen Ping/Latenz des Bots in ms (verfügbar für alle, außer Bot-gesperrte)
    if (command === 'runtime') {
        try {
            const t0 = Date.now();
            // send only the final message; measure elapsed as time until send completes
            await msg.reply(`🏓 Pong — ${Date.now() - t0} ms`);
            return;
        } catch (e) {
            console.error('[error] /runtime failed:', e && (e.stack || e));
            return msg.reply('⚠️ Fehler beim Messen der Latenz.');
        }
    }

    // /whoami - Debug: zeigt authorId, owner, Kontaktinfo und ob der Bot dich als Admin sieht
    if (command === "whoami") {
        try {
            const contact = authorContact || await msg.getContact().catch(() => null);
            const contactId = normalizeId(contact && contact.id) || 'N/A';
            const contactNumber = contact && contact.number ? contact.number : (contactId !== 'N/A' ? contactId.replace(/[^0-9]/g, '') : 'N/A');
            const ownerId = chat.owner ? normalizeId(chat.owner) : 'N/A';
            const participantsInfo = (participants && Array.isArray(participants)) ? participants.slice(0,10).map(p => ({ id: normalizeId(p.id||p), isAdmin: !!p.isAdmin, adminField: p.admin, roleField: p.role })) : [];
            try {
                const ra = await resolveMention(authorId);
                const ro = ownerId && ownerId !== 'N/A' ? await resolveMention(ownerId).catch(() => null) : null;
                await msg.reply(`authorId: ${ra.name}\nauthorContactId: ${contactId}\nauthorContactNumber: ${contactNumber}\nownerId: ${ro ? ro.name : (ownerId && ownerId !== 'N/A' ? ownerId : 'N/A')}\nisGroupAdmin: ${isGroupAdmin}\nparticipants (sample): ${JSON.stringify(participantsInfo)}`, { mentions: [ra.contact].filter(Boolean).concat(ro && ro.contact ? [ro.contact] : []) });
            } catch (e) {
                const fallbackAuthor = registry[authorId] && registry[authorId].name ? ('@'+registry[authorId].name) : (`<@${authorId}>`);
                const fallbackOwner = ownerId && ownerId !== 'N/A' ? (registry[ownerId] && registry[ownerId].name ? ('@'+registry[ownerId].name) : (`<@${ownerId}>`)) : 'N/A';
                await msg.reply(`authorId: ${fallbackAuthor}\nauthorContactId: ${contactId}\nauthorContactNumber: ${contactNumber}\nownerId: ${fallbackOwner}\nisGroupAdmin: ${isGroupAdmin}\nparticipants (sample): ${JSON.stringify(participantsInfo)}`);
            }
        } catch (e) {
            console.error('[error] /whoami failed:', e);
            msg.reply('❌ Fehler beim Ausführen von /whoami. Sieh in der Konsole nach.');
        }
    }

    // /setprefix (group-specific)
    if (command === "setprefix") {
        if (!chat.isGroup) return msg.reply('🛑 Dieser Befehl ist nur in Gruppen verfügbar.');
        if (!isGroupAdmin) return msg.reply('🛑 Keine Berechtigung. Nur Gruppenadmins können den Prefix der Gruppe ändern.');
        if (!args[0]) return msg.reply('Usage: /setprefix <prefix> | /setprefix reset');
        const newp = args[0];
        if (newp.toLowerCase() === 'reset' || newp.toLowerCase() === 'clear') {
            if (config.groupPrefixes && config.groupPrefixes[groupId]) {
                delete config.groupPrefixes[groupId];
                saveConfig();
                return msg.reply(`✅ Gruppenspezifischer Prefix wurde zurückgesetzt. Der Bot verwendet jetzt globalen Prefix \`${config.prefix || prefix}\`.`);
            } else {
                return msg.reply('⚠️ Es ist kein gruppenspezifischer Prefix gesetzt.');
            }
        }
        if (/\s/.test(newp)) return msg.reply('❌ Prefix darf keine Leerzeichen enthalten.');
        if (newp.length > 3) return msg.reply('❌ Prefix darf maximal 3 Zeichen lang sein.');
        config.groupPrefixes = config.groupPrefixes || {};
        config.groupPrefixes[groupId] = newp;
        saveConfig();
        return msg.reply(`✅ Neuer Prefix für diese Gruppe: \`${newp}\``);
    }

    // /autospam (group-specific on|off)
    if (command === 'autospam') {
        if (!chat.isGroup) return msg.reply('🛑 Dieser Befehl ist nur in Gruppen verfügbar.');
        if (!isGroupAdmin) return msg.reply('🛑 Keine Berechtigung. Nur Gruppenadmins können Autospam konfigurieren.');
        const opt = args[0] ? String(args[0]).toLowerCase() : null;
        if (!opt) {
            const cur = (config.groupAutospam && typeof config.groupAutospam[groupId] !== 'undefined') ? (config.groupAutospam[groupId] ? 'an' : 'aus') : 'an';
            return msg.reply(`Autospam ist derzeit: \`${cur}\` (Nutze /autospam an oder /autospam aus)`);
        }
        if (['an','on','true','ein'].includes(opt)) {
            config.groupAutospam = config.groupAutospam || {};
            config.groupAutospam[groupId] = true;
            saveConfig();
            return msg.reply('✅ Autospam aktiviert für diese Gruppe.');
        }
        if (['aus','off','false'].includes(opt)) {
            config.groupAutospam = config.groupAutospam || {};
            config.groupAutospam[groupId] = false;
            saveConfig();
            return msg.reply('✅ Autospam deaktiviert für diese Gruppe.');
        }
        return msg.reply('Usage: /autospam an|aus');
    }

    // /dsgvo - Datenschutzerklärung (für alle Nutzer)
    if (command === 'dsgvo') {
        const privacy = `📘 Aktualisierte Datenschutzerklärung für AegisBot (DSGVO‑konform)
Stand: 30.12.2025
Verantwortlicher: Betreiber des WhatsApp‑Bots „AegisBot" 

1. Zweck der Datenverarbeitung
AegisBot verarbeitet personenbezogene Daten ausschließlich zur Bereitstellung von Moderations‑ und Automatisierungsfunktionen in WhatsApp‑Gruppen

2. Verarbeitete Daten
AegisBot verarbeitet folgende Daten:

- Telefonnummern
- Nachrichteninhalte, soweit sie zur Funktion notwendig sind
- Log‑Daten 
- Registrierungsdaten

3. Speicherdauer
Registrierte Nutzerdaten werden nur so lange gespeichert, wie der Nutzer registriert ist.
Sobald ein Nutzer /unregister ausführt, werden seine Daten vollständig gelöscht.

Log‑Daten können technisch bedingt länger gespeichert werden, jedoch nur zur Sicherstellung der Funktionsfähigkeit.

Nachrichteninhalte werden nur temporär verarbeitet und nicht dauerhaft gespeichert.

4. Rechtsgrundlage
Art. 6 Abs. 1 lit. b DSGVO – Nutzung des Bots

Art. 6 Abs. 1 lit. f DSGVO – Funktionssicherheit, Missbrauchsvermeidung

5. Weitergabe von Daten
Es erfolgt keine Weitergabe an Dritte, außer wenn gesetzlich vorgeschrieben oder technisch notwendig ist

6. Rechte der Nutzer
Nutzer können jederzeit:

- Auskunft über gespeicherte Daten erhalten
- Löschung verlangen
- Widerspruch einlegen
- Berichtigung verlangen

Anfragen können an den Inhaber gesendet werden (+49 15174203668)

7. Sicherheit
Es werden angemessene technische und organisatorische Maßnahmen getroffen, um Daten vor unbefugtem Zugriff zu schützen.`;
        return msg.reply(privacy);
    }

    // Common guard: prevent group-only commands from being used in private chats
    // Centralized check to provide a consistent message.
    try {
        if (!chat.isGroup && command) {
            const GROUP_ONLY = new Set(['warn','delwarn','kick','promote','demote','lock','unlock','tempban','mute','unmute','mutes','setprefix','prefix','autospam']);
            if (GROUP_ONLY.has(command)) {
                return msg.reply('🛑 Diesen Befehl kannst du nur in Gruppen nutzen.');
            }
        }
    } catch (e) {
        console.error('[error] group-only guard failed:', e && (e.stack || e));
    }

    // handle prefixed '/prefix' command (consistent with bare keyword)
    if (command === 'prefix') {
        if (!chat.isGroup) return msg.reply('🛑 Diesen Befehl kannst du nur in Gruppen nutzen.');
        try {
            const grpPrefix = (config.groupPrefixes && config.groupPrefixes[groupId]) ? config.groupPrefixes[groupId] : (config.prefix || prefix);
            return msg.reply(`Der aktuelle Prefix für diese Gruppe ist: \`${grpPrefix}\``);
        } catch (e) {
            console.error('[error] /prefix handler failed:', e && (e.stack || e));
            return msg.reply('⚠️ Fehler beim Abrufen des Prefixes.');
        }
    }

    // /agb - Allgemeine Geschäftsbedingungen (für alle Nutzer)
    if (command === 'agb') {
        const agb = `📘 AGB für AegisBot
Stand: 30.12.2025
Geltungsbereich: Diese Allgemeinen Geschäftsbedingungen gelten für die Nutzung des WhatsApp‑Bots „AegisBot".

1. Leistungsbeschreibung
AegisBot ist ein Moderations‑ und Automatisierungsbot für WhatsApp‑Gruppen.
Der Bot bietet u. a.:

- Moderationsfunktionen
- Automatische Reaktionen
- Nutzerregistrierung und Rollenverwaltung
- Logging zur Funktionssicherheit

Es besteht kein Anspruch auf ständige Verfügbarkeit, fehlerfreie Funktion oder vollständige Leistung.

2. Nutzungsvoraussetzungen
Die Nutzung erfolgt freiwillig.

Durch das Interagieren mit dem Bot akzeptieren Nutzer diese AGB und die Datenschutzerklärung.

Der Betreiber kann Funktionen jederzeit ändern, erweitern oder entfernen.

3. Registrierung und Abmeldung
Nutzer können sich über entsprechende Befehle registrieren.

Registrierungsdaten werden in einer Datei gespeichert.

Bei Nutzung von /unregister werden alle personenbezogenen Registrierungsdaten vollständig gelöscht.

Ohne Registrierung stehen ggf. eingeschränkte Funktionen zur Verfügung.

4. Pflichten der Nutzer
Nutzer verpflichten sich, den Bot nicht zu verwenden für:

- rechtswidrige Inhalte
- Spam, Belästigung oder Missbrauch
- technische Angriffe oder Manipulation
- Umgehung von Sicherheitsmechanismen

Moderatoren können Nutzer bei Verstößen sperren oder entfernen

5. Haftungsausschluss
Der Betreiber haftet nicht für:

- Schäden durch Fehlfunktionen
- Datenverlust
- Missbrauch durch Dritte
- Ausfälle oder technische Probleme
- falsche Nutzung durch Nutzer

Die Nutzung erfolgt auf eigenes Risiko.

6. Datenverarbeitung
Die Verarbeitung personenbezogener Daten erfolgt ausschließlich gemäß der Datenschutzerklärung.

7. Beendigung der Nutzung
Nutzer können die Nutzung jederzeit beenden.

Der Betreiber kann den Dienst jederzeit einstellen oder Nutzer ausschließen.

Bei Abmeldung werden personenbezogene Registrierungsdaten gelöscht.

8. Änderungen der AGB
Der Betreiber behält sich vor, diese AGB jederzeit zu ändern.
Durch die weitere Nutzung des Bots gelten die Änderungen als akzeptiert.`;
        return msg.reply(agb);
    }

    // /fixjobs - Owner/CoOwner/Moderator: bereinigt ungültige Job-Einträge
    if (command === 'fixjobs') {
        if (!isOwner && !isCoOwner && !isModerator) return msg.reply('⚠️ Nur Owner/Co-Owner/Moderator kann dies ausführen.');
        try {
            const cleaned = econ.sanitizeUserJobs();
            msg.reply(`✅ Bereinigt: ${cleaned} Nutzer hatten ungültige Jobs entfernt.`);
        } catch (errF) {
            console.error('[error] /fixjobs failed:', errF);
            msg.reply('❌ Fehler beim Bereinigen: ' + (errF && (errF.message || 'unknown')));
        }
    }

    // /warn @person OR /warn list
    if (command === "warn") {
        const sub = args[0] ? String(args[0]).toLowerCase() : null;

        // /warn list - list all warns in the current group (admin-only)
        if (sub === 'list' || sub === 'liste') {
            if (!isGroupAdmin) return msg.reply("🛑 Keine Berechtigung.");
            const groupWarns = warns[groupId] || {};
            const uids = Object.keys(groupWarns);
            if (!uids || uids.length === 0) return msg.reply("⚠️ Es gibt keine Verwarnungen in dieser Gruppe.");
            const lines = [];
            const mentionsForWarnList = [];
            for (const uid of uids) {
                try {
                    const r = await resolveMention(uid);
                    lines.push(`@${r.name} — ${groupWarns[uid]}/3`);
                    mentionsForWarnList.push(r.contact);
                } catch (e) {
                    // try to normalize to a usable jid and build a minimal contact so the mention works
                    let norm = uid;
                    if (/^\d+$/.test(norm)) norm = norm + '@c.us';
                    if (norm.includes('@lid')) {
                        const resolved = await resolveLidToCjid(norm).catch(() => null);
                        if (resolved) norm = resolved;
                    }
                    const fallbackName = registry[uid] && registry[uid].name ? ('@'+registry[uid].name) : ('@' + String(norm).replace(/@.*/, ''));
                    lines.push(`${fallbackName} — ${groupWarns[uid]}/3`);
                    mentionsForWarnList.push({ id: { _serialized: norm } });
                }
            }
            try {
                await msg.reply(`*AegisBot*\n\n ⚠️ Verwarnungen in dieser Gruppe:\n${lines.join('\n')}`, { mentions: (mentionsForWarnList || []).filter(Boolean) });
            } catch (e) {
                await msg.reply(`*AegisBot*\n\n ⚠️ Verwarnungen in dieser Gruppe:\n${lines.join('\n')}`);
            }
            return;
        }

        if (!isGroupAdmin) return msg.reply("🛑 Keine Berechtigung.");

        if (!msg.mentionedIds || msg.mentionedIds.length === 0) {
            return msg.reply("⚠️ Bitte markiere eine Person zum Verwarnen.");
        }

        // normalize target mention to canonical id (@c.us where possible)
        let targetRaw = msg.mentionedIds[0];
        let target = targetRaw;
        try {
            if (typeof target === 'string') {
                if (/^\d+$/.test(target)) target = target + '@c.us';
                if (target.includes('@lid')) {
                    const resolved = await resolveLidToCjid(target).catch(() => null);
                    if (resolved) target = resolved;
                }
            } else {
                target = normalizeId(target) || target;
            }
        } catch (e) {
            console.error('[error] warn target normalization failed:', e && (e.message || e));
        }

        warns[groupId] = warns[groupId] || {};
        if (!warns[groupId][target]) warns[groupId][target] = 0;
        warns[groupId][target]++;

        console.debug('[debug] warn applied', { groupId, raw: targetRaw, normalized: target, count: warns[groupId][target] });
        saveWarns();

        // show raw JID in warn messages
        msg.reply(`⚠️ <@${target}> wurde verwarnt. (${warns[groupId][target]}/3)`);

        // Automatischer Kick
        if (warns[groupId][target] >= 3) {
            try {
                const r = await resolveMention(target);
                await msg.reply(`❌ ${r.name} hat 3 Warns erreicht und wird aus der Gruppe entfernt.`, { mentions: r.contact ? [r.contact] : [] });
            } catch (e) {
                const fallback = registry[target] && registry[target].name ? registry[target].name : (`<@${target}>`);
                msg.reply(`❌ ${fallback} hat 3 Warns erreicht und wird aus der Gruppe entfernt.`);
            }

            try {
                await chat.removeParticipants([target]);
                try {
                    const r2 = await resolveMention(target);
                    await msg.reply(`✅ ${r2.name} wurde entfernt.`, { mentions: r2.contact ? [r2.contact] : [] });
                } catch (e) {
                    msg.reply("✅ Person wurde entfernt.");
                }
                // Entferne gespeicherte Warns
                if (warns[groupId] && warns[groupId][target]) {
                    delete warns[groupId][target];
                    saveWarns();
                }
            } catch (err) {
                msg.reply("❌ Fehler: Bot muss Admin sein.");
            }
        }
    }

    // /delwarn @user - Entfernt alle Warns von einem User (nur Gruppenadmins)
    if (command === "delwarn") {
        if (!isGroupAdmin) return msg.reply("🛑 Keine Berechtigung.");
        if (!msg.mentionedIds || msg.mentionedIds.length === 0) return msg.reply("⚠️ Bitte markiere eine Person zum Entfernen der Warns.");
        let targetDel = msg.mentionedIds[0];
        try {
            if (typeof targetDel === 'string') {
                if (/^\d+$/.test(targetDel)) targetDel = targetDel + '@c.us';
                if (targetDel.includes('@lid')) {
                    const resolved = await resolveLidToCjid(targetDel).catch(() => null);
                    if (resolved) targetDel = resolved;
                }
            } else {
                targetDel = normalizeId(targetDel) || targetDel;
            }
        } catch (e) {
            console.error('[error] delwarn target normalization failed:', e && (e.message || e));
        }
        if (!warns[groupId] || !warns[groupId][targetDel]) {
            return msg.reply("⚠️ Diese Person hat keine Warns.");
        }
        delete warns[groupId][targetDel];
        saveWarns();
        try {
            const r = await resolveMention(targetDel);
            await msg.reply(`✅ Alle Warns für <@${targetDel}> wurden entfernt.`);
        } catch (e) {
            msg.reply(`✅ Alle Warns für <@${targetDel}> wurden entfernt.`);
        }
    }

    // /kick @user - entfernt die markierte Person aus der Gruppe (nur Gruppenadmins)
    if (command === "kick") {
        if (!isGroupAdmin) return msg.reply("🛑 Keine Berechtigung.");
        if (!msg.mentionedIds || msg.mentionedIds.length === 0) return msg.reply("⚠️ Bitte markiere eine Person zum Kicken.");
        let targetKick = msg.mentionedIds[0];
        try {
            if (typeof targetKick === 'string') {
                if (/^\d+$/.test(targetKick)) targetKick = targetKick + '@c.us';
                if (targetKick.includes('@lid')) {
                    const resolved = await resolveLidToCjid(targetKick).catch(() => null);
                    if (resolved) targetKick = resolved;
                }
            } else {
                targetKick = normalizeId(targetKick) || targetKick;
            }

            await chat.removeParticipants([targetKick]);
            try {
                const r = await resolveMention(targetKick);
                await msg.reply(`✅ ${r.name} wurde aus der Gruppe entfernt.`, { mentions: r.contact ? [r.contact] : [] });
            } catch (e) {
                const norm = targetKick;
                const display = registry[targetKick] && registry[targetKick].name ? ('@'+registry[targetKick].name) : ('@' + String(norm).replace(/@.*/, ''));
                const contactObj = { id: { _serialized: norm } };
                await msg.reply(`✅ ${display} wurde aus der Gruppe entfernt.`, { mentions: [contactObj] });
            }
            if (warns[groupId] && warns[groupId][targetKick]) {
                delete warns[groupId][targetKick];
                saveWarns();
            }
        } catch (err) {
            console.error('[error] /kick failed:', err);
            msg.reply("❌ Fehler: Bot muss Admin sein oder konnte die Person nicht entfernen.");
        }
    }

    // /allcmds - listet alle verfügbaren Befehle auf
    if (command === "allcmds") {
        const cmds = [
            "/ping",
            "/whoami",
            "/setprefix <prefix>  (nur Gruppenadmins)",
            "/dsgvo — Datenschutzerklärung (öffentlich)",
            "/agb — AGB (öffentlich)",
            "/autospam (an|aus)  (nur Gruppenadmins)", 
            "/runtime — Zeigt die Bot-Ping/Latenz in ms",
            "/warn @user  (nur Gruppenadmins)",
            "/delwarn @user  (nur Gruppenadmins)",
            "/kick @user  (nur Gruppenadmins)",
            "/promote @user  (nur Gruppenadmins)",
            "/demote @user  (nur Gruppenadmins)",
            "/lock  (nur Gruppenadmins)",
            "/unlock  (nur Gruppenadmins)",
            "/tempban @user <minutes>  (nur Gruppenadmins)",
            "/mute @user <seconds>  (nur Gruppenadmins)",
            "/unmute @user  (nur Gruppenadmins)",
            "/mutes  (nur Gruppenadmins)",
            "/del <anzahl>  (nur Gruppenadmins)",
            "/fixjobs  (nur Owner/Co-Owner/Moderator)",
            "/menu",
            "/me",
            "--- Wirtschaft (Economy):",
            "/balance [@user]",
            "/daily",
            "/work",
            "/pay @user <betrag>",
            "/leaderboard",
            "/coinflip <betrag> <kopf|zahl>",
            "/dice <betrag> <1-6>",
            "/slots <betrag>",
            "/lotto buy [n1,n2,...]",
            "/lotto draw  (nur Gruppenadmins)",
            "/shop",
            "/buy <itemId>",
            "/inventory",
            "/sell <itemId>",
            "/use <itemId>",
            "/jobs",
            "/job  (zeigt deinen Job)",
            "/job take <jobId>",
            "/job quit",
            "/house list",
            "/house buy <houseId>",
            "/house info",
            "/allcmds"
            
        ];
        msg.reply(`Verfügbare Befehle:\n${cmds.join('\n')}`);

    // -------------------- ECONOMY COMMANDS --------------------
    // /balance [@user]
    if (command === 'balance' || command === 'bal') {
        try {
            let target = authorId;
            if (msg.mentionedIds && msg.mentionedIds.length > 0) target = msg.mentionedIds[0];
            const bal = econ.getBalance(target);
            try {
                const r = await resolveMention(target);
                await msg.reply(`💰 Kontostand von ${r.name}: ${bal} Coins`, { mentions: r.contact ? [r.contact] : [] });
            } catch (e) {
                const fallback = registry[target] && registry[target].name ? ('@'+registry[target].name) : ('@' + String(target).replace(/@.*/, ''));
                msg.reply(`💰 Kontostand von ${fallback}: ${bal} Coins`);
            }
        } catch (e) {
            console.error('[error] /balance failed:', e);
            msg.reply('❌ Fehler beim Abrufen des Kontostands.');
        }
    }

    // /daily
    if (command === 'daily') {
        try {
            const res = econ.claimDaily(authorId);
            if (!res.ok) {
                msg.reply(`⏳ Du kannst dein Daily in ${res.remaining} Sekunden erneut abholen.`);
            } else {
                msg.reply(`✅ Du hast ${res.amount} Coins erhalten. Aktueller Kontostand: ${econ.getBalance(authorId)}`);
            }
        } catch (e) {
            console.error('[error] /daily failed:', e);
            msg.reply('❌Fehler beim Beanspruchen des Daily.');
        }
    }

    // /work
    if (command === 'work') {
        try {
            console.debug('[debug] /work invoked', { authorId });
            const res = econ.work(authorId);
            console.debug('[debug] /work result', res);
            if (!res.ok) {
                if (res.error === 'no job') return await msg.reply('Du hast keinen Job. Sieh dir /jobs an und nimm einen an.');
                if (res.error === 'cooldown') return await msg.reply(`⏳ Bitte warte noch ${res.remaining} Sekunden, bevor du wieder arbeiten kannst.`);
                return await msg.reply('❌ Fehler beim Arbeiten.');
            }
            await msg.reply(`💼 Du hast gearbeitet und ${res.pay} Coins verdient. Aktueller Kontostand: ${econ.getBalance(authorId)}`);
        } catch (e) {
            console.error('[error] /work failed:', e);
            try { await msg.reply('❌ Fehler beim Arbeiten: ' + (e && (e.message || e))); } catch (e2) { console.error('[error] failed to send /work error reply:', e2); }
        }
    }

    // /pay @user <betrag>
    if (command === 'pay') {
        try {
            if (!msg.mentionedIds || msg.mentionedIds.length === 0) return msg.reply('Bitte markiere eine Person, an die du zahlen möchtest.');
            const to = msg.mentionedIds[0];
            const num = args.find(a => /^\d+(?:\.\d+)?$/.test(a));
            if (!num) return msg.reply('Bitte gib einen Betrag an, z.B. `/pay @user 50`');
            const amount = Number(num);
            if (amount <= 0) return msg.reply('Ungültiger Betrag.');
            try {
                const r = econ.transfer(authorId, to, amount, 'pay');
                try {
                    const rr = await resolveMention(to);
                    await msg.reply(`✅ Du hast ${amount} Coins an ${rr.name} überwiesen. Steuer: ${r.tax} Coins (${r.taxPercent}%). Empfänger erhielt ${r.net} Coins.`, { mentions: rr.contact ? [rr.contact] : [] });
                } catch (e) {
                    try {
                        const rr = await resolveMention(to);
                        msg.reply(`✅ Du hast ${amount} Coins an ${rr.name} überwiesen. Steuer: ${r.tax} Coins (${r.taxPercent}%). Empfänger erhielt ${r.net} Coins.`, { mentions: rr.contact ? [rr.contact] : [] });
                    } catch (e2) {
                        const fallback = registry[to] && registry[to].name ? registry[to].name : (`<@${to}>`);
                        msg.reply(`✅ Du hast ${amount} Coins an ${fallback} überwiesen. Steuer: ${r.tax} Coins (${r.taxPercent}%). Empfänger erhielt ${r.net} Coins.`);
                    }
                }
            } catch (errPay) {
                msg.reply('❌ Fehler: ' + (errPay.message || 'Überweisung fehlgeschlagen'));
            }
        } catch (e) {
            console.error('[error] /pay failed:', e);
            msg.reply('❌ Fehler beim Ausführen von /pay.');
        }
    }

    // /leaderboard
    if (command === 'leaderboard' || command === 'leaderbord') {
        try {
            const rows = econ.leaderboard(10);
            if (!rows || rows.length === 0) return msg.reply('Keine Einträge in der Bestenliste.');
            const lines = [];
            const lbMents = [];
            for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                try {
                    const r = await resolveMention(row.id);
                    lines.push(`${i+1}. ${r.name} — ${Math.round(row.balance*100)/100} Coins`);
                    if (r.contact) lbMents.push(r.contact);
                } catch (e) {
                    try {
                        const rr = await resolveMention(row.id);
                        lines.push(`${i+1}. ${rr.name} — ${Math.round(row.balance*100)/100} Coins`);
                        if (rr.contact) lbMents.push(rr.contact);
                    } catch (e2) {
                        const fallback = registry[row.id] && registry[row.id].name ? ('@'+registry[row.id].name) : (`<@${row.id}>`);
                        lines.push(`${i+1}. ${fallback} — ${Math.round(row.balance*100)/100} Coins`);
                    }
                }
            }
            msg.reply(`🏆 Bestenliste:\n${lines.join('\n')}`, { mentions: lbMents.filter(Boolean) });
        } catch (e) {
            console.error('[error] /leaderboard failed:', e);
            msg.reply('❌ Fehler beim Abrufen der Bestenliste.');
        }
    }

    // /coinflip <betrag> <kopf|zahl>
    if (command === 'coinflip') {
        try {
            const num = args.find(a => /^\d+(?:\.\d+)?$/.test(a));
            const choice = args.find(a => /^(kopf|zahl)$/i.test(a));
            if (!num || !choice) return msg.reply('Usage: /coinflip <betrag> <kopf|zahl>');
            const bet = Number(num);
            try {
                const r = econ.coinflip(authorId, bet, choice.toLowerCase());
                if (r.win) msg.reply(`🎉 Gewinn! Die Münze zeigte ${r.flip}. Du gewinnst ${r.payout} Coins!`);
                else msg.reply(`😢 Verloren. Die Münze zeigte ${r.flip}. Besser Glück beim nächsten Mal.`);
            } catch (errGame) {
                msg.reply('❌ Fehler: ' + (errGame.message || 'Spiel fehlgeschlagen'));
            }
        } catch (e) {
            console.error('[error] /coinflip failed:', e);
            msg.reply('❌ Fehler beim Coinflip.');
        }
    }

    // /dice <betrag> <1-6>
    if (command === 'dice') {
        try {
            const num = args.find(a => /^\d+(?:\.\d+)?$/.test(a));
            const guess = args.find(a => /^[1-6]$/.test(a));
            if (!num || !guess) return msg.reply('Usage: /dice <betrag> <1-6>');
            const bet = Number(num);
            const g = Number(guess);
            try {
                const r = econ.dice(authorId, bet, g);
                if (r.win) msg.reply(`🎉 Richtig! Die Zahl war ${r.roll}. Du gewinnst ${r.payout} Coins!`);
                else msg.reply(`😢 Falsch. Die Zahl war ${r.roll}.`);
            } catch (errGame) {
                msg.reply('❌ Fehler: ' + (errGame.message || 'Spiel fehlgeschlagen'));
            }
        } catch (e) {
            console.error('[error] /dice failed:', e);
            msg.reply('❌ Fehler beim Dice-Spiel.');
        }
    }

    // /slots <betrag>
    if (command === 'slots') {
        try {
            const num = args.find(a => /^\d+(?:\.\d+)?$/.test(a));
            if (!num) return msg.reply('Usage: /slots <betrag>');
            const bet = Number(num);
            try {
                const r = econ.slots(authorId, bet);
                const board = `${r.a} | ${r.b} | ${r.c}`;
                if (r.win) msg.reply(`🎰 ${board}\n🎉 Triple! Du gewinnst ${r.payout} Coins!`);
                else msg.reply(`🎰 ${board}\n😢 Leider verloren.`);
            } catch (errGame) {
                msg.reply('❌ Fehler: ' + (errGame.message || 'Slots fehlgeschlagen'));
            }
        } catch (e) {
            console.error('[error] /slots failed:', e);
            msg.reply('❌ Fehler beim Slots-Spiel.');
        }
    }

    // /lotto buy [n1,n2,...]   and /lotto draw
    if (command === 'lotto') {
        try {
            const sub = (args && args[0]) ? args[0].toLowerCase() : '';
            if (sub === 'buy') {
                const nums = args[1] || null; // e.g. "1,2,3,4,5,6"
                try {
                    econ.buyLottoTicket(groupId, authorId, nums || []);
                    msg.reply('🎟️ Lotto-Ticket gekauft. Viel Glück!');
                } catch (errL) {
                    console.error('[error] /lotto buy failed:', errL);
                    msg.reply('❌ Fehler beim Kaufen des Lotto-Tickets.');
                }
            } else if (sub === 'draw') {
                if (!isGroupAdmin) return msg.reply('Keine Berechtigung.');
                try {
                    const res = econ.drawLotto(groupId);
                    msg.reply(`🎉 Lotto gezogen: Zahlen ${res.numbers.join(', ')}\nGewinner: ${res.winners.length ? res.winners.join(', ') : 'Keine Gewinner'}\nPott: ${res.pot} Coins`);
                } catch (errD) {
                    console.error('[error] /lotto draw failed:', errD);
                    msg.reply('❌ Fehler beim Ziehen des Lottos.');
                }
            } else {
                msg.reply('Usage: /lotto buy [n1,n2,...]  oder /lotto draw (nur Admins)');
            }
        } catch (e) {
            console.error('[error] /lotto handling failed:', e);
            msg.reply('❌ Fehler beim Lotto-Befehl.');
        }
    }

    // /shop
    if (command === 'shop') {
        try {
            const items = econ.listShop();
            if (!items || items.length === 0) return msg.reply('Shop ist leer.');
            const lines = items.map(i => `${i.id}: ${i.name} — ${i.price} Coins — ${i.description}`);
            msg.reply(`🛒 Shop:\n${lines.join('\n')}`);
        } catch (e) {
            console.error('[error] /shop failed:', e);
            msg.reply('❌ Fehler beim Anzeigen des Shops.');
        }
    }

    // /buy <itemId>
    if (command === 'buy') {
        try {
            const itemId = args[0];
            if (!itemId) return msg.reply('Usage: /buy <itemId>');
            try {
                const item = econ.buyItem(authorId, itemId);
                msg.reply(`✅ Du hast ${item.name} gekauft für ${item.price} Coins.`);
            } catch (errB) {
                msg.reply('❌ Fehler: ' + (errB.message || 'Kauf fehlgeschlagen'));
            }
        } catch (e) {
            console.error('[error] /buy failed:', e);
            msg.reply('❌ Fehler beim Kaufen.');
        }
    }

    // /inventory
    if (command === 'inventory' || command === 'inv') {
        try {
            const inv = econ.getInventory(authorId);
            if (!inv || inv.length === 0) return msg.reply('Dein Inventar ist leer.');
            const lines = inv.map((it, idx) => `${idx+1}. ${it.name} (${it.id})`);
            msg.reply(`🎒 Dein Inventar:\n${lines.join('\n')}`);
        } catch (e) {
            console.error('[error] /inventory failed:', e);
            msg.reply('❌ Fehler beim Anzeigen des Inventars.');
        }
    }

    // /sell <itemId>
    if (command === 'sell') {
        try {
            const itemId = args[0];
            if (!itemId) return msg.reply('Usage: /sell <itemId>');
            try {
                const gain = econ.sellItem(authorId, itemId);
                msg.reply(`✅ Du hast ${gain} Coins erhalten (Verkauf).`);
            } catch (errS) {
                msg.reply('❌ Fehler: ' + (errS.message || 'Verkauf fehlgeschlagen'));
            }
        } catch (e) {
            console.error('[error] /sell failed:', e);
            msg.reply('❌ Fehler beim Verkaufen.');
        }
    }

    // /use <itemId>
    if (command === 'use') {
        try {
            const itemId = args[0];
            if (!itemId) return msg.reply('Usage: /use <itemId>');
            try {
                const it = econ.useItem(authorId, itemId);
                msg.reply(`✅ Du hast ${it.name} verwendet.`);
            } catch (errU) {
                msg.reply('❌ Fehler: ' + (errU.message || 'Gebrauch fehlgeschlagen'));
            }
        } catch (e) {
            console.error('[error] /use failed:', e);
            msg.reply('❌ Fehler beim Verwenden des Items.');
        }
    }

    // /jobs
    if (command === 'jobs') {
        try {
            const jobs = econ.listJobs();
            if (!jobs || jobs.length === 0) return msg.reply('❌ Keine Jobs verfügbar.');
            const lines = jobs.map(j => `${j.id}: ${j.name} — ${j.pay_min}-${j.pay_max} Coins — ${j.description}`);
            msg.reply(`🔨 Verfügbare Jobs:\n${lines.join('\n')}`);
        } catch (e) {
            console.error('[error] /jobs failed:', e);
            msg.reply('❌ Fehler beim Anzeigen der Jobs.');
        }
    }


    // /house buy <houseId>, /house info
    if (command === 'house') {
        try {
            const sub = args[0] ? args[0].toLowerCase() : null;
            if (sub === 'buy') {
                const idHouse = args[1];
                if (!idHouse) return msg.reply('Usage: /house buy <houseId>');
                try {
                    const h = econ.buyHouse(authorId, idHouse);
                    msg.reply(`🏠 Du hast ein Haus gekauft: ${h.name}`);
                } catch (errH) {
                    msg.reply('❌ Fehler: ' + (errH.message || 'Haus-Kauf fehlgeschlagen'));
                }
            } else if (sub === 'info') {
                try {
                    const info = econ.houseInfo(authorId);
                    if (!info) return msg.reply('❌ Du besitzt kein Haus.');
                    msg.reply(`🏠 Haus: ${info.name} — ${info.description} — Preis: ${info.price} Coins`);
                } catch (e) {
                    console.error('[error] /house info failed:', e);
                    msg.reply('❌ Fehler beim Abrufen der Haus-Info.');
                }
            } else {
                msg.reply('Usage: /house buy <houseId>  oder /house info');
            }
        } catch (e) {
            console.error('[error] /house handling failed:', e);
            msg.reply('❌ Fehler beim House-Befehl.');
        }
    }

    // -------------------- END ECONOMY COMMANDS --------------------

    // If this was a command but no handler replied, log and notify (helps debugging silent commands)
    if (isCommand) {
        if (!__handled) {
            console.warn('[warn] Command was not handled or produced no reply:', { command, args, authorId, authorBare, isGroupAdmin });
            try {
                await msg.reply('Befehl wurde nicht ausgeführt oder schlug fehl. Sieh in der Bot-Konsole nach (debug logs).');
            } catch (e) {
                console.error('[error] failed to send unhandled-command notification:', e);
            }
        }
    }
    }

    // /mutes - zeigt aktuelle Stummschaltungen in der Gruppe (nur Gruppenadmins)
    if (command === "mutes") {
        if (!isGroupAdmin) return msg.reply("🛑 Keine Berechtigung.");
        const list = (mutes[groupId] || []).map(e => {
            const secondsLeft = e.unmuteAt ? Math.max(0, Math.ceil((e.unmuteAt - Date.now())/1000)) : 'unbekannt';
            return `${e.userId} — ${secondsLeft}s`;
        });
        msg.reply(`Aktuelle Mutes:\n${list.length ? list.join('\n') : 'Keine Stummschaltungen'}`);
    }

    // /del - löscht die zitierte Nachricht und die /del-Nachricht selbst (nur Gruppenadmins)
    if (command === "del") {
        if (!isGroupAdmin) return msg.reply("🛑 Keine Berechtigung.");
        if (!msg.hasQuotedMsg) return msg.reply("⚠️ Bitte antworte auf die Nachricht, die gelöscht werden soll, mit /del.");
        try {
            const quotedMsg = await msg.getQuotedMessage();
            if (!quotedMsg) return msg.reply("❌ Konnte die zitierte Nachricht nicht finden.");

            let quotedDeletedForEveryone = false;
            let quotedDeletedLocally = false;
            let cmdDeletedForEveryone = false;
            let cmdDeletedLocally = false;

            // Versuche, die zitierte Nachricht für alle zu löschen
            try {
                await quotedMsg.delete(true);
                quotedDeletedForEveryone = true;
            } catch (err) {
                console.debug('[debug] quoted delete for everyone failed:', err && (err.message || err));
                try {
                    await quotedMsg.delete(false);
                    quotedDeletedLocally = true;
                } catch (err2) {
                    console.error('[error] quoted delete local failed:', err2);
                }
            }

            // Versuche, die /del-Nachricht (Command) zu löschen - zuerst for everyone, dann lokal
            try {
                await msg.delete(true);
                cmdDeletedForEveryone = true;
            } catch (e) {
                try {
                    await msg.delete(false);
                    cmdDeletedLocally = true;
                } catch (e2) {
                    console.error('[error] deleting /del command message failed:', e2);
                }
            }

            // Bestätigungsnachricht nur senden, wenn mindestens eine Löschung erfolgreich war
            if (quotedDeletedForEveryone || quotedDeletedLocally) {
                const note = quotedDeletedForEveryone ? '✅ Nachricht gelöscht.' : '✅ Nachricht lokal gelöscht (konnte nicht für alle löschen).';
                // Wenn auch die Command-Nachricht entfernt wurde, keine zusätzliche Bestätigung nötig (um Chat sauber zu halten)
                if (!(cmdDeletedForEveryone || cmdDeletedLocally)) {
                    await chat.sendMessage(note);
                }
            } else {
                // Falls gar nichts gelöscht werden konnte, antworte mit Fehler
                return msg.reply('❌ Fehler: Konnte die Nachricht nicht löschen (bot benötigt Adminrechte oder Zeitfenster ist abgelaufen).');
            }
        } catch (e) {
            console.error('[error] /del failed:', e);
            msg.reply('❌ Fehler beim Löschen der Nachricht.');
        }
    }

    // /promote @user - macht die markierte Person zum Gruppenadmin (nur Gruppenadmins)
    if (command === "promote") {
        if (!isGroupAdmin) return msg.reply("🛑 Keine Berechtigung.");
        if (!msg.mentionedIds || msg.mentionedIds.length === 0) return msg.reply("⚠️ Bitte markiere eine Person zum Promoten.");
        const targetPromote = msg.mentionedIds[0];
        try {
            const res = await chat.promoteParticipants([targetPromote]);
            // res may be { status: 200 } or true
            if ((res && res.status === 200) || res === true) {
                msg.reply(`✅ <@${targetPromote}> wurde zum Admin gemacht.`);
            } else {
                msg.reply(`❌ Fehler beim Promoten: ${JSON.stringify(res)}`);
            }
        } catch (err) {
            console.error('[error] /promote failed:', err);
            msg.reply('❌ Fehler: Bot muss Admin sein oder konnte die Person nicht promoten.');
        }
    }

    // /tempban @user <minutes> - kickt den user und fügt ihn nach der Zeit automatisch wieder hinzu (nur Gruppenadmins)
    if (command === "tempban") {
        if (!isGroupAdmin) return msg.reply("🛑 Keine Berechtigung.");
        if (!msg.mentionedIds || msg.mentionedIds.length === 0) return msg.reply("⚠️ Bitte markiere eine Person zum temporären Bannen.");
        const targetTemp = msg.mentionedIds[0];
        // parse minutes from args (first numeric token)
        const numToken = args.find(a => /^\d+$/.test(a));
        const minutes = parseInt(numToken || args[1] || args[0]);
        if (!minutes || isNaN(minutes) || minutes <= 0) return msg.reply('⚠️ Bitte gib eine gültige Dauer in Minuten an, z.B. `/tempban @User 15`');

        const unbanAt = Date.now() + minutes * 60 * 1000;

        // kick now
        try {
            await chat.removeParticipants([targetTemp]);
            msg.reply(`✅ <@${targetTemp}> wurde temporär für ${minutes} Minuten gebannt.`);

            tempbans[groupId] = tempbans[groupId] || [];
            // prevent duplicate
            if (!tempbans[groupId].some(e => e.userId === targetTemp)) {
                tempbans[groupId].push({ userId: targetTemp, unbanAt, attempts: 0 });
                saveTempbans();
                scheduleUnban(groupId, targetTemp, unbanAt, 0);
            } else {
                msg.reply('⚠️ Hinweis: Diese Person ist bereits temporär gebannt.');
            }
        } catch (err) {
            console.error('[error] /tempban remove failed:', err);
            msg.reply('❌ Fehler: Bot muss Admin sein oder konnte die Person nicht entfernen.');
        }
    }

    // /botban @user - permanent bot-level ban (Owner/CoOwner/Moderator only)
    if (command === 'botban') {
        if (!isOwner && !isCoOwner && !isModerator) return msg.reply('🛑 Keine Berechtigung.');
        if (!msg.mentionedIds || msg.mentionedIds.length === 0) return msg.reply('⚠️ Bitte markiere eine Person zum Bot-Bannen.');
        let target = msg.mentionedIds[0];
        try {
            if (typeof target === 'string') {
                if (/^\d+$/.test(target)) target = target + '@c.us';
                if (target.includes('@lid')) {
                    const resolved = await resolveLidToCjid(target).catch(() => null);
                    if (resolved) target = resolved;
                }
            } else {
                target = normalizeId(target) || target;
            }
            config.botBanned = config.botBanned || [];
            if (!config.botBanned.includes(target)) {
                config.botBanned.push(target);
                saveConfig();
            }
            // also remove any tempban
            botTempBans = (botTempBans || []).filter(b => b.userId !== target);
            saveBotTempBans();
            await msg.reply(`✅ <@${target}> wurde permanent vom Bot gesperrt.`);
        } catch (e) {
            console.error('[error] /botban failed:', e);
            msg.reply('❌ Fehler beim Bot-Bannen.');
        }
    }

    // /botunban @user - remove from permanent bot-ban
    if (command === 'botunban') {
        if (!isOwner && !isCoOwner && !isModerator) return msg.reply('🛑 Keine Berechtigung.');
        if (!msg.mentionedIds || msg.mentionedIds.length === 0) return msg.reply('⚠️ Bitte markiere eine Person zum Entfernen des Bot-Banns.');
        let target = msg.mentionedIds[0];
        try {
            if (typeof target === 'string') {
                if (/^\d+$/.test(target)) target = target + '@c.us';
                if (target.includes('@lid')) {
                    const resolved = await resolveLidToCjid(target).catch(() => null);
                    if (resolved) target = resolved;
                }
            } else {
                target = normalizeId(target) || target;
            }
            config.botBanned = config.botBanned || [];
            if (config.botBanned.includes(target)) {
                config.botBanned = config.botBanned.filter(x => x !== target);
                saveConfig();
            }
            await msg.reply(`✅ <@${target}> wurde vom Bot-Bann entfernt.`);
        } catch (e) {
            console.error('[error] /botunban failed:', e);
            msg.reply('❌ Fehler beim Entfernen des Bot-Banns.');

        }
    }

    // /bottempban @user <minutes> - temporary ban on bot commands
    if (command === 'bottempban') {
        if (!isOwner && !isCoOwner && !isModerator) return msg.reply('🛑 Keine Berechtigung.');
        if (!msg.mentionedIds || msg.mentionedIds.length === 0) return msg.reply('⚠️ Bitte markiere eine Person zum temporären Bot-Bannen.');
        let target = msg.mentionedIds[0];
        const numToken = args.find(a => /^\d+$/.test(a));
        const minutes = parseInt(numToken || args[1] || args[0]);
        if (!minutes || isNaN(minutes) || minutes <= 0) return msg.reply('⚠️ Bitte gib eine gültige Dauer in Minuten an, z.B. `/bottempban @User 15`');
        try {
            if (typeof target === 'string') {
                if (/^\d+$/.test(target)) target = target + '@c.us';
                if (target.includes('@lid')) {
                    const resolved = await resolveLidToCjid(target).catch(() => null);
                    if (resolved) target = resolved;
                }
            } else {
                target = normalizeId(target) || target;
            }
            const unbanAt = Date.now() + minutes * 60 * 1000;
            // add to botTempBans and schedule
            botTempBans = botTempBans || [];
            if (!botTempBans.some(b => b.userId === target)) {
                botTempBans.push({ userId: target, unbanAt });
                saveBotTempBans();
                scheduleBotUnban(target, unbanAt);
                await msg.reply(`✅ <@${target}> wurde für ${minutes} Minuten vom Bot gesperrt.`);
            } else {
                await msg.reply('⚠️ Hinweis: Diese Person ist bereits temporär vom Bot gesperrt.');
            }
        } catch (e) {
            console.error('[error] /bottempban failed:', e);
            msg.reply('❌ Fehler beim temporären Bot-Bannen.');
        }
    }

    // /botwarn @user - give a bot warning (Moderator or higher only). At 3 warns -> 1 day tempban.
    if (command === 'botwarn') {
        if (!isOwner && !isCoOwner && !isModerator) return msg.reply('🛑 Keine Berechtigung.');
        if (!msg.mentionedIds || msg.mentionedIds.length === 0) return msg.reply('❌ Bitte markiere eine Person für den Bot-Warn.');
        let target = msg.mentionedIds[0];
        try {
            if (typeof target === 'string') {
                if (/^\d+$/.test(target)) target = target + '@c.us';
                if (target.includes('@lid')) {
                    const resolved = await resolveLidToCjid(target).catch(() => null);
                    if (resolved) target = resolved;
                }
            } else {
                target = normalizeId(target) || target;
            }
            botWarns = botWarns || {};
            botWarns[target] = (botWarns[target] || 0) + 1;
            saveBotWarns();
            if (botWarns[target] >= 3) {
                // reset warns and apply 1 day temp ban
                botWarns[target] = 0;
                saveBotWarns();
                const unbanAt = Date.now() + 24 * 60 * 60 * 1000;
                botTempBans = botTempBans || [];
                if (!botTempBans.some(b => b.userId === target)) {
                    botTempBans.push({ userId: target, unbanAt });
                    saveBotTempBans();
                    scheduleBotUnban(target, unbanAt);
                }
                await msg.reply(`✅ <@${target}> hat 3 Bot-Warns erhalten und wurde für 1 Tag vom Bot gesperrt (bis ${new Date(unbanAt).toUTCString()}).`);
            } else {
                await msg.reply(`⚠️ <@${target}> wurde ein Bot-Warn hinzugefügt. Aktuelle Bot-Warns: ${botWarns[target]}/3`);
            }
        } catch (e) {
            console.error('[error] /botwarn failed:', e);
            msg.reply('❌ Fehler beim Setzen des Bot-Warns.');
        }
    }

    // /botdelwarn @user - clear all bot warns (Moderator or higher only)
    if (command === 'botdelwarn') {
        if (!isOwner && !isCoOwner && !isModerator) return msg.reply('🛑 Keine Berechtigung.');
        if (!msg.mentionedIds || msg.mentionedIds.length === 0) return msg.reply('❌ Bitte markiere eine Person zum Löschen der Bot-Warns.');
        let target = msg.mentionedIds[0];
        try {
            if (typeof target === 'string') {
                if (/^\d+$/.test(target)) target = target + '@c.us';
                if (target.includes('@lid')) {
                    const resolved = await resolveLidToCjid(target).catch(() => null);
                    if (resolved) target = resolved;
                }
            } else {
                target = normalizeId(target) || target;
            }
            botWarns = botWarns || {};
            if (botWarns[target]) {
                delete botWarns[target];
                saveBotWarns();
            }
            await msg.reply(`✅ Alle Bot-Warns für <@${target}> wurden nun gelöscht.`);
        } catch (e) {
            console.error('[error] /botdelwarn failed:', e);
            msg.reply('❌ Fehler beim Löschen der Bot-Warns.');
        }
    }

    // /mute @user <seconds> 
    if (command === "mute") {
        if (!isGroupAdmin) return msg.reply("🛑 Keine Berechtigung.");
        if (!msg.mentionedIds || msg.mentionedIds.length === 0) return msg.reply("❌ Bitte markiere eine Person zum Stummschalten.");
        const targetMute = msg.mentionedIds[0];
        const numToken = args.find(a => /^\d+$/.test(a));
        const seconds = parseInt(numToken || args[1] || args[0]);
        if (!seconds || isNaN(seconds) || seconds <= 0) return msg.reply('❌ Bitte gib eine gültige Dauer in Sekunden an, z.B. `/mute @User 15`');
        const unmuteAt = Date.now() + seconds * 1000;
        mutes[groupId] = mutes[groupId] || [];
        // accept also if target is provided as @lid — resolve to c.us for storage if possible
        let storeUser = targetMute;
        if (typeof storeUser === 'string' && storeUser.includes('@lid')) {
            const resolved = await resolveLidToCjid(storeUser);
            if (resolved) storeUser = resolved;
        }
        if (!mutes[groupId].some(e => e.userId === storeUser || (e.userId && e.userId.replace(/[^0-9]/g,'') === (storeUser.replace(/[^0-9]/g,''))))) {
            mutes[groupId].push({ userId: storeUser, unmuteAt });
            saveMutes();
            scheduleUnmute(groupId, storeUser, unmuteAt);
            msg.reply(`🔇 <@${targetMute}> wurde für ${seconds} Sekunden stummgeschaltet.`);
        } else {
            msg.reply('⚠️ Hinweis: Diese Person ist bereits stummgeschaltet.');
        }
    }

    // /unmute @user 
    if (command === "unmute") {
        if (!isGroupAdmin) return msg.reply("🛑 Keine Berechtigung.");
        if (!msg.mentionedIds || msg.mentionedIds.length === 0) return msg.reply("❌ Bitte markiere eine Person zum Entstummen.");
        const targetUnmute = msg.mentionedIds[0];
        // try to normalize id
        let norm = targetUnmute;
        if (typeof norm === 'string' && norm.includes('@lid')) {
            const resolved = await resolveLidToCjid(norm);
            if (resolved) norm = resolved;
        }
        if (mutes[groupId] && mutes[groupId].some(e => e.userId === norm || (e.userId && e.userId.replace(/[^0-9]/g,'') === (norm.replace(/[^0-9]/g,''))))) {
            mutes[groupId] = mutes[groupId].filter(e => !(e.userId === norm || (e.userId && e.userId.replace(/[^0-9]/g,'') === (norm.replace(/[^0-9]/g,'')))));
            if (mutes[groupId].length === 0) delete mutes[groupId];
            saveMutes();
            const key = `${groupId}|${norm}`;
            if (muteTimers[key]) { clearTimeout(muteTimers[key]); delete muteTimers[key]; }
            msg.reply(`🔊 <@${targetUnmute}> wurde entstummt.`);
        } else {
            msg.reply('⚠️ Diese Person ist nicht stummgeschaltet.');
        }
    }
    // /unmute @user - hebt Stummschaltung auf (nur Gruppenadmins)
    if (command === "unmute") {
        if (!isGroupAdmin) return msg.reply("🛑 Keine Berechtigung.");
        if (!msg.mentionedIds || msg.mentionedIds.length === 0) return msg.reply("❌ Bitte markiere eine Person zum Entstummen.");
        const targetUnmute = msg.mentionedIds[0];
        if (mutes[groupId] && mutes[groupId].some(e => e.userId === targetUnmute)) {
            mutes[groupId] = mutes[groupId].filter(e => e.userId !== targetUnmute);
            if (mutes[groupId].length === 0) delete mutes[groupId];
            saveMutes();
            const key = `${groupId}|${targetUnmute}`;
            if (muteTimers[key]) { clearTimeout(muteTimers[key]); delete muteTimers[key]; }
            msg.reply(`🔊 <@${targetUnmute}> wurde entstummt.`);
        } else {
            msg.reply('⚠️ Diese Person ist nicht stummgeschaltet.');
        }
    }
    // /demote @user - entfernt Adminrechte von der markierten Person (nur Gruppenadmins)
    if (command === "demote") {
        if (!isGroupAdmin) return msg.reply("*<--> [AegisBot] <-->*\n🛑 Keine Berechtigung.");
        if (!msg.mentionedIds || msg.mentionedIds.length === 0) return msg.reply("❌ Bitte markiere eine Person zum Demoten.");
        const targetDemote = msg.mentionedIds[0];
        try {
            const res = await chat.demoteParticipants([targetDemote]);
            if ((res && res.status === 200) || res === true) {
                msg.reply(`*<--> [AegisBot] <-->*\n✅ <@${targetDemote}> ist nun kein Admin mehr.`);
            } else {
                msg.reply(`*<--> [AegisBot] <-->*\n❌ Fehler beim Demoten: ${JSON.stringify(res)}`);
            }
        } catch (err) {
            console.error('[error] /demote failed:', err);
            msg.reply('*<--> [AegisBot] <-->*\n❌ Fehler: Bot muss Admin sein oder konnte die Person nicht demoten.');
        }
    }

    // /lock - schließt die Gruppe, sodass nur Admins schreiben dürfen (nur Gruppenadmins)
    if (command === "lock") {
        if (!isGroupAdmin) return msg.reply("*<--> [AegisBot] <-->*\n🛑 Keine Berechtigung.");
        try {
            const success = await chat.setMessagesAdminsOnly(true);
            if (success) {
                msg.reply('*<--> [AegisBot] <-->*\n🔒 Gruppe wurde gesperrt — nur Admins können jetzt schreiben.');
            } else {
                msg.reply('*<--> [AegisBot] <-->*\n❌ Fehler: Konnte die Gruppe nicht sperren.');
            }
        } catch (err) {
            console.error('[error] /lock failed:', err);
            msg.reply('*<--> [AegisBot] <-->*\n❌ Fehler: Bot muss Admin sein oder konnte die Gruppenrechte nicht ändern.');
        }
    }

    // /unlock - öffnet die Gruppe, sodass alle schreiben dürfen (nur Gruppenadmins)
    if (command === "unlock") {
        if (!isGroupAdmin) return msg.reply('*<--> [AegisBot] <-->*\n🛑 Keine Berechtigung.');
        try {
            const success = await chat.setMessagesAdminsOnly(false);
            if (success) {
                msg.reply('*<--> [AegisBot] <-->*\n🔓 Gruppe wurde entsperrt — alle können jetzt schreiben.');
            } else {
                msg.reply('*<--> [AegisBot] <-->*\n❌ Fehler: Konnte die Gruppe nicht entsperren.');
            }
        } catch (err) {
            console.error('[error] /unlock failed:', err);
            msg.reply('*<--> [AegisBot] <-->*\n❌ Fehler: Bot muss Admin sein oder konnte die Gruppenrechte nicht ändern.');
        }
    }
});

console.log("[debug] client.initialize wird aufgerufen...()");
client.initialize();
console.log("[debug] client.initialize() wurde aufgerufen...");
