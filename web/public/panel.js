'use strict';

/* ── Rank system ───────────────────────────────────────── */
const RANKS = [
  { min:4000, key:'director',    label:'DIRECTOR',    icon:'👑' },
  { min:1500, key:'engineer',    label:'ENGINEER',    icon:'🔧' },
  { min:500,  key:'operator',    label:'OPERATOR',    icon:'⚙️'  },
  { min:100,  key:'miner',       label:'MINER',       icon:'⛏️'  },
  { min:1,    key:'apprentice',  label:'APPRENTICE',  icon:'🔩'  },
  { min:0,    key:'offline',     label:'OFFLINE',     icon:'○'  },
];
function getRank(pts)     { return RANKS.find(r => pts >= r.min) || RANKS[RANKS.length-1]; }
function getNextRank(pts) { const i = RANKS.findIndex(r => pts >= r.min); return i > 0 ? RANKS[i-1] : null; }

/* ── Category icons ────────────────────────────────────── */
const ICONS = {
  purchase:'🏭', renewal:'🔄', checkin:'📅',
  daily:'⚡', claim:'💎', stake:'🔒', registration:'🔑', other:'•'
};

/* ── State ─────────────────────────────────────────────── */
const S = {
  user:null, wallet:null, season:null, stats:null, allTime:null,
  seasonStamps:[], badges:[], nearbyRanks:null,
  dailyMissions:[], prizePool:null, syncedAt:null,
  recentEvents:[], leaderboard:null, myRank:null,
  lbLoaded:false, countdownTimer:null, prevEventCount:0
};
let myTelegramId = null;

/* ── Bootstrap ─────────────────────────────────────────── */
async function init() {
  const tg = window.Telegram?.WebApp;
  if (!tg?.initData) { hide('loading'); show('gate-outside'); return; }

  tg.ready();
  tg.expand();
  tg.setBackgroundColor('#030d12');
  tg.setHeaderColor('#030d12');
  myTelegramId = String(tg.initDataUnsafe?.user?.id ?? '');

  try {
    const data = await get('/api/panel/me');
    if (!data.ok) throw new Error(data.error || 'Failed to load.');

    S.user          = data.user;
    S.wallet        = data.wallet;
    S.season        = data.season;
    S.stats         = data.stats;
    S.allTime       = data.allTime;
    S.seasonStamps  = data.seasonStamps || [];
    S.badges        = data.badges || [];
    S.nearbyRanks   = data.nearbyRanks || null;
    S.dailyMissions = data.dailyMissions || [];
    S.prizePool     = data.prizePool || null;
    S.syncedAt      = data.syncedAt || null;
    S.prevEventCount = S.recentEvents.length;
    S.recentEvents  = data.recentEvents || [];

    renderHeader();
    renderPassport();
    renderSeasonTab();
    hide('loading');
    show('app');
  } catch(err) {
    q('#error-message').textContent = err.message || 'Could not load.';
    hide('loading'); show('gate-error');
  }
}

function retryInit() { hide('gate-error'); show('loading'); S.lbLoaded=false; init(); }

/* ── API ───────────────────────────────────────────────── */
function initData() { return window.Telegram?.WebApp?.initData || ''; }
async function get(path) {
  const r = await fetch(path, { headers:{'x-telegram-init-data':initData()} });
  return r.json();
}
async function post(path, body) {
  const r = await fetch(path, {
    method:'POST',
    headers:{'x-telegram-init-data':initData(),'content-type':'application/json'},
    body:JSON.stringify(body)
  });
  return r.json();
}

/* ── Tabs ──────────────────────────────────────────────── */
function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab===tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
  const panel = q('#tab-'+tab); if (panel) panel.classList.remove('hidden');
  if (tab==='leaderboard' && !S.lbLoaded) loadLeaderboard();
}

/* ── Header ────────────────────────────────────────────── */
function renderHeader() {
  if (S.season) { const b=q('#season-badge'); b.textContent=S.season.name; b.classList.remove('hidden'); }
}

/* ── Passport ──────────────────────────────────────────── */
function renderPassport() {
  const pts   = S.stats?.totalPoints ?? 0;
  const rank  = getRank(pts);
  const next  = getNextRank(pts);
  const u     = S.user;
  const at    = S.allTime;

  // Passport card
  const card = q('#passport-card');
  card.className = `passport-card rank-${rank.key}`;
  const letter = (u?.firstName?.[0] || u?.username?.[0] || '?').toUpperCase();
  q('#passport-avatar').textContent = letter;
  q('#passport-name').textContent   = u?.username ? '@'+u.username : (u?.firstName || 'Operator');
  q('#passport-rank').textContent   = `${rank.icon} ${rank.label}`;
  q('#passport-id').textContent     = u?.operatorId || 'OP-0000';
  q('#passport-since').textContent  = u?.createdAt ? 'Since '+fmtDate(u.createdAt) : '';

  // Current season card
  const pill = q('#scn-status-pill');
  if (S.season) {
    q('#scn-season-name').textContent = S.season.name;
    pill.textContent  = S.season.status;
    pill.className    = 'status-pill '+S.season.status.toLowerCase();
    pill.style.display = '';
  } else {
    q('#scn-season-name').textContent = 'No active season';
    pill.style.display = 'none';
  }

  q('#scn-pts').textContent = fmtNum(pts);

  if (S.stats?.rank) {
    q('#scn-meta').innerHTML = `Rank <strong class="cyan">#${S.stats.rank}</strong> · ${S.stats.eventsCount} events`;
  } else {
    q('#scn-meta').textContent = S.season ? 'Earn points to get ranked' : 'Season not started';
  }

  // Goal bar
  if (next) {
    const ptsToNext  = next.min - pts;
    const rangeSize  = next.min - rank.min;
    const progress   = rangeSize > 0 ? Math.min(100, ((pts - rank.min) / rangeSize) * 100) : 100;
    q('#goal-label').innerHTML = `${fmtNum(ptsToNext)} pts to <strong>${next.icon} ${next.label}</strong>`;
    q('#goal-pct').textContent = Math.round(progress)+'%';
    q('#goal-fill').style.width = progress.toFixed(1)+'%';
    show('goal-bar');
  } else {
    hide('goal-bar');
  }

  // Battle card
  renderBattleCard();

  // Stats row
  q('#stat-rank').textContent      = S.stats?.rank ? '#'+S.stats.rank : '—';
  q('#stat-events').textContent    = String(S.stats?.eventsCount ?? 0);
  q('#stat-best-rank').textContent = at?.bestRank ? '#'+at.bestRank : '—';

  // All-time
  q('#at-pts').textContent     = fmtNum(at?.totalPoints ?? 0);
  q('#at-seasons').textContent = String(at?.seasonsCount ?? 0);

  // Stamps
  renderStamps();

  // Badges
  renderBadges();

  // Prize pool
  renderPrizePool();

  // Daily missions
  renderMissions();

  // Refresh time
  updateRefreshTime();

  // Wallet
  if (S.wallet) {
    q('#wallet-address').textContent = S.wallet.address;
    show('wallet-card'); hide('register-card');
  } else {
    hide('wallet-card'); show('register-card');
  }

  // Feed
  renderFeed();
}

/* ── Battle card ───────────────────────────────────────── */
function renderBattleCard() {
  const nr = S.nearbyRanks;
  if (!S.stats?.rank || (!nr?.above && !nr?.below)) { hide('battle-card'); return; }

  show('battle-card');
  const myName = S.user?.username ? '@'+S.user.username : (S.user?.firstName || 'You');
  q('#b-me-rank').textContent = '#'+S.stats.rank;
  q('#b-me-name').textContent = myName;
  q('#b-me-pts').textContent  = fmtNum(S.stats.totalPoints);

  if (nr?.above) {
    const name = nr.above.username ? '@'+nr.above.username : (nr.above.firstName || 'Operator');
    q('#b-above-rank').textContent = '#'+nr.above.rank;
    q('#b-above-name').textContent = esc(name);
    q('#b-above-pts').textContent  = fmtNum(nr.above.points);
    q('#b-above-gap').textContent  = '+'+fmtNum(nr.above.gap);
    show('battle-above');
  } else { hide('battle-above'); }

  if (nr?.below) {
    const name = nr.below.username ? '@'+nr.below.username : (nr.below.firstName || 'Operator');
    q('#b-below-rank').textContent = '#'+nr.below.rank;
    q('#b-below-name').textContent = esc(name);
    q('#b-below-pts').textContent  = fmtNum(nr.below.points);
    q('#b-below-gap').textContent  = '-'+fmtNum(nr.below.gap);
    show('battle-below');
  } else { hide('battle-below'); }
}

/* ── Stamps ────────────────────────────────────────────── */
function renderStamps() {
  const row = q('#stamps-row');
  if (!S.seasonStamps.length) {
    row.innerHTML = '<span class="no-badges muted">No seasons yet.</span>';
    return;
  }
  row.innerHTML = S.seasonStamps.map(s => {
    const cls = s.status==='active' ? 'active' : s.participated ? 'done' : '';
    const short = s.name.replace(/season\s*/i,'S');
    return `
      <div class="stamp ${cls}">
        <div class="stamp-circle">${short}</div>
        <div class="stamp-name">${esc(s.name)}</div>
      </div>`;
  }).join('');
}

/* ── Badges ────────────────────────────────────────────── */
function renderBadges() {
  const grid = q('#badges-grid');
  if (!S.badges.length) {
    grid.innerHTML = '<span class="no-badges muted">Complete actions to earn badges.</span>';
    return;
  }
  grid.innerHTML = S.badges.map(b =>
    `<div class="badge"><span class="badge-icon">${b.icon}</span><span>${esc(b.label)}</span></div>`
  ).join('');
}

/* ── Prize pool ────────────────────────────────────────── */
function renderPrizePool() {
  const pp = S.prizePool;
  if (!pp) { hide('prize-card'); return; }
  show('prize-card');

  q('#prize-total').textContent = fmtNum(pp.total) + ' XNT prize pool';

  if (pp.myEstimated > 0 && pp.myTier) {
    q('#prize-my-amount').textContent = fmtNum(pp.myEstimated);
    q('#prize-my-tier').textContent   = pp.myTier;
    show('prize-my'); hide('prize-no-rank');
  } else {
    hide('prize-my'); show('prize-no-rank');
  }

  if (pp.breakdown) {
    q('#prize-breakdown').innerHTML = pp.breakdown.map(tier => {
      const isMe = pp.myTier === tier.label;
      return `
        <div class="prize-tier-row${isMe?' is-mine':''}">
          <span class="prize-tier-rank">${esc(tier.rankLabel)}</span>
          <span class="prize-tier-label">${esc(tier.label)}</span>
          <span class="prize-tier-amount">${fmtNum(tier.perPerson)} XNT</span>
        </div>`;
    }).join('');
  }
}

/* ── Daily missions ────────────────────────────────────── */
function renderMissions() {
  const ms = S.dailyMissions;
  if (!ms.length || !S.season) { hide('missions-card'); return; }
  show('missions-card');

  q('#missions-row').innerHTML = ms.map(m => `
    <div class="mission${m.done?' done':''}">
      <div class="mission-check">✓</div>
      <span class="mission-icon">${m.icon}</span>
      <span class="mission-label">${esc(m.label)}</span>
      <span class="mission-pts">${m.done ? 'done' : '+'+m.pts+' pts'}</span>
    </div>`
  ).join('');
}

/* ── Refresh ───────────────────────────────────────────── */
function updateRefreshTime() {
  if (!S.syncedAt) return;
  const ago = timeAgo(S.syncedAt);
  q('#refresh-time').textContent = ago;
}

async function doRefresh() {
  const btn = q('#refresh-btn');
  btn.classList.add('spinning');
  try {
    const data = await get('/api/panel/me');
    if (!data.ok) return;
    const hadEvents = S.recentEvents.length;
    S.stats         = data.stats;
    S.wallet        = data.wallet;
    S.badges        = data.badges || [];
    S.nearbyRanks   = data.nearbyRanks || null;
    S.dailyMissions = data.dailyMissions || [];
    S.prizePool     = data.prizePool || null;
    S.syncedAt      = data.syncedAt;
    S.prevEventCount = hadEvents;
    S.recentEvents  = data.recentEvents || [];
    renderPassport();
  } finally {
    btn.classList.remove('spinning');
  }
}

/* ── Feed ──────────────────────────────────────────────── */
function renderFeed() {
  const feed = q('#activity-feed');
  const evs  = S.recentEvents;
  if (S.stats) q('#events-total').textContent = S.stats.eventsCount+' total';
  if (!evs.length) {
    feed.innerHTML = '<div class="empty-state">No activity yet.<br>Earn points on X1Factory.</div>';
    return;
  }
  const newCount = Math.max(0, evs.length - S.prevEventCount);
  feed.innerHTML = evs.map((ev, i) => {
    const cat  = catClass(ev.category);
    const icon = ICONS[cat] || ICONS.other;
    const isNew = i < newCount;
    return `
      <div class="activity-item${isNew?' new':''}">
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
  if (!s) { q('#season-card').innerHTML='<div class="empty-state">No active season.</div>'; return; }
  q('#season-name-big').textContent = s.name;
  const pill=q('#season-status-pill'); pill.textContent=s.status; pill.className='status-pill '+s.status.toLowerCase();
  const pct=Math.min(100,Math.max(0,(s.day/s.totalDays)*100));
  q('#season-day-text').textContent=`Day ${s.day} / ${s.totalDays}`;
  q('#season-progress').style.width=pct.toFixed(1)+'%';
  const fmt=iso=>new Date(iso).toLocaleDateString('en-US',{month:'short',day:'numeric'});
  q('#season-dates').innerHTML=`<span>${fmt(s.startsAt)}</span><span>${fmt(s.endsAt)}</span>`;
  if (S.countdownTimer) clearInterval(S.countdownTimer);
  tickCountdown(new Date(s.endsAt));
  S.countdownTimer=setInterval(()=>tickCountdown(new Date(s.endsAt)),1000);
}

function tickCountdown(endsAt) {
  const ms=endsAt.getTime()-Date.now(); const el=q('#season-countdown');
  if (ms<=0){el.textContent='Season ended';clearInterval(S.countdownTimer);return;}
  const d=Math.floor(ms/86400000),h=Math.floor((ms%86400000)/3600000),
        m=Math.floor((ms%3600000)/60000),sc=Math.floor((ms%60000)/1000);
  el.textContent=d>0?`${d}d ${pad(h)}h ${pad(m)}m`:`${pad(h)}:${pad(m)}:${pad(sc)}`;
}

/* ── Leaderboard ───────────────────────────────────────── */
async function loadLeaderboard() {
  const list=q('#lb-list'); list.innerHTML='<div class="empty-state">Loading rankings...</div>';
  try {
    const data=await get('/api/panel/leaderboard');
    if (!data.ok) throw new Error(data.error||'Failed.');
    S.leaderboard=data.rows||[]; S.myRank=data.myRank??null; S.lbLoaded=true;
    q('#lb-season-name').textContent=data.season?.name||'Rankings';
    if (S.myRank) q('#lb-my-pos').textContent='Your rank: #'+S.myRank;
    renderLeaderboard();
    if (S.stats?.rank) q('#stat-rank-sub').textContent=`of ${S.leaderboard.length}`;
  } catch(err) { list.innerHTML=`<div class="empty-state">${esc(err.message)}</div>`; }
}

function renderLeaderboard() {
  const list=q('#lb-list'); const rows=S.leaderboard||[];
  if (!rows.length){list.innerHTML='<div class="empty-state">No rankings yet.</div>';return;}
  const inTop=rows.some(r=>r.telegramId===myTelegramId);
  list.innerHTML=rows.map(row=>{
    const isMe=row.telegramId===myTelegramId;
    const rc=row.rank===1?'g1':row.rank===2?'g2':row.rank===3?'g3':'';
    const name=row.username?'@'+row.username:(row.firstName||'OP-'+row.telegramId.slice(-4));
    return `<div class="lb-row${isMe?' is-me':''}">
      <span class="lb-rank ${rc}">${row.rank}</span>
      <span class="lb-name${isMe?' is-me':''}">${esc(name)}</span>
      <span class="lb-pts${isMe?' is-me':''}">${fmtNum(row.points)}</span>
    </div>`;
  }).join('');
  if (!inTop && S.myRank && S.stats) {
    const myName=S.user?.username?'@'+S.user.username:(S.user?.firstName||'You');
    list.innerHTML+=`<div class="lb-sep"></div>
    <div class="lb-row is-me">
      <span class="lb-rank">${S.myRank}</span>
      <span class="lb-name is-me">${esc(myName)} · you</span>
      <span class="lb-pts is-me">${fmtNum(S.stats.totalPoints)}</span>
    </div>`;
  }
}

/* ── Wallet registration ───────────────────────────────── */
async function submitWallet() {
  const input=q('#wallet-input'), btn=q('#register-btn');
  const address=input.value.trim();
  q('#register-error').classList.add('hidden');
  if (!address){showRegErr('Paste your Solana wallet address.');return;}
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)){showRegErr('Invalid Solana address.');return;}
  btn.disabled=true; btn.textContent='Registering...';
  try {
    const data=await post('/api/panel/register',{address});
    if (!data.ok){showRegErr(data.error||'Failed.');btn.disabled=false;btn.textContent='Register Wallet';return;}
    btn.textContent='✓ Registered!';
    setTimeout(async()=>{
      const r=await get('/api/panel/me');
      if (r.ok){S.wallet=r.wallet;S.stats=r.stats;S.badges=r.badges||[];S.recentEvents=r.recentEvents||[];renderPassport();}
    },800);
  } catch {showRegErr('Network error.');btn.disabled=false;btn.textContent='Register Wallet';}
}
function showRegErr(msg){const e=q('#register-error');e.textContent=msg;e.classList.remove('hidden');}

/* ── Helpers ───────────────────────────────────────────── */
function q(sel){return document.querySelector(sel);}
function show(id){const e=document.getElementById(id);if(e)e.classList.remove('hidden');}
function hide(id){const e=document.getElementById(id);if(e)e.classList.add('hidden');}
function fmtNum(n){return Number(n).toLocaleString('en-US');}
function pad(n){return String(n).padStart(2,'0');}
function fmtDate(iso){return new Date(iso).toLocaleDateString('en-US',{month:'short',year:'numeric'});}
function timeAgo(d){
  const s=Math.floor((Date.now()-new Date(d).getTime())/1000);
  if(s<60)return s+'s'; if(s<3600)return Math.floor(s/60)+'m';
  if(s<86400)return Math.floor(s/3600)+'h'; return Math.floor(s/86400)+'d';
}
function esc(s){return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function catClass(c){
  if(!c)return'other';
  if(c.includes('purchase'))return'purchase'; if(c.includes('renewal'))return'renewal';
  if(c.includes('checkin')||c.includes('check_in'))return'checkin';
  if(c.includes('daily'))return'daily'; if(c.includes('claim'))return'claim';
  if(c.includes('stake'))return'stake'; if(c.includes('registr'))return'registration';
  return'other';
}

window.addEventListener('DOMContentLoaded',init);
