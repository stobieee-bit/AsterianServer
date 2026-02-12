// Asterian Multiplayer Server — Tier 1: presence + chat
// Node.js + ws, deploy on Render/Railway or run locally

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 20;
const HEARTBEAT_INTERVAL = 15000;
const HEARTBEAT_TIMEOUT = 30000;

// ── HTTP health check ──────────────────────────────────────────
const httpServer = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            players: players.size,
            maxPlayers: MAX_PLAYERS,
            uptime: Math.floor(process.uptime())
        }));
    } else {
        res.writeHead(404);
        res.end();
    }
});

// ── WebSocket server ───────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });
const players = new Map(); // ws → playerData

function genId() {
    return Math.random().toString(36).slice(2, 10);
}

function broadcast(data, exclude) {
    const msg = JSON.stringify(data);
    for (const [ws] of players) {
        if (ws !== exclude && ws.readyState === 1) {
            ws.send(msg);
        }
    }
}

function sendTo(ws, data) {
    if (ws.readyState === 1) {
        ws.send(JSON.stringify(data));
    }
}

wss.on('connection', (ws) => {
    if (players.size >= MAX_PLAYERS) {
        sendTo(ws, { type: 'error', msg: 'Server full' });
        ws.close();
        return;
    }

    let joined = false;
    let pData = null;

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        // ── Join ───────────────────────────────────────────
        if (msg.type === 'join' && !joined) {
            const name = (msg.name || 'Player').slice(0, 16).replace(/[<>&"']/g, '');
            pData = {
                id: genId(),
                name: name,
                x: 0, z: 0, ry: 0, moving: false,
                equipment: {},
                stats: { level: 1, combatStyle: 'nano', hp: 100, maxHp: 100, area: 'station-hub' },
                lastPing: Date.now()
            };
            players.set(ws, pData);
            joined = true;

            // Send welcome with existing player list
            const existing = [];
            for (const [ows, op] of players) {
                if (ows !== ws) {
                    existing.push({
                        id: op.id, name: op.name,
                        x: op.x, z: op.z, ry: op.ry, moving: op.moving,
                        equipment: op.equipment, stats: op.stats
                    });
                }
            }
            sendTo(ws, { type: 'welcome', id: pData.id, players: existing });

            // Broadcast join to others
            broadcast({ type: 'join', id: pData.id, name: pData.name }, ws);

            console.log(`[+] ${pData.name} joined (${players.size}/${MAX_PLAYERS})`);
            return;
        }

        if (!joined) return;

        // ── Move ───────────────────────────────────────────
        if (msg.type === 'move') {
            pData.x = Number(msg.x) || 0;
            pData.z = Number(msg.z) || 0;
            pData.ry = Number(msg.ry) || 0;
            pData.moving = !!msg.moving;
            broadcast({ type: 'move', id: pData.id, x: pData.x, z: pData.z, ry: pData.ry, moving: pData.moving }, ws);
        }

        // ── Chat ───────────────────────────────────────────
        else if (msg.type === 'chat') {
            const text = (msg.text || '').slice(0, 200).replace(/[<>&]/g, '');
            if (text.length > 0) {
                // Broadcast to ALL including sender (confirmation)
                broadcast({ type: 'chat', id: pData.id, name: pData.name, text: text });
            }
        }

        // ── Equipment sync ─────────────────────────────────
        else if (msg.type === 'equip') {
            pData.equipment = msg.equipment || {};
            broadcast({ type: 'equip', id: pData.id, equipment: pData.equipment }, ws);
        }

        // ── Stats sync ─────────────────────────────────────
        else if (msg.type === 'stats') {
            pData.stats = {
                level: Number(msg.level) || 1,
                combatStyle: msg.combatStyle || 'nano',
                hp: Number(msg.hp) || 100,
                maxHp: Number(msg.maxHp) || 100,
                area: msg.area || 'station-hub'
            };
            broadcast({ type: 'stats', id: pData.id, stats: pData.stats }, ws);
        }

        // ── Attack relay (shared combat) ─────────────────────
        else if (msg.type === 'attack') {
            broadcast({
                type: 'attack', id: pData.id, name: pData.name,
                enemyId: msg.enemyId, damage: Number(msg.damage) || 0,
                style: msg.style || 'nano',
                x: Number(msg.x) || 0, z: Number(msg.z) || 0
            }, ws);
        }

        // ── Enemy kill relay ──────────────────────────────────
        else if (msg.type === 'enemyKill') {
            broadcast({
                type: 'enemyKill', id: pData.id, name: pData.name,
                enemyId: msg.enemyId
            }, ws);
        }

        // ── Ground item drop relay ───────────────────────────
        else if (msg.type === 'groundDrop') {
            broadcast({
                type: 'groundDrop', id: pData.id, name: pData.name,
                x: Number(msg.x) || 0, z: Number(msg.z) || 0,
                itemId: (msg.itemId || '').slice(0, 64),
                quantity: Math.min(Number(msg.quantity) || 1, 1000)
            }, ws);
        }

        // ── Heartbeat response ─────────────────────────────
        else if (msg.type === 'pong') {
            pData.lastPing = Date.now();
        }
    });

    ws.on('close', () => {
        if (pData) {
            broadcast({ type: 'leave', id: pData.id });
            console.log(`[-] ${pData.name} left (${players.size - 1}/${MAX_PLAYERS})`);
        }
        players.delete(ws);
    });

    ws.on('error', () => {
        players.delete(ws);
    });
});

// ── Heartbeat ping ─────────────────────────────────────────────
setInterval(() => {
    const now = Date.now();
    for (const [ws, pd] of players) {
        if (now - pd.lastPing > HEARTBEAT_TIMEOUT) {
            console.log(`[!] ${pd.name} timed out`);
            ws.terminate();
            players.delete(ws);
        } else {
            sendTo(ws, { type: 'ping' });
        }
    }
}, HEARTBEAT_INTERVAL);

// ── Start ──────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
    console.log(`Asterian MP server listening on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/`);
});
