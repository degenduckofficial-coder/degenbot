// 100 SOL Button — full Node.js bot + game API in one file.
//
// Required env vars:
//   TELEGRAM_BOT_TOKEN  - from @BotFather
//   DATABASE_URL        - Postgres connection string
//   PORT                - HTTP port (optional, default 3000)
//
// Install:
//   npm install node-telegram-bot-api node-cron express cors pg
//
// Run:
//   node index.js

const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');

// ---------- config ----------
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');

const PORT = Number(process.env.PORT) || 3000;

const APP_URL = 'https://degen100solbutton.netlify.app';
const GROUP   = 'https://t.me/xDegenDuck';
const X_URL   = 'https://x.com/xdegenduck?s=21';
const BROADCAST_CHAT = '@xDegenDuck';

const TIMER_MS = 5 * 60 * 1000;        // 5 min shared timer
const STARTING_TRIES = 4;
const MAX_TRIES = 11;
const EVENT_END = new Date('2026-10-10T00:00:00.000Z');

// ---------- database ----------
const pool = new Pool({ connectionString: DATABASE_URL });

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      telegram_id      BIGINT PRIMARY KEY,
      username         TEXT,
      first_name       TEXT,
      tries_remaining  INTEGER NOT NULL DEFAULT 4,
      tries_earned     INTEGER NOT NULL DEFAULT 0,
      total_clicks     INTEGER NOT NULL DEFAULT 0,
      last_click_at    TIMESTAMPTZ,
      last_shared_at   TIMESTAMPTZ,
      joined_group     INTEGER NOT NULL DEFAULT 0,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clicks (
      id           BIGSERIAL PRIMARY KEY,
      telegram_id  BIGINT NOT NULL,
      clicked_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS game_state (
      id                 INTEGER PRIMARY KEY DEFAULT 1,
      timer_ends_at      TIMESTAMPTZ NOT NULL,
      last_clicker_id    BIGINT,
      last_clicker_name  TEXT,
      total_clicks       INTEGER NOT NULL DEFAULT 0,
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function getOrInitState() {
  const { rows } = await pool.query('SELECT * FROM game_state WHERE id = 1');
  if (rows[0]) return rows[0];
  const ins = await pool.query(
    `INSERT INTO game_state (id, timer_ends_at, total_clicks)
     VALUES (1, $1, 0) RETURNING *`,
    [new Date(Date.now() + TIMER_MS)]
  );
  return ins.rows[0];
}

async function getOrCreatePlayer(telegramId, username, firstName) {
  const { rows } = await pool.query(
    'SELECT * FROM players WHERE telegram_id = $1',
    [telegramId]
  );
  if (rows[0]) {
    if ((username && rows[0].username !== username) ||
        (firstName && rows[0].first_name !== firstName)) {
      const upd = await pool.query(
        `UPDATE players SET username = COALESCE($1, username),
                            first_name = COALESCE($2, first_name)
         WHERE telegram_id = $3 RETURNING *`,
        [username || null, firstName || null, telegramId]
      );
      return upd.rows[0];
    }
    return rows[0];
  }
  const ins = await pool.query(
    `INSERT INTO players (telegram_id, username, first_name, tries_remaining)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [telegramId, username || null, firstName || null, STARTING_TRIES]
  );
  return ins.rows[0];
}

// ---------- telegram bot ----------
const bot = new TelegramBot(TOKEN, { polling: true });

const keyboard = {
  reply_markup: {
    inline_keyboard: [[
      { text: '🦆 Press the 100 SOL Button', web_app: { url: APP_URL } }
    ],[
      { text: '📢 Join @xDegenDuck', url: GROUP },
      { text: '🐦 Follow on X', url: X_URL }
    ]]
  }
};

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
`🦆 *Welcome to the $DEGEN 100 SOL Button!*

💰 Prize: *100 SOL*
⏰ Ends: *October 10, 2026*
🏆 Winner: *Last click before 00:00.000*

→ Join @xDegenDuck first (required)
→ You start with 4 tries
→ Every click resets the shared timer
→ Be the LAST click before timer hits zero
→ Earn extra tries by completing tasks
→ Share daily for +1 try per day

*Patience wins. WAGMI 🚀*`,
    { parse_mode: 'Markdown', ...keyboard }
  );
});

bot.onText(/\/play/, (msg) => {
  bot.sendMessage(msg.chat.id, '🦆 Tap below to open the game!', keyboard);
});

bot.onText(/\/rules/, (msg) => {
  bot.sendMessage(msg.chat.id,
`📋 *100 SOL BUTTON RULES*

1️⃣ Last click before 00:00.000 wins 100 SOL
2️⃣ Must join @xDegenDuck to participate
3️⃣ Start with 4 tries — earn up to 7 more
4️⃣ Every click resets the shared 5min timer
5️⃣ Clicking early wastes a try permanently
6️⃣ Share daily for +1 try per day
7️⃣ Event ends October 10 2026
8️⃣ One account per person — cheating = ban
9️⃣ Prize paid in SOL within 7 days

*The duck is watching. 🦆*`,
    { parse_mode: 'Markdown', ...keyboard }
  );
});

bot.on('message', (msg) => {
  if (msg.text && !msg.text.startsWith('/')) {
    bot.sendMessage(msg.chat.id, '🦆 Tap the button below to play!', keyboard);
  }
});

bot.on('polling_error', (err) => console.error('polling_error:', err.message));

// ---------- daily broadcast ----------
function formatPlayerName(p) {
  if (p.username) return '@' + p.username;
  if (p.first_name) return p.first_name;
  return `Player ${p.telegram_id}`;
}

function formatRemaining(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

async function buildDailyBroadcast() {
  const state = (await pool.query('SELECT * FROM game_state WHERE id = 1')).rows[0];
  const top = (await pool.query(
    `SELECT telegram_id, username, first_name, total_clicks
     FROM players ORDER BY total_clicks DESC LIMIT 5`
  )).rows;

  const daysLeft = Math.max(
    0,
    Math.ceil((EVENT_END.getTime() - Date.now()) / (24 * 60 * 60 * 1000))
  );
  const totalClicks = state ? state.total_clicks : 0;
  const remainingMs = state
    ? Math.max(0, new Date(state.timer_ends_at).getTime() - Date.now())
    : 0;
  const lastClicker = state && state.last_clicker_name ? state.last_clicker_name : '—';

  const leaderboard = top.length > 0
    ? top.map((p, i) => `${i + 1}. ${formatPlayerName(p)} — ${p.total_clicks} clicks`).join('\n')
    : 'No clicks yet — be the first!';

  return `🚨 100 SOL BUTTON DAILY UPDATE 🚨

⏰ Event ends: October 10, 2026 (${daysLeft} days left)
🏆 Prize: 100 SOL
🎯 Strategy: Wait. Click last. Win everything.

📊 Live stats
• Total clicks: ${totalClicks}
• Timer: ${formatRemaining(remainingMs)} remaining
• Last clicker: ${lastClicker}

🥇 Top 5
${leaderboard}

Have you used your tries today?
Share daily for +1 free try 📤

👇 TAP TO PLAY
@xDegenDuck100Bot`;
}

async function sendDailyBroadcast() {
  try {
    const text = await buildDailyBroadcast();
    await bot.sendMessage(BROADCAST_CHAT, text, keyboard);
    console.log('Daily broadcast sent to', BROADCAST_CHAT);
  } catch (err) {
    console.error('Daily broadcast failed:', err.message);
  }
}

// ---------- game HTTP API ----------
const app = express();
app.use(cors());
app.use(express.json());

app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

app.get('/api/game/state', async (_req, res) => {
  try {
    const state = await getOrInitState();
    const now = Date.now();
    const remainingMs = Math.max(0, new Date(state.timer_ends_at).getTime() - now);
    res.json({
      timerEndsAt: state.timer_ends_at,
      remainingMs,
      eventEndsAt: EVENT_END.toISOString(),
      eventActive: now < EVENT_END.getTime(),
      totalClicks: state.total_clicks,
      lastClicker: state.last_clicker_name
        ? { id: state.last_clicker_id, name: state.last_clicker_name }
        : null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/game/leaderboard', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT telegram_id AS "telegramId", username, first_name AS "firstName",
              total_clicks AS "totalClicks"
       FROM players ORDER BY total_clicks DESC LIMIT 20`
    );
    res.json({ players: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/game/me/:telegramId', async (req, res) => {
  try {
    const id = Number(req.params.telegramId);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid telegramId' });
    const { rows } = await pool.query('SELECT * FROM players WHERE telegram_id = $1', [id]);
    if (rows.length === 0) return res.json({ exists: false });
    const p = rows[0];
    res.json({
      exists: true,
      telegramId: p.telegram_id,
      username: p.username,
      firstName: p.first_name,
      triesRemaining: p.tries_remaining,
      triesEarned: p.tries_earned,
      totalClicks: p.total_clicks,
      lastClickAt: p.last_click_at,
      lastSharedAt: p.last_shared_at,
      joinedGroup: p.joined_group === 1,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/game/click', async (req, res) => {
  try {
    const { telegramId, username, firstName } = req.body || {};
    const id = Number(telegramId);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'telegramId required' });

    const now = new Date();
    if (now.getTime() >= EVENT_END.getTime()) {
      return res.status(403).json({ error: 'Event has ended' });
    }

    const player = await getOrCreatePlayer(id, username, firstName);
    if (player.tries_remaining <= 0) {
      return res.status(403).json({ error: 'No tries remaining', triesRemaining: 0 });
    }

    await pool.query(
      `UPDATE players
         SET tries_remaining = tries_remaining - 1,
             total_clicks    = total_clicks + 1,
             last_click_at   = $1
       WHERE telegram_id = $2`,
      [now, id]
    );
    await pool.query('INSERT INTO clicks (telegram_id) VALUES ($1)', [id]);

    const newTimerEnd = new Date(now.getTime() + TIMER_MS);
    const displayName = firstName || username || player.first_name || player.username || `Player ${id}`;
    await getOrInitState();
    await pool.query(
      `UPDATE game_state
         SET timer_ends_at     = $1,
             last_clicker_id   = $2,
             last_clicker_name = $3,
             total_clicks      = total_clicks + 1,
             updated_at        = $4
       WHERE id = 1`,
      [newTimerEnd, id, displayName, now]
    );

    const updated = (await pool.query(
      'SELECT tries_remaining, total_clicks FROM players WHERE telegram_id = $1',
      [id]
    )).rows[0];

    res.json({
      success: true,
      triesRemaining: updated.tries_remaining,
      totalClicks: updated.total_clicks,
      timerEndsAt: newTimerEnd,
      remainingMs: TIMER_MS,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/game/share', async (req, res) => {
  try {
    const { telegramId } = req.body || {};
    const id = Number(telegramId);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'telegramId required' });

    const player = await getOrCreatePlayer(id);
    const now = new Date();
    const last = player.last_shared_at ? new Date(player.last_shared_at).getTime() : 0;
    const oneDay = 24 * 60 * 60 * 1000;
    if (now.getTime() - last < oneDay) {
      return res.status(429).json({
        error: 'Already shared today',
        nextAvailableAt: new Date(last + oneDay),
      });
    }
    if (player.tries_earned >= MAX_TRIES - STARTING_TRIES) {
      return res.status(403).json({ error: 'Max bonus tries earned' });
    }
    const upd = await pool.query(
      `UPDATE players
         SET tries_remaining = tries_remaining + 1,
             tries_earned    = tries_earned + 1,
             last_shared_at  = $1
       WHERE telegram_id = $2
       RETURNING tries_remaining, tries_earned`,
      [now, id]
    );
    res.json({
      success: true,
      triesRemaining: upd.rows[0].tries_remaining,
      triesEarned: upd.rows[0].tries_earned,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/game/joined-group', async (req, res) => {
  try {
    const { telegramId } = req.body || {};
    const id = Number(telegramId);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'telegramId required' });
    const player = await getOrCreatePlayer(id);
    if (player.joined_group === 1) {
      return res.json({ success: true, alreadyClaimed: true });
    }
    const upd = await pool.query(
      `UPDATE players
         SET joined_group    = 1,
             tries_remaining = tries_remaining + 2,
             tries_earned    = tries_earned + 2
       WHERE telegram_id = $1
       RETURNING tries_remaining, tries_earned`,
      [id]
    );
    res.json({
      success: true,
      triesRemaining: upd.rows[0].tries_remaining,
      triesEarned: upd.rows[0].tries_earned,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- startup ----------
(async () => {
  try {
    await initDb();
    console.log('Database ready');

    const me = await bot.getMe();
    console.log('🦆 Bot is running as @' + me.username);

    const task = cron.schedule('0 12 * * *', () => { sendDailyBroadcast(); }, { timezone: 'UTC' });
    task.start();
    console.log('Daily broadcast scheduled: 12:00 UTC ->', BROADCAST_CHAT);

    app.listen(PORT, () => console.log('HTTP server listening on port', PORT));

    const stop = (sig) => {
      console.log('Stopping (' + sig + ')...');
      task.stop();
      bot.stopPolling().finally(() => pool.end()).finally(() => process.exit(0));
    };
    process.once('SIGINT',  () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
  } catch (err) {
    console.error('Startup failed:', err);
    process.exit(1);
  }
})();
