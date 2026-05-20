const tg = window.Telegram?.WebApp ?? null;
const BOT_URL = "https://t.me/x1factory_bot";

const upgradeDefs = [
  { id: "pickaxe", title: "Tap Power", effect: "Hash / tap", levels: [{ l: 1, v: 1, c: 0 }, { l: 2, v: 2, c: 500 }, { l: 3, v: 3, c: 1500 }, { l: 4, v: 5, c: 4000 }, { l: 5, v: 8, c: 10000 }] },
  { id: "passive_rig", title: "Passive Rig", effect: "Hash / hour", levels: [{ l: 0, v: 0, c: 0 }, { l: 1, v: 20, c: 1000 }, { l: 2, v: 60, c: 3000 }, { l: 3, v: 150, c: 8000 }, { l: 4, v: 400, c: 20000 }] },
  { id: "battery", title: "Battery", effect: "Energy cap", levels: [{ l: 1, v: 100, c: 0 }, { l: 2, v: 150, c: 2000 }, { l: 3, v: 250, c: 7000 }, { l: 4, v: 400, c: 15000 }] },
  { id: "storage", title: "Storage", effect: "Passive cap", levels: [{ l: 1, v: "4h", c: 0 }, { l: 2, v: "6h", c: 5000 }, { l: 3, v: "10h", c: 15000 }, { l: 4, v: "16h", c: 40000 }], mockOnly: true },
  { id: "factory_level", title: "Factory Level", effect: "Progression tier", levels: [{ l: 1, v: "Recruit", c: 0 }, { l: 2, v: "Builder", c: 8000 }, { l: 3, v: "Operator", c: 25000 }, { l: 4, v: "Commander", c: 75000 }], mockOnly: true }
];

const boostDefs = [
  { id: "energy_refill", title: "Energy Refill", cost: 50, effect: "Restores Energy to full", duration: "Instant" },
  { id: "turbo_1h", title: "Turbo Mode", cost: 100, effect: "x2 Hash from tapping", duration: "1h" },
  { id: "auto_miner_24h", title: "Auto Miner", cost: 300, effect: "+100 passive Hash/hour", duration: "24h" },
  { id: "storage_12h", title: "Storage Expansion", cost: 500, effect: "Storage becomes 12h", duration: "7d" },
  { id: "season_boost_24h", title: "Season Boost", cost: 700, effect: "+20% Season Points milestones", duration: "24h" },
  { id: "industrial_overclock", title: "Industrial Overclock", cost: 1000, effect: "x3 Hash from tapping", duration: "6h", mockOnly: true }
];

const mockRows = {
  main: ["0xMindPilot", "factorymax", "xnt_builder", "hash_unit", "rigrunner"],
  f2p: ["free_miner", "tap_only", "dailyhash", "patient_rig", "zero_xnt"],
  clickers: ["tapstorm", "thumbcore", "clickline", "hashhand", "daily500"],
  supporters: ["reactor_whale", "xntfuel", "lp_builder", "boostmax", "corebuyer"],
  efficiency: ["smart_hash", "leanrig", "value_miner", "minmax", "cooldown"]
};

const state = {
  game: null,
  feed: ["Reactor online"],
  tab: "reactor",
  board: "main",
  mock: false,
  loading: false
};

const $ = (id) => document.getElementById(id);
const nodes = {
  outsideTelegram: $("outsideTelegram"),
  walletGate: $("walletGate"),
  game: $("game"),
  modeBadge: $("modeBadge"),
  refreshButton: $("refreshButton"),
  seasonName: $("seasonName"),
  seasonDay: $("seasonDay"),
  rank: $("rank"),
  seasonPoints: $("seasonPoints"),
  hashBalance: $("hashBalance"),
  energyBalance: $("energyBalance"),
  reactorCore: $("reactorCore"),
  floatLayer: $("floatLayer"),
  tapRate: $("tapRate"),
  energyCopy: $("energyCopy"),
  energyMeterText: $("energyMeterText"),
  energyMeter: $("energyMeter"),
  passiveRate: $("passiveRate"),
  storageText: $("storageText"),
  collectButton: $("collectButton"),
  feedList: $("feedList"),
  top10Distance: $("top10Distance"),
  upgradeList: $("upgradeList"),
  reactorEnergy: $("reactorEnergy"),
  boostList: $("boostList"),
  seasonTitle: $("seasonTitle"),
  timeLeft: $("timeLeft"),
  seasonRank: $("seasonRank"),
  rewardPool: $("rewardPool"),
  tierName: $("tierName"),
  tierMeter: $("tierMeter"),
  leaderboard: $("leaderboard"),
  walletAddress: $("walletAddress"),
  walletEnergy: $("walletEnergy"),
  energyRate: $("energyRate"),
  minDeposit: $("minDeposit"),
  treasuryAddress: $("treasuryAddress"),
  copyTreasury: $("copyTreasury"),
  refreshDeposits: $("refreshDeposits"),
  depositList: $("depositList")
};

function initTelegram() {
  if (!tg) {
    return false;
  }

  tg.ready();
  tg.expand();
  document.documentElement.style.setProperty("--tg-bg", tg.themeParams?.bg_color ?? "#04070d");
  return Boolean(tg.initData);
}

function getInitData() {
  return tg?.initData ?? "";
}

function fmt(value) {
  const num = typeof value === "bigint" ? Number(value) : Number(value ?? 0);
  if (!Number.isFinite(num)) return "0";
  return num.toLocaleString("en-US");
}

function shortAddress(address) {
  return address ? (address.length > 14 ? `${address.slice(0, 6)}...${address.slice(-6)}` : address) : "not registered";
}

function hoursLeft(ms) {
  const totalMinutes = Math.max(0, Math.floor(ms / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  return days > 0 ? `${days}d ${hours}h` : `${hours}h ${minutes}m`;
}

function makeMockGame() {
  return {
    mode: "mock",
    season: { name: "Season 0: Bot Test", day: 3, durationDays: 21, timeLeftMs: 18 * 86400000, breakDays: 7 },
    profile: {
      hash: "12450",
      totalHash: "32800",
      energy: 72,
      energyCap: 150,
      hashPerTap: 3,
      passiveHashPerHour: 120,
      storageHours: 4,
      dailyClicks: 184,
      dailyClickCap: 500,
      factoryLevel: 4,
      rank: 14,
      seasonPoints: 2180,
      top10Distance: 120
    },
    wallet: {
      registered: true,
      address: "X1DemoWallet111111111111111111111111",
      reactorEnergy: 500,
      ratePerXnt: 1000,
      minDepositXnt: 0.1,
      treasuryAddress: "TreasuryAddressComingSoon",
      deposits: []
    },
    boosts: [{ type: "turbo_1h", expiresAt: new Date(Date.now() + 2600000).toISOString(), multiplier: 2 }],
    recent: ["Mock Mode active", "Tap animations are local", "Real state changes stay server-side later"]
  };
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers: {
      "content-type": "application/json",
      "x-telegram-init-data": getInitData()
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.error || "Request failed");
    error.code = payload.code;
    throw error;
  }
  return payload;
}

const api = {
  async getGameProfile() {
    return (await request("/api/reactor/me")).game;
  },
  async tapReactor() {
    return request("/api/reactor/tap", { method: "POST" });
  },
  async collectPassive() {
    return request("/api/reactor/collect", { method: "POST" });
  },
  async buyUpgrade(upgradeId) {
    return request("/api/reactor/upgrade", { method: "POST", body: { upgradeId } });
  },
  async buyBoost(boostId) {
    return request("/api/reactor/boost", { method: "POST", body: { boostId } });
  },
  async getSeasonLeaderboard(type) {
    return request(`/api/reactor/leaderboard?type=${encodeURIComponent(type)}`);
  },
  async getWalletEnergy() {
    return (await request("/api/reactor/wallet")).wallet;
  },
  async refreshDeposits() {
    return request("/api/reactor/deposits/refresh", { method: "POST" });
  }
};

function addFeed(message) {
  state.feed = [message, ...state.feed].slice(0, 5);
  renderFeed();
}

function setGate(gate) {
  nodes.outsideTelegram.classList.toggle("hidden", gate !== "outside");
  nodes.walletGate.classList.toggle("hidden", gate !== "wallet");
  nodes.game.classList.toggle("hidden", Boolean(gate));
}

function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll(".tab-screen").forEach((screen) => screen.classList.toggle("active", screen.id === `tab-${tab}`));
  document.querySelectorAll("[data-tab-target]").forEach((button) => button.classList.toggle("active", button.dataset.tabTarget === tab));
  if (tab === "season") void loadLeaderboard(state.board);
}

function renderFeed() {
  nodes.feedList.innerHTML = "";
  for (const item of state.feed) {
    const div = document.createElement("div");
    div.className = "feed-item";
    div.textContent = item;
    nodes.feedList.appendChild(div);
  }
}

function getTier(points) {
  if (points >= 10000) return ["Reactor Legend", 100];
  if (points >= 5000) return ["Factory Commander", 72];
  if (points >= 2500) return ["Factory Operator", 48];
  if (points >= 1000) return ["Factory Builder", 26];
  return ["Factory Recruit", Math.min(18, points / 10)];
}

function inferLevel(def, game) {
  if (def.id === "pickaxe") return def.levels.find((x) => x.v === game.profile.hashPerTap)?.l ?? 1;
  if (def.id === "passive_rig") return def.levels.find((x) => x.v === game.profile.passiveHashPerHour)?.l ?? 0;
  if (def.id === "battery") return def.levels.find((x) => x.v === game.profile.energyCap)?.l ?? 1;
  if (def.id === "storage") return def.levels.find((x) => x.v === `${game.profile.storageHours}h`)?.l ?? 1;
  return game.profile.factoryLevel ?? 1;
}

function renderUpgrades(game) {
  const hash = Number(game.profile.hash);
  nodes.upgradeList.innerHTML = "";
  for (const def of upgradeDefs) {
    const level = inferLevel(def, game);
    const current = def.levels.find((x) => x.l === level) ?? def.levels[0];
    const next = def.levels.find((x) => x.l === level + 1);
    const canBuy = next && hash >= next.c && !def.mockOnly;
    const card = document.createElement("article");
    card.className = "upgrade-card";
    card.innerHTML = `
      <div class="card-title"><strong>${def.title}</strong><span>${def.mockOnly ? "API pending" : "Hash"}</span></div>
      <div class="metric-row"><span>Level</span><strong>${level}</strong></div>
      <div class="metric-row"><span>Current</span><strong>${current.v} ${def.effect}</strong></div>
      <div class="metric-row"><span>Next</span><strong>${next ? `${next.v} ${def.effect}` : "Maxed"}</strong></div>
      <div class="metric-row"><span>Cost</span><strong>${next ? `${fmt(next.c)} Hash` : "-"}</strong></div>
      <button type="button" data-upgrade="${def.id}" ${canBuy ? "" : "disabled"}>${next ? "Upgrade" : "Maxed"}</button>
    `;
    nodes.upgradeList.appendChild(card);
  }
}

function renderBoosts(game) {
  nodes.reactorEnergy.textContent = fmt(game.wallet.reactorEnergy);
  nodes.boostList.innerHTML = "";
  for (const boost of boostDefs) {
    const active = game.boosts.some((entry) => entry.type === boost.id);
    const canBuy = game.wallet.reactorEnergy >= boost.cost && !boost.mockOnly;
    const card = document.createElement("article");
    card.className = "boost-card";
    card.innerHTML = `
      <div class="card-title"><strong>${boost.title}</strong><span class="premium-tag">${boost.cost} Energy</span></div>
      <div class="metric-row"><span>Effect</span><strong>${boost.effect}</strong></div>
      <div class="metric-row"><span>Duration</span><strong>${boost.duration}</strong></div>
      <div class="metric-row"><span>Status</span><strong>${active ? "Active" : boost.mockOnly ? "API pending" : "Ready"}</strong></div>
      <button type="button" data-boost="${boost.id}" ${canBuy ? "" : "disabled"}>${active ? "Active" : "Activate"}</button>
    `;
    nodes.boostList.appendChild(card);
  }
}

function renderWallet(game) {
  nodes.walletAddress.textContent = shortAddress(game.wallet.address);
  nodes.walletEnergy.textContent = fmt(game.wallet.reactorEnergy);
  nodes.energyRate.textContent = `1 XNT = ${fmt(game.wallet.ratePerXnt)} Energy`;
  nodes.minDeposit.textContent = `${game.wallet.minDepositXnt} XNT`;
  nodes.treasuryAddress.textContent = game.wallet.treasuryAddress ?? "Coming soon";
  nodes.depositList.innerHTML = "";
  const deposits = game.wallet.deposits?.length ? game.wallet.deposits : [{ status: "No deposits yet", energyAmount: 0, amountXnt: "0" }];
  for (const deposit of deposits) {
    const div = document.createElement("div");
    div.className = "deposit-item";
    div.textContent = `${deposit.status}: ${deposit.amountXnt} XNT -> ${deposit.energyAmount} Energy`;
    nodes.depositList.appendChild(div);
  }
}

function renderGame(game) {
  state.game = game;
  state.mock = game.mode !== "live";
  nodes.modeBadge.textContent = state.mock ? "Mock Mode" : "Live Mode";
  nodes.seasonName.textContent = game.season.name;
  nodes.seasonDay.textContent = `Day ${game.season.day} / 21`;
  nodes.rank.textContent = game.profile.rank ? `#${game.profile.rank}` : "-";
  nodes.seasonPoints.textContent = fmt(game.profile.seasonPoints);
  nodes.hashBalance.textContent = fmt(game.profile.hash);
  nodes.energyBalance.textContent = `${game.profile.energy}/${game.profile.energyCap}`;
  nodes.tapRate.textContent = `+${game.profile.hashPerTap} Hash / tap`;
  const energyPercent = Math.max(0, Math.min(100, (game.profile.energy / game.profile.energyCap) * 100));
  nodes.energyMeter.style.width = `${energyPercent}%`;
  nodes.energyMeterText.textContent = `${Math.round(energyPercent)}%`;
  nodes.energyCopy.textContent = game.profile.energy <= 0 ? "Energy low" : game.profile.energy < game.profile.energyCap * 0.25 ? "Energy low" : "Reactor online";
  nodes.passiveRate.textContent = `${fmt(game.profile.passiveHashPerHour)} Hash/hour`;
  nodes.storageText.textContent = `0h / ${game.profile.storageHours}h`;
  nodes.top10Distance.textContent = `Top 10 distance: ${fmt(game.profile.top10Distance)} SP`;
  nodes.seasonTitle.textContent = game.season.name;
  nodes.timeLeft.textContent = hoursLeft(game.season.timeLeftMs);
  nodes.seasonRank.textContent = game.profile.rank ? `#${game.profile.rank}` : "-";
  const [tier, pct] = getTier(game.profile.seasonPoints);
  nodes.tierName.textContent = tier;
  nodes.tierMeter.style.width = `${pct}%`;
  nodes.rewardPool.textContent = "TBA XNT";
  state.feed = [...(game.recent ?? []), ...state.feed].slice(0, 5);
  renderFeed();
  renderUpgrades(game);
  renderBoosts(game);
  renderWallet(game);
}

function floatHash(amount) {
  const el = document.createElement("div");
  el.className = "float-num";
  el.textContent = `+${amount}`;
  el.style.setProperty("--drift", `${Math.round(Math.random() * 90 - 45)}px`);
  nodes.floatLayer.appendChild(el);
  setTimeout(() => el.remove(), 900);
}

function pulseCore() {
  nodes.reactorCore.classList.remove("tapped");
  void nodes.reactorCore.offsetWidth;
  nodes.reactorCore.classList.add("tapped");
  setTimeout(() => nodes.reactorCore.classList.remove("tapped"), 240);
  tg?.HapticFeedback?.impactOccurred?.("light");
}

async function loadProfile() {
  if (!initTelegram()) {
    renderGame(makeMockGame());
    setGate("outside");
    return;
  }

  try {
    setGate(null);
    const game = await api.getGameProfile();
    renderGame(game);
  } catch (error) {
    if (error.code === "WALLET_REQUIRED") {
      setGate("wallet");
      return;
    }
    renderGame(makeMockGame());
    addFeed(error.message || "Mock Mode loaded");
  }
}

async function tapReactor() {
  if (!state.game) return;
  pulseCore();
  floatHash(state.game.profile.hashPerTap);
  if (state.mock) {
    state.game.profile.hash = String(Number(state.game.profile.hash) + state.game.profile.hashPerTap);
    state.game.profile.energy = Math.max(0, state.game.profile.energy - 1);
    renderGame(state.game);
    return;
  }
  try {
    const result = await api.tapReactor();
    renderGame(result.game);
    addFeed(result.message || "Mined Hash");
  } catch (error) {
    addFeed(error.message || "Tap failed");
  }
}

async function collectPassive() {
  if (state.mock) {
    addFeed("Collected passive Hash in Mock Mode");
    return;
  }
  try {
    const result = await api.collectPassive();
    renderGame(result.game);
    addFeed(result.message || "Collected passive Hash");
  } catch (error) {
    addFeed(error.message || "Collect failed");
  }
}

async function buyUpgrade(upgradeId) {
  const def = upgradeDefs.find((item) => item.id === upgradeId);
  if (def?.mockOnly || state.mock) {
    addFeed(`${def?.title ?? upgradeId} is a UI placeholder for the next backend step`);
    return;
  }
  try {
    const result = await api.buyUpgrade(upgradeId);
    renderGame(result.game);
    addFeed(result.message || "Upgrade ready");
  } catch (error) {
    addFeed(error.message || "Upgrade failed");
  }
}

async function buyBoost(boostId) {
  const def = boostDefs.find((item) => item.id === boostId);
  if (def?.mockOnly || state.mock) {
    addFeed(`${def?.title ?? boostId} is a UI placeholder for the next backend step`);
    return;
  }
  try {
    const result = await api.buyBoost(boostId);
    renderGame(result.game);
    addFeed(result.message || "Boost active");
  } catch (error) {
    addFeed(error.message || "Boost failed");
  }
}

async function loadLeaderboard(type) {
  state.board = type;
  document.querySelectorAll(".leader-tab").forEach((button) => button.classList.toggle("active", button.dataset.board === type));
  nodes.leaderboard.innerHTML = "";
  let rows = [];
  if (!state.mock) {
    try {
      rows = (await api.getSeasonLeaderboard(type)).rows;
    } catch {
      rows = [];
    }
  }
  if (!rows.length) {
    rows = mockRows[type].map((name, index) => ({ rank: index + 1, username: name, hash: String(42000 - index * 3900), factoryLevel: 5 - Math.min(index, 3) }));
  }
  for (const row of rows.slice(0, 10)) {
    const div = document.createElement("div");
    div.className = "leader-row";
    div.innerHTML = `<span>#${row.rank}</span><strong>${row.username ? `@${row.username}` : "operator"}</strong><em>${fmt(row.hash)} Hash</em>`;
    nodes.leaderboard.appendChild(div);
  }
}

function bind() {
  nodes.refreshButton.addEventListener("click", () => void loadProfile());
  nodes.reactorCore.addEventListener("click", () => void tapReactor());
  nodes.collectButton.addEventListener("click", () => void collectPassive());
  nodes.upgradeList.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-upgrade]");
    if (button) void buyUpgrade(button.dataset.upgrade);
  });
  nodes.boostList.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-boost]");
    if (button) void buyBoost(button.dataset.boost);
  });
  document.querySelectorAll("[data-tab-target]").forEach((button) => {
    button.addEventListener("click", () => switchTab(button.dataset.tabTarget));
  });
  document.querySelectorAll(".leader-tab").forEach((button) => {
    button.addEventListener("click", () => void loadLeaderboard(button.dataset.board));
  });
  nodes.copyTreasury.addEventListener("click", async () => {
    await navigator.clipboard?.writeText?.(nodes.treasuryAddress.textContent ?? "");
    addFeed("Treasury address copied");
  });
  nodes.refreshDeposits.addEventListener("click", async () => {
    if (state.mock) {
      addFeed("Deposit refresh is mocked in preview");
      return;
    }
    try {
      const result = await api.refreshDeposits();
      state.game.wallet = result.wallet;
      renderWallet(state.game);
      addFeed(result.message || "Deposits refreshed");
    } catch (error) {
      addFeed(error.message || "Deposit refresh failed");
    }
  });
}

bind();
void loadProfile();
