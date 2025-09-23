const WATCH_BUTTON_ID = 'ytlm-summarize-btn';
const SHORTS_CONTAINER_ID = 'ytlm-floating-controls';
const SHORTS_BUTTON_ID = 'ytlm-shorts-summarize-btn';
const SETTINGS_PANEL_ID = 'ytlm-settings-panel';
const SETTINGS_STORAGE_KEY = 'ytlmSettingsV1';
const STYLE_ELEMENT_ID = 'ytlm-shared-styles';
const ACTION_MENU_VISIBLE_CLASS = 'ytlm-visible';
const TOOLTIP_ID = 'ytlm-shared-tooltip';
const TOOLTIP_VISIBLE_CLASS = 'ytlm-tooltip-visible';
const TOOLTIP_DELAY_MS = 400;
const TOOLTIP_HIDE_DELAY_MS = 120;

const BUTTON_LABELS = {
  idle: 'Summarize with ChatGPT',
  loadingTranscript: 'Fetching transcript…',
  openingChat: 'Opening ChatGPT…'
};

const SHORTS_BUTTON_LABELS = {
  idle: 'Summarize',
  loadingTranscript: 'Loading…',
  openingChat: 'Opening…'
};

function getButtonLabelForState(state, context) {
  const normalizedState = state && BUTTON_LABELS[state] ? state : 'idle';
  if (context === 'shorts') {
    return SHORTS_BUTTON_LABELS[normalizedState] || SHORTS_BUTTON_LABELS.idle;
  }
  return BUTTON_LABELS[normalizedState] || BUTTON_LABELS.idle;
}

const DEFAULT_SETTINGS = {
  preferredChatHost: 'chatgpt.com',
  customInstructions: 'Fact check, verify, and synthesize a summary.',
  autoSendPrompt: true
};

let currentSettings = { ...DEFAULT_SETTINGS };
let settingsLoaded = false;
let settingsLoadPromise = null;
let settingsPanelRefs = null;
let lastFocusedElement = null;
let pendingButtonUpdate = false;
let activeMenuState = null;
let menuDismissListenersAttached = false;
let tooltipAnchor = null;
let tooltipScheduledFor = null;
let tooltipShowTimeout = null;
let tooltipHideTimeout = null;
let tooltipDismissListenersAttached = false;

if (typeof window !== 'undefined' && typeof document !== 'undefined' && typeof MutationObserver !== 'undefined') {
  ensureGlobalStyles();
  ensureSettingsLoaded().catch((error) => console.error('Failed to pre-load settings', error));
  addOrUpdateButtons();

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type !== 'childList') {
        continue;
      }

      if (isExtensionOwnedNode(mutation.target)) {
        continue;
      }

      const hasRelevantAddition = Array.from(mutation.addedNodes).some(
        (node) => !isExtensionOwnedNode(node)
      );
      const hasRelevantRemoval = Array.from(mutation.removedNodes).some(
        (node) => !isExtensionOwnedNode(node)
      );

      if (!hasRelevantAddition && !hasRelevantRemoval) {
        continue;
      }

      scheduleButtonUpdate();
      break;
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
    hideTooltip(true);
    setTimeout(() => {
      addOrUpdateButtons();
      resetButtonStates();
    }, 600);
  });
}

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

function isExtensionOwnedNode(node) {
  if (!node) {
    return false;
  }

  if (node.nodeType === Node.ELEMENT_NODE) {
    const element = node;

    if (typeof element.id === 'string' && element.id.startsWith('ytlm-')) {
      return true;
    }

    if (element.classList) {
      for (const className of element.classList) {
        if (className.startsWith('ytlm-')) {
          return true;
        }
      }
    }

    return false;
  }

  if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
    return Array.from(node.childNodes).every((child) => isExtensionOwnedNode(child));
  }

  if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.COMMENT_NODE) {
    const parentElement = node.parentElement;
    if (parentElement) {
      return isExtensionOwnedNode(parentElement);
    }
  }

  return false;
}

function ensureWatchButtons() {
  if (isShortsPage()) {
    const existingWatchButton = document.getElementById(WATCH_BUTTON_ID);
    if (existingWatchButton) {
      cancelTooltip(existingWatchButton);
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
      dismissTooltipForElement(slot);
      slot.remove();
    }
    removeActionMenu(SHORTS_BUTTON_ID);
    return;
  }

  const host = findShortsActionsHost();
  if (!host) {
    if (slot) {
      dismissTooltipForElement(slot);
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
  const existingState = button?.dataset?.ytlmState || 'idle';
  const initialLabel = getButtonLabelForState(existingState, context);

  if (!button) {
    button = document.createElement('button');
    button.id = id;
    button.type = 'button';
    button.dataset.ytlmBusy = 'false';
    button.dataset.ytlmState = existingState;
    button.dataset.ytlmContext = context;
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    button.className = 'ytlm-action-button';

    const icon = document.createElement('span');
    icon.className = 'ytlm-button-icon';
    icon.setAttribute('aria-hidden', 'true');

    const label = document.createElement('span');
    label.className = 'ytlm-button-label';
    label.textContent = initialLabel;

    const caret = document.createElement('span');
    caret.className = 'ytlm-button-caret';
    caret.setAttribute('aria-hidden', 'true');

    button.append(icon, label, caret);
    button.setAttribute('aria-label', initialLabel);
    button.removeAttribute('title');

    container.appendChild(button);
  } else {
    button.dataset.ytlmContext = context;
    button.classList.add('ytlm-action-button');
    button.removeAttribute('title');
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
    label.textContent = initialLabel;
    button.appendChild(label);
  }

  if (!button.querySelector('.ytlm-button-caret')) {
    const caret = document.createElement('span');
    caret.className = 'ytlm-button-caret';
    caret.setAttribute('aria-hidden', 'true');
    button.appendChild(caret);
  }

  button.dataset.ytlmContext = context;

  const nativeWatchClasses = [
    'yt-spec-button-shape-next',
    'yt-spec-button-shape-next--tonal',
    'yt-spec-button-shape-next--mono',
    'yt-spec-button-shape-next--size-m',
    'yt-spec-button-shape-next--icon-leading'
  ];

  button.classList.remove('ytlm-action-button--watch', 'ytlm-action-button--shorts', ...nativeWatchClasses);
  if (context === 'watch') {
    button.classList.add('ytlm-action-button--watch', ...nativeWatchClasses);
  } else {
    button.classList.add('ytlm-action-button--shorts');
  }

  const labelElement = button.querySelector('.ytlm-button-label');
  if (labelElement) {
    const currentState = button.dataset.ytlmState || 'idle';
    labelElement.textContent = getButtonLabelForState(currentState, context);
  }
  button.setAttribute('aria-label', getButtonLabelForState(button.dataset.ytlmState || 'idle', context));
  button.removeAttribute('title');

  if (!button.dataset.ytlmMenuBound) {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      toggleActionMenu(button, context);
    });
    button.dataset.ytlmMenuBound = 'true';
  }

  if (context !== 'shorts') {
    if (!button.dataset.ytlmTooltipBound) {
      const handlePointerEnter = (event) => {
        const target = event.currentTarget;
        if (target instanceof HTMLElement) {
          scheduleTooltip(target);
        }
      };
      const handlePointerLeave = (event) => {
        const target = event.currentTarget;
        if (target instanceof HTMLElement) {
          cancelTooltip(target);
        }
      };
      const handleFocus = (event) => {
        const target = event.currentTarget;
        if (target instanceof HTMLElement) {
          scheduleTooltip(target);
        }
      };
      const handleBlur = (event) => {
        const target = event.currentTarget;
        if (target instanceof HTMLElement) {
          cancelTooltip(target);
        }
      };
      const handlePointerDown = (event) => {
        const target = event.currentTarget;
        if (target instanceof HTMLElement) {
          cancelTooltip(target);
          hideTooltip(true);
        }
      };

      button.addEventListener('mouseenter', handlePointerEnter);
      button.addEventListener('mouseleave', handlePointerLeave);
      button.addEventListener('focus', handleFocus);
      button.addEventListener('blur', handleBlur);
      button.addEventListener('pointerdown', handlePointerDown);
      button.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' || event.key === 'Esc') {
          hideTooltip(true);
        }
      });

      button.dataset.ytlmTooltipBound = 'true';
    }
  } else {
    cancelTooltip(button);
    button.removeAttribute('aria-describedby');
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
  hideTooltip(true);
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

function ensureTooltipElement() {
  let tooltip = document.getElementById(TOOLTIP_ID);
  if (tooltip) {
    return tooltip;
  }

  if (!document.body) {
    return null;
  }

  tooltip = document.createElement('div');
  tooltip.id = TOOLTIP_ID;
  tooltip.className = 'ytlm-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.style.display = 'none';
  document.body.appendChild(tooltip);

  return tooltip;
}

function scheduleTooltip(button) {
  if (!button || button.dataset.ytlmBusy === 'true') {
    return;
  }

  if (!button.isConnected) {
    return;
  }

  if (tooltipAnchor && tooltipAnchor !== button) {
    hideTooltip(true);
  }

  tooltipScheduledFor = button;
  if (tooltipShowTimeout) {
    clearTimeout(tooltipShowTimeout);
  }
  if (tooltipHideTimeout) {
    clearTimeout(tooltipHideTimeout);
    tooltipHideTimeout = null;
  }

  tooltipShowTimeout = window.setTimeout(() => {
    tooltipShowTimeout = null;
    const target = tooltipScheduledFor;
    tooltipScheduledFor = null;
    if (target) {
      showTooltip(target);
    }
  }, TOOLTIP_DELAY_MS);
}

function cancelTooltip(button) {
  if (!button) {
    return;
  }

  if (tooltipScheduledFor === button) {
    tooltipScheduledFor = null;
    if (tooltipShowTimeout) {
      clearTimeout(tooltipShowTimeout);
      tooltipShowTimeout = null;
    }
  }

  if (tooltipAnchor === button) {
    hideTooltip(true);
  }
}

function showTooltip(button) {
  if (!button || button.dataset.ytlmBusy === 'true' || !button.isConnected) {
    return;
  }

  const tooltip = ensureTooltipElement();
  if (!tooltip) {
    return;
  }

  const label = getTooltipLabel(button);
  if (!label) {
    return;
  }

  if (tooltipAnchor && tooltipAnchor !== button) {
    hideTooltip(true);
  }

  tooltip.textContent = label;
  tooltip.style.display = 'inline-flex';
  tooltip.style.visibility = 'hidden';
  tooltip.classList.remove(TOOLTIP_VISIBLE_CLASS);

  tooltipAnchor = button;

  positionTooltip(button, tooltip);

  const describedBy = button.getAttribute('aria-describedby');
  const ids = new Set((describedBy || '').split(/\s+/).filter(Boolean));
  ids.add(TOOLTIP_ID);
  button.setAttribute('aria-describedby', Array.from(ids).join(' '));

  attachTooltipDismissListeners();

  requestAnimationFrame(() => {
    if (tooltipAnchor !== button) {
      return;
    }

    tooltip.style.visibility = '';
    positionTooltip(button, tooltip);
    tooltip.classList.add(TOOLTIP_VISIBLE_CLASS);
  });
}

function hideTooltip(immediate = false) {
  if (tooltipShowTimeout) {
    clearTimeout(tooltipShowTimeout);
    tooltipShowTimeout = null;
  }
  tooltipScheduledFor = null;

  const tooltip = document.getElementById(TOOLTIP_ID);
  const anchor = tooltipAnchor;
  tooltipAnchor = null;

  if (anchor) {
    const describedBy = anchor.getAttribute('aria-describedby');
    if (describedBy) {
      const ids = describedBy.split(/\s+/).filter(Boolean);
      const filtered = ids.filter((id) => id !== TOOLTIP_ID);
      if (filtered.length > 0) {
        anchor.setAttribute('aria-describedby', filtered.join(' '));
      } else {
        anchor.removeAttribute('aria-describedby');
      }
    }
  }

  if (!tooltip) {
    detachTooltipDismissListeners();
    return;
  }

  tooltip.classList.remove(TOOLTIP_VISIBLE_CLASS);

  const finalize = () => {
    tooltip.style.display = 'none';
    tooltip.style.visibility = '';
  };

  if (tooltipHideTimeout) {
    clearTimeout(tooltipHideTimeout);
    tooltipHideTimeout = null;
  }

  if (immediate) {
    finalize();
  } else {
    tooltipHideTimeout = window.setTimeout(() => {
      finalize();
      tooltipHideTimeout = null;
    }, TOOLTIP_HIDE_DELAY_MS);
  }

  detachTooltipDismissListeners();
}

function updateActiveTooltip(button) {
  if (!button) {
    return;
  }

  if (tooltipScheduledFor === button && button.dataset.ytlmBusy !== 'true') {
    return;
  }

  if (tooltipAnchor !== button) {
    return;
  }

  const tooltip = document.getElementById(TOOLTIP_ID);
  if (!tooltip) {
    return;
  }

  const label = getTooltipLabel(button);
  if (!label) {
    hideTooltip(true);
    return;
  }

  tooltip.textContent = label;
  tooltip.style.display = 'inline-flex';
  positionTooltip(button, tooltip);

  requestAnimationFrame(() => {
    if (tooltipAnchor === button) {
      positionTooltip(button, tooltip);
    }
  });
}

function getTooltipLabel(button) {
  if (!button) {
    return '';
  }

  const ariaLabel = button.getAttribute('aria-label');
  if (ariaLabel && ariaLabel.trim().length > 0) {
    return ariaLabel.trim();
  }

  const title = button.getAttribute('title');
  if (title && title.trim().length > 0) {
    return title.trim();
  }

  return button.textContent ? button.textContent.trim() : '';
}

function positionTooltip(button, tooltip) {
  if (!button || !tooltip) {
    return;
  }

  const anchorRect = button.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  const gap = 8;
  const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
  const viewportHeight = document.documentElement.clientHeight || window.innerHeight;

  let top;
  let left;

  top = anchorRect.bottom + gap;
  left = anchorRect.left + anchorRect.width / 2 - tooltipRect.width / 2;
  if (top + tooltipRect.height > viewportHeight - gap) {
    top = anchorRect.top - tooltipRect.height - gap;
  }

  top = Math.max(gap, Math.min(top, viewportHeight - tooltipRect.height - gap));
  left = Math.max(gap, Math.min(left, viewportWidth - tooltipRect.width - gap));

  tooltip.style.top = `${Math.round(top)}px`;
  tooltip.style.left = `${Math.round(left)}px`;
}

function attachTooltipDismissListeners() {
  if (tooltipDismissListenersAttached) {
    return;
  }

  tooltipDismissListenersAttached = true;
  document.addEventListener('pointerdown', handleTooltipDismiss, true);
  window.addEventListener('scroll', handleTooltipDismiss, true);
  window.addEventListener('resize', handleTooltipDismiss, true);
}

function detachTooltipDismissListeners() {
  if (!tooltipDismissListenersAttached) {
    return;
  }

  tooltipDismissListenersAttached = false;
  document.removeEventListener('pointerdown', handleTooltipDismiss, true);
  window.removeEventListener('scroll', handleTooltipDismiss, true);
  window.removeEventListener('resize', handleTooltipDismiss, true);
}

function handleTooltipDismiss() {
  hideTooltip(true);
}

function dismissTooltipForElement(element) {
  if (!element) {
    return;
  }

  if (tooltipScheduledFor && element.contains(tooltipScheduledFor)) {
    cancelTooltip(tooltipScheduledFor);
  }

  if (tooltipAnchor && element.contains(tooltipAnchor)) {
    cancelTooltip(tooltipAnchor);
  }
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
      throw new Error('Source text unavailable for this content.');
    }

    const title = getVideoTitle();
    const creator = getVideoCreator();
    const uploadDate = getVideoUploadDate();
    const prompt = buildPrompt({
      title,
      url: targetUrl,
      transcript,
      settings,
      creator,
      uploadDate,
      referenceDate: new Date()
    });

    setButtonState(button, 'openingChat');
    await openChatGPT(prompt, settings.preferredChatHost, settings.autoSendPrompt !== false);
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
  const context = button.dataset.ytlmContext || 'watch';
  const label = getButtonLabelForState(state, context);
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
  button.removeAttribute('title');

  updateActiveTooltip(button);

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

function getVideoCreator() {
  const authorLink = document.querySelector('link[itemprop="name"][content]');
  if (authorLink?.content) {
    const normalized = authorLink.content.trim();
    if (normalized) {
      return normalized;
    }
  }

  const selectors = [
    '#owner-container ytd-channel-name a',
    '#owner-container ytd-channel-name yt-formatted-string',
    '#upload-info ytd-channel-name a',
    '#text-container ytd-channel-name yt-formatted-string',
    'ytd-channel-name a',
    'ytd-channel-name yt-formatted-string',
    'ytd-reel-player-header-renderer #channel-name a',
    'ytd-reel-player-header-renderer #channel-name yt-formatted-string',
    'ytd-reel-player-header-renderer #creator-container yt-formatted-string'
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

  return '';
}

function getVideoUploadDate() {
  const metaSelectors = [
    'meta[itemprop="uploadDate"]',
    'meta[itemprop="datePublished"]',
    'meta[property="og:video:release_date"]'
  ];

  for (const selector of metaSelectors) {
    const element = document.querySelector(selector);
    const content =
      element?.getAttribute?.('content') || (element && 'content' in element ? element.content : null);
    if (typeof content === 'string') {
      const normalized = content.trim();
      if (normalized) {
        return normalized;
      }
    }
  }

  const textSelectors = [
    '#info-strings yt-formatted-string',
    '#description #info-strings yt-formatted-string',
    'ytd-video-primary-info-renderer #info-strings yt-formatted-string',
    'ytd-reel-player-header-renderer #info #metadata-line span',
    'span[itemprop="uploadDate"]',
    'time[itemprop="datePublished"]'
  ];

  for (const selector of textSelectors) {
    const element = document.querySelector(selector);
    const text = element?.innerText || element?.textContent || element?.getAttribute?.('datetime');
    if (text) {
      const normalized = text.trim();
      if (normalized) {
        return normalized;
      }
    }
  }

  return '';
}

function formatDateForPrompt(value) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return '';
    }
    return value.toISOString().slice(0, 10);
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return '';
    }

    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) {
      const parsedDate = new Date(parsed);
      if (!Number.isNaN(parsedDate.getTime())) {
        return parsedDate.toISOString().slice(0, 10);
      }
    }

    return trimmed;
  }

  return '';
}

function quoteForPrompt(value) {
  if (value === null || value === undefined) {
    return '""';
  }

  const stringValue = String(value);
  const escaped = stringValue.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function buildPrompt({ title, url, transcript, settings, creator, uploadDate, referenceDate }) {
  const trimmedTranscript = sanitizeTranscriptForPrompt(transcript);
  if (!trimmedTranscript) {
    throw new Error('Source text unavailable for this content.');
  }
  const safeTitle = typeof title === 'string' && title.trim() ? title.trim() : 'Untitled content';
  const safeUrl = typeof url === 'string' && url.trim() ? url.trim() : 'Unknown';
  const safeSource = typeof creator === 'string' && creator.trim() ? creator.trim() : 'Unknown source';
  const formattedUploadDate = formatDateForPrompt(uploadDate) || 'Unknown';
  const formattedReferenceDate = formatDateForPrompt(referenceDate) || formatDateForPrompt(new Date());

  const customLines = settings.customInstructions
    ? settings.customInstructions
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
    : [];

  const instructionsSegments = [];
  if (customLines.length) {
    instructionsSegments.push(customLines.join(' '));
  } else {
    instructionsSegments.push('Provide a concise, fact-checked summary of the content.');
  }

  const metadataLines = [
    `Link: ${quoteForPrompt(safeUrl)}`,
    `Title: ${quoteForPrompt(safeTitle)}`,
    `Source: ${quoteForPrompt(safeSource)}`,
    `Published: ${quoteForPrompt(formattedUploadDate)}`,
    `Date: ${quoteForPrompt(formattedReferenceDate)}`
  ].join('\n');

  const instructionsText = instructionsSegments.filter((segment) => segment && segment.trim().length > 0).join(' ');

  const promptSections = [
    metadataLines,
    `Instructions: ${quoteForPrompt(instructionsText)}`,
    `Text: ${quoteForPrompt(trimmedTranscript)}`
  ];

  return promptSections.join('\n\n');
}

function sanitizeTranscriptForPrompt(transcript) {
  if (typeof transcript !== 'string') {
    return '';
  }

  // Include bidi controls so markers & separators still match when decorated
  const zeroWidthCharacters =
    '\\u200b\\u200c\\u200d\\u200e\\u200f\\u2060\\ufeff' + // ZWSP,ZWNJ,ZWJ,LRM,RLM,WJ,BOM
    '\\u061c' + // ALM
    '\\u202a\\u202b\\u202c\\u202d\\u202e'; // LRE,RLE,PDF,LRO,RLO
  const zeroWidthCharsRegex = new RegExp(`[${zeroWidthCharacters}]`, 'g');
  const stripZeroWidth = (value) => value.replace(zeroWidthCharsRegex, '');

  let normalizedText = transcript.replace(/\r\n?/g, '\n').replace(/[\u2028\u2029]/g, '\n');

  const zeroWidthOptionalPattern = `[${zeroWidthCharacters}]*`;
  const whitespaceOrZeroWidthPattern = `(?:\\s|[${zeroWidthCharacters}])+`;
  const optionalWhitespaceOrZeroWidthPattern = `(?:\\s|[${zeroWidthCharacters}])*`;
  const escapeForRegex = (value) => value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  const allowZeroWidthInKeyword = (value) =>
    `${zeroWidthOptionalPattern}${Array.from(value)
      .map((character) => `${escapeForRegex(character)}${zeroWidthOptionalPattern}`)
      .join('')}`;
  const shareKeywordPattern = allowZeroWidthInKeyword('Share');
  const downloadKeywordPattern = allowZeroWidthInKeyword('Download');
  const copyKeywordPattern = allowZeroWidthInKeyword('Copy');
  const videoKeywordPattern = allowZeroWidthInKeyword('Video');
  const markerBoundaryLookahead = `(?=${zeroWidthOptionalPattern}(?:\\s|$|[.,;:?!]|[A-Z]))`;
  const markerContinuationLookahead =
    `(?=${zeroWidthOptionalPattern}(?:\\s|$|[.,;:?!]|${copyKeywordPattern}|${shareKeywordPattern}|${downloadKeywordPattern}))`;
  const downloadTrailingWordPattern = `(?:[A-Za-z]${zeroWidthOptionalPattern})+?`;

  const shareMarkerCorePattern = `${shareKeywordPattern}${whitespaceOrZeroWidthPattern}${videoKeywordPattern}${markerBoundaryLookahead}`;
  const downloadMarkerCorePattern =
    `${downloadKeywordPattern}${optionalWhitespaceOrZeroWidthPattern}(?:\\.${zeroWidthOptionalPattern}(?:[^\\s${zeroWidthCharacters}]${zeroWidthOptionalPattern})+?${markerContinuationLookahead}|${downloadTrailingWordPattern}${markerContinuationLookahead})`;
  const copyMarkerCorePattern = `${copyKeywordPattern}${markerBoundaryLookahead}`;
  const marketingMarkerPattern = `(?:${shareMarkerCorePattern}|${downloadMarkerCorePattern}|${copyMarkerCorePattern})`;
  const sawAnyMarketingMarker = new RegExp(marketingMarkerPattern).test(normalizedText);
  const markerSeparatorCharacters =
    `\\\\s\\u00a0${zeroWidthCharacters}&•*·\\-–—|/\\\\.,;:?!()\\[\\]"'`;
  const markerSeparatorPattern = new RegExp(`^[${markerSeparatorCharacters}]*$`);
  const headerPrefixIndicatorKeywords = [
    'summary',
    'highlights',
    'highlight',
    'notes',
    'note',
    'transcript',
    'chapter',
    'chapters',
    'title',
    'creator',
    'channel',
    'uploaded',
    'views',
    'overview',
    'introduction',
    'intro',
    'episode',
    'lesson',
    'part'
  ];
  const shouldIsolateMarker = (markerText) => {
    if (typeof markerText !== 'string' || markerText.length === 0) {
      return false;
    }

    const normalizedMarker = stripZeroWidth(markerText)
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();

    if (!normalizedMarker) {
      return false;
    }

    if (normalizedMarker.startsWith('download ')) {
      const trailingWord = normalizedMarker.slice('download '.length).trim();
      if (/^(?:the|this|that|these|those|my|your|our|his|her|their|a|an)$/i.test(trailingWord)) {
        return false;
      }
    }

    return true;
  };

  let firstLineBreakIndex = normalizedText.indexOf('\n');
  let firstLine = firstLineBreakIndex === -1 ? normalizedText : normalizedText.slice(0, firstLineBreakIndex);
  let firstLineMatches = [...firstLine.matchAll(new RegExp(marketingMarkerPattern, 'g'))];
  let removedFirstMarkerLineViaHardCut = false;
  let removedMarkerLineViaPrefixDrop = false;

  // Hard-cut header: if the first line contains ≥2 marketing markers (Share/Download/Copy),
  // drop EVERYTHING before the *last* marker so the first token is the spoken text (e.g., "Daniel.")
  if (firstLineMatches.length >= 2) {
    const lastMatch = firstLineMatches[firstLineMatches.length - 1];
    const restOfFirstLine = firstLine
      .slice(lastMatch.index + lastMatch[0].length)
      .replace(new RegExp(`^[\\s\\u00a0${zeroWidthCharacters}]+`, 'u'), '');
    const remainder = firstLineBreakIndex === -1 ? '' : normalizedText.slice(firstLineBreakIndex + 1);
    normalizedText = restOfFirstLine
      ? `${restOfFirstLine}${remainder ? `\n${remainder}` : ''}`
      : remainder;

    firstLineBreakIndex = normalizedText.indexOf('\n');
    firstLine = firstLineBreakIndex === -1 ? normalizedText : normalizedText.slice(0, firstLineBreakIndex);
    firstLineMatches = [...firstLine.matchAll(new RegExp(marketingMarkerPattern, 'g'))];
    removedFirstMarkerLineViaHardCut = true;
  }

  const shouldDropFirstLinePrefix = (() => {
    if (firstLineMatches.length === 0) {
      return false;
    }

    const firstMarkerIndex = firstLineMatches[0].index;
    if (firstMarkerIndex <= 0) {
      return false;
    }

    const rawPrefix = firstLine.slice(0, firstMarkerIndex);
    const strippedPrefix = stripZeroWidth(rawPrefix).trim();
    if (strippedPrefix.length === 0) {
      return false;
    }

    const normalizedPrefix = strippedPrefix.toLowerCase();
    const prefixHasIndicator =
      headerPrefixIndicatorKeywords.some((keyword) => normalizedPrefix.includes(keyword)) ||
      /[•|]/.test(strippedPrefix) ||
      /[-–—]/.test(strippedPrefix) ||
      /\bby\b/i.test(strippedPrefix);
    const prefixLengthScore = normalizedPrefix.replace(/\s+/g, ' ').length >= 15;

    if (firstLineMatches.length < 2 && !prefixHasIndicator) {
      return false;
    }

    if (!prefixHasIndicator && !prefixLengthScore) {
      return false;
    }

    let previousEnd = firstMarkerIndex;
    for (const match of firstLineMatches) {
      const separator = stripZeroWidth(firstLine.slice(previousEnd, match.index));
      if (separator.length > 0 && !markerSeparatorPattern.test(separator)) {
        return false;
      }
      previousEnd = match.index + match[0].length;
    }

    return true;
  })();

  if (shouldDropFirstLinePrefix) {
    const lastMatch = firstLineMatches[firstLineMatches.length - 1];
    const restOfFirstLine = firstLine
      .slice(lastMatch.index + lastMatch[0].length)
      .replace(new RegExp(`^[\\s\\u00a0${zeroWidthCharacters}]+`, 'u'), '');
    const remainder =
      firstLineBreakIndex === -1 ? '' : normalizedText.slice(firstLineBreakIndex + 1);
    normalizedText = restOfFirstLine
      ? `${restOfFirstLine}${remainder ? `\n${remainder}` : ''}`
      : remainder;
    removedMarkerLineViaPrefixDrop = true;
  }

  // Always try to isolate markers; we'll still gate with shouldIsolateMarker(...)
  const marketingBreakPatterns = [
    new RegExp(`(${shareMarkerCorePattern})`, 'g'),
    new RegExp(`(${downloadMarkerCorePattern})`, 'g'),
    new RegExp(`(${copyMarkerCorePattern})`, 'g')
  ];

  let processedText = normalizedText;
  for (const pattern of marketingBreakPatterns) {
    processedText = processedText.replace(pattern, (match, marker) => {
      const safeMarker = marker === undefined ? match : marker;
      if (!shouldIsolateMarker(safeMarker)) {
        return safeMarker;
      }
      return `\n${safeMarker}\n`;
    });
  }

  const lines = processedText
    .split('\n')
    .map((line) => line.replace(/\u00a0/g, ' ').trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return '';
  }

  const marketingPrefixes = [
    /^(?:&\s*)?summary\b/i,
    /^share\s+video\b/i,
    /^copy\b/i
  ];
  const marketingExactMatches = new Set([
    'summary',
    'share video',
    'copy',
    'transcript',
    'highlight',
    'highlights',
    'my highlights',
    'note',
    'notes',
    'my notes'
  ]);
  const marketingKeywordFragments = ['share', 'video', 'download', 'copy', 'highlight', 'highlights', 'note', 'notes', 'transcript'];
  const isDownloadHeader = (headerKey) =>
    headerKey.startsWith('download ') && /(?:\.srt\b|\btranscript\b|\.txt\b|\btext\b)/.test(headerKey);

  const normalizeForComparison = (value) =>
    stripZeroWidth(value)
      .toLowerCase()
      .replace(/[\s\u00a0]+/g, ' ')
      .replace(/^[\s\p{P}\p{S}]+/gu, '')
      .replace(/[\s\p{P}\p{S}]+$/gu, '')
      .trim();

  let lineData = lines.map((line) => {
    const compactLine = stripZeroWidth(line).replace(/[\s\u00a0]+/g, ' ');
    const headerCandidate = compactLine.replace(/^[\s&•*·\-–—]+/u, '');
    const headerKey = normalizeForComparison(headerCandidate);
    const comparisonKey = normalizeForComparison(line);
    return { line, headerCandidate, headerKey, comparisonKey };
  });

  const looksLikeMetadataEntry = (entry) => {
    const { headerCandidate } = entry;
    if (!headerCandidate) {
      return false;
    }

    if (/^by\s+/i.test(headerCandidate)) {
      return true;
    }

    if (/[#@]/.test(headerCandidate) || headerCandidate.includes('•')) {
      return true;
    }

    if (
      /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i.test(
        headerCandidate
      )
    ) {
      return true;
    }

    return false;
  };

  const dropLeadingMetadataEntries = () => {
    let dropCount = 0;
    while (dropCount < lineData.length && looksLikeMetadataEntry(lineData[dropCount])) {
      dropCount += 1;
    }

    if (dropCount === 0) {
      return false;
    }

    lineData = lineData.slice(dropCount);
    return true;
  };

  if (removedFirstMarkerLineViaHardCut) {
    dropLeadingMetadataEntries();
  }

  const isMarketingEntry = (entry) => {
    const { headerCandidate, headerKey, comparisonKey } = entry;
    if (!comparisonKey) {
      return true;
    }

    const hasSummaryPrefix = headerKey && headerKey.startsWith('summary');
    const containsMarketingKeyword =
      headerKey && marketingKeywordFragments.some((keyword) => headerKey.includes(keyword));

    return (
      marketingPrefixes.some((pattern) => pattern.test(headerCandidate)) ||
      (headerKey && (marketingExactMatches.has(headerKey) || isDownloadHeader(headerKey))) ||
      (hasSummaryPrefix && (headerKey === 'summary' || containsMarketingKeyword))
    );
  };

  const buildMarkerLineIndices = () => {
    const indices = [];
    for (let index = 0; index < lineData.length; index += 1) {
      const { headerKey } = lineData[index];
      if (!headerKey) {
        continue;
      }

      if (
        headerKey === 'share video' ||
        headerKey.startsWith('share video ') ||
        headerKey === 'copy' ||
        headerKey.startsWith('copy ') ||
        isDownloadHeader(headerKey)
      ) {
        indices.push(index);
      }
    }
    return indices;
  };

  let markerLineIndices = buildMarkerLineIndices();

  if (markerLineIndices.length === 0 && removedMarkerLineViaPrefixDrop && sawAnyMarketingMarker) {
    const droppedMetadata = dropLeadingMetadataEntries();
    if (droppedMetadata) {
      markerLineIndices = buildMarkerLineIndices();
    }
  }

  const qualifiesAsMetadataEntry = (entry) =>
    isMarketingEntry(entry) || looksLikeMetadataEntry(entry);

  let startIndex = 0;
  if (markerLineIndices.length > 0) {
    const firstMarkerIndex = markerLineIndices[0];

    if (firstMarkerIndex > 0) {
      const precedingEntries = lineData.slice(0, firstMarkerIndex);
      const precedingLinesAreMetadata =
        precedingEntries.length > 0 &&
        precedingEntries.every((entry) => qualifiesAsMetadataEntry(entry)) &&
        precedingEntries.some((entry) => looksLikeMetadataEntry(entry));

      if (precedingLinesAreMetadata) {
        startIndex = firstMarkerIndex;
      }
    }
  }

  while (startIndex < lineData.length) {
    const entry = lineData[startIndex];
    const { comparisonKey } = entry;

    let duplicateCount = 1;
    while (
      startIndex + duplicateCount < lineData.length &&
      comparisonKey &&
      comparisonKey === lineData[startIndex + duplicateCount].comparisonKey
    ) {
      duplicateCount += 1;
    }

    if (duplicateCount > 1) {
      startIndex += duplicateCount;
      continue;
    }

    if (isMarketingEntry(entry)) {
      startIndex += 1;
      continue;
    }

    break;
  }

  const sanitizedLines = lineData.slice(startIndex).map((entry) => entry.line);
  const sanitizedText = sanitizedLines.join('\n').trim();
  return sanitizedText;
}

function buildPromptPreview(settings) {
  const previewTranscript = [
    '[00:00] {{content_line_1}}',
    '[00:45] {{content_line_2}}',
    '[01:30] {{content_line_3}}'
  ].join('\n');
  return buildPrompt({
    title: '{{content_title}}',
    url: '{{source_url}}',
    transcript: previewTranscript,
    settings,
    creator: '{{content_source}}',
    uploadDate: '{{published_date}}',
    referenceDate: '{{current_date}}'
  });
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

      const errorMessage = response?.error || 'Source text unavailable for this content.';
      reject(new Error(errorMessage));
    });
  });
}

async function openChatGPT(prompt, preferredHost, autoSend) {
  if (!chrome?.runtime?.sendMessage) {
    throw new Error('chrome.runtime.sendMessage is unavailable.');
  }

  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'openChatGPT', prompt, preferredHost, autoSend }, (response) => {
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
      width: 60px;
      min-height: 88px;
      flex: none;
      margin: 8px 0 20px;
    }

    .ytlm-shorts-button-slot {
      display: flex;
      justify-content: center;
      width: 100%;
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

    .ytlm-action-button--shorts:focus-visible {
      outline-offset: 4px;
    }

    .ytlm-action-button--watch {
      margin-left: 8px;
      min-height: 36px;
      padding: 0 16px;
      border-radius: 18px;
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

    ytd-app[dark] .ytlm-action-button--watch,
    html[dark] .ytlm-action-button--watch,
    body[dark] .ytlm-action-button--watch {
      background: var(--yt-spec-badge-chip-background, rgba(255, 255, 255, 0.16));
      color: var(--yt-spec-text-primary-inverse, #f1f1f1);
    }

    ytd-app[dark] .ytlm-action-button--watch:hover:not(.ytlm-busy),
    html[dark] .ytlm-action-button--watch:hover:not(.ytlm-busy),
    body[dark] .ytlm-action-button--watch:hover:not(.ytlm-busy) {
      background: var(--yt-spec-touch-response, rgba(255, 255, 255, 0.18));
    }

    ytd-app[dark] .ytlm-action-button--watch:active,
    html[dark] .ytlm-action-button--watch:active,
    body[dark] .ytlm-action-button--watch:active {
      background: var(--yt-spec-touch-response, rgba(255, 255, 255, 0.22));
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
      flex-direction: column;
      align-items: center;
      justify-content: flex-start;
      gap: 6px;
      width: 56px;
      padding: 0;
      border: none;
      background: none;
      color: var(--yt-spec-text-primary-inverse, #f1f1f1);
    }

    .ytlm-action-button--shorts:focus-visible {
      outline: none;
    }

    .ytlm-action-button--shorts .ytlm-button-label {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      text-align: center;
      white-space: normal;
      font-size: 12px;
      font-weight: 600;
      line-height: 1.25;
      max-width: 56px;
    }

    .ytlm-action-button--shorts .ytlm-button-caret {
      display: none;
    }

    .ytlm-action-button--shorts .ytlm-button-icon {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 48px;
      height: 48px;
      border-radius: 50%;
      background-color: var(--yt-spec-static-overlay-background-brand, rgba(0, 0, 0, 0.08));
      background-repeat: no-repeat;
      background-position: center;
      background-size: 24px 24px;
      background-image: url('data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%20viewBox%3D%220%200%2024%2024%22%20fill%3D%22none%22%3E%3Cpath%20fill%3D%22%23FF0000%22%20d%3D%22M10.8%202.1%2016.6%205c1.4.7%201.9%202.4%201.2%203.8-.2.4-.5.7-.8.9l-1.8%201.1%201.8%201c1.4.7%201.9%202.4%201.2%203.8-.2.4-.5.7-.8.9l-5.8%203c-1.5.8-3.3.2-4.1-1.2-.4-.7-.5-1.5-.3-2.3l.1-.3-1.4-.7c-1.4-.7-1.9-2.4-1.2-3.8.2-.4.5-.7.8-.9l1.8-1.1-1.8-1c-1.4-.7-1.9-2.4-1.2-3.8.2-.4.5-.7.8-.9l5.8-3c.9-.5%202-.5%202.9%200Z%22/%3E%3Cpath%20fill%3D%22%23FFFFFF%22%20d%3D%22M10%208.75v6.5l5-3.25-5-3.25Z%22/%3E%3C/svg%3E');
      transition: background-color 0.18s ease, transform 0.18s ease;
    }

    .ytlm-action-button--shorts:hover:not(.ytlm-busy) .ytlm-button-icon {
      background-color: var(--yt-spec-static-overlay-background-strong, rgba(0, 0, 0, 0.12));
      transform: translateY(-1px);
    }

    .ytlm-action-button--shorts:active .ytlm-button-icon {
      background-color: var(--yt-spec-static-overlay-background-heavy, rgba(0, 0, 0, 0.16));
      transform: translateY(0);
    }

    .ytlm-action-button--shorts .ytlm-button-icon::after {
      content: '';
      position: absolute;
      inset: 12px;
      border-radius: 50%;
      border: 3px solid var(--yt-spec-static-overlay-background-strong, rgba(0, 0, 0, 0.18));
      border-top-color: var(--yt-spec-static-overlay-background-heavy, rgba(0, 0, 0, 0.36));
      opacity: 0;
    }

    .ytlm-action-button--shorts.ytlm-busy {
      cursor: progress;
    }

    .ytlm-action-button--shorts.ytlm-busy .ytlm-button-icon {
      background-image: none;
    }

    .ytlm-action-button--shorts.ytlm-busy .ytlm-button-icon::after {
      opacity: 1;
      animation: ytlm-spin 1s linear infinite;
    }

    ytd-app[dark] .ytlm-action-button--shorts .ytlm-button-icon,
    html[dark] .ytlm-action-button--shorts .ytlm-button-icon,
    body[dark] .ytlm-action-button--shorts .ytlm-button-icon {
      background-color: var(--yt-spec-static-overlay-background-brand, rgba(255, 255, 255, 0.16));
    }

    ytd-app[dark] .ytlm-action-button--shorts:hover:not(.ytlm-busy) .ytlm-button-icon,
    html[dark] .ytlm-action-button--shorts:hover:not(.ytlm-busy) .ytlm-button-icon,
    body[dark] .ytlm-action-button--shorts:hover:not(.ytlm-busy) .ytlm-button-icon {
      background-color: var(--yt-spec-static-overlay-background-strong, rgba(255, 255, 255, 0.24));
    }

    ytd-app[dark] .ytlm-action-button--shorts:active .ytlm-button-icon,
    html[dark] .ytlm-action-button--shorts:active .ytlm-button-icon,
    body[dark] .ytlm-action-button--shorts:active .ytlm-button-icon {
      background-color: var(--yt-spec-static-overlay-background-heavy, rgba(255, 255, 255, 0.32));
    }

    ytd-app[dark] .ytlm-action-button--shorts .ytlm-button-icon::after,
    html[dark] .ytlm-action-button--shorts .ytlm-button-icon::after,
    body[dark] .ytlm-action-button--shorts .ytlm-button-icon::after {
      border-color: var(--yt-spec-static-overlay-background-strong, rgba(255, 255, 255, 0.28));
      border-top-color: var(--yt-spec-static-overlay-background-heavy, rgba(255, 255, 255, 0.68));
    }

    .ytlm-tooltip {
      position: fixed;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 6px 10px;
      border-radius: 4px;
      font-size: 12px;
      line-height: 1.4;
      font-weight: 500;
      font-family: Roboto, Arial, sans-serif;
      background: rgba(28, 28, 28, 0.92);
      color: #ffffff;
      pointer-events: none;
      opacity: 0;
      transform: translateY(4px);
      transition: opacity 0.18s ease, transform 0.18s ease;
      white-space: nowrap;
      z-index: 2147483601;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
      will-change: transform, opacity;
    }

    .ytlm-tooltip.${TOOLTIP_VISIBLE_CLASS} {
      opacity: 1;
      transform: translateY(0);
    }

    ytd-app[dark] .ytlm-tooltip,
    html[dark] .ytlm-tooltip,
    body[dark] .ytlm-tooltip {
      background: rgba(0, 0, 0, 0.92);
      color: #ffffff;
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

    #${SETTINGS_PANEL_ID} .ytlm-preview-container {
      display: flex;
      flex-direction: column;
      gap: 6px;
      margin-top: 4px;
    }

    #${SETTINGS_PANEL_ID} .ytlm-preview-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 13px;
      font-weight: 600;
    }

    #${SETTINGS_PANEL_ID} .ytlm-inline-button {
      background: transparent;
      color: inherit;
      border: 1px solid var(--yt-spec-outline, rgba(0, 0, 0, 0.2));
      border-radius: 999px;
      padding: 4px 12px;
      font-size: 12px;
      cursor: pointer;
    }

    #${SETTINGS_PANEL_ID} .ytlm-inline-button:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    #${SETTINGS_PANEL_ID} .ytlm-inline-button:active:not(:disabled) {
      transform: translateY(1px);
    }

    #${SETTINGS_PANEL_ID} .ytlm-prompt-preview {
      font-family: 'Roboto Mono', 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
      font-size: 12px;
      min-height: 150px;
      white-space: pre;
    }

    #${SETTINGS_PANEL_ID} .ytlm-preview-note {
      margin: 0;
      font-size: 12px;
      color: var(--yt-spec-text-secondary, #606060);
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
  const sanitizedInstructions = sanitizeMultilineString(
    raw.customInstructions,
    DEFAULT_SETTINGS.customInstructions
  );
  if (sanitizedInstructions.trim() === 'You are helping me summarize a YouTube video.') {
    settings.customInstructions = DEFAULT_SETTINGS.customInstructions;
  } else {
    settings.customInstructions = sanitizedInstructions;
  }
  settings.autoSendPrompt = sanitizeBoolean(raw.autoSendPrompt, DEFAULT_SETTINGS.autoSendPrompt);

  return settings;
}

function sanitizeHost(value, fallback) {
  if (typeof value === 'string') {
    const normalized = value
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*/, '');
    if (normalized === 'chatgpt.com') {
      return 'chatgpt.com';
    }
  }
  return fallback;
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
  hostLabel.textContent = 'Preferred Domain';
  const hostSelect = document.createElement('select');
  hostSelect.name = 'preferredChatHost';
  const optionChatGPT = document.createElement('option');
  optionChatGPT.value = 'chatgpt.com';
  optionChatGPT.textContent = 'ChatGPT';
  hostSelect.append(optionChatGPT);
  hostLabel.appendChild(hostSelect);

  const autoSendLabel = document.createElement('label');
  autoSendLabel.className = 'ytlm-checkbox';
  const autoSendCheckbox = document.createElement('input');
  autoSendCheckbox.type = 'checkbox';
  autoSendCheckbox.name = 'autoSendPrompt';
  const autoSendText = document.createElement('span');
  autoSendText.textContent = 'Automatically send pasted prompt.';
  autoSendLabel.append(autoSendCheckbox, autoSendText);

  const instructionsLabel = document.createElement('label');
  instructionsLabel.textContent = 'Custom Instructions';
  const instructionsTextarea = document.createElement('textarea');
  instructionsTextarea.name = 'customInstructions';
  instructionsLabel.appendChild(instructionsTextarea);

  const previewContainer = document.createElement('div');
  previewContainer.className = 'ytlm-preview-container';
  const previewHeader = document.createElement('div');
  previewHeader.className = 'ytlm-preview-header';
  const previewTitle = document.createElement('span');
  previewTitle.textContent = 'Prompt preview';
  const previewCopyButton = document.createElement('button');
  previewCopyButton.type = 'button';
  previewCopyButton.className = 'ytlm-inline-button';
  previewCopyButton.textContent = 'Copy';
  previewHeader.append(previewTitle, previewCopyButton);
  const previewTextarea = document.createElement('textarea');
  previewTextarea.className = 'ytlm-prompt-preview';
  previewTextarea.setAttribute('readonly', 'readonly');
  previewTextarea.setAttribute('spellcheck', 'false');
  previewTextarea.rows = 10;
  const previewNote = document.createElement('p');
  previewNote.className = 'ytlm-preview-note';
  previewNote.textContent = 'Placeholders such as {{content_title}} and {{content_line_1}} will be replaced with real content details when the prompt is sent.';
  previewContainer.append(previewHeader, previewTextarea, previewNote);

  const actionsRow = document.createElement('div');
  actionsRow.className = 'ytlm-settings-actions';
  const saveButton = document.createElement('button');
  saveButton.type = 'submit';
  saveButton.className = 'ytlm-primary';
  saveButton.textContent = 'Save';
  const resetButton = document.createElement('button');
  resetButton.type = 'button';
  resetButton.className = 'ytlm-secondary';
  resetButton.textContent = 'Reset';
  actionsRow.append(saveButton, resetButton);

  const status = document.createElement('p');
  status.className = 'ytlm-settings-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  form.append(hostLabel, autoSendLabel, instructionsLabel, previewContainer, actionsRow);

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
      autoSendCheckbox,
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
      autoSendCheckbox,
      instructionsTextarea
    },
    saveButton,
    resetButton,
    previewTextarea,
    previewCopyButton
  };

  const updatePreview = () => updatePromptPreviewFromForm(settingsPanelRefs);
  const updateUnsavedStatus = () => updateUnsavedChangesStatus(settingsPanelRefs);
  hostSelect.addEventListener('change', () => {
    updatePreview();
    updateUnsavedStatus();
  });
  instructionsTextarea.addEventListener('input', () => {
    updatePreview();
    updateUnsavedStatus();
  });
  autoSendCheckbox.addEventListener('change', updateUnsavedStatus);

  resetButton.addEventListener('click', () => {
    populateSettingsForm(settingsPanelRefs.elements, { ...DEFAULT_SETTINGS });
    updatePromptPreviewFromForm(settingsPanelRefs);
    updateUnsavedChangesStatus(settingsPanelRefs);
  });

  if (!(navigator?.clipboard && typeof navigator.clipboard.writeText === 'function')) {
    previewCopyButton.disabled = true;
    previewCopyButton.title = 'Clipboard access is unavailable in this context.';
  } else {
    previewCopyButton.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(previewTextarea.value);
        setStatusMessage(status, 'Prompt preview copied to clipboard.', false);
      } catch (error) {
        console.error('Failed to copy prompt preview', error);
        setStatusMessage(status, 'Unable to copy prompt preview. Please copy manually.', true);
      }
    });
  }

  return settingsPanelRefs;
}

async function openSettingsPanel() {
  const refs = ensureSettingsPanel();
  await ensureSettingsLoaded();

  populateSettingsForm(refs.elements, currentSettings);
  updatePromptPreviewFromForm(refs);
  refs.status.textContent = '';
  refs.status.classList.remove('ytlm-error');
  updateUnsavedChangesStatus(refs);

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
  if (!elements) {
    return;
  }
  if (elements.hostSelect) {
    elements.hostSelect.value = settings.preferredChatHost;
  }
  if (elements.autoSendCheckbox) {
    elements.autoSendCheckbox.checked = settings.autoSendPrompt;
  }
  if (elements.instructionsTextarea) {
    elements.instructionsTextarea.value = settings.customInstructions;
  }
}

function collectSettingsFromElements(elements) {
  if (!elements) {
    return { ...DEFAULT_SETTINGS };
  }

  return sanitizeSettings({
    preferredChatHost: elements.hostSelect?.value,
    autoSendPrompt: elements.autoSendCheckbox?.checked,
    customInstructions: elements.instructionsTextarea?.value
  });
}

function areSettingsEqual(a, b) {
  if (!a || !b) {
    return false;
  }

  return (
    a.preferredChatHost === b.preferredChatHost &&
    a.autoSendPrompt === b.autoSendPrompt &&
    a.customInstructions === b.customInstructions
  );
}

function updateUnsavedChangesStatus(refs) {
  if (!refs?.status) {
    return;
  }

  const formSettings = collectSettingsFromElements(refs.elements);
  const hasUnsavedChanges = !areSettingsEqual(formSettings, currentSettings);

  if (hasUnsavedChanges) {
    setStatusMessage(refs.status, 'Save to apply settings.', false);
    return;
  }

  if (refs.status.textContent === 'Save to apply settings.') {
    setStatusMessage(refs.status, '', false);
  }
}

function updatePromptPreviewFromForm(refs) {
  if (!refs?.previewTextarea) {
    return;
  }

  const previewSettings = collectSettingsFromElements(refs.elements);
  refs.previewTextarea.value = buildPromptPreview(previewSettings);
  refs.previewTextarea.scrollTop = 0;
}

async function handleSettingsSubmit({ hostSelect, autoSendCheckbox, instructionsTextarea, saveButton, status }) {
  const updated = {
    preferredChatHost: hostSelect.value,
    autoSendPrompt: autoSendCheckbox.checked,
    customInstructions: instructionsTextarea.value
  };

  setStatusMessage(status, 'Saving…', false);
  saveButton.disabled = true;

  try {
    await saveSettings(updated);
    if (settingsPanelRefs) {
      updatePromptPreviewFromForm(settingsPanelRefs);
    }
    setStatusMessage(status, 'Settings saved.', false);
    closeSettingsPanel();
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    sanitizeTranscriptForPrompt,
    buildPrompt
  };
}
