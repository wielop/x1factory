'use strict';

/* ── Rank system ───────────────────────────────────────── */
const RANKS = [
  { min:7000, key:'director',  label:'DIRECTOR',  icon:'👑' },
  { min:3500, key:'engineer',  label:'ENGINEER',  icon:'🔧' },
  { min:1000, key:'operator',  label:'OPERATOR',  icon:'⚙️'  },
  { min:100,  key:'miner',     label:'MINER',     icon:'⛏️'  },
  { min:0,    key:'offline',   label:'OFFLINE',   icon:'○'  },
];
function getRank(pts)     { return RANKS.find(r => pts >= r.min) || RANKS[RANKS.length-1]; }
function getNextRank(pts) { const i = RANKS.findIndex(r => pts >= r.min); return i > 0 ? RANKS[i-1] : null; }

const RANK_CLASSES = {
  offline:  'Unregistered',
  miner:    'Signal Runner',
  operator: 'Core Builder',
  engineer: 'Validator',
  director: 'Architect',
};
function isGenesis(opId) {
  const n = parseInt((opId||'').replace('OP-',''), 10);
  return !isNaN(n) && n <= 200;
}
function operatorClass(rankKey, opId) {
  if (rankKey === 'offline') return 'Unregistered';
  if (isGenesis(opId)) return 'Genesis Operator';
  return RANK_CLASSES[rankKey] || 'Operator';
}

/* ── Category icons ────────────────────────────────────── */
const ICONS = {
  purchase:'🏭', renewal:'🔄', checkin:'📅',
  daily:'⚡', claim:'💎', stake:'🔒', registration:'🔑', other:'•'
};

/* ── State ─────────────────────────────────────────────── */
const S = {
  user:null, wallet:null, season:null, stats:null, allTime:null,
  seasonStamps:[], badges:{ badges:[], trophies:[] }, nearbyRanks:null,
  dailyMissions:[], prizePool:null, syncedAt:null,
  recentEvents:[], leaderboard:null, myRank:null,
  lbLoaded:false, countdownTimer:null, refreshTimer:null, prevEventCount:0,
  photoUrl:null,
  streak:{ count:0, lastAt:null },
  claimTodayPts:0, rigTodayPts:0, stakeTodayPts:0,
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
    S.photoUrl      = data.user?.photoUrl || null;
    S.wallet        = data.wallet;
    S.season        = data.season;
    S.stats         = data.stats;
    S.allTime       = data.allTime;
    S.seasonStamps  = data.seasonStamps || [];
    S.badges        = data.badges || { badges:[], trophies:[] };
    S.nearbyRanks   = data.nearbyRanks || null;
    S.dailyMissions = data.dailyMissions || [];
    S.prizePool     = data.prizePool || null;
    S.syncedAt      = data.syncedAt || null;
    S.prevEventCount = S.recentEvents.length;
    S.recentEvents  = data.recentEvents || [];
    S.streak        = data.streak || { count:0, lastAt:null };
    S.claimTodayPts = data.claimTodayPts || 0;
    S.rigTodayPts   = data.rigTodayPts   || 0;
    S.stakeTodayPts = data.stakeTodayPts || 0;

    renderHeader();
    renderPassport();
    renderSeasonTab();
    hide('loading');
    show('app');
    startAutoRefresh();
  } catch(err) {
    console.error('panel init error:', err);
    const em = q('#error-message');
    if (em) em.textContent = err.message || 'Could not load.';
    hide('loading'); show('gate-error');
  }
}

function retryInit() { hide('gate-error'); show('loading'); S.lbLoaded=false; init(); }

function startAutoRefresh() {
  if (S.refreshTimer) clearInterval(S.refreshTimer);
  S.refreshTimer = setInterval(doRefresh, 15000);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') doRefresh();
});

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
  if (tab === 'missions') renderMissionsTab();
  if (tab === 'leaderboard' && !S.lbLoaded) loadLeaderboard();
  if (tab === 'swap') initSwapTab();
}

/* ── Header ────────────────────────────────────────────── */
function renderHeader() {
  if (S.season) { const b=q('#season-badge'); if(b){b.textContent=S.season.name; b.classList.remove('hidden');} }
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
  if(card) card.className = `passport-card rank-${rank.key}`;
  const av = q('#passport-avatar');
  if (av) {
    if (S.photoUrl) {
      av.className = 'passport-avatar';
      const initial = (u?.firstName?.[0]||u?.username?.[0]||'?').toUpperCase();
      av.innerHTML = `<img src="${S.photoUrl}" class="avatar-photo" alt="avatar" onerror="this.className='passport-avatar avatar-emblem';this.outerHTML='<span class=\\'avatar-glyph\\'>${initial}</span>'">`;
    } else {
      av.className = 'passport-avatar avatar-emblem';
      const initial = (u?.firstName?.[0] || u?.username?.[0] || '?').toUpperCase();
      av.innerHTML = `<span class="avatar-glyph">${initial}</span>`;
    }
  }
  const opId = u?.operatorId || 'OP-0000';
  setText('passport-name', u?.username ? '@'+u.username : (u?.firstName || 'Operator'));
  setText('passport-class', operatorClass(rank.key, opId).toUpperCase());
  setText('passport-rank-icon', rank.icon);
  setText('passport-rank', rank.label);
  setText('passport-id', opId);
  setText('passport-since', u?.createdAt ? fmtDate(u.createdAt) : '—');
  const genesisTag = isGenesis(opId) ? '/GENESIS' : '';
  const seasonTag  = S.season ? '/' + S.season.name.toUpperCase().replace(/\s+/g, '-') : '';
  setText('passport-validity-text', `X1F/${opId}${genesisTag}${seasonTag}/X1-NETWORK`);
  setText('passport-status', 'SYNCHRONIZED');

  // Current season card
  const pill = q('#scn-status-pill');
  if (S.season) {
    setText('scn-season-name', S.season.name);
    if(pill){pill.textContent=S.season.status; pill.className='status-pill '+S.season.status.toLowerCase(); pill.style.display='';}
  } else {
    setText('scn-season-name', 'No active season');
    if(pill) pill.style.display = 'none';
  }

  setText('scn-pts', fmtNum(pts));

  const meta = q('#scn-meta');
  if (S.stats?.rank) {
    if(meta) meta.innerHTML = `<span class="scn-rank-hero">#${S.stats.rank}</span><span class="scn-rank-label">Rank</span>`;
  } else {
    if(meta) meta.innerHTML = `<span class="scn-rank-unranked">${S.season ? 'Unranked' : 'Season not started'}</span>`;
  }

  // Goal bar
  if (next) {
    const ptsToNext = next.min - pts;
    const rangeSize = next.min - rank.min;
    const progress  = rangeSize > 0 ? Math.min(100, ((pts - rank.min) / rangeSize) * 100) : 100;
    setText('goal-label', `Next Rank: ${next.icon} ${next.label}`);
    setText('scn-rank-from', rank.label);
    setText('scn-rank-to',   next.label);
    setText('scn-pts-remaining', `${fmtNum(ptsToNext)} SP remaining`);
    setText('goal-pct', Math.round(progress)+'%');
    const gf=q('#goal-fill'); if(gf) gf.style.width = progress.toFixed(1)+'%';
    show('goal-bar');
  } else {
    const glEl = q('#goal-label');
    if (glEl) glEl.textContent = rank.key !== 'offline' ? `Max Rank: ${rank.icon} ${rank.label}` : '';
    setText('scn-rank-from', ''); setText('scn-rank-to', ''); setText('scn-pts-remaining', '');
    setText('goal-pct', '');
    const gf=q('#goal-fill'); if(gf) gf.style.width='100%';
  }

  // Battle card
  renderBattleCard();

  // Season history meta
  const seasonsCount = at?.seasonsCount ?? 0;
  setText('sh-meta', seasonsCount ? `${seasonsCount} season${seasonsCount > 1 ? 's' : ''}` : '');

  // Stamps
  renderStamps();

  // Badges
  renderBadges();

  // Prize pool
  renderPrizePool();

  // Missions snap (passport tab)
  renderMissionsSnap();

  // Refresh time
  updateRefreshTime();

  // Wallet
  if (S.wallet) {
    setText('wallet-address', S.wallet.address);
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
  setText('b-me-rank', '#'+S.stats.rank);
  setText('b-me-name', myName);
  setText('b-me-pts', fmtNum(S.stats.totalPoints));

  if (nr?.above) {
    const name = nr.above.username ? '@'+nr.above.username : (nr.above.firstName || 'Operator');
    setText('b-above-rank', '#'+nr.above.rank);
    setText('b-above-name', esc(name));
    setText('b-above-pts', fmtNum(nr.above.points));
    setText('b-above-gap', '+'+fmtNum(nr.above.gap));
    show('battle-above');
  } else { hide('battle-above'); }

  if (nr?.below) {
    const name = nr.below.username ? '@'+nr.below.username : (nr.below.firstName || 'Operator');
    setText('b-below-rank', '#'+nr.below.rank);
    setText('b-below-name', esc(name));
    setText('b-below-pts', fmtNum(nr.below.points));
    setText('b-below-gap', '-'+fmtNum(nr.below.gap));
    show('battle-below');
  } else { hide('battle-below'); }
}

/* ── Season Stamps ──────────────────────────────────────── */
function seasonCode(name, idx) {
  const m = name.match(/\d+/);
  if (m) return 'S' + m[0];
  return 'S' + (idx + 1);
}

function renderStamps() {
  const grid = q('#stamps-row');
  if (!grid) return;
  if (!S.seasonStamps.length) {
    grid.innerHTML = '<span class="stamps-empty">No seasons yet.</span>';
    return;
  }
  grid.innerHTML = S.seasonStamps.map((s, i) => {
    const isActive = s.status === 'active';
    const isDone   = s.participated && !isActive;
    const cls      = isActive ? 'active' : isDone ? 'done' : 'skip';
    const code     = seasonCode(s.name, i);
    const label    = s.name.replace(/season\s*/i, '').trim() || s.name;
    const pts      = s.points || 0;
    const ptsLabel = pts > 0 ? `${fmtNum(pts)} SP` : (isActive ? 'ACTIVE' : 'UPCOMING');
    const rankLabel = s.rank ? ` · #${s.rank}` : '';
    return `
      <div class="stamp-item ${cls}">
        <div class="stamp-seal">
          <div class="stamp-inner">
            <span class="stamp-code">${esc(code)}</span>
            <span class="stamp-word">${esc(label.toUpperCase())}</span>
          </div>
        </div>
        <div class="stamp-foot">
          <span class="stamp-full-name">${esc(s.name)}</span>
          <span class="stamp-status-tag ${cls}">${ptsLabel}${rankLabel}</span>
        </div>
      </div>`;
  }).join('');
}

/* ── Badges ────────────────────────────────────────────── */
function renderBadges() {
  const grid = q('#badges-grid');
  if (!grid) return;
  const bd = S.badges || {};
  const badges = bd.badges || [];
  const trophies = bd.trophies || [];
  if (!badges.length && !trophies.length) {
    grid.innerHTML = '<span class="no-badges muted">Complete actions to unlock badges.</span>';
    return;
  }
  let html = '';

  if (badges.length) {
    html += '<div class="badge-section"><div class="badge-section-title">Odznaki</div><div class="badge-leveled-grid">';
    for (const b of badges) {
      html += `<div class="badge-lvl ${esc(b.colorClass)} earned">
        <div class="badge-lvl-icon">${b.icon}</div>
        <div class="badge-lvl-body">
          <div class="badge-lvl-name">${esc(b.label)}</div>
          <div class="badge-lvl-tier">${esc(b.desc)}</div>
        </div>
      </div>`;
    }
    html += '</div></div>';
  }

  if (trophies.length) {
    html += '<div class="badge-section"><div class="badge-section-title">Trofea sezonowe</div><div class="badge-trophy-grid">';
    for (const t of trophies) {
      html += `<div class="badge-trophy"><span class="badge-trophy-icon">${t.icon}</span><span class="badge-trophy-label">${esc(t.label)}</span></div>`;
    }
    html += '</div></div>';
  }

  grid.innerHTML = html;
}

/* ── Prize pool ────────────────────────────────────────── */
function renderPrizePool() {
  const pp = S.prizePool;
  if (!pp) { hide('prize-card'); return; }
  show('prize-card');

  setText('prize-total', fmtNum(pp.total) + ' XNT prize pool');

  if (pp.myEstimated > 0 && pp.myTier) {
    setText('prize-my-amount', fmtNum(pp.myEstimated));
    setText('prize-my-tier', pp.myTier);
    show('prize-my'); hide('prize-no-rank');
  } else {
    hide('prize-my'); show('prize-no-rank');
  }

  if (pp.breakdown) {
    const pb=q('#prize-breakdown'); if(pb) pb.innerHTML = pp.breakdown.map(tier => {
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

/* ── Daily Check-in / Energy tap ──────────────────────── */
async function doCheckin() {
  const btn = q('#ms-checkin-btn');
  const msg = q('#ms-checkin-msg');
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  const prevText = btn.textContent;
  btn.textContent = '...';
  if (msg) { msg.classList.add('hidden'); msg.classList.remove('error'); }
  try {
    const r = await fetch('/api/panel/checkin', {
      method: 'POST',
      headers: { 'x-telegram-init-data': initData() }
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || 'Failed.');

    if (data.alreadyDone) {
      renderMissionsTab();
      return;
    }

    S.streak = { count: data.streak, lastAt: new Date().toISOString() };
    const cm = S.dailyMissions.find(m => m.key === 'checkin');
    if (cm) cm.done = true;
    S.stats = S.stats ? { ...S.stats, totalPoints: data.totalPoints, rank: data.rank } : null;
    setText('scn-pts', fmtNum(data.totalPoints));

    floatPts(btn, '+' + data.pointsAwarded);

    const parts = [];
    if (data.pointsAwarded) parts.push(`+${data.pointsAwarded} pts`);
    if (data.streakBonus)   parts.push(`🔥 +${data.streakBonus} streak bonus`);
    if (msg && parts.length) { msg.textContent = parts.join(' · '); msg.classList.remove('hidden'); }

    renderMissionsTab();
    renderMissionsSnap();

    if (data.streakBonus && data.streak) {
      setTimeout(() => showStreakCelebration(data.streak, data.streakBonus), 300);
    }
  } catch(err) {
    btn.disabled = false;
    btn.textContent = prevText;
    if (msg) { msg.textContent = err.message || 'Error'; msg.classList.remove('hidden'); msg.classList.add('error'); }
  }
}

function floatPts(anchor, text) {
  const el = document.createElement('div');
  el.className = 'pts-float';
  el.textContent = text;
  const rect = anchor.getBoundingClientRect();
  el.style.left = (rect.left + rect.width / 2) + 'px';
  el.style.top  = rect.top + 'px';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 900);
}

function showStreakCelebration(days, bonus) {
  const el = document.createElement('div');
  el.className = 'streak-celebrate';
  el.innerHTML = `🔥 ${days}-day streak!<br><span>+${bonus} bonus pts</span>`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2800);
}

/* ── Missions snap (passport tab compact) ──────────────── */
function renderMissionsSnap() {
  const ms = S.dailyMissions;
  if (!ms.length || !S.season) { hide('missions-snap'); return; }
  show('missions-snap');
  const row = q('#missions-snap-row');
  if (!row) return;
  const items = ms.filter(m => m.key !== 'active_rig').map(m => ({ icon: m.icon, label: m.label, done: m.done }));
  row.innerHTML = items.map(it => `
    <div class="snap-item${it.done?' done':''}">
      <span class="snap-icon">${it.icon}</span>
      <span class="snap-label">${esc(it.label)}</span>
      <span class="snap-check">${it.done ? '✓' : ''}</span>
    </div>`
  ).join('');
}

/* ── Missions tab (full) ───────────────────────────────── */
function renderMissionsTab() {
  if (!S.season) return;

  // Date header
  const dateEl = q('#ms-today');
  if (dateEl) {
    dateEl.textContent = new Date().toLocaleDateString('en-US', { weekday:'long', day:'numeric', month:'short' });
  }

  // ── Check-in button ──
  const checkinDone = S.dailyMissions.find(m => m.key === 'checkin')?.done;
  const btn = q('#ms-checkin-btn');
  if (btn) {
    btn.disabled = !!checkinDone;
    btn.textContent = checkinDone ? '✅ Done today' : '⚡ Check In  +10 pts';
    btn.classList.toggle('ms-btn-done', !!checkinDone);
  }

  const badgeEl = q('#ms-checkin-badge');
  if (badgeEl) badgeEl.textContent = checkinDone ? '✓' : '+10';

  // ── Claim MIND status ──
  const claimDone = S.dailyMissions.find(m => m.key === 'claim')?.done;
  const claimCard = q('#ms-claim-card');
  if (claimCard) claimCard.classList.toggle('ms-card-done', !!claimDone);
  const claimBadge = q('#ms-claim-badge');
  if (claimBadge) { claimBadge.textContent = claimDone ? '✓ Done' : '+5–150'; claimBadge.className = 'ms-card-badge' + (claimDone ? ' ms-badge-done' : ''); }

  // ── Mark which claim tiers are reached today ──
  const CLAIM_TIER_PTS = [5, 15, 30, 80, 150];
  const claimPts = S.claimTodayPts || 0;
  document.querySelectorAll('#ms-claim-card .ms-reward-row').forEach((row, i) => {
    row.classList.toggle('done', claimPts >= CLAIM_TIER_PTS[i]);
  });

  // ── Passive: Active Rig ──
  const rigStatus = q('#ms-rig-status');
  if (rigStatus) {
    const pts = S.rigTodayPts || 0;
    rigStatus.textContent = pts > 0 ? `+${pts} pts` : '—';
    rigStatus.className = 'ms-passive-status' + (pts > 0 ? ' done' : '');
  }

  // ── Passive: Staking ──
  const stakeStatus = q('#ms-stake-status');
  if (stakeStatus) {
    const pts = S.stakeTodayPts || 0;
    stakeStatus.textContent = pts > 0 ? `+${pts} pts` : '—';
    stakeStatus.className = 'ms-passive-status' + (pts > 0 ? ' done' : '');
  }

  // ── Streak ──
  const streakCount = S.streak?.count || 0;
  setText('ms-streak-big', String(streakCount));

  const pill = q('#ms-streak-pill');
  if (pill) {
    if (streakCount > 0) { pill.textContent = streakCount + (streakCount === 1 ? ' day' : ' days'); pill.classList.remove('hidden'); }
    else pill.classList.add('hidden');
  }

  const hintEl = q('#ms-streak-hint');
  if (hintEl) {
    const checkinDoneToday = S.dailyMissions.find(m => m.key === 'checkin')?.done;
    const claimDoneToday   = S.dailyMissions.find(m => m.key === 'claim')?.done;
    const MILESTONES = [3,7,14,21];
    const next = MILESTONES.find(m => m > streakCount);
    if (checkinDoneToday && !claimDoneToday) {
      hintEl.textContent = '💎 Claim MIND to complete your streak!';
    } else if (claimDoneToday && !checkinDoneToday) {
      hintEl.textContent = '⚡ Check in to complete your streak!';
    } else if (streakCount === 0) {
      hintEl.textContent = 'Check in + claim MIND to start your streak';
    } else if (next) {
      const left = next - streakCount;
      hintEl.textContent = `${left} ${left === 1 ? 'day' : 'days'} left to +${[50,150,350,700][[3,7,14,21].indexOf(next)]} pts bonus`;
    } else {
      hintEl.textContent = '🏆 Maximum milestone reached!';
    }
  }

  const msNodes = document.querySelectorAll('#ms-milestones .ms-milestone');
  msNodes.forEach(node => {
    const days = parseInt(node.dataset.days, 10);
    node.classList.toggle('ms-ms-reached', streakCount >= days);
    node.classList.toggle('ms-ms-next', streakCount < days && (!node.previousElementSibling || streakCount >= parseInt(node.previousElementSibling.dataset.days||'0',10)));
  });

}

/* ── Refresh ───────────────────────────────────────────── */
function updateRefreshTime() {
  if (!S.syncedAt) return;
  const ago = timeAgo(S.syncedAt);
  q('#refresh-time').textContent = ago;
}

async function doRefresh() {
  const btn1 = q('#refresh-btn');
  const btn2 = q('#scn-refresh-btn');
  if(btn1) btn1.classList.add('spinning');
  if(btn2) btn2.classList.add('spinning');
  try {
    const data = await get('/api/panel/me');
    if (!data.ok) return;
    const hadEvents = S.recentEvents.length;
    S.user          = data.user;
    S.wallet        = data.wallet;
    S.season        = data.season;
    S.stats         = data.stats;
    S.allTime       = data.allTime;
    S.seasonStamps  = data.seasonStamps || [];
    S.badges        = data.badges || { badges:[], trophies:[] };
    S.nearbyRanks   = data.nearbyRanks || null;
    S.dailyMissions = data.dailyMissions || [];
    S.prizePool     = data.prizePool || null;
    S.syncedAt      = data.syncedAt;
    S.prevEventCount = hadEvents;
    S.recentEvents  = data.recentEvents || [];
    S.streak        = data.streak || { count:0, lastAt:null };
    S.claimTodayPts = data.claimTodayPts || 0;
    S.rigTodayPts   = data.rigTodayPts   || 0;
    S.stakeTodayPts = data.stakeTodayPts || 0;
    renderHeader();
    renderPassport();
    renderSeasonTab();
    if (S.lbLoaded) { S.lbLoaded = false; loadLeaderboard(); }
  } finally {
    if(btn1) btn1.classList.remove('spinning');
    if(btn2) btn2.classList.remove('spinning');
  }
}

/* ── Feed ──────────────────────────────────────────────── */
function renderFeed() {
  const feed = q('#activity-feed');
  const evs  = S.recentEvents;
  if (S.stats) setText('events-total', S.stats.eventsCount+' total');
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
  const sc=q('#season-card'); if(!s){if(sc)sc.innerHTML='<div class="empty-state">No active season.</div>'; return;}
  setText('season-name-big', s.name);
  const pill=q('#season-status-pill'); if(pill){pill.textContent=s.status; pill.className='status-pill '+s.status.toLowerCase();}
  const pct=Math.min(100,Math.max(0,(s.day/s.totalDays)*100));
  setText('season-day-text', `Day ${s.day} / ${s.totalDays}`);
  const sp=q('#season-progress'); if(sp) sp.style.width=pct.toFixed(1)+'%';
  const fmt=iso=>new Date(iso).toLocaleDateString('en-US',{month:'short',day:'numeric'});
  const sd=q('#season-dates'); if(sd) sd.innerHTML=`<span>${fmt(s.startsAt)}</span><span>${fmt(s.endsAt)}</span>`;
  if (S.countdownTimer) clearInterval(S.countdownTimer);
  tickCountdown(new Date(s.endsAt));
  S.countdownTimer=setInterval(()=>tickCountdown(new Date(s.endsAt)),1000);
}

function tickCountdown(endsAt) {
  const ms=endsAt.getTime()-Date.now(); const el=q('#season-countdown');
  if(!el) return;
  if (ms<=0){el.textContent='Season ended';clearInterval(S.countdownTimer);return;}
  const d=Math.floor(ms/86400000),h=Math.floor((ms%86400000)/3600000),
        m=Math.floor((ms%3600000)/60000),sc=Math.floor((ms%60000)/1000);
  el.textContent=d>0?`${d}d ${pad(h)}h ${pad(m)}m`:`${pad(h)}:${pad(m)}:${pad(sc)}`;
}

/* ── Leaderboard ───────────────────────────────────────── */
async function loadLeaderboard() {
  const list=q('#lb-list'); if(list) list.innerHTML='<div class="empty-state">Loading rankings...</div>';
  try {
    const data=await get('/api/panel/leaderboard');
    if (!data.ok) throw new Error(data.error||'Failed.');
    S.leaderboard=data.rows||[]; S.myRank=data.myRank??null; S.lbLoaded=true;
    setText('lb-season-name', data.season?.name||'Rankings');
    if (S.myRank) setText('lb-my-pos', 'Your rank: #'+S.myRank);
    renderLeaderboard();
    if (S.stats?.rank) setText('stat-rank-sub', `of ${S.leaderboard.length}`);
  } catch(err) { if(list) list.innerHTML=`<div class="empty-state">${esc(err.message)}</div>`; }
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
function showRegErr(msg){const e=q('#register-error');if(e){e.textContent=msg;e.classList.remove('hidden');}}

/* ── Helpers ───────────────────────────────────────────── */
function q(sel){return document.querySelector(sel);}
function setText(id,val){const e=document.getElementById(id);if(e)e.textContent=val;}
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

/* ── Swap Tab ────────────────────────────────────────────── */
const SWAP_DECIMALS = 9;

function initSwapTab() {
  loadSwapPoolStats();
  loadSwapLeaderboard('season');
}

/* ── Swap Leaderboard ────────────────────────────────────── */
let slbCurrentMode = 'season';

function switchSwapLb(mode) {
  slbCurrentMode = mode;
  q('#slb-tab-season').classList.toggle('active', mode === 'season');
  q('#slb-tab-alltime').classList.toggle('active', mode === 'alltime');
  loadSwapLeaderboard(mode);
}

async function loadSwapLeaderboard(mode) {
  const container = q('#slb-list');
  if (container) container.innerHTML = '<div class="slb-empty muted">Loading...</div>';
  const myRankEl = q('#slb-my-rank');
  if (myRankEl) myRankEl.classList.add('hidden');

  try {
    const res  = await fetch(`/api/panel/swap/leaderboard?mode=${mode}`);
    const data = await res.json();
    if (!data.ok || !data.entries.length) {
      if (container) container.innerHTML = '<div class="slb-empty muted">No swap activity yet. Be the first!</div>';
      return;
    }

    const myUserId = S.user?.id;
    const entries  = data.entries;
    const maxVol   = entries[0]?.volumeCents || 1;

    // My rank banner
    const me = entries.find(e => e.userId === myUserId);
    if (me && myRankEl) {
      myRankEl.classList.remove('hidden');
      myRankEl.innerHTML =
        `<span class="slb-my-rank-label">Your rank</span>` +
        `<span class="slb-my-rank-val">#${me.rank} · $${(me.volumeCents/100).toLocaleString('en-US',{minimumFractionDigits:0,maximumFractionDigits:0})} vol · ${me.gigaWins} ⚡ wins</span>`;
    }

    let html = '';

    // Top-3 podium
    const top3 = entries.slice(0, 3);
    if (top3.length) {
      const medals = ['🥇','🥈','🥉'];
      const cls    = ['p1','p2','p3'];
      html += '<div class="slb-podium">';
      top3.forEach((e, i) => {
        const isMe = e.userId === myUserId;
        const vol  = '$' + (e.volumeCents/100).toLocaleString('en-US',{maximumFractionDigits:0});
        const name = e.name.length > 10 ? e.name.slice(0,9)+'…' : e.name;
        html += `<div class="slb-podium-card ${cls[i]}${isMe?' is-me':''}">
          <span class="slb-medal">${medals[i]}</span>
          <span class="slb-podium-name">${name}</span>
          <span class="slb-podium-vol">${vol}</span>
          <span class="slb-podium-sub">${e.swapCount} swap${e.swapCount!==1?'s':''}</span>
          ${e.gigaWins > 0 ? `<span class="slb-podium-wins">⚡ ${e.gigaWins} wins</span>` : ''}
        </div>`;
      });
      html += '</div>';
    }

    // Rows 4+
    entries.slice(3).forEach(e => {
      const isMe  = e.userId === myUserId;
      const vol   = '$' + (e.volumeCents/100).toLocaleString('en-US',{maximumFractionDigits:0});
      const barPct = Math.round((e.volumeCents / maxVol) * 100);
      const rateStr = e.swapCount > 0 ? `${e.winRate}% win rate` : '';
      html += `<div class="slb-row${isMe?' is-me':''}">
        <span class="slb-row-rank">#${e.rank}</span>
        <div class="slb-row-info">
          <div class="slb-row-name${isMe?' is-me':''}">${e.name}</div>
          <div class="slb-row-meta">
            <span class="slb-row-vol">${vol} · ${e.swapCount} swaps</span>
            ${e.gigaWins > 0 ? `<span class="slb-row-wins-badge">⚡ ${e.gigaWins}</span>` : ''}
          </div>
          <div class="slb-row-bar-wrap"><div class="slb-row-bar" style="width:${barPct}%"></div></div>
        </div>
        <div class="slb-row-right">
          <span class="slb-row-pts${isMe?' is-me':''}">${vol}</span>
          ${rateStr ? `<span class="slb-row-rate">${rateStr}</span>` : ''}
        </div>
      </div>`;
    });

    if (container) container.innerHTML = html;
  } catch (err) {
    if (container) container.innerHTML = '<div class="slb-empty muted">Failed to load.</div>';
  }
}

async function loadSwapPoolStats() {
  try {
    // Use a 1 MIND quote just to get pool sizes
    const amountIn = BigInt(1 * 10 ** SWAP_DECIMALS);
    const res = await fetch(`/api/panel/swap/quote?amountIn=${amountIn}&direction=mind_to_xnt`);
    const data = await res.json();
    if (!data.ok) return;
    const poolXnt = Number(BigInt(data.poolXnt)) / 10 ** SWAP_DECIMALS;
    const poolMind = Number(BigInt(data.poolMind)) / 10 ** SWAP_DECIMALS;
    setText('swap-pool-xnt', poolXnt.toLocaleString('en-US', { maximumFractionDigits: 0 }) + ' XNT');
    setText('swap-pool-mind', poolMind.toLocaleString('en-US', { maximumFractionDigits: 0 }) + ' MIND');
  } catch (_) { /* ignore */ }
}

function openSwapPage() {
  const url = 'https://x1factory.xyz/swap';
  if (window.Telegram?.WebApp?.openLink) {
    window.Telegram.WebApp.openLink(url);
  } else {
    window.open(url, '_blank');
  }
}
