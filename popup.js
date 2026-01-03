const DEFAULT_SETTINGS = {
  idleEnabled: true,
  idleMinutes: 30,
  memoryEnabled: false,
  memoryThresholdMB: 500,
  duplicatesEnabled: true
};

const elements = {};

document.addEventListener('DOMContentLoaded', async () => {
  // Cache DOM elements
  elements.idleEnabled = document.getElementById('idleEnabled');
  elements.idleMinutes = document.getElementById('idleMinutes');
  elements.memoryEnabled = document.getElementById('memoryEnabled');
  elements.memoryThresholdMB = document.getElementById('memoryThresholdMB');
  elements.duplicatesEnabled = document.getElementById('duplicatesEnabled');
  elements.memoryNote = document.getElementById('memoryNote');

  // Load and display settings
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);

  elements.idleEnabled.checked = settings.idleEnabled;
  elements.idleMinutes.value = settings.idleMinutes;
  elements.memoryEnabled.checked = settings.memoryEnabled;
  elements.memoryThresholdMB.value = settings.memoryThresholdMB;
  elements.duplicatesEnabled.checked = settings.duplicatesEnabled;

  // Check if processes API is available
  checkMemoryApiAvailable();

  // Load and display logs
  loadLogs();

  // Load and display closed tabs
  loadClosedTabs();

  // Clear history button
  document.getElementById('clearHistory').addEventListener('click', clearClosedTabs);

  // Debug refresh button
  document.getElementById('refreshDebug').addEventListener('click', loadDebugInfo);
  loadDebugInfo();

  // Add event listeners
  elements.idleEnabled.addEventListener('change', saveSettings);
  elements.idleMinutes.addEventListener('change', saveSettings);
  elements.memoryEnabled.addEventListener('change', saveSettings);
  elements.memoryThresholdMB.addEventListener('change', saveSettings);
  elements.duplicatesEnabled.addEventListener('change', saveSettings);
});

async function checkMemoryApiAvailable() {
  // Check if we have the processes permission
  const hasPermission = await chrome.permissions.contains({ permissions: ['processes'] });

  if (!hasPermission) {
    elements.memoryNote.textContent = 'Requires additional permission';
    elements.memoryEnabled.addEventListener('change', async (e) => {
      if (e.target.checked) {
        const granted = await chrome.permissions.request({ permissions: ['processes'] });
        if (!granted) {
          e.target.checked = false;
          elements.memoryNote.textContent = 'Permission denied';
        } else {
          elements.memoryNote.textContent = '';
        }
      }
    });
  }
}

async function saveSettings() {
  const settings = {
    idleEnabled: elements.idleEnabled.checked,
    idleMinutes: parseInt(elements.idleMinutes.value, 10) || 30,
    memoryEnabled: elements.memoryEnabled.checked,
    memoryThresholdMB: parseInt(elements.memoryThresholdMB.value, 10) || 500,
    duplicatesEnabled: elements.duplicatesEnabled.checked
  };

  await chrome.storage.sync.set(settings);
}

async function loadLogs() {
  const { logs = [] } = await chrome.storage.local.get('logs');
  const logsDiv = document.getElementById('logs');

  if (logs.length === 0) {
    logsDiv.innerHTML = '<div class="log-entry">No activity yet</div>';
    return;
  }

  logsDiv.innerHTML = logs.map(entry => {
    const time = new Date(entry.time);
    const timeStr = time.toLocaleTimeString();
    return `<div class="log-entry"><span class="log-time">${timeStr}</span> ${entry.message}</div>`;
  }).join('');
}

async function loadClosedTabs() {
  const { closedTabs = [] } = await chrome.storage.local.get('closedTabs');
  const container = document.getElementById('closedTabs');

  if (closedTabs.length === 0) {
    container.innerHTML = '<div class="empty-state">No closed tabs yet</div>';
    return;
  }

  container.innerHTML = closedTabs.map((tab, index) => {
    const time = new Date(tab.closedAt);
    const timeStr = time.toLocaleTimeString();
    const title = tab.title.length > 40 ? tab.title.substring(0, 40) + '...' : tab.title;
    const reasonLabel = { idle: 'idle', duplicate: 'dup', memory: 'mem' }[tab.reason] || tab.reason;

    return `
      <div class="closed-tab" data-index="${index}">
        <div class="closed-tab-info">
          <div class="closed-tab-title" title="${tab.title}">${title}</div>
          <div class="closed-tab-meta">
            <span class="closed-tab-time">${timeStr}</span>
            <span class="closed-tab-reason">${reasonLabel}</span>
          </div>
        </div>
        <button class="reopen-btn" data-url="${tab.url}">Reopen</button>
      </div>
    `;
  }).join('');

  // Add click handlers for reopen buttons
  container.querySelectorAll('.reopen-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const url = e.target.dataset.url;
      chrome.tabs.create({ url });
    });
  });
}

async function clearClosedTabs() {
  await chrome.storage.local.set({ closedTabs: [] });
  loadClosedTabs();
}

async function loadDebugInfo() {
  const container = document.getElementById('debugTabs');
  container.innerHTML = '<div class="empty-state">Loading...</div>';

  try {
    // Get all windows first, then all tabs
    const windows = await chrome.windows.getAll({ populate: true });
    const tabs = windows.flatMap(w => w.tabs || []);

    // Debug: log tabs per window
    console.log('[TabCloser Debug] Windows:', windows.map(w => ({
      id: w.id,
      type: w.type,
      tabCount: w.tabs?.length || 0
    })));

    const { tabActivityData = {} } = await chrome.storage.local.get('tabActivityData');
    const now = Date.now();

    // Build URL counts for duplicate detection
    const urlCounts = new Map();
    for (const tab of tabs) {
      if (tab.url && !tab.url.startsWith('chrome://')) {
        urlCounts.set(tab.url, (urlCounts.get(tab.url) || 0) + 1);
      }
    }

    // Build debug info
    const debugInfo = tabs.map(tab => {
      const lastActive = tabActivityData[tab.id] || now;
      const idleMinutes = Math.round((now - lastActive) / 60000);
      const isDupe = urlCounts.get(tab.url) > 1;

      return {
        id: tab.id,
        title: tab.title || 'Untitled',
        url: tab.url,
        idleMinutes,
        memoryMB: null, // Can't get memory from popup
        isDupe,
        isPinned: tab.pinned,
        isActive: tab.active
      };
    });

    const windowInfo = windows.map(w => w.tabs?.length || 0).join('+');
    document.getElementById('tabCount').textContent = `${debugInfo.length} (${windowInfo})`;

    if (debugInfo.length === 0) {
      container.innerHTML = '<div class="empty-state">No tabs found</div>';
      return;
    }

    // Sort by idle time descending
    debugInfo.sort((a, b) => b.idleMinutes - a.idleMinutes);

    container.innerHTML = debugInfo.map(tab => {
      const title = tab.title.length > 30 ? tab.title.substring(0, 30) + '...' : tab.title;
      const badges = [];

      if (tab.isActive) badges.push('<span class="badge badge-active">active</span>');
      if (tab.isPinned) badges.push('<span class="badge badge-pinned">pinned</span>');
      if (tab.isDupe) badges.push('<span class="badge badge-dupe">dupe</span>');

      const idleStr = tab.idleMinutes > 0 ? `${tab.idleMinutes}m` : '<1m';

      return `
        <div class="debug-tab">
          <div class="debug-tab-title" title="${tab.title}">${title}</div>
          <div class="debug-tab-badges">${badges.join('')}</div>
          <div class="debug-tab-metrics">
            <span class="metric" title="Idle time">⏱${idleStr}</span>
          </div>
        </div>
      `;
    }).join('');
  } catch (e) {
    container.innerHTML = `<div class="empty-state">Error: ${e.message}</div>`;
  }
}
