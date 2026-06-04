'use strict';

/* ── Rank system ───────────────────────────────────────── */
const RANKS = [
  { min: 4000, key: 'director',   label: 'DIRECTOR',   icon: '👑' },
  { min: 1500, key: 'engineer',   label: 'ENGINEER',   icon: '🔧' },
  { min: 500,  key: 'operator',   label: 'OPERATOR',   icon: '⚙️'  },
  { min: 100,  key: 'miner',      label: 'MINER',      icon: '⛏️'  },
  { min: 1,    key: 'apprentice', label: 'APPRENTICE', icon: '🔩'  },
  { min: 0,    key: 'offline',    label: 'OFFLINE',    icon: '○'  },
];

function getRank(points) {
  return RANKS.find(r => points >= r.min) || RANKS[RANKS.length - 1];
}

function getNextRank(points) {
  const idx = RANKS.findIndex(r => points >= r.min);
  return idx > 0 ? RANKS[idx - 1] : null;
}

/* ── Category icons ────────────────────────────────────── */
const CAT_ICON = {
  purchase: '🏭', renewal: '🔄', checkin: '📅',
  daily: '⚡', claim: '💎', stake: '🔒',
  registration: '🔑', other: '•'
};

/* ── State ─────────────────────────────────────────────── */
const S = {
  user: null, wallet: null, season: null, stats: null,
  recentEvents: [], leaderboard: null, myRank: null,
  lbLoaded: false, countdownTimer: null
};

let myTelegramId = null;

/* ── Bootstrap ─────────────────────────────────────────── */
async function init() {
  const tg = window.Telegram?.WebApp;

  if (!tg || !tg.initData) {
    hide('loading'); show('gate-outside');
    return;
  }

  tg.ready();
  tg.expand();
  tg.setBackgroundColor('#030d12');
  tg.setHeaderColor('#030d12');

  myTelegramId = String(tg.initDataUnsafe?.user?.id ?? '');

  try {
    const data = await get('/api/panel/me');
    if (!data.ok) throw new Error(data.error || 'Failed to load.');

    S.user         = data.user;
    S.wallet       = data.wallet;
    S.season       = data.season;
    S.stats        = data.stats;
    S.recentEvents = data.recentEvents || [];

    renderHeader();
    renderOperatorTab();
    renderSeasonTab();

    hide('loading');
    show('app');
  } catch (err) {
    q('#error-message').textContent = err.message || 'Could not load operator data.';
    hide('loading');
    show('gate-error');
  }
}

function retryInit() {
  hide('gate-error'); show('loading');
  S.lbLoaded = false;
  init();
}

/* ── API ───────────────────────────────────────────────── */
function initData() { return window.Telegram?.WebApp?.initData || ''; }

async function get(path) {
  const res = await fetch(path, { headers: { 'x-telegram-init-data': initData() } });
  return res.json();
}

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'x-telegram-init-data': initData(), 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}

/* ── Tab switching ─────────────────────────────────────── */
function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
  const panel = q('#tab-' + tab);
  if (panel) panel.classList.remove('hidden');
  if (tab === 'leaderboard' && !S.lbLoaded) loadLeaderboard();
}

/* ── Header ────────────────────────────────────────────── */
function renderHeader() {
  if (S.season) {
    const b = q('#season-badge');
    b.textContent = S.season.name;
    b.classList.remove('hidden');
  }
}

/* ── Operator tab ──────────────────────────────────────── */
function renderOperatorTab() {
  const u = S.user, s = S.stats, w = S.wallet;
  const pts = s?.totalPoints ?? 0;
  const rank = getRank(pts);
  const nextRank = getNextRank(pts);

  // Profile card
  const card = q('#profile-card');
  card.className = `profile-card card rank-${rank.key}`;
  const letter = (u?.firstName?.[0] || u?.username?.[0] || '?').toUpperCase();
  q('#profile-avatar').textContent = letter;
  q('#profile-name').textContent = u?.username ? '@' + u.username : (u?.firstName || 'Operator');
  q('#profile-rank-title').textContent = `${rank.icon} ${rank.label}`;
  q('#profile-season-label').textContent = S.season ? ' · ' + S.season.name : '';

  // Points hero
  q('#points-value').textContent = fmtNum(pts);

  if (s?.rank) {
    q('#points-meta').innerHTML = `Rank <strong>#${s.rank}</strong> this season`;
  } else {
    q('#points-meta').textContent = S.season ? 'No rank yet — earn your first points' : 'No active season';
  }

  // Goal bar
  if (nextRank) {
    const ptsToNext = nextRank.min - pts;
    const rangeSize = nextRank.min - rank.min;
    const progress = rangeSize > 0 ? Math.min(100, ((pts - rank.min) / rangeSize) * 100) : 100;
    q('#goal-label').textContent = `${fmtNum(ptsToNext)} pts to ${nextRank.label}`;
    q('#goal-pct').textContent = Math.round(progress) + '%';
    q('#goal-fill').style.width = progress.toFixed(1) + '%';
    show('goal-bar-wrap');
  } else {
    hide('goal-bar-wrap');
  }

  // Stats
  q('#stat-rank').textContent = s?.rank ? '#' + s.rank : '—';
  if (s?.rank && S.leaderboard) {
    const total = S.leaderboard.length;
    q('#stat-rank-sub').textContent = total ? `of ${total}` : '';
  } else {
    q('#stat-rank-sub').textContent = '';
  }
  q('#stat-events').textContent = String(s?.eventsCount ?? 0);
  q('#stat-streak').textContent = '—';

  // Wallet
  if (w) {
    q('#wallet-address').textContent = w.address;
    show('wallet-card');
    hide('register-card');
  } else {
    hide('wallet-card');
    show('register-card');
  }

  renderFeed();
}

/* ── Activity feed ─────────────────────────────────────── */
function renderFeed() {
  const feed = q('#activity-feed');
  const evs  = S.recentEvents;

  if (S.stats) q('#events-total').textContent = S.stats.eventsCount + ' total';

  if (!evs.length) {
    feed.innerHTML = '<div class="empty-state">No activity yet.<br>Start earning on X1Factory.</div>';
    return;
  }

  feed.innerHTML = evs.map(ev => {
    const cat  = catClass(ev.category);
    const icon = CAT_ICON[cat] || CAT_ICON.other;
    return `
      <div class="activity-item">
        <span class="a-icon">${icon}</span>
        <span class="a-reason">${esc(ev.reason)}</span>
        <span class="a-pts">+${ev.points}</span>
        <span class="a-time">${timeAgo(ev.createdAt)}</span>
      </div>`;
  }).join('');
}

/* ── Season tab ────────────────────────────────────────── */
function renderSeasonTab() {
  const s = S.season;
  if (!s) {
    q('#season-card').innerHTML = '<div class="empty-state">No active season at the moment.</div>';
    return;
  }
  q('#season-name-big').textContent = s.name;
  const pill = q('#season-status-pill');
  pill.textContent = s.status;
  pill.className   = 'status-pill ' + s.status.toLowerCase();
  const pct = Math.min(100, Math.max(0, (s.day / s.totalDays) * 100));
  q('#season-day-text').textContent = `Day ${s.day} / ${s.totalDays}`;
  q('#season-progress').style.width = pct.toFixed(1) + '%';
  const fmt = iso => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  q('#season-dates').innerHTML = `<span>${fmt(s.startsAt)}</span><span>${fmt(s.endsAt)}</span>`;
  if (S.countdownTimer) clearInterval(S.countdownTimer);
  tickCountdown(new Date(s.endsAt));
  S.countdownTimer = setInterval(() => tickCountdown(new Date(s.endsAt)), 1000);
}

function tickCountdown(endsAt) {
  const ms = endsAt.getTime() - Date.now();
  const el = q('#season-countdown');
  if (ms <= 0) { el.textContent = 'Season ended'; clearInterval(S.countdownTimer); return; }
  const d  = Math.floor(ms / 86400000);
  const h  = Math.floor((ms % 86400000) / 3600000);
  const m  = Math.floor((ms % 3600000)  / 60000);
  const sc = Math.floor((ms % 60000)    / 1000);
  el.textContent = d > 0 ? `${d}d ${pad(h)}h ${pad(m)}m` : `${pad(h)}:${pad(m)}:${pad(sc)}`;
}

/* ── Leaderboard ───────────────────────────────────────── */
async function loadLeaderboard() {
  const list = q('#lb-list');
  list.innerHTML = '<div class="empty-state">Loading rankings...</div>';
  try {
    const data = await get('/api/panel/leaderboard');
    if (!data.ok) throw new Error(data.error || 'Failed to load.');
    S.leaderboard = data.rows || [];
    S.myRank      = data.myRank ?? null;
    S.lbLoaded    = true;
    q('#lb-season-name').textContent = data.season?.name || 'Rankings';
    if (S.myRank) q('#lb-my-pos').textContent = 'Your rank: #' + S.myRank;
    renderLeaderboard();
    // Update stat rank sub after loading
    if (S.stats?.rank) q('#stat-rank-sub').textContent = `of ${S.leaderboard.length}`;
  } catch (err) {
    list.innerHTML = `<div class="empty-state">${esc(err.message)}</div>`;
  }
}

function renderLeaderboard() {
  const list = q('#lb-list');
  const rows = S.leaderboard || [];
  if (!rows.length) { list.innerHTML = '<div class="empty-state">No rankings yet.</div>'; return; }

  const inTop    = rows.some(r => r.telegramId === myTelegramId);
  const needSep  = !inTop && S.myRank && S.stats;

  list.innerHTML = rows.map(row => {
    const isMe  = row.telegramId === myTelegramId;
    const rankClass = row.rank === 1 ? 'g1' : row.rank === 2 ? 'g2' : row.rank === 3 ? 'g3' : '';
    const rank  = getRank(row.points);
    const name  = row.username ? '@' + row.username : (row.firstName || 'user_' + row.telegramId.slice(-4));
    return `
      <div class="lb-row${isMe ? ' is-me' : ''}">
        <span class="lb-rank ${rankClass}">${row.rank}</span>
        <span class="lb-name${isMe ? ' is-me' : ''}">${esc(name)}</span>
        <span class="lb-pts${isMe ? ' is-me' : ''}">${fmtNum(row.points)}</span>
      </div>`;
  }).join('');

  if (needSep) {
    const myName = S.user?.username ? '@' + S.user.username : (S.user?.firstName || 'You');
    list.innerHTML += `
      <div class="lb-sep"></div>
      <div class="lb-row is-me">
        <span class="lb-rank">${S.myRank}</span>
        <span class="lb-name is-me">${esc(myName)} · you</span>
        <span class="lb-pts is-me">${fmtNum(S.stats.totalPoints)}</span>
      </div>`;
  }
}

/* ── Wallet registration ───────────────────────────────── */
async function submitWallet() {
  const input   = q('#wallet-input');
  const btn     = q('#register-btn');
  const address = input.value.trim();

  q('#register-error').classList.add('hidden');

  if (!address) { showRegisterError('Paste your Solana wallet address.'); return; }
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
    showRegisterError('Invalid Solana address format. Check and try again.');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Registering...';

  try {
    const data = await post('/api/panel/register', { address });
    if (!data.ok) {
      showRegisterError(data.error || 'Registration failed.');
      btn.disabled = false;
      btn.textContent = 'Register Wallet';
      return;
    }

    btn.textContent = '✓ Registered!';
    setTimeout(async () => {
      const refresh = await get('/api/panel/me');
      if (refresh.ok) {
        S.wallet = refresh.wallet;
        S.stats  = refresh.stats;
        S.recentEvents = refresh.recentEvents || [];
        renderOperatorTab();
      }
    }, 800);
  } catch {
    showRegisterError('Network error. Try again.');
    btn.disabled = false;
    btn.textContent = 'Register Wallet';
  }
}

function showRegisterError(msg) {
  const el = q('#register-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}

/* ── Helpers ───────────────────────────────────────────── */
function q(sel)   { return document.querySelector(sel); }
function show(id) { const e = document.getElementById(id); if (e) e.classList.remove('hidden'); }
function hide(id) { const e = document.getElementById(id); if (e) e.classList.add('hidden'); }
function fmtNum(n) { return Number(n).toLocaleString('en-US'); }
function pad(n)    { return String(n).padStart(2, '0'); }

function timeAgo(dateStr) {
  const s = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (s < 60)    return s + 's';
  if (s < 3600)  return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function catClass(cat) {
  if (!cat) return 'other';
  if (cat.includes('purchase'))  return 'purchase';
  if (cat.includes('renewal'))   return 'renewal';
  if (cat.includes('checkin') || cat.includes('check_in')) return 'checkin';
  if (cat.includes('daily'))     return 'daily';
  if (cat.includes('claim'))     return 'claim';
  if (cat.includes('stake'))     return 'stake';
  if (cat.includes('registr'))   return 'registration';
  return 'other';
}

window.addEventListener('DOMContentLoaded', init);
