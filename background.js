// Tab activity tracking (persisted to survive service worker restarts)
let tabActivity = new Map();

// Load tab activity from storage
async function loadTabActivity() {
  const { tabActivityData = {} } = await chrome.storage.local.get('tabActivityData');
  tabActivity = new Map(Object.entries(tabActivityData).map(([k, v]) => [parseInt(k), v]));
}

// Save tab activity to storage
async function saveTabActivity() {
  const data = Object.fromEntries(tabActivity);
  await chrome.storage.local.set({ tabActivityData: data });
}

// Default settings
const DEFAULT_SETTINGS = {
  idleEnabled: true,
  idleTime: 30,
  idleUnit: 'minutes',
  memoryEnabled: false,
  memoryThresholdMB: 500,
  duplicatesEnabled: true
};

let settings = { ...DEFAULT_SETTINGS };

// Activity log (stored for popup display)
async function log(message) {
  console.log(`[Stab] ${message}`);
  const { logs = [] } = await chrome.storage.local.get('logs');
  logs.unshift({ time: Date.now(), message });
  // Keep only last 20 entries
  await chrome.storage.local.set({ logs: logs.slice(0, 20) });
}

// Save closed tabs to history
async function saveClosedTabs(tabs, reason) {
  const { closedTabs = [] } = await chrome.storage.local.get('closedTabs');
  const newEntries = tabs.map(tab => ({
    url: tab.url,
    title: tab.title || tab.url,
    closedAt: Date.now(),
    reason
  }));
  await chrome.storage.local.set({ closedTabs: [...newEntries, ...closedTabs].slice(0, 100) });
}

// Load settings from storage
async function loadSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  settings = stored;
  return settings;
}

// Initialize on install/startup
chrome.runtime.onInstalled.addListener(async () => {
  await loadSettings();
  await loadTabActivity();
  await initializeTabActivity();
  setupAlarm();
  await log('Extension installed');
});

chrome.runtime.onStartup.addListener(async () => {
  await loadSettings();
  await loadTabActivity();
  await initializeTabActivity();
  setupAlarm();
});

// Initialize activity for all existing tabs
async function initializeTabActivity() {
  const tabs = await chrome.tabs.query({});
  const now = Date.now();
  let changed = false;
  tabs.forEach(tab => {
    if (!tabActivity.has(tab.id)) {
      tabActivity.set(tab.id, now);
      changed = true;
    }
  });
  if (changed) await saveTabActivity();
}

// Set up periodic check alarm (every 1 minute)
function setupAlarm() {
  chrome.alarms.create('checkTabs', { periodInMinutes: 1 });
}

// Track tab activation
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  tabActivity.set(tabId, Date.now());
  await saveTabActivity();
});

// Track tab updates (for new tabs)
chrome.tabs.onCreated.addListener(async (tab) => {
  tabActivity.set(tab.id, Date.now());
  await saveTabActivity();
});

// Clean up when tabs close
chrome.tabs.onRemoved.addListener(async (tabId) => {
  tabActivity.delete(tabId);
  await saveTabActivity();
});

// Listen for settings changes
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'sync') {
    for (const [key, { newValue }] of Object.entries(changes)) {
      settings[key] = newValue;
    }
  }
});

// Alarm handler - run checks
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'checkTabs') {
    await loadTabActivity(); // Reload in case service worker restarted
    await log('Running check...');
    await runChecks();
  }
});

// Main check function
async function runChecks() {
  await loadSettings();

  if (settings.duplicatesEnabled) {
    await checkDuplicateTabs();
  }

  if (settings.idleEnabled) {
    await checkIdleTabs();
  }

  if (settings.memoryEnabled) {
    await checkMemoryTabs();
  }
}

// Convert idle time to milliseconds based on unit
function getIdleThresholdMs() {
  const multipliers = { minutes: 60 * 1000, hours: 60 * 60 * 1000, days: 24 * 60 * 60 * 1000 };
  return settings.idleTime * (multipliers[settings.idleUnit] || multipliers.minutes);
}

// Check and close idle tabs
async function checkIdleTabs() {
  const tabs = await chrome.tabs.query({});
  const now = Date.now();
  const idleThreshold = getIdleThresholdMs();

  const tabsToClose = [];

  for (const tab of tabs) {
    // Skip pinned tabs and active tab
    if (tab.pinned || tab.active) continue;

    const lastActive = tabActivity.get(tab.id) || now;
    if (now - lastActive > idleThreshold) {
      tabsToClose.push(tab);
    }
  }

  if (tabsToClose.length > 0) {
    try {
      await chrome.tabs.remove(tabsToClose.map(t => t.id));
      await saveClosedTabs(tabsToClose, 'idle');
      await log(`Closed ${tabsToClose.length} idle tab(s)`);
    } catch (e) {
      console.log('Failed to close idle tabs:', e.message);
    }
  }
}

// Check and close memory-heavy tabs
async function checkMemoryTabs() {
  if (!chrome.processes) return;

  try {
    const processInfo = await chrome.processes.getProcessInfo([], true);
    const tabs = await chrome.tabs.query({});
    const thresholdBytes = settings.memoryThresholdMB * 1024 * 1024;

    const tabsToClose = [];

    for (const tab of tabs) {
      if (tab.pinned || tab.active) continue;

      for (const [, process] of Object.entries(processInfo)) {
        if (process.tabs && process.tabs.includes(tab.id)) {
          if (process.privateMemory > thresholdBytes) {
            tabsToClose.push(tab);
          }
          break;
        }
      }
    }

    if (tabsToClose.length > 0) {
      await chrome.tabs.remove(tabsToClose.map(t => t.id));
      await saveClosedTabs(tabsToClose, 'memory');
      await log(`Closed ${tabsToClose.length} memory-heavy tab(s)`);
    }
  } catch (e) {
    // Memory API not available or error - silently ignore
  }
}

// Check and close duplicate tabs
async function checkDuplicateTabs() {
  const tabs = await chrome.tabs.query({});
  const urlGroups = new Map();

  // Group tabs by URL
  for (const tab of tabs) {
    // Skip tabs without URLs, pinned tabs, or chrome:// pages
    if (!tab.url || tab.pinned || tab.url.startsWith('chrome://')) continue;

    const url = tab.url;
    if (!urlGroups.has(url)) {
      urlGroups.set(url, []);
    }
    urlGroups.get(url).push(tab);
  }

  const tabsToClose = [];

  // For each group with duplicates, keep most recently active
  for (const [, tabGroup] of urlGroups) {
    if (tabGroup.length <= 1) continue;

    // Sort by last active time (most recent first)
    tabGroup.sort((a, b) => {
      const aTime = tabActivity.get(a.id) || 0;
      const bTime = tabActivity.get(b.id) || 0;
      return bTime - aTime;
    });

    // Keep the first (most recent), close the rest (unless active)
    for (let i = 1; i < tabGroup.length; i++) {
      if (!tabGroup[i].active) {
        tabsToClose.push(tabGroup[i]);
      }
    }
  }

  if (tabsToClose.length > 0) {
    try {
      await chrome.tabs.remove(tabsToClose.map(t => t.id));
      await saveClosedTabs(tabsToClose, 'duplicate');
      await log(`Closed ${tabsToClose.length} duplicate tab(s)`);
    } catch (e) {
      console.log('Failed to close duplicate tabs:', e.message);
    }
  }
}
