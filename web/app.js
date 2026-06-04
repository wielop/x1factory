const tg = window.Telegram?.WebApp ?? null;

const moduleOrder = ["reactor", "fuel", "claim", "stability"];

const moduleMeta = {
  reactor: {
    title: "Reactor Core",
    hint: "Tap output",
    description: "Raises MIND per tap.",
    effect: (dashboard) => `1 MIND per ${dashboard.reactorCoreLevel ? tapsPerMind(dashboard.reactorCoreLevel) : 20} taps`
  },
  fuel: {
    title: "Fuel Cell",
    hint: "Daily energy",
    description: "Raises the daily tap cap.",
    effect: (dashboard) => `${dashboard.dailyTapCap} taps/day`
  },
  claim: {
    title: "Claim Terminal",
    hint: "XNT fee",
    description: "Lowers claim cost.",
    effect: (dashboard) => `1 MIND = ${dashboard.claimPricePerMind} XNT`
  },
  stability: {
    title: "Stability Module",
    hint: "Streak safety",
    description: "Strengthens streak bonuses.",
    effect: (dashboard) => `${dashboard.streakDays} day streak`
  }
};

const state = {
  dashboard: null,
  demo: false,
  loading: true,
  feed: []
};

const nodes = {
  seasonPill: document.getElementById("seasonPill"),
  claimable: document.getElementById("claimable"),
  statusLine: document.getElementById("statusLine"),
  operatorLevel: document.getElementById("operatorLevel"),
  streakDays: document.getElementById("streakDays"),
  tapsLeft: document.getElementById("tapsLeft"),
  tapPower: document.getElementById("tapPower"),
  claimPrice: document.getElementById("claimPrice"),
  referenceRate: document.getElementById("referenceRate"),
  fundingWallet: document.getElementById("fundingWallet"),
  payoutWallet: document.getElementById("payoutWallet"),
  dailyCap: document.getElementById("dailyCap"),
  boostState: document.getElementById("boostState"),
  todayMind: document.getElementById("todayMind"),
  tapRewardLabel: document.getElementById("tapRewardLabel"),
  treasuryReserve: document.getElementById("treasuryReserve"),
  treasuryBalance: document.getElementById("treasuryBalance"),
  treasuryXnt: document.getElementById("treasuryXnt"),
  claimStatus: document.getElementById("claimStatus"),
  todaySession: document.getElementById("todaySession"),
  feedLog: document.getElementById("feedLog"),
  demoBanner: document.getElementById("demoBanner"),
  tap: document.getElementById("tap"),
  claim: document.getElementById("claim"),
  cancel: document.getElementById("cancel"),
  openMenu: document.getElementById("openMenu"),
  refresh: document.getElementById("refresh"),
  upgradeGrid: document.getElementById("upgradeGrid"),
  tapHint: document.getElementById("tapHint")
};

function tapsPerMind(level) {
  const table = [20, 19, 18, 17, 16, 15, 14, 13, 12, 10];
  return table[Math.max(1, Math.min(10, level)) - 1] ?? 20;
}

function shortAddress(address) {
  if (!address) {
    return "-";
  }

  return address.length > 12 ? `${address.slice(0, 4)}...${address.slice(-4)}` : address;
}

function addFeed(message) {
  state.feed = [message, ...state.feed].slice(0, 6);
}

function setLoading(loading) {
  state.loading = loading;
  nodes.tap.disabled = loading || state.demo;
  nodes.claim.disabled = loading || state.demo;
  nodes.cancel.disabled = loading || state.demo;
  nodes.openMenu.disabled = loading;
  nodes.refresh.disabled = loading;
  for (const button of document.querySelectorAll(".upgrade-button")) {
    button.disabled = loading || state.demo || button.dataset.maxed === "1";
  }
}

function getInitData() {
  return tg?.initData ?? "";
}

async function request(path, method = "GET", body = null) {
  const response = await fetch(path, {
    method,
    headers: {
      "content-type": "application/json",
      "x-telegram-init-data": getInitData()
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }

  return payload;
}

function renderFeed() {
  nodes.feedLog.innerHTML = "";
  const items = state.feed.length > 0
    ? state.feed
    : [state.demo ? "Demo surface ready." : "Waiting for reactor activity."];

  for (const item of items) {
    const div = document.createElement("div");
    div.className = "feed-item";
    div.textContent = item;
    nodes.feedLog.appendChild(div);
  }
}

function renderSession(dashboard) {
  nodes.todaySession.innerHTML = "";
  const rows = dashboard.todaySession
    ? [
        `Taps used: ${dashboard.todaySession.tapsUsed}`,
        `MIND earned today: ${dashboard.todaySession.mindEarned}`,
        `XNT spent today: ${dashboard.todaySession.xntSpent}`,
        `Session status: ${dashboard.todaySession.status}`
      ]
    : ["No taps recorded yet."];

  for (const row of rows) {
    const li = document.createElement("li");
    li.textContent = row;
    nodes.todaySession.appendChild(li);
  }
}

function renderUpgrades(dashboard) {
  const modules = [
    {
      id: "reactor",
      level: dashboard.reactorCoreLevel,
      nextCost: dashboard.reactorCoreLevel >= 10 ? null : dashboard.nextReactorCostMind
    },
    {
      id: "fuel",
      level: dashboard.fuelCellLevel,
      nextCost: dashboard.fuelCellLevel >= 10 ? null : dashboard.nextFuelCostMind
    },
    {
      id: "claim",
      level: dashboard.claimTerminalLevel,
      nextCost: dashboard.claimTerminalLevel >= 10 ? null : dashboard.nextClaimCostMind
    },
    {
      id: "stability",
      level: dashboard.stabilityModuleLevel,
      nextCost: dashboard.stabilityModuleLevel >= 10 ? null : dashboard.nextStabilityCostMind
    }
  ];

  nodes.upgradeGrid.innerHTML = "";

  for (const module of modules) {
    const meta = moduleMeta[module.id];
    const card = document.createElement("article");
    card.className = "upgrade-card";
    card.innerHTML = `
      <div class="upgrade-title">
        <strong>${meta.title}</strong>
        <span>${meta.hint}</span>
      </div>
      <div class="upgrade-metric"><span>Level</span><strong>${module.level}/10</strong></div>
      <div class="upgrade-metric"><span>Effect</span><strong>${meta.effect(dashboard)}</strong></div>
      <div class="upgrade-metric"><span>Next cost</span><strong>${module.nextCost ? `${module.nextCost} MIND` : "maxed"}</strong></div>
      <button class="upgrade-button${module.level >= 10 ? " maxed" : ""}" type="button" data-module="${module.id}" data-maxed="${module.level >= 10 ? "1" : "0"}" ${module.level >= 10 ? "disabled" : ""}>
        ${module.level >= 10 ? "Maxed" : `Upgrade ${meta.title}`}
      </button>
    `;
    nodes.upgradeGrid.appendChild(card);
  }
}

function renderDashboard(dashboard) {
  state.dashboard = dashboard;
  state.demo = false;

  nodes.seasonPill.textContent = dashboard.seasonName ?? "Season paused";
  nodes.claimable.textContent = dashboard.claimableMind;
  nodes.statusLine.textContent = dashboard.pendingClaim
    ? "Claim is pending. Finish the XNT top-up to release the payout."
    : dashboard.tapsLeft > 0
      ? "Reactor online. Tap the core to build claimable MIND."
      : "Daily tap budget reached. Come back tomorrow.";
  nodes.operatorLevel.textContent = String(dashboard.operatorLevel ?? 1);
  nodes.streakDays.textContent = `${dashboard.streakDays ?? 0} days`;
  nodes.tapsLeft.textContent = `${dashboard.tapsLeft} / ${dashboard.dailyTapCap}`;
  nodes.tapPower.textContent = `1 / ${dashboard.reactorCoreLevel ? tapsPerMind(dashboard.reactorCoreLevel) : 20} taps`;
  nodes.claimPrice.textContent = `${dashboard.claimPricePerMind} XNT`;
  nodes.referenceRate.textContent = `${dashboard.referenceXntPerMind} XNT`;
  nodes.fundingWallet.textContent = dashboard.clickerWallet ? dashboard.clickerWallet.shortAddress : "not created";
  nodes.payoutWallet.textContent = dashboard.payoutWallet ? dashboard.payoutWallet.shortAddress : "not set";
  nodes.dailyCap.textContent = `${dashboard.dailyTapCap} taps`;
  nodes.boostState.textContent = dashboard.currentBoost ?? "none";
  nodes.todayMind.textContent = `${dashboard.todaySession?.mindEarned ?? "0"} MIND`;
  nodes.tapRewardLabel.textContent = `+${dashboard.tapRewardMind ?? "0"} MIND`;
  nodes.treasuryReserve.textContent = `${dashboard.treasury.mindReserveFloor} MIND`;
  nodes.treasuryBalance.textContent = `${dashboard.treasury.mindTreasuryBalance} MIND`;
  nodes.treasuryXnt.textContent = `${dashboard.treasury.xntTreasuryBalance} XNT`;
  nodes.claimStatus.textContent = dashboard.pendingClaim
    ? `${dashboard.pendingClaim.paymentStatus} · ${dashboard.pendingClaim.xntRequired} XNT`
    : "none";

  if (dashboard.payoutWallet) {
    nodes.tapHint.textContent = "Tap the reactor core to add MIND to your claimable balance.";
  } else {
    nodes.tapHint.textContent = "Connect your season wallet first to unlock the reactor.";
  }

  nodes.demoBanner.classList.add("hidden");
  renderSession(dashboard);
  renderUpgrades(dashboard);
  renderFeed();
  syncButtons();
}

function renderDemo(reason) {
  state.demo = true;
  nodes.seasonPill.textContent = "Season 0";
  nodes.claimable.textContent = "0.120";
  nodes.statusLine.textContent = reason || "Demo mode. Open from Telegram to use live state.";
  nodes.operatorLevel.textContent = "1";
  nodes.streakDays.textContent = "0 days";
  nodes.tapsLeft.textContent = "48 / 50";
  nodes.tapPower.textContent = "1 / 20 taps";
  nodes.claimPrice.textContent = "0.050 XNT";
  nodes.referenceRate.textContent = "0.075 XNT";
  nodes.fundingWallet.textContent = "demo-clicker-wallet";
  nodes.payoutWallet.textContent = "demo-wallet";
  nodes.dailyCap.textContent = "50 taps";
  nodes.boostState.textContent = "none";
  nodes.todayMind.textContent = "0.04 MIND";
  nodes.tapRewardLabel.textContent = "+0.05 MIND";
  nodes.treasuryReserve.textContent = "5000 MIND";
  nodes.treasuryBalance.textContent = "5000 MIND";
  nodes.treasuryXnt.textContent = "0 XNT";
  nodes.claimStatus.textContent = "none";
  nodes.todaySession.innerHTML = "<li>No live session in demo mode.</li>";
  nodes.upgradeGrid.innerHTML = "";
  for (const module of moduleOrder) {
    const meta = moduleMeta[module];
    const card = document.createElement("article");
    card.className = "upgrade-card";
    card.innerHTML = `
      <div class="upgrade-title">
        <strong>${meta.title}</strong>
        <span>${meta.hint}</span>
      </div>
      <div class="upgrade-metric"><span>Level</span><strong>1/10</strong></div>
      <div class="upgrade-metric"><span>Effect</span><strong>${meta.description}</strong></div>
      <div class="upgrade-metric"><span>Next cost</span><strong>coming soon</strong></div>
      <button class="upgrade-button" type="button" disabled>Locked</button>
    `;
    nodes.upgradeGrid.appendChild(card);
  }
  nodes.demoBanner.classList.remove("hidden");
  renderFeed();
  syncButtons();
}

function syncButtons() {
  const active = !state.loading;
  nodes.tap.disabled = !active || state.demo;
  nodes.claim.disabled = !active || state.demo;
  nodes.cancel.disabled = !active || state.demo;
  nodes.openMenu.disabled = !active;
  for (const button of document.querySelectorAll(".upgrade-button")) {
    const isMaxed = button.dataset.maxed === "1";
    button.disabled = !active || state.demo || isMaxed;
  }
}

function tapBurst() {
  const button = nodes.tap;
  button.classList.remove("tapped");
  void button.offsetWidth;
  button.classList.add("tapped");
  setTimeout(() => button.classList.remove("tapped"), 520);
}

async function loadDashboard() {
  setLoading(true);

  try {
    const response = await request("/api/clicker");
    renderDashboard(response.dashboard);
    addFeed("Live dashboard loaded.");
  } catch (error) {
    renderDemo(error instanceof Error ? error.message : "Unable to load live factory state.");
  } finally {
    setLoading(false);
  }
}

async function runAction(path, label, method = "POST", body = null) {
  setLoading(true);

  try {
    const response = await request(path, method, body);
    renderDashboard(response.dashboard);
    addFeed(response.message || label);
    if (label === "Run Factory") {
      tapBurst();
    }
  } catch (error) {
    addFeed(error instanceof Error ? error.message : `${label} failed.`);
    if (!state.dashboard) {
      renderDemo(error instanceof Error ? error.message : "Unable to load live factory state.");
    }
  } finally {
    setLoading(false);
  }
}

function bindEvents() {
  nodes.refresh.addEventListener("click", () => void loadDashboard());
  nodes.tap.addEventListener("click", () => {
    tapBurst();
    void runAction("/api/tap", "Run Factory");
  });
  nodes.claim.addEventListener("click", () => void runAction("/api/claim", "Claim MIND"));
  nodes.cancel.addEventListener("click", () => void runAction("/api/cancel", "Cancel Claim"));
  nodes.openMenu.addEventListener("click", () => tg?.close());
  nodes.upgradeGrid.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    const button = target.closest("button[data-module]");
    if (!button) {
      return;
    }

    const module = button.dataset.module;
    if (!module) {
      return;
    }

    void runAction("/api/upgrade", `Upgrade ${module}`, "POST", { module });
  });

  tg?.BackButton?.onClick(() => tg.close());
  if (tg) {
    tg.ready();
    tg.expand();
    tg.BackButton?.show();
    tg.MainButton.setText("Close");
    tg.MainButton.onClick(() => tg.close());
    tg.MainButton.show();
  }
}

bindEvents();
void loadDashboard();
