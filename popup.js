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

const elements = {};

document.addEventListener('DOMContentLoaded', async () => {
  // Cache DOM elements
  elements.idleEnabled = document.getElementById('idleEnabled');
  elements.idleTime = document.getElementById('idleTime');
  elements.idleUnit = document.getElementById('idleUnit');
  elements.memoryEnabled = document.getElementById('memoryEnabled');
  elements.memoryThresholdMB = document.getElementById('memoryThresholdMB');
  elements.duplicatesEnabled = document.getElementById('duplicatesEnabled');
  elements.memoryNote = document.getElementById('memoryNote');
  elements.apiKey = document.getElementById('apiKey');
  elements.organizationMode = document.getElementById('organizationMode');
  elements.organizeBtn = document.getElementById('organizeBtn');
  elements.organizeStatus = document.getElementById('organizeStatus');

  // Load and display settings
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);

  elements.idleEnabled.checked = settings.idleEnabled;
  elements.idleTime.value = settings.idleTime;
  elements.idleUnit.value = settings.idleUnit;
  elements.memoryEnabled.checked = settings.memoryEnabled;
  elements.memoryThresholdMB.value = settings.memoryThresholdMB;
  elements.duplicatesEnabled.checked = settings.duplicatesEnabled;
  elements.apiKey.value = settings.apiKey;
  elements.organizationMode.value = settings.organizationMode;

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
  elements.idleTime.addEventListener('change', saveSettings);
  elements.idleUnit.addEventListener('change', saveSettings);
  elements.memoryEnabled.addEventListener('change', saveSettings);
  elements.memoryThresholdMB.addEventListener('change', saveSettings);
  elements.duplicatesEnabled.addEventListener('change', saveSettings);
  elements.apiKey.addEventListener('change', saveSettings);
  elements.organizationMode.addEventListener('change', saveSettings);

  // Organize button
  elements.organizeBtn.addEventListener('click', organizeWorkspaces);
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
    idleTime: parseInt(elements.idleTime.value, 10) || 30,
    idleUnit: elements.idleUnit.value,
    memoryEnabled: elements.memoryEnabled.checked,
    memoryThresholdMB: parseInt(elements.memoryThresholdMB.value, 10) || 500,
    duplicatesEnabled: elements.duplicatesEnabled.checked,
    apiKey: elements.apiKey.value,
    organizationMode: elements.organizationMode.value
  };

  await chrome.storage.sync.set(settings);
}

async function organizeWorkspaces() {
  const apiKey = elements.apiKey.value.trim();
  if (!apiKey) {
    elements.organizeStatus.textContent = 'Enter API key first';
    elements.organizeStatus.className = 'organize-status error';
    return;
  }

  // Save API key before organizing (in case it wasn't saved yet)
  await chrome.storage.sync.set({ apiKey });

  elements.organizeBtn.disabled = true;
  elements.organizeStatus.textContent = 'Organizing...';
  elements.organizeStatus.className = 'organize-status';

  try {
    const response = await chrome.runtime.sendMessage({ action: 'organizeWorkspaces' });

    if (response.error) {
      elements.organizeStatus.textContent = response.error;
      elements.organizeStatus.className = 'organize-status error';
    } else if (response.count === 0) {
      elements.organizeStatus.textContent = 'No workspaces found';
      elements.organizeStatus.className = 'organize-status';
    } else {
      elements.organizeStatus.textContent = `Created ${response.count} workspace(s)`;
      elements.organizeStatus.className = 'organize-status success';
    }
  } catch (e) {
    elements.organizeStatus.textContent = e.message;
    elements.organizeStatus.className = 'organize-status error';
  }

  elements.organizeBtn.disabled = false;
  loadLogs();
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

  const reasonLabels = { idle: 'idle', duplicate: 'dup', memory: 'mem' };

  container.innerHTML = closedTabs.map(tab => {
    const timeStr = new Date(tab.closedAt).toLocaleTimeString();
    const title = tab.title.length > 40 ? tab.title.slice(0, 40) + '...' : tab.title;

    return `
      <div class="closed-tab">
        <div class="closed-tab-info">
          <div class="closed-tab-title" title="${tab.title}">${title}</div>
          <div class="closed-tab-meta">
            <span class="closed-tab-time">${timeStr}</span>
            <span class="closed-tab-reason">${reasonLabels[tab.reason] || tab.reason}</span>
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

  try {
    const tabs = await chrome.tabs.query({});
    const { tabActivityData = {} } = await chrome.storage.local.get('tabActivityData');
    const now = Date.now();

    if (tabs.length === 0) {
      container.innerHTML = '<div class="empty-state">No tabs found</div>';
      return;
    }

    // Count URLs for duplicate detection
    const urlCounts = new Map();
    tabs.forEach(tab => {
      if (tab.url && !tab.url.startsWith('chrome://')) {
        urlCounts.set(tab.url, (urlCounts.get(tab.url) || 0) + 1);
      }
    });

    // Sort by idle time descending
    const sortedTabs = tabs
      .map(tab => ({
        ...tab,
        idleMinutes: Math.round((now - (tabActivityData[tab.id] || now)) / 60000),
        isDupe: urlCounts.get(tab.url) > 1
      }))
      .sort((a, b) => b.idleMinutes - a.idleMinutes);

    container.innerHTML = sortedTabs.map(tab => {
      const title = (tab.title || 'Untitled').slice(0, 30) + (tab.title?.length > 30 ? '...' : '');
      const badges = [
        tab.active && '<span class="badge badge-active">active</span>',
        tab.pinned && '<span class="badge badge-pinned">pinned</span>',
        tab.isDupe && '<span class="badge badge-dupe">dupe</span>'
      ].filter(Boolean).join('');
      const idleStr = tab.idleMinutes > 0 ? `${tab.idleMinutes}m` : '<1m';

      return `
        <div class="active-tab">
          <span class="active-tab-title" title="${tab.title || ''}">${title}</span>
          <span class="active-tab-badges">${badges}</span>
          <span class="active-tab-idle">⏱${idleStr}</span>
        </div>
      `;
    }).join('');
  } catch (e) {
    container.innerHTML = `<div class="empty-state">Error: ${e.message}</div>`;
  }
}
