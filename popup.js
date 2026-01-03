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
