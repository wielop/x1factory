'use strict';

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
    hide('loading');
    show('gate-outside');
    return;
  }

  tg.ready();
  tg.expand();

  myTelegramId = String(tg.initDataUnsafe?.user?.id ?? '');

  // Apply Telegram theme colors if available
  if (tg.themeParams?.bg_color) {
    document.documentElement.style.setProperty('--bg', tg.themeParams.bg_color);
  }

  try {
    const data = await get('/api/panel/me');
    if (!data.ok) throw new Error(data.error || 'Failed to load.');

    S.user   = data.user;
    S.wallet = data.wallet;
    S.season = data.season;
    S.stats  = data.stats;
    S.recentEvents = data.recentEvents || [];

    renderHeader();
    renderHomeTab();
    renderSeasonTab();

    hide('loading');
    show('app');
  } catch (err) {
    q('#error-message').textContent = err.message || 'Could not load your profile.';
    hide('loading');
    show('gate-error');
  }
}

function retryInit() {
  hide('gate-error');
  show('loading');
  S.lbLoaded = false;
  init();
}

/* ── API ───────────────────────────────────────────────── */
function initData() {
  return window.Telegram?.WebApp?.initData || '';
}

async function get(path) {
  const res = await fetch(path, {
    headers: { 'x-telegram-init-data': initData() }
  });
  return res.json();
}

/* ── Tab switching ─────────────────────────────────────── */
function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
  const panel = q('#tab-' + tab);
  if (panel) panel.classList.remove('hidden');

  if (tab === 'leaderboard' && !S.lbLoaded) loadLeaderboard();
}

/* ── Header ────────────────────────────────────────────── */
function renderHeader() {
  if (S.season) {
    const badge = q('#season-badge');
    badge.textContent = S.season.name;
    badge.classList.remove('hidden');
  }
}

/* ── Home / Profile tab ────────────────────────────────── */
function renderHomeTab() {
  const u = S.user, s = S.stats, w = S.wallet;

  // Avatar + name
  const letter = (u?.firstName?.[0] || u?.username?.[0] || '?').toUpperCase();
  q('#profile-avatar').textContent = letter;
  q('#profile-name').textContent = u?.username ? '@' + u.username : (u?.firstName || 'Unknown');
  q('#profile-season-label').textContent = S.season ? S.season.name : 'No active season';

  // Stats
  q('#stat-points').textContent = s ? fmtNum(s.totalPoints) : '0';
  q('#stat-rank').textContent   = s?.rank ? '#' + s.rank : '—';
  q('#stat-events').textContent = s ? String(s.eventsCount) : '0';
  q('#stat-last').textContent   = s?.lastEventAt ? timeAgo(s.lastEventAt) + ' ago' : '—';

  // Wallet
  if (w) {
    const el = q('#wallet-address');
    el.textContent = w.address;
    el.classList.add('cyan');
    q('#wallet-hint').textContent = 'Registered season wallet';
  } else {
    q('#wallet-hint').textContent = 'Use /register in the bot to link a wallet';
  }

  renderFeed();
}

function renderFeed() {
  const feed = q('#activity-feed');
  const evs  = S.recentEvents;

  if (S.stats) {
    q('#events-total').textContent = S.stats.eventsCount + ' total';
  }

  if (!evs.length) {
    feed.innerHTML = '<div class="empty-state">No activity yet. Earn points on X1Factory.</div>';
    return;
  }

  feed.innerHTML = evs.map(ev => `
    <div class="activity-item">
      <span class="a-dot ${catClass(ev.category)}"></span>
      <span class="a-reason">${esc(ev.reason)}</span>
      <span class="a-pts">+${ev.points}</span>
      <span class="a-time">${timeAgo(ev.createdAt)}</span>
    </div>
  `).join('');
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

  const fmtDate = iso => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  q('#season-dates').innerHTML =
    `<span>${fmtDate(s.startsAt)}</span><span>${fmtDate(s.endsAt)}</span>`;

  if (S.countdownTimer) clearInterval(S.countdownTimer);
  tickCountdown(new Date(s.endsAt));
  S.countdownTimer = setInterval(() => tickCountdown(new Date(s.endsAt)), 1000);
}

function tickCountdown(endsAt) {
  const ms = endsAt.getTime() - Date.now();
  const el = q('#season-countdown');

  if (ms <= 0) {
    el.textContent = 'Season ended';
    clearInterval(S.countdownTimer);
    return;
  }

  const d  = Math.floor(ms / 86400000);
  const h  = Math.floor((ms % 86400000) / 3600000);
  const m  = Math.floor((ms % 3600000)  / 60000);
  const sc = Math.floor((ms % 60000)    / 1000);

  el.textContent = d > 0
    ? `${d}d ${pad(h)}h ${pad(m)}m`
    : `${pad(h)}:${pad(m)}:${pad(sc)}`;
}

/* ── Leaderboard tab ───────────────────────────────────── */
async function loadLeaderboard() {
  const list = q('#lb-list');
  list.innerHTML = '<div class="empty-state">Loading rankings...</div>';

  try {
    const data = await get('/api/panel/leaderboard');
    if (!data.ok) throw new Error(data.error || 'Failed to load rankings.');

    S.leaderboard = data.rows || [];
    S.myRank      = data.myRank ?? null;
    S.lbLoaded    = true;

    q('#lb-season-name').textContent = data.season?.name || 'Rankings';

    if (S.myRank) {
      q('#lb-my-pos').textContent = 'Your rank: #' + S.myRank;
    }

    renderLeaderboard();
  } catch (err) {
    list.innerHTML = `<div class="empty-state">${esc(err.message)}</div>`;
  }
}

function renderLeaderboard() {
  const list = q('#lb-list');
  const rows = S.leaderboard || [];

  if (!rows.length) {
    list.innerHTML = '<div class="empty-state">No rankings yet.</div>';
    return;
  }

  const inTop = rows.some(r => r.telegramId === myTelegramId);
  const needAppend = !inTop && S.myRank && S.stats;

  list.innerHTML = rows.map(row => {
    const isMe = row.telegramId === myTelegramId;
    const rankClass = row.rank === 1 ? 'g1' : row.rank === 2 ? 'g2' : row.rank === 3 ? 'g3' : '';
    const name = row.username
      ? '@' + row.username
      : (row.firstName || 'user_' + row.telegramId.slice(-4));

    return `
      <div class="lb-row${isMe ? ' is-me' : ''}">
        <span class="lb-rank ${rankClass}">${row.rank}</span>
        <span class="lb-name${isMe ? ' is-me' : ''}">${esc(name)}${isMe ? ' ·&nbsp;you' : ''}</span>
        <span class="lb-pts${isMe ? ' is-me' : ''}">${fmtNum(row.points)}</span>
      </div>
    `;
  }).join('');

  if (needAppend) {
    const myName = S.user?.username
      ? '@' + S.user.username
      : (S.user?.firstName || 'You');

    list.innerHTML += `
      <div class="lb-sep"></div>
      <div class="lb-row is-me">
        <span class="lb-rank">${S.myRank}</span>
        <span class="lb-name is-me">${esc(myName)} · you</span>
        <span class="lb-pts is-me">${fmtNum(S.stats.totalPoints)}</span>
      </div>
    `;
  }
}

/* ── Helpers ───────────────────────────────────────────── */
function q(sel) { return document.querySelector(sel); }
function show(id) { const el = document.getElementById(id); if (el) el.classList.remove('hidden'); }
function hide(id) { const el = document.getElementById(id); if (el) el.classList.add('hidden'); }

function fmtNum(n) { return Number(n).toLocaleString('en-US'); }
function pad(n)    { return String(n).padStart(2, '0'); }

function timeAgo(dateStr) {
  const s = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (s < 60)   return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
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
  if (cat.includes('purchase'))     return 'purchase';
  if (cat.includes('renewal'))      return 'renewal';
  if (cat.includes('checkin') || cat.includes('check_in')) return 'checkin';
  if (cat.includes('daily_active') || cat.includes('daily')) return 'daily';
  if (cat.includes('claim'))        return 'claim';
  if (cat.includes('stake'))        return 'stake';
  return 'other';
}

/* ── Start ─────────────────────────────────────────────── */
window.addEventListener('DOMContentLoaded', init);
