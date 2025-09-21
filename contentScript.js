const WATCH_BUTTON_ID = 'ytlm-summarize-btn';
const SHORTS_CONTAINER_ID = 'ytlm-floating-controls';
const SHORTS_BUTTON_ID = 'ytlm-shorts-summarize-btn';
const SETTINGS_PANEL_ID = 'ytlm-settings-panel';
const SETTINGS_STORAGE_KEY = 'ytlmSettingsV1';
const STYLE_ELEMENT_ID = 'ytlm-shared-styles';
const ACTION_MENU_VISIBLE_CLASS = 'ytlm-visible';

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
let activeMenuState = null;
let menuDismissListenersAttached = false;

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
  closeActiveMenu();
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
  if (isShortsPage()) {
    const existingWatchButton = document.getElementById(WATCH_BUTTON_ID);
    if (existingWatchButton) {
      existingWatchButton.remove();
    }

    removeActionMenu(WATCH_BUTTON_ID);
    return;
  }

  const container =
    document.querySelector('#top-row #actions #top-level-buttons-computed') ||
    document.querySelector('#top-level-buttons-computed');

  if (!container) {
    return;
  }

  const summarizeButton = ensureContextualActionButton({
    id: WATCH_BUTTON_ID,
    container,
    context: 'watch'
  });

  setButtonState(summarizeButton, summarizeButton.dataset.ytlmState || 'idle');
}

function ensureShortsButtons() {
  const isShorts = isShortsPage();
  let slot = document.getElementById(SHORTS_CONTAINER_ID);

  if (!isShorts) {
    if (slot) {
      slot.remove();
    }
    removeActionMenu(SHORTS_BUTTON_ID);
    return;
  }

  const host = findShortsActionsHost();
  if (!host) {
    if (slot) {
      slot.remove();
    }
    removeActionMenu(SHORTS_BUTTON_ID);
    return;
  }

  if (!slot) {
    slot = document.createElement('div');
    slot.id = SHORTS_CONTAINER_ID;
    slot.className = 'ytlm-shorts-button-slot';
    host.appendChild(slot);
  } else if (slot.parentElement !== host) {
    slot.remove();
    host.appendChild(slot);
  }

  const summarizeButton = ensureContextualActionButton({
    id: SHORTS_BUTTON_ID,
    container: slot,
    context: 'shorts'
  });

  setButtonState(summarizeButton, summarizeButton.dataset.ytlmState || 'idle');
}

function findShortsActionsHost() {
  const selectors = [
    'ytd-reel-player-overlay-renderer #actions',
    '#actions.ytd-reel-player-overlay-renderer',
    'ytd-reel-player-overlay-renderer #actions ytd-reel-player-toolbar-renderer',
    'ytd-reel-player-overlay-renderer #actions ytd-reel-fixed-player-overlay-renderer',
    'ytd-reel-player-overlay-renderer #buttons',
    '#shorts-player #actions',
    '#shorts-player #actions ytd-reel-player-toolbar-renderer'
  ];

  for (const selector of selectors) {
    const element = document.querySelector(selector);
    if (element) {
      return element;
    }
  }

  return null;
}

function ensureContextualActionButton({ id, container, context }) {
  let button = document.getElementById(id);
  if (!button) {
    button = document.createElement('button');
    button.id = id;
    button.type = 'button';
    button.dataset.ytlmBusy = 'false';
    button.dataset.ytlmState = 'idle';
    button.dataset.ytlmContext = context;
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');

    button.className = 'ytlm-action-button';

    const icon = document.createElement('span');
    icon.className = 'ytlm-button-icon';
    icon.setAttribute('aria-hidden', 'true');

    const label = document.createElement('span');
    label.className = 'ytlm-button-label';
    label.textContent = BUTTON_LABELS.idle;

    const caret = document.createElement('span');
    caret.className = 'ytlm-button-caret';
    caret.setAttribute('aria-hidden', 'true');

    button.append(icon, label, caret);
    button.setAttribute('aria-label', BUTTON_LABELS.idle);

    container.appendChild(button);
  } else {
    button.dataset.ytlmContext = context;
    button.classList.add('ytlm-action-button');
  }

  if (!button.querySelector('.ytlm-button-icon')) {
    const icon = document.createElement('span');
    icon.className = 'ytlm-button-icon';
    icon.setAttribute('aria-hidden', 'true');
    button.prepend(icon);
  }

  if (!button.querySelector('.ytlm-button-label')) {
    const label = document.createElement('span');
    label.className = 'ytlm-button-label';
    label.textContent = BUTTON_LABELS.idle;
    button.appendChild(label);
  }

  if (!button.querySelector('.ytlm-button-caret')) {
    const caret = document.createElement('span');
    caret.className = 'ytlm-button-caret';
    caret.setAttribute('aria-hidden', 'true');
    button.appendChild(caret);
  }

  button.classList.remove('ytlm-action-button--watch', 'ytlm-action-button--shorts');
  if (context === 'watch') {
    button.classList.add('ytlm-action-button--watch');
  } else {
    button.classList.add('ytlm-action-button--shorts');
  }

  if (!button.querySelector('.ytlm-button-icon')) {
    const icon = document.createElement('span');
    icon.className = 'ytlm-button-icon';
    icon.setAttribute('aria-hidden', 'true');
    button.prepend(icon);
  }

  if (!button.querySelector('.ytlm-button-label')) {
    const label = document.createElement('span');
    label.className = 'ytlm-button-label';
    label.textContent = BUTTON_LABELS.idle;
    button.appendChild(label);
  }

  if (!button.dataset.ytlmMenuBound) {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      toggleActionMenu(button, context);
    });
    button.dataset.ytlmMenuBound = 'true';
  }

  const menu = ensureActionMenu(button, context);
  button.setAttribute('aria-controls', menu.id);

  if (!button.dataset.ytlmBusy) {
    button.dataset.ytlmBusy = 'false';
  }

  if (!button.dataset.ytlmState) {
    button.dataset.ytlmState = 'idle';
  }

  return button;
}

function ensureActionMenu(button, context) {
  const menuId = `${button.id}-menu`;
  let menu = document.getElementById(menuId);

  if (!menu) {
    menu = document.createElement('div');
    menu.id = menuId;
    menu.className = 'ytlm-action-menu';
    menu.setAttribute('role', 'menu');
    menu.dataset.ytlmOpen = 'false';

    const summarizeItem = document.createElement('button');
    summarizeItem.type = 'button';
    summarizeItem.className = 'ytlm-action-menu__item';
    summarizeItem.textContent = 'Summarize';
    summarizeItem.setAttribute('role', 'menuitem');
    summarizeItem.dataset.action = 'summarize';
    summarizeItem.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const currentButton = document.getElementById(menu.dataset.ytlmButtonId);
      if (currentButton) {
        closeActionMenu(menu, currentButton);
        handleSummarize(currentButton);
      } else {
        closeActionMenu(menu, null);
      }
    });

    const settingsItem = document.createElement('button');
    settingsItem.type = 'button';
    settingsItem.className = 'ytlm-action-menu__item';
    settingsItem.textContent = 'Settings';
    settingsItem.setAttribute('role', 'menuitem');
    settingsItem.dataset.action = 'settings';
    settingsItem.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const currentButton = document.getElementById(menu.dataset.ytlmButtonId);
      closeActionMenu(menu, currentButton || null);
      openSettingsPanel().catch((error) => console.error('Failed to open settings panel', error));
    });

    menu.append(summarizeItem, settingsItem);
    document.body.appendChild(menu);
  }

  menu.dataset.ytlmButtonId = button.id;
  menu.dataset.ytlmContext = context;
  menu.setAttribute('aria-labelledby', button.id);

  return menu;
}

function toggleActionMenu(button, context) {
  const menu = ensureActionMenu(button, context);

  if (menu.dataset.ytlmOpen === 'true') {
    closeActionMenu(menu, button);
  } else {
    openActionMenu(menu, button, context);
  }
}

function openActionMenu(menu, button, context) {
  if (activeMenuState && activeMenuState.menu !== menu) {
    closeActionMenu(activeMenuState.menu, activeMenuState.button);
  }

  activeMenuState = { menu, button };
  menu.dataset.ytlmOpen = 'true';
  menu.classList.add(ACTION_MENU_VISIBLE_CLASS);
  menu.style.visibility = 'hidden';
  button.setAttribute('aria-expanded', 'true');

  positionActionMenu(menu, button, context);

  menu.style.visibility = '';
  attachMenuDismissListeners();
}

function closeActionMenu(menu, button) {
  if (!menu) {
    return;
  }

  menu.dataset.ytlmOpen = 'false';
  menu.classList.remove(ACTION_MENU_VISIBLE_CLASS);
  menu.style.top = '';
  menu.style.left = '';
  menu.style.visibility = '';

  if (button) {
    button.setAttribute('aria-expanded', 'false');
  }

  if (activeMenuState && activeMenuState.menu === menu) {
    activeMenuState = null;
    detachMenuDismissListeners();
  }
}

function closeActiveMenu() {
  if (!activeMenuState) {
    return;
  }

  const { menu, button } = activeMenuState;
  closeActionMenu(menu, button);
}

function removeActionMenu(buttonId) {
  const menu = document.getElementById(`${buttonId}-menu`);
  if (!menu) {
    return;
  }

  const button = document.getElementById(buttonId);
  closeActionMenu(menu, button || null);
  menu.remove();
}

function positionActionMenu(menu, button, context) {
  const rect = button.getBoundingClientRect();
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;

  // Force layout to measure size.
  const menuRect = menu.getBoundingClientRect();

  let top;
  let left;

  if (context === 'shorts') {
    top = rect.top + rect.height / 2 - menuRect.height / 2;
    left = rect.left - menuRect.width - 12;

    if (left < 8) {
      left = rect.right + 12;
    }
  } else {
    top = rect.bottom + 8;
    left = rect.left;
  }

  if (top + menuRect.height > viewportHeight - 8) {
    top = Math.max(rect.top - menuRect.height - 8, viewportHeight - menuRect.height - 8);
  }

  if (top < 8) {
    top = 8;
  }

  if (left + menuRect.width > viewportWidth - 8) {
    left = Math.max(viewportWidth - menuRect.width - 8, 8);
  }

  if (left < 8) {
    left = 8;
  }

  menu.style.top = `${Math.round(top)}px`;
  menu.style.left = `${Math.round(left)}px`;
}

function attachMenuDismissListeners() {
  if (menuDismissListenersAttached) {
    return;
  }

  menuDismissListenersAttached = true;
  document.addEventListener('pointerdown', handleMenuDismissPointer, true);
  document.addEventListener('keydown', handleMenuDismissKeydown, true);
  window.addEventListener('resize', handleMenuDismissResize, true);
  window.addEventListener('scroll', handleMenuScroll, true);
}

function detachMenuDismissListeners() {
  if (!menuDismissListenersAttached) {
    return;
  }

  menuDismissListenersAttached = false;
  document.removeEventListener('pointerdown', handleMenuDismissPointer, true);
  document.removeEventListener('keydown', handleMenuDismissKeydown, true);
  window.removeEventListener('resize', handleMenuDismissResize, true);
  window.removeEventListener('scroll', handleMenuScroll, true);
}

function handleMenuDismissPointer(event) {
  if (!activeMenuState) {
    return;
  }

  const { menu, button } = activeMenuState;
  const target = event.target;

  if (menu.contains(target) || button.contains(target)) {
    return;
  }

  closeActionMenu(menu, button);
}

function handleMenuDismissKeydown(event) {
  if (!activeMenuState) {
    return;
  }

  if (event.key === 'Escape' || event.key === 'Esc') {
    const { menu, button } = activeMenuState;
    closeActionMenu(menu, button);
    if (button && typeof button.focus === 'function') {
      try {
        button.focus({ preventScroll: true });
      } catch (error) {
        button.focus();
      }
    }
  }
}

function handleMenuDismissResize() {
  closeActiveMenu();
}

function handleMenuScroll(event) {
  if (!activeMenuState) {
    return;
  }

  const { menu } = activeMenuState;
  if (menu.contains(event.target)) {
    return;
  }

  closeActiveMenu();
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
  const isIdle = state === 'idle';
  button.dataset.ytlmState = state;
  button.dataset.ytlmBusy = (!isIdle).toString();
  button.classList.toggle('ytlm-busy', !isIdle);

  const labelElement = button.querySelector('.ytlm-button-label');
  if (labelElement) {
    labelElement.textContent = label;
  } else {
    button.textContent = label;
  }

  button.setAttribute('aria-label', label);

  const menuId = button.getAttribute('aria-controls');
  if (menuId) {
    const menu = document.getElementById(menuId);
    if (menu) {
      const summarizeItem = menu.querySelector('[data-action="summarize"]');
      if (summarizeItem) {
        summarizeItem.disabled = !isIdle;
        summarizeItem.textContent = isIdle ? 'Summarize' : 'Summarizing…';
      }
    }
  }
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
  const overviewCount = sanitizeNumber(settings.overviewSentences, DEFAULT_SETTINGS.overviewSentences, 1, 10);
  const includeTakeaways = Boolean(settings.includeTakeaways);
  const includeActionSteps = Boolean(settings.includeActionSteps);
  const responseLanguage = settings.responseLanguage?.trim() || DEFAULT_SETTINGS.responseLanguage;

  const requestParts = [`Please give me a concise overview in ${overviewCount} sentence${overviewCount === 1 ? '' : 's'}.`];
  if (includeTakeaways) {
    requestParts.push('After that, add a bulleted list of the main takeaways.');
  }
  if (includeActionSteps) {
    requestParts.push('Call out any actionable steps or recommendations in their own short section.');
  }
  requestParts.push(`Write the entire response in ${responseLanguage}.`);

  const customLines = settings.customInstructions
    ? settings.customInstructions
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
    : [];

  const customBlock = customLines.length
    ? `Additional preferences:\n${customLines.map((line) => `- ${line}`).join('\n')}`
    : '';

  const promptSections = [
    'You are helping me summarize a YouTube video.',
    `Title: "${safeTitle}"\nLink: ${url}`,
    requestParts.join(' '),
    customBlock,
    `Use the transcript below as your source material:\n${trimmedTranscript}`
  ].filter((section) => section && section.trim().length > 0);

  return promptSections.join('\n\n');
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
      display: flex;
      align-items: center;
      justify-content: center;
      width: 48px;
      height: 48px;
      flex: none;
    }

    .ytlm-action-button {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      font: inherit;
      line-height: 1;
      border: none;
      border-radius: 999px;
      background: transparent;
      color: inherit;
      cursor: pointer;
      padding: 0;
      text-decoration: none;
      transition: background-color 0.18s ease, color 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease, transform 0.18s ease;
    }

    .ytlm-action-button .ytlm-button-label {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      white-space: nowrap;
    }

    .ytlm-action-button .ytlm-button-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }

    .ytlm-action-button .ytlm-button-caret {
      display: inline-block;
      width: 0;
      height: 0;
      margin-left: 2px;
      border-left: 4px solid transparent;
      border-right: 4px solid transparent;
      border-top: 5px solid currentColor;
      transition: transform 0.18s ease;
    }

    .ytlm-action-button[aria-expanded='true'] .ytlm-button-caret {
      transform: rotate(180deg);
    }

    .ytlm-action-button:focus-visible {
      outline: 3px solid var(--yt-spec-brand-button-background, #065fd4);
      outline-offset: 2px;
    }

    .ytlm-action-button--watch {
      margin-left: 8px;
      min-height: 36px;
      padding: 0 16px;
      border-radius: 18px;
      border: 1px solid var(--yt-spec-badge-chip-outline, rgba(0, 0, 0, 0.1));
      background: var(--yt-spec-badge-chip-background, rgba(0, 0, 0, 0.04));
      color: var(--yt-spec-text-primary, #0f0f0f);
      font-size: 14px;
      font-weight: 500;
    }

    .ytlm-action-button--watch:hover:not(.ytlm-busy) {
      background: var(--yt-spec-touch-response, rgba(0, 0, 0, 0.08));
    }

    .ytlm-action-button--watch:active {
      background: var(--yt-spec-touch-response, rgba(0, 0, 0, 0.12));
    }

    .ytlm-action-button--watch .ytlm-button-icon {
      display: none;
    }

    .ytlm-action-button--watch.ytlm-busy {
      cursor: progress;
    }

    .ytlm-action-button--watch.ytlm-busy .ytlm-button-label {
      opacity: 0.75;
    }

    .ytlm-action-button--watch.ytlm-busy .ytlm-button-caret {
      opacity: 0.6;
    }

    .ytlm-action-button--shorts {
      width: 48px;
      height: 48px;
      border-radius: 50%;
      border: 1px solid rgba(255, 255, 255, 0.28);
      background: rgba(15, 15, 15, 0.88);
      color: #ffffff;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
    }

    .ytlm-action-button--shorts:hover:not(.ytlm-busy) {
      transform: translateY(-2px);
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.4);
      background: rgba(15, 15, 15, 0.94);
    }

    .ytlm-action-button--shorts:active {
      transform: translateY(0);
    }

    .ytlm-action-button--shorts .ytlm-button-label,
    .ytlm-action-button--shorts .ytlm-button-caret {
      display: none;
    }

    .ytlm-action-button--shorts .ytlm-button-icon {
      width: 24px;
      height: 24px;
      background-repeat: no-repeat;
      background-position: center;
      background-size: 22px 22px;
      background-image: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.75a5.25 5.25 0 0 1 4.72 7.72A5.25 5.25 0 0 1 19 14.25 5.25 5.25 0 0 1 8.53 18.7 5.25 5.25 0 0 1 5 13.75a5.25 5.25 0 0 1 2.54-9.48"/><path d="M8.2 7.4 12 9.5l3.8-2.1"/><path d="M8.2 16.6v-4.2l-3.2-1.8"/><path d="M15.8 16.6v-4.2l3.2-1.8"/></svg>');
    }

    .ytlm-action-button--shorts.ytlm-busy {
      cursor: progress;
    }

    .ytlm-action-button--shorts.ytlm-busy .ytlm-button-icon {
      background-image: none;
      border-radius: 50%;
      border: 3px solid rgba(255, 255, 255, 0.35);
      border-top-color: rgba(255, 255, 255, 0.95);
      width: 24px;
      height: 24px;
      animation: ytlm-spin 1s linear infinite;
    }

    @keyframes ytlm-spin {
      from {
        transform: rotate(0deg);
      }
      to {
        transform: rotate(360deg);
      }
    }

    .ytlm-action-menu {
      position: fixed;
      top: 0;
      left: 0;
      display: none;
      flex-direction: column;
      gap: 4px;
      min-width: 160px;
      padding: 8px;
      border-radius: 12px;
      background: var(--yt-spec-base-background, #ffffff);
      color: var(--yt-spec-text-primary, #0f0f0f);
      box-shadow: 0 18px 48px rgba(0, 0, 0, 0.28);
      border: 1px solid rgba(0, 0, 0, 0.08);
      z-index: 2147483600;
    }

    .ytlm-action-menu.${ACTION_MENU_VISIBLE_CLASS} {
      display: flex;
    }

    .ytlm-action-menu__item {
      font: inherit;
      border: none;
      background: transparent;
      color: inherit;
      border-radius: 8px;
      padding: 10px 12px;
      text-align: left;
      cursor: pointer;
      transition: background-color 0.18s ease, color 0.18s ease;
    }

    .ytlm-action-menu__item:hover:not(:disabled),
    .ytlm-action-menu__item:focus-visible {
      background: var(--yt-spec-10-percent-layer, rgba(0, 0, 0, 0.08));
      outline: none;
    }

    .ytlm-action-menu__item:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }

    .ytlm-action-menu__item + .ytlm-action-menu__item {
      margin-top: 2px;
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
