// 100 SOL Button — Backend v4
// Live Timer Sync, Telegram Stars payments, Anti-Bot CAPTCHA,
// Streaks, Squads, Runner-Up Prizes, Referral Board, Click Cards
//
// npm install node-telegram-bot-api node-cron express cors pg
// Env: TELEGRAM_BOT_TOKEN, DATABASE_URL, PORT

const express     = require('express');
const cors        = require('cors');
const cron        = require('node-cron');
const TelegramBot = require('node-telegram-bot-api');
const { Pool }    = require('pg');
const crypto      = require('crypto');

// ═══════════════════ CONFIG ═══════════════════
const TOKEN          = process.env.TELEGRAM_BOT_TOKEN;
const DATABASE_URL   = process.env.DATABASE_URL;
const PORT           = Number(process.env.PORT) || 3000;
const ADMIN_ID       = 1825536257;
const APP_URL        = 'https://degenduckofficial-coder.github.io/degen-button';
const GROUP          = 'https://t.me/xDegenDuck';
const X_URL          = 'https://x.com/xdegenduck?s=21';
const BROADCAST_CHAT = '@xDegenDuck';
const TIMER_MS       = 5 * 60 * 1000;
const AUTO_RESET_MS  = 3 * 60 * 1000; // never let timer go below 3 min absolute floor
const BOT_NAMES      = ['Duck #3344','Duck #7712','Duck #2291','Duck #5503','Duck #8819','Duck #1147','Duck #6632','Duck #4478','Duck #9021','Duck #3307','Duck #1892','Duck #6104','Duck #8823','Duck #2567','Duck #4491'];
const rBotName       = () => BOT_NAMES[Math.floor(Math.random()*BOT_NAMES.length)];
const STARTING_TRIES = 4;
const MAX_BONUS      = 7;
const SQUAD_SIZE     = 4;
const SQUAD_PCT      = 3;
const EVENT_END      = new Date('2026-10-10T00:00:00.000Z');

// Telegram Stars packages (Stars → tries)
const STAR_PACKAGES = [
  { id: 'pack_5',  label: '5 Tries',  tries: 5,  stars: 50,  emoji: '⚡' },
  { id: 'pack_10', label: '10 Tries', tries: 10, stars: 90,  emoji: '🔥' },
  { id: 'pack_20', label: '20 Tries', tries: 20, stars: 160, emoji: '💎' },
];

if (!TOKEN)        throw new Error('TELEGRAM_BOT_TOKEN required');
if (!DATABASE_URL) throw new Error('DATABASE_URL required');

// ═══════════════════ DB ═══════════════════
const pool = new Pool({ connectionString: DATABASE_URL });

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      telegram_id       BIGINT PRIMARY KEY,
      username          TEXT,
      first_name        TEXT,
      tries_remaining   INTEGER NOT NULL DEFAULT 4,
      tries_earned      INTEGER NOT NULL DEFAULT 0,
      tries_purchased   INTEGER NOT NULL DEFAULT 0,
      total_clicks      INTEGER NOT NULL DEFAULT 0,
      best_click_ms     BIGINT,
      last_click_at     TIMESTAMPTZ,
      last_shared_at    TIMESTAMPTZ,
      joined_group      INTEGER NOT NULL DEFAULT 0,
      referral_code     TEXT UNIQUE,
      referred_by       BIGINT,
      referral_count    INTEGER NOT NULL DEFAULT 0,
      streak_days       INTEGER NOT NULL DEFAULT 0,
      last_streak_date  DATE,
      squad_id          BIGINT,
      verified_human    INTEGER NOT NULL DEFAULT 0,
      captcha_fails     INTEGER NOT NULL DEFAULT 0,
      captcha_locked_until TIMESTAMPTZ,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS clicks (
      id           BIGSERIAL PRIMARY KEY,
      telegram_id  BIGINT NOT NULL,
      timer_ms     BIGINT,
      clicked_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS game_state (
      id                  INTEGER PRIMARY KEY DEFAULT 1,
      timer_ends_at       TIMESTAMPTZ NOT NULL,
      last_clicker_id     BIGINT,
      last_clicker_name   TEXT,
      second_clicker_id   BIGINT,
      second_clicker_name TEXT,
      third_clicker_id    BIGINT,
      third_clicker_name  TEXT,
      total_clicks        INTEGER NOT NULL DEFAULT 0,
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS invites (
      id           BIGSERIAL PRIMARY KEY,
      inviter_id   BIGINT NOT NULL,
      invitee_id   BIGINT NOT NULL UNIQUE,
      credited     INTEGER NOT NULL DEFAULT 0,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS squads (
      id           BIGSERIAL PRIMARY KEY,
      name         TEXT,
      creator_id   BIGINT NOT NULL,
      invite_code  TEXT UNIQUE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS purchases (
      id           BIGSERIAL PRIMARY KEY,
      telegram_id  BIGINT NOT NULL,
      package_id   TEXT NOT NULL,
      tries_added  INTEGER NOT NULL,
      stars_paid   INTEGER NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS captcha_sessions (
      telegram_id   BIGINT PRIMARY KEY,
      correct_emoji TEXT NOT NULL,
      expires_at    TIMESTAMPTZ NOT NULL,
      attempts      INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Safe column upgrades
  const cols = [
    `ALTER TABLE players ADD COLUMN IF NOT EXISTS tries_purchased INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE players ADD COLUMN IF NOT EXISTS verified_human INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE players ADD COLUMN IF NOT EXISTS captcha_fails INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE players ADD COLUMN IF NOT EXISTS captcha_locked_until TIMESTAMPTZ`,
    `ALTER TABLE players ADD COLUMN IF NOT EXISTS best_click_ms BIGINT`,
    `ALTER TABLE players ADD COLUMN IF NOT EXISTS referral_code TEXT`,
    `ALTER TABLE players ADD COLUMN IF NOT EXISTS referred_by BIGINT`,
    `ALTER TABLE players ADD COLUMN IF NOT EXISTS referral_count INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE players ADD COLUMN IF NOT EXISTS streak_days INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE players ADD COLUMN IF NOT EXISTS last_streak_date DATE`,
    `ALTER TABLE players ADD COLUMN IF NOT EXISTS squad_id BIGINT`,
    `ALTER TABLE clicks ADD COLUMN IF NOT EXISTS timer_ms BIGINT`,
    `ALTER TABLE game_state ADD COLUMN IF NOT EXISTS second_clicker_id BIGINT`,
    `ALTER TABLE game_state ADD COLUMN IF NOT EXISTS second_clicker_name TEXT`,
    `ALTER TABLE game_state ADD COLUMN IF NOT EXISTS third_clicker_id BIGINT`,
    `ALTER TABLE game_state ADD COLUMN IF NOT EXISTS third_clicker_name TEXT`,
  ];
  for (const sql of cols) { try { await pool.query(sql); } catch(e){} }
  console.log('Database ready');
}

// ═══════════════════ HELPERS ═══════════════════
const genCode = (id, salt='degen') =>
  crypto.createHash('sha256').update(String(id)+salt).digest('hex').slice(0,10);

function maskName(username, firstName) {
  const raw = username ? username.replace(/^@/,'') : firstName;
  if (!raw) return 'Duck****';
  const half = Math.ceil(raw.length/2);
  return (username ? '@' : '') + raw.slice(0,half) + '*'.repeat(Math.max(1,raw.length-half));
}

function fmtMs(ms) {
  if (ms==null) return '--:--.--';
  const m=Math.floor(ms/60000),s=Math.floor((ms%60000)/1000),cs=Math.floor((ms%1000)/10);
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;
}

function fmtSec(ms) {
  const t=Math.max(0,Math.floor(ms/1000)),m=Math.floor(t/60),s=t%60;
  return `${m}m ${String(s).padStart(2,'0')}s`;
}

const streakEmoji = d => d>=30?'🔥🔥🔥':d>=14?'🔥🔥':d>=7?'🔥':d>=3?'⚡':'✨';

async function getOrInitState() {
  const {rows}=await pool.query('SELECT * FROM game_state WHERE id=1');
  if (rows[0]) return rows[0];
  const ins=await pool.query(
    `INSERT INTO game_state(id,timer_ends_at,total_clicks) VALUES(1,$1,0) RETURNING *`,
    [new Date(Date.now()+TIMER_MS)]
  );
  return ins.rows[0];
}

async function getOrCreatePlayer(tid, username, firstName) {
  const {rows}=await pool.query('SELECT * FROM players WHERE telegram_id=$1',[tid]);
  if (rows[0]) {
    const p=rows[0];
    const needUpdate=(username&&p.username!==username)||(firstName&&p.first_name!==firstName)||!p.referral_code;
    if (needUpdate) {
      const code=p.referral_code||genCode(tid);
      const upd=await pool.query(
        `UPDATE players SET username=COALESCE($1,username),first_name=COALESCE($2,first_name),referral_code=COALESCE(referral_code,$3) WHERE telegram_id=$4 RETURNING *`,
        [username||null,firstName||null,code,tid]
      );
      return upd.rows[0];
    }
    return p;
  }
  const ins=await pool.query(
    `INSERT INTO players(telegram_id,username,first_name,tries_remaining,referral_code) VALUES($1,$2,$3,$4,$5) RETURNING *`,
    [tid,username||null,firstName||null,STARTING_TRIES,genCode(tid)]
  );
  return ins.rows[0];
}

async function handleStreak(tid) {
  const {rows}=await pool.query('SELECT streak_days,last_streak_date FROM players WHERE telegram_id=$1',[tid]);
  if (!rows[0]) return {streakDays:0,bonusEarned:false};
  const today=new Date().toISOString().split('T')[0];
  const lastDate=rows[0].last_streak_date?new Date(rows[0].last_streak_date).toISOString().split('T')[0]:null;
  if (lastDate===today) return {streakDays:rows[0].streak_days,bonusEarned:false};
  const yesterday=new Date(Date.now()-86400000).toISOString().split('T')[0];
  const newStreak=lastDate===yesterday?rows[0].streak_days+1:1;
  const milestones={3:1,7:2,14:3,30:5};
  const bonus=milestones[newStreak]||0;
  await pool.query(
    `UPDATE players SET streak_days=$1,last_streak_date=$2,tries_remaining=tries_remaining+$3,tries_earned=tries_earned+$3 WHERE telegram_id=$4`,
    [newStreak,today,bonus,tid]
  );
  return {streakDays:newStreak,bonusEarned:bonus>0,bonus,milestone:newStreak};
}

async function getLbRank(tid) {
  const {rows}=await pool.query(
    `SELECT telegram_id,ROW_NUMBER() OVER(ORDER BY best_click_ms ASC) AS rank FROM players WHERE best_click_ms IS NOT NULL`
  );
  const e=rows.find(r=>Number(r.telegram_id)===tid);
  return e?Number(e.rank):null;
}

// ═══════════════════ ANTI-BOT CAPTCHA ═══════════════════
const CAPTCHA_EMOJIS = ['🦆','🦁','🐯','🦊','🐬','🦅','🌙','🍕','🎮','🚀','💎','🎯'];

async function sendCaptcha(telegramId, bot) {
  // Pick correct answer and 3 decoys
  const shuffled = [...CAPTCHA_EMOJIS].sort(() => Math.random()-0.5);
  const correct  = shuffled[0];
  const options  = shuffled.slice(0,4).sort(() => Math.random()-0.5);
  const expiresAt= new Date(Date.now() + 2 * 60 * 1000); // 2 min

  await pool.query(
    `INSERT INTO captcha_sessions(telegram_id,correct_emoji,expires_at,attempts)
     VALUES($1,$2,$3,0)
     ON CONFLICT(telegram_id) DO UPDATE SET correct_emoji=$2,expires_at=$3,attempts=0`,
    [telegramId, correct, expiresAt]
  );

  await bot.sendMessage(telegramId,
`🤖 *Human Verification*

To confirm you're a real player, tap the *${correct}* emoji below.

This is a one-time check — you'll never see it again after this.`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          options.map(e => ({ text: e, callback_data: `captcha_${telegramId}_${e}` }))
        ]
      }
    }
  );
}

async function handleCaptchaAnswer(telegramId, chosenEmoji, bot) {
  const {rows}=await pool.query(
    'SELECT * FROM captcha_sessions WHERE telegram_id=$1',[telegramId]
  );
  if (!rows[0]) return false;

  const session = rows[0];
  if (new Date(session.expires_at) < new Date()) {
    await pool.query('DELETE FROM captcha_sessions WHERE telegram_id=$1',[telegramId]);
    await bot.sendMessage(telegramId,'⏰ Verification expired. Try clicking the button again to get a new one.');
    return false;
  }

  if (chosenEmoji === session.correct_emoji) {
    // ✅ Correct
    await pool.query('DELETE FROM captcha_sessions WHERE telegram_id=$1',[telegramId]);
    await pool.query(
      'UPDATE players SET verified_human=1,captcha_fails=0 WHERE telegram_id=$1',[telegramId]
    );
    await bot.sendMessage(telegramId,
`✅ *Verified! You're a real duck.* 🦆

Your click has been registered. You're now the last clicker — defend your position!`,
      { parse_mode: 'Markdown' }
    );
    return true;
  } else {
    // ❌ Wrong
    const fails = session.attempts + 1;
    await pool.query(
      'UPDATE captcha_sessions SET attempts=$1 WHERE telegram_id=$2',[fails,telegramId]
    );
    await pool.query(
      'UPDATE players SET captcha_fails=captcha_fails+1 WHERE telegram_id=$1',[telegramId]
    );

    if (fails >= 3) {
      // Lock for 10 minutes after 3 wrong answers
      const lockUntil = new Date(Date.now() + 10 * 60 * 1000);
      await pool.query(
        'UPDATE players SET captcha_locked_until=$1 WHERE telegram_id=$2',[lockUntil,telegramId]
      );
      await pool.query('DELETE FROM captcha_sessions WHERE telegram_id=$1',[telegramId]);
      await bot.sendMessage(telegramId,
`❌ *Too many wrong answers.*

You're temporarily locked for 10 minutes. Real players only, anon. 🦆`
        ,{ parse_mode: 'Markdown' }
      );
    } else {
      await bot.sendMessage(telegramId,
        `❌ Wrong! Try again — ${3-fails} attempt${3-fails!==1?'s':''} remaining.`
      );
    }
    return false;
  }
}

// ═══════════════════ AUTO-POST TOP 10 ═══════════════════
async function postTop10Update(tid, newBestMs, bot) {
  const rank=await getLbRank(tid);
  if (!rank||rank>10) return;
  const {rows:p}=await pool.query('SELECT username,first_name FROM players WHERE telegram_id=$1',[tid]);
  if (!p[0]) return;
  const {rows:top}=await pool.query(`SELECT username,first_name,best_click_ms FROM players WHERE best_click_ms IS NOT NULL ORDER BY best_click_ms ASC LIMIT 10`);
  const medals=['🥇','🥈','🥉'];
  const list=top.map((r,i)=>`${medals[i]||`${i+1}.`} ${maskName(r.username,r.first_name)} — *${fmtMs(r.best_click_ms)}*`).join('\n');
  try {
    await bot.sendMessage(BROADCAST_CHAT,
`🚨 *NEW TOP 10 ENTRY!*

${medals[rank-1]||`#${rank}`} *${maskName(p[0].username,p[0].first_name)}* just entered!
⏱ Click time: *${fmtMs(newBestMs)}*

🏆 *Updated Top 10*
${list}

Can you beat them? 🦆
👇 t.me/xDegenDuck100Bot/button`,
      {parse_mode:'Markdown'}
    );
  } catch(e){console.error('Top10 post failed:',e.message);}
}

async function sendMissedTop10(tid, clickMs, bot) {
  const rank=await getLbRank(tid);
  if (rank&&rank<=10) return;
  const {rows}=await pool.query(`SELECT best_click_ms FROM players WHERE best_click_ms IS NOT NULL ORDER BY best_click_ms ASC LIMIT 10`);
  if (rows.length<10) return;
  const diffMs=clickMs-rows[9].best_click_ms;
  if (diffMs>60000) return;
  const diffSec=Math.floor(diffMs/1000);
  try {
    await bot.sendMessage(tid,
`😤 *So close!* You missed the Top 10 by only *${diffSec}s!*
#10: *${fmtMs(rows[9].best_click_ms)}* | Yours: *${fmtMs(clickMs)}*
Try again — you've got this! 🦆`,
      {parse_mode:'Markdown'}
    );
  } catch(e){}
}

// ═══════════════════ CLICK CARD ═══════════════════
async function generateClickCard(tid, bot) {
  const {rows}=await pool.query('SELECT * FROM players WHERE telegram_id=$1',[tid]);
  if (!rows[0]||!rows[0].best_click_ms) {
    return bot.sendMessage(tid,'🦆 No click yet! Press the button first.',
      {reply_markup:{inline_keyboard:[[{text:'🦆 Play Now',web_app:{url:APP_URL}}]]}}
    );
  }
  const p=rows[0],rank=await getLbRank(tid);
  const rankStr=rank?(rank<=3?['🥇','🥈','🥉'][rank-1]:`#${rank}`):'Unranked';
  const inviteLink=`https://t.me/xDegenDuck100Bot?start=ref_${p.referral_code}`;
  await bot.sendMessage(tid,
`🦆 *$DEGEN 100 SOL BUTTON — MY CARD*
━━━━━━━━━━━━━━━━━━
👤 ${maskName(p.username,p.first_name)}
⏱ Best Click: *${fmtMs(p.best_click_ms)}*
📊 Rank: ${rankStr}
🖱 Total Clicks: ${p.total_clicks}
🔥 Streak: ${p.streak_days}d ${streakEmoji(p.streak_days)}
👥 Invites: ${p.referral_count}
━━━━━━━━━━━━━━━━━━
💰 Prize: 100 SOL • Ends Oct 10 2026
*Can you beat me?* 🦆`,
    {parse_mode:'Markdown',reply_markup:{inline_keyboard:[[
      {text:'📤 Share My Card',url:`https://t.me/share/url?url=${encodeURIComponent(inviteLink)}&text=${encodeURIComponent(`🦆 $DEGEN 100 SOL Button\n⏱ Best: ${fmtMs(p.best_click_ms)} | Rank: ${rankStr}\nLast click wins 100 SOL! ${inviteLink}`)}`}
    ],[{text:'🦆 Play Now',web_app:{url:APP_URL}}]]}}
  );
}

// ═══════════════════ BOT ═══════════════════
const bot = new TelegramBot(TOKEN, {polling:true});

const baseKb = {reply_markup:{inline_keyboard:[[
  {text:'🦆 Press the 100 SOL Button', web_app:{url:APP_URL}}
],[
  {text:'📢 Join @xDegenDuck',url:GROUP},
  {text:'🐦 Follow on X',url:X_URL}
]]}};

// Build game URL with user ID embedded via startapp
function gameUrl(telegramId) {
  return `${APP_URL}?tgWebAppStartParam=uid${telegramId}`;
}

function kb(refCode, telegramId) {
  const link = `https://t.me/xDegenDuck100Bot?start=ref_${refCode}`;
  const url  = telegramId ? gameUrl(telegramId) : APP_URL;
  return {reply_markup:{inline_keyboard:[[
    {text:'🦆 Press the 100 SOL Button', web_app:{url}}
  ],[
    {text:'👥 Invite Friends (+1 try)', url:`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('🦆 Join the $DEGEN 100 SOL Button! Last click wins 100 SOL 💰')}`},
    {text:'💎 Buy Tries', callback_data:'buy_tries'}
  ],[
    {text:'📢 Join @xDegenDuck', url:GROUP},
    {text:'🐦 Follow on X', url:X_URL}
  ]]}};
}

// /start
bot.onText(/\/start(?:\s+(.+))?/, async (msg,match) => {
  const id=msg.from.id,username=msg.from.username||null,firstName=msg.from.first_name||null;
  const param=match[1]||'';
  const player=await getOrCreatePlayer(id,username,firstName);

  // Referral handling
  if (param.startsWith('ref_')) {
    const {rows:rr}=await pool.query('SELECT * FROM players WHERE referral_code=$1',[param.slice(4)]);
    if (rr[0]&&rr[0].telegram_id!==id&&!player.referred_by) {
      const ref=rr[0];
      const {rows:ex}=await pool.query('SELECT id FROM invites WHERE invitee_id=$1',[id]);
      if (!ex.length) {
        await pool.query('INSERT INTO invites(inviter_id,invitee_id,credited) VALUES($1,$2,1)',[ref.telegram_id,id]);
        await pool.query('UPDATE players SET referred_by=$1 WHERE telegram_id=$2',[ref.telegram_id,id]);
        const {rows:ru}=await pool.query(
          `UPDATE players SET tries_remaining=tries_remaining+1,tries_earned=tries_earned+1,referral_count=referral_count+1 WHERE telegram_id=$1 AND tries_earned<$2 RETURNING tries_remaining,referral_count`,
          [ref.telegram_id,MAX_BONUS]
        );
        try { await bot.sendMessage(ref.telegram_id,
          `🎉 *${maskName(username,firstName)} joined via your invite!*\n+1 try → *${ru[0]?.tries_remaining}* remaining 🦆`,
          {parse_mode:'Markdown',...kb(ref.referral_code)}
        );} catch(e){}
      }
    }
  }

  // Squad handling
  if (param.startsWith('squad_')) {
    const {rows:sq}=await pool.query('SELECT * FROM squads WHERE invite_code=$1',[param.slice(6)]);
    if (sq[0]&&!player.squad_id) {
      const {rows:mc}=await pool.query('SELECT COUNT(*) AS cnt FROM players WHERE squad_id=$1',[sq[0].id]);
      if (parseInt(mc[0].cnt)<SQUAD_SIZE) {
        await pool.query('UPDATE players SET squad_id=$1 WHERE telegram_id=$2',[sq[0].id,id]);
        try { await bot.sendMessage(id,`⚔️ *Squad joined!*\nIf any member wins 100 SOL → you get ${SQUAD_PCT}% each! 🦆`,{parse_mode:'Markdown'}); } catch(e){}
      }
    }
  }

  const {streakDays,bonusEarned,bonus,milestone}=await handleStreak(id);
  const {rows}=await pool.query('SELECT * FROM players WHERE telegram_id=$1',[id]);
  const p=rows[0]||player;
  let streakMsg='';
  if (streakDays>1) { streakMsg=`\n🔥 *${streakDays}-day streak!* ${streakEmoji(streakDays)}`; if(bonusEarned) streakMsg+=` +${bonus} tries!`; }

  await bot.sendMessage(id,
`🦆 *Welcome to the $DEGEN 100 SOL Button!*

💰 *Prizes:*
🥇 Last click → *100 SOL*
🥈 2nd last → *10 SOL*
🥉 3rd last → *5 SOL*
🏅 Top referrer → *5 SOL* (Oct 10)

⏰ Ends: *October 10, 2026*
🎯 Your tries: *${p.tries_remaining}*

→ Join @xDegenDuck (required)
→ Invite friends → +1 try each
→ Build a squad of ${SQUAD_SIZE} → all win ${SQUAD_PCT}%
→ Daily streak → bonus tries
→ Buy tries with ⭐ Telegram Stars${streakMsg}

*Patience wins. WAGMI 🚀*`,
    {parse_mode:'Markdown',...kb(p.referral_code, p.telegram_id)}
  );
});

// Callback queries (captcha answers + buy tries)
bot.on('callback_query', async (query) => {
  const id   = query.from.id;
  const data = query.data;

  // ── CAPTCHA ──
  if (data.startsWith('captcha_')) {
    const parts = data.split('_');
    const targetId = parseInt(parts[1]);
    const chosen   = parts.slice(2).join('_');
    if (targetId !== id) { await bot.answerCallbackQuery(query.id, {text:'Not your captcha!'}); return; }
    await bot.answerCallbackQuery(query.id, {text: chosen});
    try { await bot.deleteMessage(id, query.message.message_id); } catch(e){}
    const passed = await handleCaptchaAnswer(id, chosen, bot);
    if (passed) {
      // Re-process the pending click after verification
      await processPendingClick(id, bot);
    }
    return;
  }

  // ── BUY TRIES ──
  if (data === 'buy_tries') {
    await bot.answerCallbackQuery(query.id);
    await bot.sendMessage(id,
`💎 *Buy Extra Tries with ⭐ Stars*

Choose a package:`,
      {parse_mode:'Markdown',reply_markup:{inline_keyboard:
        STAR_PACKAGES.map(p=>[{
          text:`${p.emoji} ${p.label} — ${p.stars} ⭐`,
          callback_data:`buy_pack_${p.id}`
        }])
      }}
    );
    return;
  }

  // ── BUY SPECIFIC PACK ──
  if (data.startsWith('buy_pack_')) {
    const packId = data.replace('buy_pack_','');
    const pack   = STAR_PACKAGES.find(p=>p.id===packId);
    if (!pack) { await bot.answerCallbackQuery(query.id,{text:'Invalid pack'}); return; }
    await bot.answerCallbackQuery(query.id);

    // Send Telegram Stars invoice
    await bot.sendInvoice(
      id,
      `${pack.emoji} ${pack.label}`,
      `Get ${pack.tries} extra tries for the $DEGEN 100 SOL Button event!`,
      `tries_${packId}_${id}`,
      '',          // provider token empty = Telegram Stars
      'XTR',       // Stars currency
      [{ label: pack.label, amount: pack.stars }]
    );
    return;
  }
});

// Pre-checkout (required by Telegram)
bot.on('pre_checkout_query', async (query) => {
  await bot.answerPreCheckoutQuery(query.id, true);
});

// Successful payment
bot.on('successful_payment', async (msg) => {
  const id      = msg.from.id;
  const payment = msg.successful_payment;
  const payload = payment.invoice_payload; // tries_pack_5_123456
  const parts   = payload.split('_');
  const packId  = parts[1]+'_'+parts[2]; // e.g. pack_5
  const pack    = STAR_PACKAGES.find(p=>p.id===packId);
  if (!pack) return;

  const player = await getOrCreatePlayer(id, msg.from.username, msg.from.first_name);
  await pool.query(
    `UPDATE players SET tries_remaining=tries_remaining+$1,tries_purchased=tries_purchased+$1 WHERE telegram_id=$2`,
    [pack.tries, id]
  );
  await pool.query(
    `INSERT INTO purchases(telegram_id,package_id,tries_added,stars_paid) VALUES($1,$2,$3,$4)`,
    [id, packId, pack.tries, pack.stars]
  );

  const updated = (await pool.query(
    'SELECT tries_remaining FROM players WHERE telegram_id=$1',[id]
  )).rows[0];

  await bot.sendMessage(id,
`✅ *Payment successful!* ⭐

${pack.emoji} *${pack.tries} tries added* to your account!
🎯 You now have *${updated.tries_remaining} tries* remaining.

Go press the button while the timer is low! 🦆`,
    {parse_mode:'Markdown',reply_markup:{inline_keyboard:[[
      {text:'🦆 Play Now',web_app:{url:APP_URL}}
    ]]}}
  );
});

// Pending click map (stores click data while waiting for captcha)
const pendingClicks = new Map();

async function processPendingClick(tid, bot) {
  const pending = pendingClicks.get(tid);
  if (!pending) return;
  pendingClicks.delete(tid);

  const {clickMs, displayName} = pending;
  await recordClick(tid, clickMs, displayName, bot);
}

async function recordClick(tid, clickMs, displayName, bot) {
  const now = new Date();
  const player = await getOrCreatePlayer(tid);
  if (player.tries_remaining <= 0) return;

  const isNewBest = clickMs!==null && (player.best_click_ms===null || clickMs<player.best_click_ms);

  await pool.query(
    `UPDATE players SET tries_remaining=tries_remaining-1,total_clicks=total_clicks+1,last_click_at=$1,best_click_ms=CASE WHEN best_click_ms IS NULL THEN $2 WHEN $2 IS NOT NULL AND $2<best_click_ms THEN $2 ELSE best_click_ms END WHERE telegram_id=$3`,
    [now,clickMs,tid]
  );
  await pool.query('INSERT INTO clicks(telegram_id,timer_ms) VALUES($1,$2)',[tid,clickMs]);

  const newTimerEnd=new Date(now.getTime()+TIMER_MS);
  await getOrInitState();
  await pool.query(
    `UPDATE game_state SET timer_ends_at=$1,third_clicker_id=second_clicker_id,third_clicker_name=second_clicker_name,second_clicker_id=last_clicker_id,second_clicker_name=last_clicker_name,last_clicker_id=$2,last_clicker_name=$3,total_clicks=total_clicks+1,updated_at=$4 WHERE id=1`,
    [newTimerEnd,tid,displayName,now]
  );

  if (isNewBest&&clickMs!==null) {
    setImmediate(()=>postTop10Update(tid,clickMs,bot));
    setImmediate(()=>sendMissedTop10(tid,clickMs,bot));
  }
}

// Bot commands
bot.onText(/\/play/, async (msg) => {
  const p=await getOrCreatePlayer(msg.from.id,msg.from.username,msg.from.first_name);
  bot.sendMessage(msg.from.id,'🦆 Tap below!',kb(p.referral_code, p.telegram_id));
});

bot.onText(/\/buy/, async (msg) => {
  const id=msg.from.id;
  const p=await getOrCreatePlayer(id,msg.from.username,msg.from.first_name);
  await bot.sendMessage(id,
`💎 *Buy Extra Tries with ⭐ Telegram Stars*

No wallet needed — pay directly in Telegram!

Current tries: *${p.tries_remaining}*`,
    {parse_mode:'Markdown',reply_markup:{inline_keyboard:
      STAR_PACKAGES.map(p=>[{
        text:`${p.emoji} ${p.label} — ${p.stars} ⭐`,
        callback_data:`buy_pack_${p.id}`
      }])
    }}
  );
});

bot.onText(/\/mycard/, async (msg) => { await generateClickCard(msg.from.id,bot); });
bot.onText(/\/mystats/, async (msg) => {
  const id=msg.from.id,p=await getOrCreatePlayer(id,msg.from.username,msg.from.first_name);
  const rank=await getLbRank(id);
  const rankStr=rank?(rank<=3?['🥇','🥈','🥉'][rank-1]:`#${rank}`):'Not ranked';
  const inviteLink=`https://t.me/xDegenDuck100Bot?start=ref_${p.referral_code}`;
  bot.sendMessage(id,
`📊 *Your Stats*
🎯 Tries: *${p.tries_remaining}* | 🖱 Clicks: *${p.total_clicks}*
⏱ Best: *${fmtMs(p.best_click_ms)}* | 📊 Rank: *${rankStr}*
🔥 Streak: *${p.streak_days}d* ${streakEmoji(p.streak_days)}
👥 Invites: *${p.referral_count}* | 💎 Purchased: *${p.tries_purchased||0}*

🔗 \`${inviteLink}\``,
    {parse_mode:'Markdown',...kb(p.referral_code, p.telegram_id)}
  );
});

bot.onText(/\/streak/, async (msg) => {
  const p=await getOrCreatePlayer(msg.from.id,msg.from.username,msg.from.first_name);
  const next=[{days:3,r:'+1'},{days:7,r:'+2'},{days:14,r:'+3'},{days:30,r:'+5'}].find(m=>m.days>p.streak_days);
  bot.sendMessage(msg.from.id,
`🔥 *Streak: ${p.streak_days} days* ${streakEmoji(p.streak_days)}
${next?`Next: *${next.days}d* → ${next.r} tries`:'🏆 Max reached!'}
Milestones: 3d→+1, 7d→+2, 14d→+3, 30d→+5`,
    {parse_mode:'Markdown',...kb(p.referral_code, p.telegram_id)}
  );
});

bot.onText(/\/squad/, async (msg) => {
  const id=msg.from.id,p=await getOrCreatePlayer(id,msg.from.username,msg.from.first_name);
  if (p.squad_id) {
    const {rows:m}=await pool.query(`SELECT username,first_name,total_clicks,best_click_ms FROM players WHERE squad_id=$1`,[p.squad_id]);
    const {rows:si}=await pool.query('SELECT * FROM squads WHERE id=$1',[p.squad_id]);
    const sLink=si[0]?`https://t.me/xDegenDuck100Bot?start=squad_${si[0].invite_code}`:'';
    return bot.sendMessage(id,
`⚔️ *Your Squad* (${m.length}/${SQUAD_SIZE})
${m.map((x,i)=>`${i+1}. ${maskName(x.username,x.first_name)} — ${x.total_clicks} clicks`).join('\n')}
If any member wins → ${SQUAD_PCT}% each
🔗 \`${sLink}\``,
      {parse_mode:'Markdown',...kb(p.referral_code, p.telegram_id)}
    );
  }
  const squadCode=genCode(id,'squad');
  const {rows:ns}=await pool.query(`INSERT INTO squads(name,creator_id,invite_code) VALUES($1,$2,$3) RETURNING *`,
    [`${p.first_name||'Duck'}'s Squad`,id,squadCode]
  );
  await pool.query('UPDATE players SET squad_id=$1 WHERE telegram_id=$2',[ns[0].id,id]);
  const squadInvite=`https://t.me/xDegenDuck100Bot?start=squad_${squadCode}`;
  bot.sendMessage(id,
`⚔️ *Squad Created!* Need ${SQUAD_SIZE-1} more.
If any member wins 100 SOL → all get ${SQUAD_PCT}% each!
🔗 \`${squadInvite}\``,
    {parse_mode:'Markdown',reply_markup:{inline_keyboard:[[
      {text:'⚔️ Share Squad Invite',url:`https://t.me/share/url?url=${encodeURIComponent(squadInvite)}&text=${encodeURIComponent('⚔️ Join my $DEGEN squad! If any of us wins 100 SOL we all win! 🦆')}`}
    ],[{text:'🦆 Play Now',web_app:{url:APP_URL}}]]}}
  );
});

bot.onText(/\/invite/, async (msg) => {
  const p=await getOrCreatePlayer(msg.from.id,msg.from.username,msg.from.first_name);
  const inviteLink=`https://t.me/xDegenDuck100Bot?start=ref_${p.referral_code}`;
  const {rows:ir}=await pool.query('SELECT COUNT(*) AS cnt FROM invites WHERE inviter_id=$1 AND credited=1',[msg.from.id]);
  bot.sendMessage(msg.from.id,
`👥 *Invite Stats*
✅ Invites: *${ir[0].cnt}* | 🎯 Tries: *${p.tries_remaining}*
🏅 Top referrer wins *5 SOL on Oct 10!*
🔗 \`${inviteLink}\``,
    {parse_mode:'Markdown',...kb(p.referral_code, p.telegram_id)}
  );
});

bot.onText(/\/leaderboard/, async (msg) => {
  const {rows}=await pool.query(`SELECT username,first_name,best_click_ms FROM players WHERE best_click_ms IS NOT NULL ORDER BY best_click_ms ASC LIMIT 10`);
  if (!rows.length) return bot.sendMessage(msg.chat.id,'🏆 No entries yet!',baseKb);
  const medals=['🥇','🥈','🥉'];
  const list=rows.map((p,i)=>`${medals[i]||`${i+1}.`} ${maskName(p.username,p.first_name)} — *${fmtMs(p.best_click_ms)}*`).join('\n');
  bot.sendMessage(msg.chat.id,
`🏆 *Leaderboard — Closest to Zero*
${list}
🥇100 SOL 🥈10 SOL 🥉5 SOL 🏅5 SOL (top ref)`,
    {parse_mode:'Markdown',...baseKb}
  );
});

bot.onText(/\/referralboard/, async (msg) => {
  const {rows}=await pool.query(`SELECT username,first_name,referral_count FROM players WHERE referral_count>0 ORDER BY referral_count DESC LIMIT 10`);
  if (!rows.length) return bot.sendMessage(msg.chat.id,'👥 No referrals yet!',baseKb);
  const medals=['🥇','🥈','🥉'];
  const list=rows.map((p,i)=>`${medals[i]||`${i+1}.`} ${maskName(p.username,p.first_name)} — *${p.referral_count} invites*`).join('\n');
  bot.sendMessage(msg.chat.id,
`👥 *Referral Leaderboard*\n${list}\n🏅 Top referrer wins *5 SOL* on Oct 10!`,
    {parse_mode:'Markdown',...baseKb}
  );
});

bot.onText(/\/tries/, async (msg) => {
  const p=await getOrCreatePlayer(msg.from.id,msg.from.username,msg.from.first_name);
  bot.sendMessage(msg.from.id,
`⚡ *Earn tries:*
✅ Join @xDegenDuck → required
👥 Invite friends → +1 each (max ${MAX_BONUS})
🐦 Follow on X → +2 | 🔁 Retweet → +1
🔥 Streak: 3d+1 7d+2 14d+3 30d+5
📤 Daily share → +1/day
💎 Buy with ⭐ Stars → /buy`,
    {parse_mode:'Markdown',...kb(p.referral_code, p.telegram_id)}
  );
});

bot.onText(/\/rules/, (msg) => {
  bot.sendMessage(msg.chat.id,
`📋 *RULES*
🥇 Last click → 100 SOL
🥈 2nd last → 10 SOL  🥉 3rd last → 5 SOL
🏅 Top referrer Oct 10 → 5 SOL
Every click resets the shared 5min timer
Squad of ${SQUAD_SIZE} → ${SQUAD_PCT}% each if any member wins
Daily streak = bonus tries at milestones
Buy tries with ⭐ Stars (/buy)
Oct 10 2026 deadline | 1 account per person`,
    {parse_mode:'Markdown',...baseKb}
  );
});

bot.on('message', async (msg) => {
  if (!msg.text||msg.text.startsWith('/')||msg.successful_payment) return;
  const p=await getOrCreatePlayer(msg.from.id,msg.from.username,msg.from.first_name);
  bot.sendMessage(msg.from.id,'🦆 Use the buttons or try /mystats /squad /invite /buy /mycard',kb(p.referral_code, p.telegram_id));
});

bot.on('polling_error', err => console.error('polling_error:',err.message));

// ═══════════════════ ADMIN ═══════════════════
bot.onText(/\/admin$/, async (msg) => {
  if (msg.from.id!==ADMIN_ID) return;
  const [pl,cl,inv,st,sq,pur]=await Promise.all([
    pool.query('SELECT COUNT(*) AS cnt FROM players'),
    pool.query('SELECT COUNT(*) AS cnt FROM clicks'),
    pool.query('SELECT COUNT(*) AS cnt FROM invites WHERE credited=1'),
    getOrInitState(),
    pool.query('SELECT COUNT(*) AS cnt FROM squads'),
    pool.query('SELECT COALESCE(SUM(stars_paid),0) AS total FROM purchases'),
  ]);
  const topRef=(await pool.query(`SELECT username,first_name,referral_count FROM players WHERE referral_count>0 ORDER BY referral_count DESC LIMIT 3`)).rows.map((p,i)=>`${i+1}. ${maskName(p.username,p.first_name)} — ${p.referral_count}`).join('\n');
  bot.sendMessage(ADMIN_ID,
`🔐 *ADMIN v4*
Players:${pl.rows[0].cnt} Clicks:${cl.rows[0].cnt}
Invites:${inv.rows[0].cnt} Squads:${sq.rows[0].cnt}
Stars earned:${pur.rows[0].total}⭐
Timer:${fmtSec(Math.max(0,new Date(st.timer_ends_at)-Date.now()))}
Last:${st.last_clicker_name||'—'} Total:${st.total_clicks}

Top refs:
${topRef||'None'}

/adminplayers /admininvites /adminleaderboard /adminreferralboard /adminpurchases /adminpost /admingive`,
    {parse_mode:'Markdown'}
  );
});

bot.onText(/\/adminplayers/, async (msg) => {
  if (msg.from.id!==ADMIN_ID) return;
  const {rows}=await pool.query(`SELECT telegram_id,username,first_name,tries_remaining,total_clicks,referral_count,best_click_ms,streak_days,verified_human,tries_purchased FROM players ORDER BY created_at DESC LIMIT 20`);
  if (!rows.length) return bot.sendMessage(ADMIN_ID,'No players.');
  const list=rows.map((p,i)=>{const n=p.username?'@'+p.username:(p.first_name||'?');return `${i+1}. ${n}(${p.telegram_id}) T:${p.tries_remaining} C:${p.total_clicks} I:${p.referral_count} B:${fmtMs(p.best_click_ms)} S:${p.streak_days}d V:${p.verified_human?'✅':'❌'} P:${p.tries_purchased||0}`;}).join('\n\n');
  bot.sendMessage(ADMIN_ID,`👥 *Players*\n\n${list}`,{parse_mode:'Markdown'});
});

bot.onText(/\/adminpurchases/, async (msg) => {
  if (msg.from.id!==ADMIN_ID) return;
  const {rows}=await pool.query(`SELECT p.telegram_id,pl.username,pl.first_name,p.package_id,p.tries_added,p.stars_paid,p.created_at FROM purchases p LEFT JOIN players pl ON pl.telegram_id=p.telegram_id ORDER BY p.created_at DESC LIMIT 20`);
  if (!rows.length) return bot.sendMessage(ADMIN_ID,'No purchases yet.');
  const list=rows.map((r,i)=>`${i+1}. ${r.username?'@'+r.username:(r.first_name||r.telegram_id)} — ${r.tries_added} tries for ${r.stars_paid}⭐`).join('\n');
  const total=(await pool.query('SELECT COALESCE(SUM(stars_paid),0) AS t,COALESCE(SUM(tries_added),0) AS tr FROM purchases')).rows[0];
  bot.sendMessage(ADMIN_ID,`💎 *Purchases*\n\n${list}\n\nTotal: ${total.t}⭐ → ${total.tr} tries sold`,{parse_mode:'Markdown'});
});

bot.onText(/\/adminpost/, async (msg) => {
  if (msg.from.id!==ADMIN_ID) return;
  await postDailyLeaderboard();
  bot.sendMessage(ADMIN_ID,'✅ Posted to '+BROADCAST_CHAT);
});

bot.onText(/\/admingive (\d+) (\d+)/, async (msg,match) => {
  if (msg.from.id!==ADMIN_ID) return;
  await pool.query('UPDATE players SET tries_remaining=tries_remaining+$1 WHERE telegram_id=$2',[parseInt(match[2]),parseInt(match[1])]);
  bot.sendMessage(ADMIN_ID,`✅ Gave ${match[2]} tries to ${match[1]}`);
});

bot.onText(/\/adminleaderboard/, async (msg) => {
  if (msg.from.id!==ADMIN_ID) return;
  const {rows}=await pool.query(`SELECT telegram_id,username,first_name,best_click_ms,total_clicks FROM players WHERE best_click_ms IS NOT NULL ORDER BY best_click_ms ASC LIMIT 20`);
  if (!rows.length) return bot.sendMessage(ADMIN_ID,'No entries.');
  const list=rows.map((p,i)=>`${i+1}. ${p.username?'@'+p.username:(p.first_name||'?')}(${p.telegram_id}) — ${fmtMs(p.best_click_ms)} | ${p.total_clicks}c`).join('\n');
  bot.sendMessage(ADMIN_ID,`🏆 *LB*\n\n${list}`,{parse_mode:'Markdown'});
});

bot.onText(/\/adminreferralboard/, async (msg) => {
  if (msg.from.id!==ADMIN_ID) return;
  const {rows}=await pool.query(`SELECT telegram_id,username,first_name,referral_count FROM players WHERE referral_count>0 ORDER BY referral_count DESC LIMIT 20`);
  if (!rows.length) return bot.sendMessage(ADMIN_ID,'No referrals.');
  const list=rows.map((p,i)=>`${i+1}. ${p.username?'@'+p.username:(p.first_name||'?')}(${p.telegram_id}) — ${p.referral_count} invites`).join('\n');
  bot.sendMessage(ADMIN_ID,`👥 *Referral Board*\n\n${list}`,{parse_mode:'Markdown'});
});

bot.onText(/\/admininvites/, async (msg) => {
  if (msg.from.id!==ADMIN_ID) return;
  const {rows}=await pool.query(`SELECT i.*,p1.username AS iu,p1.first_name AS ifn,p2.username AS eu,p2.first_name AS efn FROM invites i LEFT JOIN players p1 ON p1.telegram_id=i.inviter_id LEFT JOIN players p2 ON p2.telegram_id=i.invitee_id ORDER BY i.created_at DESC LIMIT 20`);
  if (!rows.length) return bot.sendMessage(ADMIN_ID,'No invites.');
  const list=rows.map((r,i)=>`${i+1}. ${r.iu?'@'+r.iu:(r.ifn||r.inviter_id)} → ${r.eu?'@'+r.eu:(r.efn||r.invitee_id)} ${r.credited?'✅':'⏳'}`).join('\n');
  bot.sendMessage(ADMIN_ID,`🔗 *Invites*\n\n${list}`,{parse_mode:'Markdown'});
});

// ═══════════════════ DAILY POST ═══════════════════
async function postDailyLeaderboard() {
  try {
    const {rows:top}=await pool.query(`SELECT username,first_name,best_click_ms FROM players WHERE best_click_ms IS NOT NULL ORDER BY best_click_ms ASC LIMIT 10`);
    const {rows:refTop}=await pool.query(`SELECT username,first_name,referral_count FROM players WHERE referral_count>0 ORDER BY referral_count DESC LIMIT 1`);
    const state=await getOrInitState();
    const daysLeft=Math.max(0,Math.ceil((EVENT_END-Date.now())/86400000));
    const remaining=Math.max(0,new Date(state.timer_ends_at)-Date.now());
    const medals=['🥇','🥈','🥉'];
    const list=top.length?top.map((p,i)=>`${medals[i]||`${i+1}.`} ${maskName(p.username,p.first_name)} — *${fmtMs(p.best_click_ms)}*`).join('\n'):'No entries yet — be first!';
    const refLeader=refTop[0]?`${maskName(refTop[0].username,refTop[0].first_name)} — ${refTop[0].referral_count} invites`:'No referrals yet';
    await bot.sendMessage(BROADCAST_CHAT,
`🏆 *DAILY LEADERBOARD — $DEGEN 100 SOL BUTTON*

📊 Clicks:${state.total_clicks} | ${daysLeft} days left
⏱ Timer:${fmtSec(remaining)} | 👑 Last:${state.last_clicker_name||'—'}

🏆 *Top 10 — Closest to Zero*
${list}

👥 *Referral Leader:* ${refLeader}
🏅 Top referrer wins 5 SOL on Oct 10!

💰 🥇100 🥈10 🥉5 🏅5 SOL
💎 Buy tries with ⭐ Stars via @xDegenDuck100Bot

👇 t.me/xDegenDuck100Bot/button`,
      {parse_mode:'Markdown',...baseKb}
    );
    console.log('Daily post done');
  } catch(e){console.error('Daily post failed:',e.message);}
}

// ═══════════════════ HTTP API ═══════════════════
const app=express();
app.use(cors()); app.use(express.json());

app.get('/healthz',(_,res)=>res.json({status:'ok',ts:Date.now()}));

// ── Direct test click — for debugging ──
// Call: GET /api/test/click/TELEGRAM_ID
app.get('/api/test/click/:tid', async(req,res)=>{
  try {
    const id = Number(req.params.tid);
    if (!Number.isFinite(id)) return res.status(400).json({error:'invalid id'});
    const player = await getOrCreatePlayer(id,'testuser','TestUser');
    if (player.tries_remaining <= 0) return res.json({error:'no tries',triesRemaining:0});
    const now = new Date();
    await pool.query(
      `UPDATE players SET tries_remaining=tries_remaining-1,total_clicks=total_clicks+1,last_click_at=$1 WHERE telegram_id=$2`,
      [now, id]
    );
    await pool.query('INSERT INTO clicks(telegram_id,timer_ms) VALUES($1,$2)',[id, 150000]);
    const upd = (await pool.query('SELECT tries_remaining,total_clicks FROM players WHERE telegram_id=$1',[id])).rows[0];
    res.json({success:true, triesRemaining:upd.tries_remaining, totalClicks:upd.total_clicks});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ── LIVE TIMER SYNC — key endpoint ──
// Frontend polls this every 1s to get real server timer
app.get('/api/game/state', async(_,res)=>{
  try {
    const state=await getOrInitState(), now=Date.now();
    const remainingMs=Math.max(0,new Date(state.timer_ends_at)-now);
    const eventActive=now<EVENT_END.getTime();
    res.json({
      timerEndsAt:  state.timer_ends_at,
      remainingMs,
      serverTime:   now,
      eventEndsAt:  EVENT_END.toISOString(),
      eventActive,
      totalClicks:  state.total_clicks,
      lastClicker:  state.last_clicker_name
        ? {name:maskName(null,state.last_clicker_name)}
        : null,
    });
  } catch(e){res.status(500).json({error:e.message});}
});

// Leaderboard
app.get('/api/game/leaderboard', async(_,res)=>{
  try {
    const {rows}=await pool.query(`SELECT username,first_name,best_click_ms,total_clicks FROM players WHERE best_click_ms IS NOT NULL ORDER BY best_click_ms ASC LIMIT 10`);
    res.json({leaderboard:rows.map((p,i)=>({rank:i+1,displayName:maskName(p.username,p.first_name),bestClickMs:p.best_click_ms,bestClickFmt:fmtMs(p.best_click_ms),totalClicks:p.total_clicks}))});
  } catch(e){res.status(500).json({error:e.message});}
});

// Referral board
app.get('/api/game/referralboard', async(_,res)=>{
  try {
    const {rows}=await pool.query(`SELECT username,first_name,referral_count FROM players WHERE referral_count>0 ORDER BY referral_count DESC LIMIT 10`);
    res.json({board:rows.map((p,i)=>({rank:i+1,displayName:maskName(p.username,p.first_name),referralCount:p.referral_count}))});
  } catch(e){res.status(500).json({error:e.message});}
});

// Player info
app.get('/api/game/me/:tid', async(req,res)=>{
  try {
    const id=Number(req.params.tid); if(!Number.isFinite(id)) return res.status(400).json({error:'invalid'});
    const {rows}=await pool.query('SELECT * FROM players WHERE telegram_id=$1',[id]);
    if (!rows[0]) return res.json({exists:false});
    const p=rows[0],rank=await getLbRank(id);
    res.json({exists:true,displayName:maskName(p.username,p.first_name),triesRemaining:p.tries_remaining,triesEarned:p.tries_earned,triesPurchased:p.tries_purchased||0,totalClicks:p.total_clicks,bestClickMs:p.best_click_ms,bestClickFmt:fmtMs(p.best_click_ms),rank:rank||null,streakDays:p.streak_days,referralCount:p.referral_count,squadId:p.squad_id,verifiedHuman:p.verified_human===1,inviteLink:`https://t.me/xDegenDuck100Bot?start=ref_${p.referral_code}`,joinedGroup:p.joined_group===1,lastClickAt:p.last_click_at,lastSharedAt:p.last_shared_at});
  } catch(e){res.status(500).json({error:e.message});}
});

// ── CLICK — direct recording, no captcha ──
app.post('/api/game/click', async(req,res)=>{
  try {
    const {telegramId,username,firstName,timerMsLeft}=req.body||{};
    const id=Number(telegramId);
    if(!Number.isFinite(id)) return res.status(400).json({error:'telegramId required'});
    const now=new Date();
    if(now.getTime()>=EVENT_END.getTime()) return res.status(403).json({error:'Event ended'});

    const player=await getOrCreatePlayer(id,username||null,firstName||null);
    if(player.tries_remaining<=0) return res.status(403).json({error:'No tries remaining',triesRemaining:0});

    // Cast timerMsLeft safely — must be integer or null
    const clickMs = (timerMsLeft !== null && timerMsLeft !== undefined && !isNaN(Number(timerMsLeft)))
      ? Math.floor(Number(timerMsLeft))
      : null;

    const isNewBest = clickMs!==null && (player.best_click_ms===null || clickMs<player.best_click_ms);

    // Mark verified
    if(!player.verified_human) {
      await pool.query('UPDATE players SET verified_human=1 WHERE telegram_id=$1',[id]);
    }

    await pool.query(
      `UPDATE players SET
         tries_remaining = tries_remaining - 1,
         total_clicks    = total_clicks + 1,
         last_click_at   = $1,
         best_click_ms   = CASE
           WHEN best_click_ms IS NULL THEN $2::bigint
           WHEN $2::bigint IS NOT NULL AND $2::bigint < best_click_ms THEN $2::bigint
           ELSE best_click_ms
         END
       WHERE telegram_id = $3`,
      [now, clickMs, id]
    );

    await pool.query(
      'INSERT INTO clicks(telegram_id,timer_ms) VALUES($1,$2::bigint)',
      [id, clickMs]
    );

    const displayName = firstName||username||player.first_name||player.username||`Player ${id}`;
    const newTimerEnd = new Date(now.getTime()+TIMER_MS);

    await getOrInitState();
    await pool.query(
      `UPDATE game_state SET
         timer_ends_at      = $1,
         third_clicker_id   = second_clicker_id,
         third_clicker_name = second_clicker_name,
         second_clicker_id  = last_clicker_id,
         second_clicker_name= last_clicker_name,
         last_clicker_id    = $2,
         last_clicker_name  = $3,
         total_clicks       = total_clicks + 1,
         updated_at         = $4
       WHERE id=1`,
      [newTimerEnd, id, displayName, now]
    );

    const {streakDays,bonusEarned,bonus,milestone}=await handleStreak(id);
    const updated=(await pool.query(
      'SELECT tries_remaining,total_clicks,best_click_ms,streak_days FROM players WHERE telegram_id=$1',[id]
    )).rows[0];

    if(isNewBest&&clickMs!==null){
      setImmediate(()=>postTop10Update(id,clickMs,bot));
      setImmediate(()=>sendMissedTop10(id,clickMs,bot));
    }
    if(bonusEarned){
      try{await bot.sendMessage(id,`🔥 *${milestone}-day streak!* +${bonus} tries! ${streakEmoji(milestone)}`,{parse_mode:'Markdown'});}catch(e){}
    }

    res.json({
      success:true,
      triesRemaining: updated.tries_remaining,
      totalClicks:    updated.total_clicks,
      bestClickMs:    updated.best_click_ms,
      bestClickFmt:   fmtMs(updated.best_click_ms),
      streakDays:     updated.streak_days,
      timerEndsAt:    newTimerEnd,
      remainingMs:    TIMER_MS
    });
  } catch(e){
    console.error('Click error:', e.message);
    res.status(500).json({error:e.message});
  }
});

app.post('/api/game/share', async(req,res)=>{
  try {
    const {telegramId}=req.body||{},id=Number(telegramId);
    if(!Number.isFinite(id)) return res.status(400).json({error:'telegramId required'});
    const player=await getOrCreatePlayer(id);
    const now=new Date(),last=player.last_shared_at?new Date(player.last_shared_at).getTime():0;
    if(now.getTime()-last<86400000) return res.status(429).json({error:'Already shared today',nextAvailableAt:new Date(last+86400000)});
    if(player.tries_earned>=MAX_BONUS) return res.status(403).json({error:'Max bonus tries earned'});
    const upd=await pool.query(`UPDATE players SET tries_remaining=tries_remaining+1,tries_earned=tries_earned+1,last_shared_at=$1 WHERE telegram_id=$2 RETURNING tries_remaining,tries_earned`,[now,id]);
    res.json({success:true,...upd.rows[0]});
  } catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/game/joined-group', async(req,res)=>{
  try {
    const {telegramId}=req.body||{},id=Number(telegramId);
    if(!Number.isFinite(id)) return res.status(400).json({error:'telegramId required'});
    const player=await getOrCreatePlayer(id);
    if(player.joined_group===1) return res.json({success:true,alreadyClaimed:true,triesRemaining:player.tries_remaining});
    const upd=await pool.query(`UPDATE players SET joined_group=1,tries_remaining=tries_remaining+2,tries_earned=tries_earned+2 WHERE telegram_id=$1 RETURNING tries_remaining,tries_earned`,[id]);
    res.json({success:true,...upd.rows[0]});
  } catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/game/sharecard', async(req,res)=>{
  try {
    const {telegramId}=req.body||{},id=Number(telegramId);
    if(!Number.isFinite(id)) return res.status(400).json({error:'telegramId required'});
    await generateClickCard(id,bot);
    res.json({success:true});
  } catch(e){res.status(500).json({error:e.message});}
});

app.get('/api/game/invite/:tid', async(req,res)=>{
  try {
    const id=Number(req.params.tid);
    if(!Number.isFinite(id)) return res.status(400).json({error:'invalid'});
    const {rows}=await pool.query('SELECT referral_code,referral_count FROM players WHERE telegram_id=$1',[id]);
    if(!rows[0]) return res.json({exists:false});
    res.json({inviteLink:`https://t.me/xDegenDuck100Bot?start=ref_${rows[0].referral_code}`,referralCount:rows[0].referral_count});
  } catch(e){res.status(500).json({error:e.message});}
});

// Admin API
app.get('/api/admin/overview', async(req,res)=>{
  if(req.headers['x-admin-id']!==String(ADMIN_ID)) return res.status(403).json({error:'Forbidden'});
  try {
    const [pl,cl,inv,st,sq,pur]=await Promise.all([
      pool.query('SELECT COUNT(*) AS cnt FROM players'),
      pool.query('SELECT COUNT(*) AS cnt FROM clicks'),
      pool.query('SELECT COUNT(*) AS cnt FROM invites WHERE credited=1'),
      getOrInitState(),
      pool.query('SELECT COUNT(*) AS cnt FROM squads'),
      pool.query('SELECT COALESCE(SUM(stars_paid),0) AS total FROM purchases'),
    ]);
    const topPlayers=(await pool.query(`SELECT telegram_id,username,first_name,total_clicks,tries_remaining,referral_count,best_click_ms,streak_days,verified_human,tries_purchased FROM players ORDER BY total_clicks DESC LIMIT 20`)).rows;
    res.json({totalPlayers:parseInt(pl.rows[0].cnt),totalClicks:parseInt(cl.rows[0].cnt),totalInvites:parseInt(inv.rows[0].cnt),totalSquads:parseInt(sq.rows[0].cnt),totalStarsEarned:parseInt(pur.rows[0].total),timerEndsAt:st.timer_ends_at,remainingMs:Math.max(0,new Date(st.timer_ends_at)-Date.now()),lastClicker:st.last_clicker_name,globalClicks:st.total_clicks,topPlayers});
  } catch(e){res.status(500).json({error:e.message});}
});

// ═══════════════════ AUTO BOT CLICKS ═══════════════════
// Floor: 3:42 (222,000ms) — timer NEVER goes below this
// Bots click very frequently to keep timer alive
// Random variance makes it look organic

const FLOOR_MS = 222000; // 3:42 absolute floor — never go below this

function randMs(min, max) { return min + Math.random() * (max - min); }

async function doBotClick() {
  try {
    const now    = Date.now();
    const newEnd = new Date(now + TIMER_MS);
    await pool.query(
      `UPDATE game_state SET timer_ends_at=$1, total_clicks=total_clicks+1, updated_at=$2 WHERE id=1`,
      [newEnd, new Date(now)]
    );
  } catch(e) { console.error('Bot click failed:', e.message); }
}

async function autoBotTick() {
  try {
    const state     = await getOrInitState();
    const now       = Date.now();
    const remaining = Math.max(0, new Date(state.timer_ends_at) - now);

    if (now >= EVENT_END.getTime()) return;

    // ALWAYS reset if at or below floor
    if (remaining <= FLOOR_MS) {
      await doBotClick();
      console.log(`FLOOR HIT: reset from ${Math.floor(remaining/1000)}s`);
      return;
    }

    // Random click logic based on timer level
    // Higher chance to click as timer gets lower
    const chanceToClick =
      remaining < 240000 ? 0.92  // below 4:00 — almost always click
    : remaining < 270000 ? 0.75  // below 4:30 — very likely
    : remaining < 285000 ? 0.50  // below 4:45 — coin flip
    : 0.25;                       // above 4:45 — let it run down naturally

    if (Math.random() > chanceToClick) return;

    // Random burst size
    const burst =
      Math.random() < 0.45 ? 1
    : Math.random() < 0.75 ? 2
    : Math.random() < 0.90 ? 3 : 4;

    for (let i = 0; i < burst; i++) {
      await new Promise(r => setTimeout(r, i === 0 ? 0 : Math.floor(randMs(150, 1200))));
      await doBotClick();
    }

    console.log(`Bot burst x${burst} at ${Math.floor(remaining/1000)}s remaining`);
  } catch(e) {
    console.error('Bot tick error:', e.message);
  }
}

// Second independent bot that fires on its own schedule
async function soloBot() {
  try {
    const state     = await getOrInitState();
    const now       = Date.now();
    const remaining = Math.max(0, new Date(state.timer_ends_at) - now);
    if (now >= EVENT_END.getTime()) return;
    if (remaining > 270000) return; // only fires below 4:30
    if (Math.random() > 0.60) return; // 60% chance
    await doBotClick();
    console.log(`Solo bot at ${Math.floor(remaining/1000)}s`);
  } catch(e) {}
}

// ═══════════════════ CRON + STARTUP ═══════════════════
const dailyTask = cron.schedule('0 12 * * *', postDailyLeaderboard, {timezone:'UTC'});

// Main bot tick every 3 seconds
const autoResetInterval = setInterval(autoBotTick, 3000);
// Solo bot every 5 seconds independently  
const soloInterval = setInterval(soloBot, 5000);

(async()=>{
  try {
    await initDb();
    const me=await bot.getMe();
    console.log('🦆 Bot running as @'+me.username);
    dailyTask.start();
    console.log('Daily post: 12:00 UTC →',BROADCAST_CHAT);
    app.listen(PORT,()=>console.log('HTTP server on port',PORT));
    const stop = sig => {
      dailyTask.stop();
      clearInterval(autoResetInterval);
      clearInterval(soloInterval);
      bot.stopPolling().finally(() => pool.end()).finally(() => process.exit(0));
    };
    process.once('SIGINT',()=>stop('SIGINT'));
    process.once('SIGTERM',()=>stop('SIGTERM'));
  } catch(err){console.error('Startup failed:',err);process.exit(1);}
})();
