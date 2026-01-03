// Tab activity tracking
const tabActivity = new Map();

// Default settings
const DEFAULT_SETTINGS = {
  idleEnabled: true,
  idleMinutes: 30,
  memoryEnabled: false,
  memoryThresholdMB: 500,
  duplicatesEnabled: true
};

let settings = { ...DEFAULT_SETTINGS };

// Activity log (stored for popup display)
async function log(message) {
  console.log(`[TabCloser] ${message}`);
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
    favIconUrl: tab.favIconUrl,
    closedAt: Date.now(),
    reason
  }));
  const updated = [...newEntries, ...closedTabs].slice(0, 100); // Keep last 100
  await chrome.storage.local.set({ closedTabs: updated });
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
  initializeTabActivity();
  setupAlarm();
  await log('Extension installed');
});

chrome.runtime.onStartup.addListener(async () => {
  await loadSettings();
  initializeTabActivity();
  setupAlarm();
});

// Initialize activity for all existing tabs
async function initializeTabActivity() {
  const tabs = await chrome.tabs.query({});
  const now = Date.now();
  tabs.forEach(tab => {
    if (!tabActivity.has(tab.id)) {
      tabActivity.set(tab.id, now);
    }
  });
}

// Set up periodic check alarm (every 1 minute)
function setupAlarm() {
  chrome.alarms.create('checkTabs', { periodInMinutes: 1 });
}

// Track tab activation
chrome.tabs.onActivated.addListener(({ tabId }) => {
  tabActivity.set(tabId, Date.now());
});

// Track tab updates (for new tabs)
chrome.tabs.onCreated.addListener((tab) => {
  tabActivity.set(tab.id, Date.now());
});

// Clean up when tabs close
chrome.tabs.onRemoved.addListener((tabId) => {
  tabActivity.delete(tabId);
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
    await log('Running check...');
    await runChecks();
  }
});

// Expose runChecks globally for manual testing via DevTools console
// Usage: Type `runChecks()` in the service worker console
globalThis.runChecks = runChecks;

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

// Check and close idle tabs
async function checkIdleTabs() {
  const tabs = await chrome.tabs.query({});
  const now = Date.now();
  const idleThreshold = settings.idleMinutes * 60 * 1000;

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
    await saveClosedTabs(tabsToClose, 'idle');
    await log(`Closed ${tabsToClose.length} idle tab(s)`);
    await chrome.tabs.remove(tabsToClose.map(t => t.id));
  }
}

// Check and close memory-heavy tabs
async function checkMemoryTabs() {
  // Check if processes API is available
  if (!chrome.processes) {
    return;
  }

  try {
    const processInfo = await chrome.processes.getProcessInfo([], true);
    const tabs = await chrome.tabs.query({});
    const thresholdBytes = settings.memoryThresholdMB * 1024 * 1024;

    const tabsToClose = [];

    for (const tab of tabs) {
      // Skip pinned tabs and active tab
      if (tab.pinned || tab.active) continue;

      // Find process for this tab
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
      await saveClosedTabs(tabsToClose, 'memory');
      await log(`Closed ${tabsToClose.length} memory-heavy tab(s)`);
      await chrome.tabs.remove(tabsToClose.map(t => t.id));
    }
  } catch (e) {
    // Processes API not available or error
    console.log('Memory check unavailable:', e.message);
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
    await saveClosedTabs(tabsToClose, 'duplicate');
    await log(`Closed ${tabsToClose.length} duplicate tab(s)`);
    await chrome.tabs.remove(tabsToClose.map(t => t.id));
  }
}
