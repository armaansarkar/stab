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

// Expose runChecks globally for manual testing via DevTools console
globalThis.runChecks = runChecks;

// Get debug info for all tabs
async function getDebugInfo() {
  await loadTabActivity();
  const tabs = await chrome.tabs.query({});
  const now = Date.now();

  // Get memory info if available
  let processInfo = {};
  if (chrome.processes) {
    try {
      processInfo = await chrome.processes.getProcessInfo([], true);
    } catch (e) {}
  }

  // Build URL groups for duplicate detection
  const urlCounts = new Map();
  for (const tab of tabs) {
    if (tab.url && !tab.url.startsWith('chrome://')) {
      urlCounts.set(tab.url, (urlCounts.get(tab.url) || 0) + 1);
    }
  }

  // Build debug info for each tab
  const debugInfo = tabs.map(tab => {
    const lastActive = tabActivity.get(tab.id) || now;
    const idleMinutes = Math.round((now - lastActive) / 60000);

    // Find memory for this tab
    let memoryMB = null;
    for (const [, process] of Object.entries(processInfo)) {
      if (process.tabs && process.tabs.includes(tab.id)) {
        memoryMB = Math.round((process.privateMemory || 0) / 1024 / 1024);
        break;
      }
    }

    const isDupe = urlCounts.get(tab.url) > 1;

    return {
      id: tab.id,
      title: tab.title || 'Untitled',
      url: tab.url,
      idleMinutes,
      memoryMB,
      isDupe,
      isPinned: tab.pinned,
      isActive: tab.active
    };
  });

  return debugInfo;
}

// Expose for popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getDebugInfo') {
    getDebugInfo().then(sendResponse);
    return true; // Keep channel open for async response
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
  // Check if processes API is available
  if (!chrome.processes) {
    await log('Memory check: API not available');
    return;
  }

  try {
    const processInfo = await chrome.processes.getProcessInfo([], true);
    const tabs = await chrome.tabs.query({});
    const thresholdBytes = settings.memoryThresholdMB * 1024 * 1024;

    const tabsToClose = [];
    let tabsChecked = 0;
    let maxMemory = 0;

    for (const tab of tabs) {
      // Skip pinned tabs and active tab
      if (tab.pinned || tab.active) continue;

      // Find process for this tab
      for (const [processId, process] of Object.entries(processInfo)) {
        if (process.tabs && process.tabs.includes(tab.id)) {
          tabsChecked++;
          const memoryMB = Math.round((process.privateMemory || 0) / 1024 / 1024);
          if (memoryMB > maxMemory) maxMemory = memoryMB;
          if (process.privateMemory > thresholdBytes) {
            tabsToClose.push(tab);
          }
          break;
        }
      }
    }

    await log(`Memory: checked ${tabsChecked} tabs, max ${maxMemory}MB (threshold: ${settings.memoryThresholdMB}MB)`);

    if (tabsToClose.length > 0) {
      await chrome.tabs.remove(tabsToClose.map(t => t.id));
      await saveClosedTabs(tabsToClose, 'memory');
      await log(`Closed ${tabsToClose.length} memory-heavy tab(s)`);
    }
  } catch (e) {
    await log(`Memory check error: ${e.message}`);
    console.log('Memory check error:', e);
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
