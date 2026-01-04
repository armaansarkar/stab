// Tab activity tracking (persisted to survive service worker restarts)
let tabActivity = new Map();

// Workspace tracking
let previousTabId = null;
let previousTabStart = null;
const MIN_DWELL_MS = 3000; // 3 seconds minimum to count as meaningful

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
  duplicatesEnabled: true,
  apiKey: '',
  organizationMode: 'groups'
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

// Track tab activation with dwell time
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const now = Date.now();

  // Update basic activity tracking
  tabActivity.set(tabId, now);
  await saveTabActivity();

  // Calculate dwell time in previous tab
  if (previousTabId && previousTabStart) {
    const dwellMs = now - previousTabStart;

    // Update engagement for previous tab
    await updateEngagement(previousTabId, dwellMs);

    // Only record relationship if meaningful dwell time
    if (dwellMs >= MIN_DWELL_MS && previousTabId !== tabId) {
      await recordRelationship(previousTabId, tabId, dwellMs);
    }
  }

  previousTabId = tabId;
  previousTabStart = now;
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

// ============================================
// Workspace Organization
// ============================================

// Update engagement tracking for a tab
async function updateEngagement(tabId, dwellMs) {
  const { tabEngagement = {} } = await chrome.storage.local.get('tabEngagement');
  const key = String(tabId);
  if (!tabEngagement[key]) {
    tabEngagement[key] = { totalSeconds: 0, visits: 0 };
  }
  tabEngagement[key].totalSeconds += dwellMs / 1000;
  tabEngagement[key].visits += 1;
  await chrome.storage.local.set({ tabEngagement });
}

// Record relationship between two tabs
async function recordRelationship(fromId, toId, dwellMs) {
  const { tabRelationships = {} } = await chrome.storage.local.get('tabRelationships');
  const key = [fromId, toId].sort().join('-');
  if (!tabRelationships[key]) {
    tabRelationships[key] = { count: 0, totalDwellSeconds: 0 };
  }
  tabRelationships[key].count += 1;
  tabRelationships[key].totalDwellSeconds += dwellMs / 1000;
  await chrome.storage.local.set({ tabRelationships });
}

// Detect workspaces using LLM
async function detectWorkspaces(apiKey) {
  const tabs = await chrome.tabs.query({});
  const { tabRelationships = {}, tabEngagement = {} } =
    await chrome.storage.local.get(['tabRelationships', 'tabEngagement']);

  // Filter to only tabs that still exist
  const existingTabIds = new Set(tabs.map(t => t.id));

  // Build data for LLM with engagement info
  const tabData = tabs
    .filter(t => t.url && !t.url.startsWith('chrome://'))
    .map(t => {
      const engagement = tabEngagement[t.id] || { totalSeconds: 0, visits: 0 };
      return {
        id: t.id,
        title: t.title || 'Untitled',
        domain: new URL(t.url).hostname,
        timeSpentMin: Math.round(engagement.totalSeconds / 60),
        visits: engagement.visits
      };
    });

  // Get significant relationships (weighted by dwell time)
  const relationships = Object.entries(tabRelationships)
    .map(([key, data]) => {
      const [id1, id2] = key.split('-').map(Number);
      // Only include relationships where both tabs still exist
      if (!existingTabIds.has(id1) || !existingTabIds.has(id2)) return null;
      return {
        pair: [id1, id2],
        count: data.count,
        avgDwellSec: Math.round(data.totalDwellSeconds / data.count)
      };
    })
    .filter(r => r && r.count >= 2)
    .sort((a, b) => (b.count * b.avgDwellSec) - (a.count * a.avgDwellSec))
    .slice(0, 50); // Limit to top 50 relationships

  if (tabData.length < 2) {
    return { workspaces: [] };
  }

  // Build prompt
  const tabLines = tabData.map(t =>
    `[id:${t.id}] "${t.title}" | ${t.domain} | ${t.timeSpentMin} min, ${t.visits} visits`
  ).join('\n');

  const relLines = relationships.map(r =>
    `Tabs ${r.pair[0]} ↔ ${r.pair[1]}: ${r.count} transitions, avg ${r.avgDwellSec}s dwell`
  ).join('\n');

  const prompt = `Analyze browser tabs to detect workspaces - tabs the user actively uses together.

TAB DATA (with engagement):
${tabLines}

RELATIONSHIP DATA (dwell-weighted, only meaningful transitions):
${relLines || 'No significant relationships recorded yet.'}

Identify workspaces. Consider:
- Relationship strength (transitions × dwell time)
- Time spent in tabs (high = important, low = waypoint)
- Semantic similarity (related content)

Return JSON only: { "workspaces": [{ "name": "Short Name", "tabIds": [123, 456] }] }

Rules:
- Workspace = tabs used together for one task
- Ignore low-engagement tabs (brief visits, just passing through)
- Short names (2-3 words)
- Minimum 2 tabs per workspace
- Tabs without clear workspace can be omitted`;

  // Call Anthropic API
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error('API error:', response.status, errorBody);
      throw new Error(`API error: ${response.status} - ${errorBody.slice(0, 100)}`);
    }

    const result = await response.json();
    const content = result.content[0].text;

    // Parse JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      await log(`LLM found ${parsed.workspaces?.length || 0} workspace(s)`);
      for (const ws of (parsed.workspaces || [])) {
        await log(`  ${ws.name}: tabs ${ws.tabIds?.join(', ')}`);
      }
      return parsed;
    }
    await log('No workspaces in LLM response');
    return { workspaces: [] };
  } catch (e) {
    console.error('Workspace detection failed:', e);
    throw e;
  }
}

// Apply workspaces (create groups or windows)
async function applyWorkspaces(workspaces, mode) {
  const colors = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'];
  let colorIndex = 0;

  // Get current tabs to validate IDs
  const currentTabs = await chrome.tabs.query({});
  const validTabIds = new Set(currentTabs.map(t => t.id));

  for (const ws of workspaces) {
    if (!ws.tabIds || ws.tabIds.length < 2) {
      console.log(`Skipping workspace "${ws.name}": not enough tabs`);
      continue;
    }

    // Filter to only valid tab IDs
    const validIds = ws.tabIds.filter(id => validTabIds.has(id));
    await log(`${ws.name}: ${validIds.length}/${ws.tabIds.length} tabs valid`);

    if (validIds.length < 2) {
      await log(`Skipped ${ws.name}: need 2+ tabs`);
      continue;
    }

    try {
      if (mode === 'windows') {
        // Move to new window
        console.log(`Creating window for "${ws.name}" with tabs:`, validIds);
        const newWindow = await chrome.windows.create({ tabId: validIds[0] });
        console.log(`Window created:`, newWindow);
        if (validIds.length > 1) {
          const moved = await chrome.tabs.move(validIds.slice(1), {
            windowId: newWindow.id,
            index: -1
          });
          console.log(`Moved tabs:`, moved);
        }
        await log(`Created window: ${ws.name}`);
      } else {
        // Create tab group (default)
        console.log(`Creating group with tabs:`, validIds);
        const groupId = await chrome.tabs.group({ tabIds: validIds });
        await chrome.tabGroups.update(groupId, {
          title: ws.name,
          color: colors[colorIndex % colors.length]
        });
        await log(`Created group: ${ws.name}`);
        colorIndex++;
      }
    } catch (e) {
      console.error(`Failed to create workspace "${ws.name}":`, e);
      await log(`Failed: ${ws.name} - ${e.message}`);
    }
  }
}

// Handle messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'organizeWorkspaces') {
    (async () => {
      try {
        await loadSettings();
        const apiKey = settings.apiKey;
        if (!apiKey) {
          sendResponse({ error: 'No API key configured' });
          return;
        }

        await log('Detecting workspaces...');
        console.log('Using API key:', apiKey ? `${apiKey.slice(0, 10)}...` : 'none');
        const result = await detectWorkspaces(apiKey);

        if (result.workspaces && result.workspaces.length > 0) {
          await applyWorkspaces(result.workspaces, settings.organizationMode || 'groups');
          await log(`Created ${result.workspaces.length} workspace(s)`);
          sendResponse({ success: true, count: result.workspaces.length });
        } else {
          await log('No workspaces detected');
          sendResponse({ success: true, count: 0 });
        }
      } catch (e) {
        await log(`Error: ${e.message}`);
        sendResponse({ error: e.message });
      }
    })();
    return true; // Keep channel open for async response
  }
});
