import makeWASocket, { 
    useMultiFileAuthState, 
    DisconnectReason, 
    makeCacheableSignalKeyStore 
} from '@whiskeysockets/baileys';
import fs from 'fs';
import chalk from 'chalk';
import pino from 'pino';
import { Boom } from '@hapi/boom';
import readline from 'readline';
import { handler } from './handler.js';
import path from 'path';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

// ===== FUNGSI UPDATE DATABASE GRUP (LID & JID SUPPORT) =====
const saveGroupMetadata = async (mahiru, id) => {
    try {
        if (!id.endsWith('@g.us')) return null;
        if (!fs.existsSync('./database/group')) fs.mkdirSync('./database/group', { recursive: true });
        
        const metadata = await mahiru.groupMetadata(id);
        const filePath = `./database/group/${id.split('@')[0]}.json`;
        
        fs.writeFileSync(filePath, JSON.stringify(metadata, null, 2));
        
        // Console log biar lu tau ada update
        console.log(`${chalk.bgGreen.black(' DB-UPDATE ')} ${chalk.green('Successful for group:')} ${chalk.yellow(metadata.subject)} ${chalk.gray('(' + id + ')')}`);
        
        return metadata;
    } catch (e) {
        console.error(`${chalk.bgRed.white(' DB-ERROR ')} ${chalk.red('Gagal update metadata ' + id + ':')}`, e.message);
        return null;
    }
};

export async function startBot() {
    const databasePath = './database.json';
    let rawDb = {};
    if (fs.existsSync(databasePath)) {
        try {
            rawDb = JSON.parse(fs.readFileSync(databasePath));
        } catch (e) {
            console.error("Gagal baca database.json, membuat baru...");
            rawDb = {};
        }
    }

    global.db = {
        data: {
            users: rawDb.users || rawDb.data?.users || {},
            chats: rawDb.chats || rawDb.data?.chats || {},
            settings: rawDb.settings || rawDb.data?.settings || { self: false, onlygc: false, onlypc: false },
            ...(rawDb.data || (rawDb.users ? rawDb : {})) // Gabungkan sisanya
        }
    };

    setInterval(() => {
        if (global.db && global.db.data) {
            fs.writeFileSync(databasePath, JSON.stringify(global.db.data, null, 2));
        }
    }, 30000);

    const { state, saveCreds } = await useMultiFileAuthState('session');

    const mahiru = makeWASocket.default({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
        },
        browser: ["Ubuntu", "Chrome", "20.0.04"]
    });
    mahiru.waUploadToServer = mahiru.waUploadToServer.bind(mahiru);

    // ===== Owner & Error Reporter =====
    const OWNER_JID = '6283138114398@s.whatsapp.net';
    let lastErrorSentAt = 0;

    const sendOwnerReport = async (title, body) => {
        const now = Date.now();
        if (now - lastErrorSentAt < 15_000) return;
        if (!mahiru?.user) return;
        lastErrorSentAt = now;
        try {
            await mahiru.sendMessage(OWNER_JID, {
                text: `⚠️ *AUTO REPORT ERROR*\n\n*Type:* ${title}\n\n*Detail:* \n${body}`.slice(0, 4000)
            });
        } catch (e) {
            console.error('[ ERROR SEND OWNER REPORT ]', e);
        }
    };

    const reportError = async (err, ctx = 'Unhandled Error') => {
        const stack = err?.stack || (typeof err === 'string' ? err : JSON.stringify(err, null, 2));
        console.error(`[ ${ctx} ]`, err);
        await sendOwnerReport(ctx, stack);
    };

    mahiru.reportError = reportError;
    
    //======== PAIRING SYSTEM =========//
    if (!mahiru.authState.creds.registered) {
        let phoneNumber = await question('Masukkan nomor WhatsApp Bot (contoh: 628xxx): ');
        phoneNumber = phoneNumber.replace(/[^0-9]/g, '');
        
        setTimeout(async () => {
            let code = await mahiru.requestPairingCode(phoneNumber);
            console.log(`\n✅ KODE PAIRING ANDA: ${code}\n`);
        }, 3000);
    }

    mahiru.ev.on('creds.update', saveCreds);
    
    //============= WELCOME & LEFT + DB UPDATE  ==============// 
    mahiru.ev.on('group-participants.update', async (anu) => {
        const { id, participants, action, author } = anu;
        const pathSettings = './database/group-settings.json';

        try {
            // Update Database Lokal setiap ada perubahan partisipan (Join/Kick/Promote/Demote)
            const metadata = await saveGroupMetadata(mahiru, id);
            
            if (!fs.existsSync('./database')) fs.mkdirSync('./database');
            if (!fs.existsSync(pathSettings)) return; 

            let dbSettings = JSON.parse(fs.readFileSync(pathSettings));
            let settings = dbSettings[id];
            if (!settings) return; 

            // Jika metadata gagal diupdate, pakai metadata darurat agar bot tidak crash
            if (!metadata) return;

            const getRealJid = (idLid) => {
                let found = metadata.participants.find(p => p.id === idLid || p.lid === idLid);
                return found && found.jid ? found.jid : idLid;
            };

            const adminJid = author ? getRealJid(author) : null;
            const adminTag = adminJid ? `@${adminJid.split('@')[0]}` : 'Sistem';

            for (let user of participants) {
                let realUserJid = getRealJid(user);
                let userTag = `@${realUserJid.split('@')[0]}`;
                
                // ACTION: ADD (WELCOME)
             
if (action === 'add' && settings.welcome) {
    let text = settings.welcomeMsg || 'Selamat datang @user di grup @subject';
    text = text.replace('@user', userTag).replace('@subject', metadata.subject).replace('@desc', metadata.desc?.toString() || '-');

    let thumb;
    try {
        if (settings.welcomeImg && settings.welcomeImg.startsWith('http')) {
            thumb = { url: settings.welcomeImg }; 
        } else {
            let pathImg = settings.welcomeImg || global.thumb || './image/thumb.png';
            thumb = fs.readFileSync(pathImg);
        }
    } catch (e) {
        thumb = fs.readFileSync('./image/thumb.png'); 
    }

    await mahiru.sendMessage(id, { 
        text: text, 
        contextInfo: {
            mentionedJid: [realUserJid],
            externalAdReply: {
                title: 'W E L C O M E',
                body: `Member Baru di ${metadata.subject}`,
                thumbnail: thumb, 
                sourceUrl: global.saluran || "https://whatsapp.com/",
                mediaType: 1,
                renderLargerThumbnail: true
            }
        }
    });
}
// ACTION: REMOVE (LEFT)
else if (action === 'remove' && settings.left) {
    let text = settings.leftMsg || '@user telah meninggalkan grup @subject';
    text = text.replace('@user', userTag).replace('@subject', metadata.subject);
    
    let thumbLeft;
    try {
        if (settings.leftImg && settings.leftImg.startsWith('http')) {
            thumbLeft = { url: settings.leftImg };
        } else {
            let pathImg = settings.leftImg || global.thumb2 || './image/thumb2.png';
            thumbLeft = fs.readFileSync(pathImg);
        }
    } catch (e) {
        thumbLeft = fs.readFileSync('./image/thumb2.png');
    }

    await mahiru.sendMessage(id, { 
        text: text,
        contextInfo: {
            mentionedJid: [realUserJid],
            externalAdReply: {
                title: 'G O O D B Y E',
                body: `Keluar dari ${metadata.subject}`,
                thumbnail: thumbLeft, 
                sourceUrl: global.saluran || "https://whatsapp.com/",
                mediaType: 1,
                renderLargerThumbnail: true
            }
        }
    });
}
                // ACTION: PROMOTE
                else if (action === 'promote') {
                    let text = `🎊 *PROMOTED* 🎊\n\nSelamat ${userTag}, sekarang lu jadi admin grup *${metadata.subject}* oleh ${adminTag}.`;
                    await mahiru.sendMessage(id, { text, mentions: [realUserJid, adminJid].filter(Boolean) });
                }
                // ACTION: DEMOTE
                else if (action === 'demote') {
                    let text = `🤣 *DEMOTED* 🤣\n\nKasian si ${userTag} jabatannya dicopot sama ${adminTag}.`;
                    await mahiru.sendMessage(id, { text, mentions: [realUserJid, adminJid].filter(Boolean) });
                }
            }
        } catch (e) {
            await reportError(e, 'ERROR GROUP UPDATE');
        }
    });

    //===== UPDATE DATABASE SAAT NAMA/DESK/SETTING GRUP BERUBAH =====//
    mahiru.ev.on('groups.update', async (updates) => {
        for (const update of updates) {
            console.log(`${chalk.bgBlue.white(' GROUP-UPDATE ')} Detected change in ${update.id}`);
            await saveGroupMetadata(mahiru, update.id);
        }
    });

    mahiru.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('✅ Bot Berhasil Terhubung!');
        }
    });

    mahiru.ev.on('messages.upsert', async (chatUpdate) => {
        const m = chatUpdate.messages[0];
        if (!m.message || m.key.fromMe) return;
        if (m.key.remoteJid && m.key.remoteJid.endsWith('@g.us')) {
            const dbPath = `./database/group/${m.key.remoteJid.split('@')[0]}.json`;
            if (!fs.existsSync(dbPath)) {
                await saveGroupMetadata(mahiru, m.key.remoteJid);
            }
        }

        try {
            await handler(mahiru, m);
        } catch (e) {
            await reportError(e, 'ERROR MESSAGE HANDLER');
        }
    });

}