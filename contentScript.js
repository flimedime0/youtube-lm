const WATCH_BUTTON_ID = 'ytlm-summarize-btn';
const WATCH_SETTINGS_BUTTON_ID = 'ytlm-settings-btn';
const SHORTS_CONTAINER_ID = 'ytlm-floating-controls';
const SHORTS_BUTTON_ID = 'ytlm-shorts-summarize-btn';
const SHORTS_SETTINGS_BUTTON_ID = 'ytlm-floating-settings-btn';
const SETTINGS_PANEL_ID = 'ytlm-settings-panel';
const SETTINGS_STORAGE_KEY = 'ytlmSettingsV1';
const STYLE_ELEMENT_ID = 'ytlm-shared-styles';

const BUTTON_LABELS = {
  idle: 'Summarize with ChatGPT',
  loadingTranscript: 'Fetching transcript…',
  openingChat: 'Opening ChatGPT…'
};

const DEFAULT_SETTINGS = {
  preferredChatHost: 'chatgpt.com',
  overviewSentences: 3,
  includeTakeaways: true,
  includeActionSteps: true,
  responseLanguage: 'English',
  customInstructions: ''
};

let currentSettings = { ...DEFAULT_SETTINGS };
let settingsLoaded = false;
let settingsLoadPromise = null;
let settingsPanelRefs = null;
let lastFocusedElement = null;
let pendingButtonUpdate = false;

ensureGlobalStyles();
ensureSettingsLoaded().catch((error) => console.error('Failed to pre-load settings', error));
addOrUpdateButtons();

const observer = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    if (mutation.type === 'childList' && (mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0)) {
      scheduleButtonUpdate();
      break;
    }
  }
});

if (document.body) {
  observer.observe(document.body, { childList: true, subtree: true });
} else {
  document.addEventListener('DOMContentLoaded', () => {
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

window.addEventListener('yt-navigate-finish', () => {
  setTimeout(() => {
    addOrUpdateButtons();
    resetButtonStates();
  }, 600);
});

function addOrUpdateButtons() {
  ensureWatchButtons();
  ensureShortsButtons();
}

function scheduleButtonUpdate() {
  if (pendingButtonUpdate) {
    return;
  }

  pendingButtonUpdate = true;

  const runUpdate = () => {
    pendingButtonUpdate = false;
    try {
      addOrUpdateButtons();
    } catch (error) {
      console.error('Failed to update extension UI after DOM mutation', error);
    }
  };

  if (typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(runUpdate);
  } else {
    setTimeout(runUpdate, 50);
  }
}

function ensureWatchButtons() {
  const container =
    document.querySelector('#top-row #actions #top-level-buttons-computed') ||
    document.querySelector('#top-level-buttons-computed');

  if (!container) {
    return;
  }

  let summarizeButton = document.getElementById(WATCH_BUTTON_ID);
  if (!summarizeButton) {
    summarizeButton = document.createElement('button');
    summarizeButton.id = WATCH_BUTTON_ID;
    summarizeButton.type = 'button';
    summarizeButton.textContent = BUTTON_LABELS.idle;
    summarizeButton.setAttribute('aria-label', BUTTON_LABELS.idle);

    const referenceButton =
      container.querySelector('button.yt-spec-button-shape-next') || container.querySelector('button');

    if (referenceButton && referenceButton.className) {
      summarizeButton.className = referenceButton.className;
    } else {
      summarizeButton.className =
        'yt-spec-button-shape-next yt-spec-button-shape-next--outline yt-spec-button-shape-next--size-m';
    }

    summarizeButton.style.marginLeft = '8px';
    summarizeButton.addEventListener('click', () => handleSummarize(summarizeButton));
    container.appendChild(summarizeButton);
  }

  setButtonState(summarizeButton, summarizeButton.dataset.ytlmState || 'idle');

  let settingsButton = document.getElementById(WATCH_SETTINGS_BUTTON_ID);
  if (!settingsButton) {
    settingsButton = document.createElement('button');
    settingsButton.id = WATCH_SETTINGS_BUTTON_ID;
    settingsButton.type = 'button';
    settingsButton.textContent = 'Settings';
    settingsButton.setAttribute('aria-label', 'Open extension settings');

    if (summarizeButton && summarizeButton.className) {
      settingsButton.className = summarizeButton.className;
    } else {
      settingsButton.className = 'ytlm-secondary-action';
    }

    settingsButton.style.marginLeft = '8px';
    settingsButton.addEventListener('click', openSettingsPanel);
    container.appendChild(settingsButton);
  }
}

function ensureShortsButtons() {
  const isShorts = isShortsPage();
  let container = document.getElementById(SHORTS_CONTAINER_ID);

  if (!isShorts) {
    if (container) {
      container.remove();
    }
    return;
  }

  if (!container) {
    if (!document.body) {
      return;
    }
    container = document.createElement('div');
    container.id = SHORTS_CONTAINER_ID;
    document.body.appendChild(container);
  }

  let summarizeButton = document.getElementById(SHORTS_BUTTON_ID);
  if (!summarizeButton) {
    summarizeButton = document.createElement('button');
    summarizeButton.id = SHORTS_BUTTON_ID;
    summarizeButton.type = 'button';
    summarizeButton.className = 'ytlm-floating-button';
    summarizeButton.textContent = BUTTON_LABELS.idle;
    summarizeButton.setAttribute('aria-label', BUTTON_LABELS.idle);
    summarizeButton.addEventListener('click', () => handleSummarize(summarizeButton));
    container.appendChild(summarizeButton);
  }

  setButtonState(summarizeButton, summarizeButton.dataset.ytlmState || 'idle');

  let settingsButton = document.getElementById(SHORTS_SETTINGS_BUTTON_ID);
  if (!settingsButton) {
    settingsButton = document.createElement('button');
    settingsButton.id = SHORTS_SETTINGS_BUTTON_ID;
    settingsButton.type = 'button';
    settingsButton.className = 'ytlm-floating-button ytlm-settings-toggle';
    settingsButton.textContent = 'Settings';
    settingsButton.setAttribute('aria-label', 'Open extension settings');
    settingsButton.addEventListener('click', openSettingsPanel);
    container.appendChild(settingsButton);
  }
}

async function handleSummarize(button) {
  if (!button || button.dataset.ytlmBusy === 'true') {
    return;
  }

  button.dataset.ytlmBusy = 'true';
  setButtonState(button, 'loadingTranscript');

  try {
    const settings = await ensureSettingsLoaded();
    const canonicalUrl = getCanonicalVideoUrl();
    const targetUrl = canonicalUrl || window.location.href;

    const transcript = await fetchTranscript(targetUrl);
    if (!transcript) {
      throw new Error('Transcript unavailable for this video.');
    }

    const title = getVideoTitle();
    const prompt = buildPrompt({
      title,
      url: targetUrl,
      transcript,
      settings
    });

    setButtonState(button, 'openingChat');
    await openChatGPT(prompt, settings.preferredChatHost);
  } catch (error) {
    console.error('Summarization failed', error);
    const message = error instanceof Error ? error.message : 'An unexpected error occurred.';
    alert(`${message} See the console for details.`);
  } finally {
    setButtonState(button, 'idle');
    button.dataset.ytlmBusy = 'false';
  }
}

function setButtonState(button, state) {
  if (!button) {
    return;
  }
  const label = BUTTON_LABELS[state] || BUTTON_LABELS.idle;
  button.dataset.ytlmState = state;
  if (state === 'idle') {
    button.disabled = false;
  } else {
    button.disabled = true;
  }
  button.textContent = label;
  button.setAttribute('aria-label', label);
}

function resetButtonStates() {
  const watchButton = document.getElementById(WATCH_BUTTON_ID);
  const shortsButton = document.getElementById(SHORTS_BUTTON_ID);
  if (watchButton) {
    watchButton.dataset.ytlmBusy = 'false';
    setButtonState(watchButton, 'idle');
  }
  if (shortsButton) {
    shortsButton.dataset.ytlmBusy = 'false';
    setButtonState(shortsButton, 'idle');
  }
}

function isShortsPage() {
  return window.location.pathname.startsWith('/shorts/');
}

function getCanonicalVideoUrl() {
  const videoId = getCurrentVideoId();
  if (!videoId) {
    return null;
  }
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function getCurrentVideoId() {
  const urlVideoId = new URLSearchParams(window.location.search).get('v');
  if (urlVideoId) {
    return urlVideoId;
  }

  const shortsMatch = window.location.pathname.match(/\/shorts\/([^/?]+)/);
  if (shortsMatch && shortsMatch[1]) {
    return shortsMatch[1];
  }

  const playerElement = document.querySelector('ytd-player, ytd-watch-flexy');
  const player = playerElement?.player_ || playerElement;

  if (player?.getVideoData) {
    try {
      const videoData = player.getVideoData();
      return videoData?.video_id || videoData?.videoId || null;
    } catch (error) {
      console.debug('Unable to read video data from player', error);
    }
  }

  return (
    playerElement?.__data?.playerResponse?.videoDetails?.videoId ||
    playerElement?.__data?.playerResponse?.videoDetails?.video_id ||
    null
  );
}

function getVideoTitle() {
  const selectors = [
    'h1.ytd-watch-metadata',
    'h1.title',
    '#title h1',
    'ytd-watch-flexy #title h1',
    'ytd-watch-flexy #title yt-formatted-string',
    'yt-formatted-string.ytd-watch-metadata',
    'ytd-reel-player-header-renderer #title yt-formatted-string',
    'yt-formatted-string.ytd-reel-title-renderer',
    '#overlay #title yt-formatted-string',
    'h1'
  ];

  for (const selector of selectors) {
    const element = document.querySelector(selector);
    const text = element?.innerText || element?.textContent;
    if (text) {
      const normalized = text.trim();
      if (normalized) {
        return normalized;
      }
    }
  }

  return document.title;
}

function buildPrompt({ title, url, transcript, settings }) {
  const trimmedTranscript = transcript.trim();
  const safeTitle = title?.trim() || 'Untitled video';
  const preferences = {
    overview_sentence_count: sanitizeNumber(settings.overviewSentences, DEFAULT_SETTINGS.overviewSentences, 1, 10),
    include_takeaways: Boolean(settings.includeTakeaways),
    include_action_steps: Boolean(settings.includeActionSteps),
    response_language: settings.responseLanguage?.trim() || DEFAULT_SETTINGS.responseLanguage
  };

  const instructions = [`Provide a concise overview in ${preferences.overview_sentence_count} sentence(s).`];
  if (preferences.include_takeaways) {
    instructions.push('List the main takeaways as bullet points.');
  }
  if (preferences.include_action_steps) {
    instructions.push('Highlight actionable steps separately.');
  }

  if (settings.customInstructions) {
    const customLines = settings.customInstructions
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    instructions.push(...customLines);
  }

  const payload = {
    task: 'summarize_youtube_video',
    format: 'json',
    metadata: {
      generated_at: new Date().toISOString(),
      source: 'youtube-transcript-summarizer-extension',
      transcript_source: 'glasp'
    },
    preferences,
    video: {
      title: safeTitle,
      url
    },
    instructions,
    transcript: trimmedTranscript
  };

  return JSON.stringify(payload, null, 2);
}

async function fetchTranscript(videoUrl) {
  if (!chrome?.runtime?.sendMessage) {
    throw new Error('chrome.runtime.sendMessage is unavailable.');
  }

  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'fetchTranscriptFromGlasp', videoUrl }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message || 'Unexpected extension error.'));
        return;
      }

      if (response?.status === 'success' && typeof response.transcript === 'string') {
        resolve(response.transcript);
        return;
      }

      const errorMessage = response?.error || 'Transcript unavailable for this video.';
      reject(new Error(errorMessage));
    });
  });
}

async function openChatGPT(prompt, preferredHost) {
  if (!chrome?.runtime?.sendMessage) {
    throw new Error('chrome.runtime.sendMessage is unavailable.');
  }

  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'openChatGPT', prompt, preferredHost }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message || 'Unexpected extension error.'));
        return;
      }

      if (response?.status === 'error') {
        reject(new Error(response.error || 'Unable to open ChatGPT.'));
        return;
      }

      resolve();
    });
  });
}

function ensureGlobalStyles() {
  if (document.getElementById(STYLE_ELEMENT_ID)) {
    return;
  }

  const style = document.createElement('style');
  style.id = STYLE_ELEMENT_ID;
  style.textContent = `
    #${SHORTS_CONTAINER_ID} {
      position: fixed;
      top: 96px;
      right: 16px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      z-index: 2147480000;
    }

    #${SHORTS_CONTAINER_ID} button {
      font: inherit;
      border-radius: 999px;
      border: 1px solid var(--yt-spec-outline, rgba(0, 0, 0, 0.2));
      padding: 8px 16px;
      cursor: pointer;
      background: var(--yt-spec-base-background, #ffffff);
      color: var(--yt-spec-text-primary, #0f0f0f);
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
      transition: transform 0.2s ease, box-shadow 0.2s ease;
    }

    #${SHORTS_CONTAINER_ID} button:hover:not(:disabled) {
      transform: translateY(-1px);
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.24);
    }

    #${SHORTS_CONTAINER_ID} button:disabled {
      opacity: 0.65;
      cursor: not-allowed;
      transform: none;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
    }

    #${SHORTS_CONTAINER_ID} .ytlm-settings-toggle {
      background: var(--yt-spec-10-percent-layer, rgba(0, 0, 0, 0.05));
    }

    .ytlm-secondary-action {
      border-radius: 999px;
      border: 1px solid var(--yt-spec-outline, rgba(0, 0, 0, 0.2));
      background: transparent;
      color: var(--yt-spec-text-primary, #0f0f0f);
      padding: 6px 14px;
      cursor: pointer;
    }

    #${SETTINGS_PANEL_ID} {
      position: fixed;
      inset: 0;
      display: none;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.45);
      z-index: 2147483600;
    }

    #${SETTINGS_PANEL_ID}.ytlm-visible {
      display: flex;
    }

    #${SETTINGS_PANEL_ID} .ytlm-settings-modal {
      position: relative;
      width: min(420px, calc(100% - 32px));
      max-height: 80vh;
      overflow-y: auto;
      background: var(--yt-spec-base-background, #ffffff);
      color: var(--yt-spec-text-primary, #0f0f0f);
      border-radius: 16px;
      box-shadow: 0 20px 48px rgba(0, 0, 0, 0.35);
      padding: 24px 24px 16px;
      font-family: Roboto, Arial, sans-serif;
    }

    #${SETTINGS_PANEL_ID} h2 {
      margin: 0 0 8px;
      font-size: 20px;
      font-weight: 600;
    }

    #${SETTINGS_PANEL_ID} .ytlm-settings-description {
      margin: 0 0 16px;
      font-size: 14px;
      color: var(--yt-spec-text-secondary, #606060);
    }

    #${SETTINGS_PANEL_ID} form {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    #${SETTINGS_PANEL_ID} label {
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 14px;
    }

    #${SETTINGS_PANEL_ID} input[type="text"],
    #${SETTINGS_PANEL_ID} input[type="number"],
    #${SETTINGS_PANEL_ID} select,
    #${SETTINGS_PANEL_ID} textarea {
      font: inherit;
      padding: 6px 10px;
      border-radius: 8px;
      border: 1px solid var(--yt-spec-outline, rgba(0, 0, 0, 0.2));
      background: var(--yt-spec-base-background, #ffffff);
      color: inherit;
    }

    #${SETTINGS_PANEL_ID} textarea {
      min-height: 80px;
      resize: vertical;
    }

    #${SETTINGS_PANEL_ID} .ytlm-checkbox {
      flex-direction: row;
      align-items: center;
      gap: 8px;
    }

    #${SETTINGS_PANEL_ID} .ytlm-checkbox span {
      flex: 1;
    }

    #${SETTINGS_PANEL_ID} .ytlm-settings-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 8px;
    }

    #${SETTINGS_PANEL_ID} .ytlm-primary {
      background: var(--yt-spec-brand-background-solid, #065fd4);
      color: #ffffff;
      border: none;
      border-radius: 999px;
      padding: 8px 18px;
      font-weight: 600;
      cursor: pointer;
    }

    #${SETTINGS_PANEL_ID} .ytlm-primary:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    #${SETTINGS_PANEL_ID} .ytlm-secondary {
      background: transparent;
      color: inherit;
      border: 1px solid var(--yt-spec-outline, rgba(0, 0, 0, 0.2));
      border-radius: 999px;
      padding: 8px 18px;
      cursor: pointer;
    }

    #${SETTINGS_PANEL_ID} .ytlm-settings-status {
      margin: 12px 0 0;
      min-height: 18px;
      font-size: 13px;
      color: var(--yt-spec-text-secondary, #606060);
    }

    #${SETTINGS_PANEL_ID} .ytlm-settings-status.ytlm-error {
      color: #d93025;
    }

    #${SETTINGS_PANEL_ID} .ytlm-close-button {
      position: absolute;
      top: 8px;
      right: 8px;
      border: none;
      background: transparent;
      font-size: 22px;
      line-height: 1;
      cursor: pointer;
      color: inherit;
    }

    #${SETTINGS_PANEL_ID} .ytlm-close-button:hover {
      opacity: 0.75;
    }
  `;

  const appendStyle = () => {
    const target = document.head || document.documentElement;
    if (target && !style.isConnected) {
      target.appendChild(style);
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', appendStyle, { once: true });
  }

  appendStyle();
}

async function ensureSettingsLoaded() {
  if (settingsLoaded) {
    return currentSettings;
  }

  if (settingsLoadPromise) {
    return settingsLoadPromise;
  }

  settingsLoadPromise = (async () => {
    try {
      const loaded = await loadSettingsFromStorage();
      currentSettings = sanitizeSettings(loaded);
      settingsLoaded = true;
      return currentSettings;
    } catch (error) {
      console.error('Failed to load settings', error);
      currentSettings = { ...DEFAULT_SETTINGS };
      settingsLoaded = true;
      return currentSettings;
    } finally {
      settingsLoadPromise = null;
    }
  })();

  return settingsLoadPromise;
}

async function loadSettingsFromStorage() {
  const storageArea = chrome?.storage?.sync || chrome?.storage?.local;
  if (!storageArea) {
    return { ...DEFAULT_SETTINGS };
  }

  const stored = await storageArea.get(SETTINGS_STORAGE_KEY);
  return stored?.[SETTINGS_STORAGE_KEY] || { ...DEFAULT_SETTINGS };
}

async function saveSettings(updatedSettings) {
  currentSettings = sanitizeSettings(updatedSettings);
  settingsLoaded = true;

  const storageArea = chrome?.storage?.sync || chrome?.storage?.local;
  if (!storageArea) {
    return currentSettings;
  }

  await storageArea.set({ [SETTINGS_STORAGE_KEY]: currentSettings });
  return currentSettings;
}

function sanitizeSettings(raw) {
  const settings = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') {
    return settings;
  }

  settings.preferredChatHost = sanitizeHost(raw.preferredChatHost, DEFAULT_SETTINGS.preferredChatHost);
  settings.overviewSentences = sanitizeNumber(
    raw.overviewSentences,
    DEFAULT_SETTINGS.overviewSentences,
    1,
    10
  );
  settings.includeTakeaways = sanitizeBoolean(raw.includeTakeaways, DEFAULT_SETTINGS.includeTakeaways);
  settings.includeActionSteps = sanitizeBoolean(raw.includeActionSteps, DEFAULT_SETTINGS.includeActionSteps);
  settings.responseLanguage = sanitizeString(raw.responseLanguage, DEFAULT_SETTINGS.responseLanguage);
  settings.customInstructions = sanitizeMultilineString(raw.customInstructions, DEFAULT_SETTINGS.customInstructions);

  return settings;
}

function sanitizeHost(value, fallback) {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'chat.openai.com') {
      return 'chat.openai.com';
    }
    if (normalized === 'chatgpt.com') {
      return 'chatgpt.com';
    }
  }
  return fallback;
}

function sanitizeNumber(value, fallback, min, max) {
  const numeric = Number.parseInt(value, 10);
  if (Number.isNaN(numeric)) {
    return fallback;
  }
  const clamped = Math.min(Math.max(numeric, min), max);
  return clamped;
}

function sanitizeBoolean(value, fallback) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  return fallback;
}

function sanitizeString(value, fallback) {
  if (typeof value !== 'string') {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed || fallback;
}

function sanitizeMultilineString(value, fallback) {
  if (typeof value !== 'string') {
    return fallback;
  }
  return value.replace(/\s+$/, '');
}

function ensureSettingsPanel() {
  if (settingsPanelRefs) {
    return settingsPanelRefs;
  }

  const panel = document.createElement('div');
  panel.id = SETTINGS_PANEL_ID;
  panel.className = 'ytlm-settings-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-hidden', 'true');

  const modal = document.createElement('div');
  modal.className = 'ytlm-settings-modal';

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'ytlm-close-button';
  closeButton.setAttribute('aria-label', 'Close settings');
  closeButton.textContent = '×';
  closeButton.addEventListener('click', closeSettingsPanel);

  const heading = document.createElement('h2');
  heading.textContent = 'Extension Settings';

  const description = document.createElement('p');
  description.className = 'ytlm-settings-description';
  description.textContent = 'Adjust how prompts are generated and which ChatGPT domain to use.';

  const form = document.createElement('form');

  const hostLabel = document.createElement('label');
  hostLabel.textContent = 'Preferred ChatGPT domain';
  const hostSelect = document.createElement('select');
  hostSelect.name = 'preferredChatHost';
  const optionChatGPT = document.createElement('option');
  optionChatGPT.value = 'chatgpt.com';
  optionChatGPT.textContent = 'chatgpt.com';
  const optionChatOpenAI = document.createElement('option');
  optionChatOpenAI.value = 'chat.openai.com';
  optionChatOpenAI.textContent = 'chat.openai.com';
  hostSelect.append(optionChatGPT, optionChatOpenAI);
  hostLabel.appendChild(hostSelect);

  const overviewLabel = document.createElement('label');
  overviewLabel.textContent = 'Overview sentence count';
  const overviewInput = document.createElement('input');
  overviewInput.type = 'number';
  overviewInput.name = 'overviewSentences';
  overviewInput.min = '1';
  overviewInput.max = '10';
  overviewInput.step = '1';
  overviewLabel.appendChild(overviewInput);

  const takeawaysLabel = document.createElement('label');
  takeawaysLabel.className = 'ytlm-checkbox';
  const takeawaysCheckbox = document.createElement('input');
  takeawaysCheckbox.type = 'checkbox';
  takeawaysCheckbox.name = 'includeTakeaways';
  const takeawaysText = document.createElement('span');
  takeawaysText.textContent = 'Include key takeaways list';
  takeawaysLabel.append(takeawaysCheckbox, takeawaysText);

  const actionLabel = document.createElement('label');
  actionLabel.className = 'ytlm-checkbox';
  const actionCheckbox = document.createElement('input');
  actionCheckbox.type = 'checkbox';
  actionCheckbox.name = 'includeActionSteps';
  const actionText = document.createElement('span');
  actionText.textContent = 'Include actionable steps';
  actionLabel.append(actionCheckbox, actionText);

  const languageLabel = document.createElement('label');
  languageLabel.textContent = 'Preferred response language';
  const languageInput = document.createElement('input');
  languageInput.type = 'text';
  languageInput.name = 'responseLanguage';
  languageLabel.appendChild(languageInput);

  const instructionsLabel = document.createElement('label');
  instructionsLabel.textContent = 'Additional instructions (one per line)';
  const instructionsTextarea = document.createElement('textarea');
  instructionsTextarea.name = 'customInstructions';
  instructionsLabel.appendChild(instructionsTextarea);

  const actionsRow = document.createElement('div');
  actionsRow.className = 'ytlm-settings-actions';
  const saveButton = document.createElement('button');
  saveButton.type = 'submit';
  saveButton.className = 'ytlm-primary';
  saveButton.textContent = 'Save';
  const closeActionButton = document.createElement('button');
  closeActionButton.type = 'button';
  closeActionButton.className = 'ytlm-secondary';
  closeActionButton.textContent = 'Close';
  closeActionButton.addEventListener('click', closeSettingsPanel);
  actionsRow.append(saveButton, closeActionButton);

  const status = document.createElement('p');
  status.className = 'ytlm-settings-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  form.append(
    hostLabel,
    overviewLabel,
    takeawaysLabel,
    actionLabel,
    languageLabel,
    instructionsLabel,
    actionsRow
  );

  modal.append(closeButton, heading, description, form, status);
  panel.appendChild(modal);
  panel.addEventListener('click', (event) => {
    if (event.target === panel) {
      closeSettingsPanel();
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    await handleSettingsSubmit({
      hostSelect,
      overviewInput,
      takeawaysCheckbox,
      actionCheckbox,
      languageInput,
      instructionsTextarea,
      saveButton,
      status
    });
  });

  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeSettingsPanel();
    }
  });

  document.body.appendChild(panel);

  settingsPanelRefs = {
    panel,
    form,
    status,
    elements: {
      hostSelect,
      overviewInput,
      takeawaysCheckbox,
      actionCheckbox,
      languageInput,
      instructionsTextarea
    },
    saveButton
  };

  return settingsPanelRefs;
}

async function openSettingsPanel() {
  const refs = ensureSettingsPanel();
  await ensureSettingsLoaded();

  populateSettingsForm(refs.elements, currentSettings);
  refs.status.textContent = '';
  refs.status.classList.remove('ytlm-error');

  refs.panel.classList.add('ytlm-visible');
  refs.panel.setAttribute('aria-hidden', 'false');

  lastFocusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  setTimeout(() => {
    refs.elements.hostSelect.focus({ preventScroll: true });
  }, 50);
}

function closeSettingsPanel() {
  if (!settingsPanelRefs) {
    return;
  }
  settingsPanelRefs.panel.classList.remove('ytlm-visible');
  settingsPanelRefs.panel.setAttribute('aria-hidden', 'true');
  settingsPanelRefs.panel.blur();

  if (lastFocusedElement && typeof lastFocusedElement.focus === 'function') {
    try {
      lastFocusedElement.focus({ preventScroll: true });
    } catch (error) {
      lastFocusedElement.focus();
    }
  }
  lastFocusedElement = null;
}

function populateSettingsForm(elements, settings) {
  elements.hostSelect.value = settings.preferredChatHost;
  elements.overviewInput.value = settings.overviewSentences;
  elements.takeawaysCheckbox.checked = settings.includeTakeaways;
  elements.actionCheckbox.checked = settings.includeActionSteps;
  elements.languageInput.value = settings.responseLanguage;
  elements.instructionsTextarea.value = settings.customInstructions;
}

async function handleSettingsSubmit({
  hostSelect,
  overviewInput,
  takeawaysCheckbox,
  actionCheckbox,
  languageInput,
  instructionsTextarea,
  saveButton,
  status
}) {
  const updated = {
    preferredChatHost: hostSelect.value,
    overviewSentences: sanitizeNumber(overviewInput.value, currentSettings.overviewSentences, 1, 10),
    includeTakeaways: takeawaysCheckbox.checked,
    includeActionSteps: actionCheckbox.checked,
    responseLanguage: sanitizeString(languageInput.value, currentSettings.responseLanguage),
    customInstructions: instructionsTextarea.value
  };

  setStatusMessage(status, 'Saving…', false);
  saveButton.disabled = true;

  try {
    await saveSettings(updated);
    setStatusMessage(status, 'Settings saved.', false);
  } catch (error) {
    console.error('Failed to save settings', error);
    setStatusMessage(status, 'Failed to save settings. Please try again.', true);
  } finally {
    saveButton.disabled = false;
  }
}

function setStatusMessage(statusElement, message, isError) {
  statusElement.textContent = message;
  if (isError) {
    statusElement.classList.add('ytlm-error');
  } else {
    statusElement.classList.remove('ytlm-error');
  }
}
