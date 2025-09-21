const GLASP_READER_BASE_URL = 'https://glasp.co/reader?url=';
const GLASP_READER_LOAD_TIMEOUT_MS = 20000;
const PENDING_STORAGE_KEY = 'pendingPromptsV2';
const MAX_INJECTION_ATTEMPTS = 12;
const RETRY_DELAY_MS = 1000;

const activeInjections = new Set();
let pendingPrompts = new Map();
let pendingLoaded = false;
let pendingLoadingPromise = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'fetchTranscriptFromGlasp' && typeof message.videoUrl === 'string') {
    (async () => {
      try {
        const transcript = await fetchTranscriptFromGlasp(message.videoUrl);
        sendResponse({ status: 'success', transcript });
      } catch (error) {
        console.error('Failed to fetch transcript from Glasp:', error);
        sendResponse({
          status: 'error',
          error: error instanceof Error ? error.message : 'Unable to retrieve transcript from Glasp.'
        });
      }
    })();
    return true;
  }

  if (message?.type === 'openChatGPT' && typeof message.prompt === 'string') {
    (async () => {
      try {
        const response = await openChatGPTTab(message.prompt, message.preferredHost);
        sendResponse(response);
      } catch (error) {
        console.error('Failed to open ChatGPT tab:', error);
        sendResponse({
          status: 'error',
          error: error instanceof Error ? error.message : 'Unable to open ChatGPT.'
        });
      }
    })();
    return true;
  }

  return false;
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  try {
    await ensurePendingPromptsLoaded();
  } catch (error) {
    console.error('Unable to load pending prompts from storage.', error);
    return;
  }

  if (!pendingPrompts.has(tabId)) {
    return;
  }

  const updatedUrl = changeInfo.url || tab?.url || '';
  if (!isChatUrl(updatedUrl)) {
    return;
  }

  if (changeInfo.status === 'complete' || changeInfo.url) {
    scheduleInjectionAttempt(tabId, 0);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  activeInjections.delete(tabId);
  try {
    await removePendingPrompt(tabId);
  } catch (error) {
    console.error('Failed to clean up pending prompt for closed tab', tabId, error);
  }
});

(async () => {
  try {
    await ensurePendingPromptsLoaded();
  } catch (error) {
    console.error('Failed to load pending prompts during startup.', error);
    return;
  }

  for (const tabId of pendingPrompts.keys()) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab?.url && isChatUrl(tab.url)) {
        scheduleInjectionAttempt(tabId, RETRY_DELAY_MS);
      } else {
        await removePendingPrompt(tabId);
      }
    } catch (error) {
      await removePendingPrompt(tabId);
    }
  }
})();

async function fetchTranscriptFromGlasp(videoUrl) {
  const targetUrl = `${GLASP_READER_BASE_URL}${encodeURIComponent(videoUrl)}`;
  const readerTab = await chrome.tabs.create({ url: targetUrl, active: false });
  if (!readerTab?.id) {
    throw new Error('Unable to open Glasp reader.');
  }

  let tabClosed = false;
  const tabId = readerTab.id;

  const cleanup = async () => {
    if (tabClosed) {
      return;
    }
    tabClosed = true;
    try {
      await chrome.tabs.remove(tabId);
    } catch (error) {
      if (error && typeof error.message === 'string' && /No tab with id/.test(error.message)) {
        return;
      }
      console.debug('Failed to close Glasp reader tab', error);
    }
  };

  try {
    await waitForTabComplete(tabId, GLASP_READER_LOAD_TIMEOUT_MS);
    const pageText = await getTabInnerText(tabId);
    const transcript = parseTranscriptFromReaderText(pageText);
    await cleanup();
    return transcript;
  } catch (error) {
    await cleanup();
    throw error instanceof Error ? error : new Error('Unable to read transcript from Glasp.');
  }
}

async function openChatGPTTab(prompt, preferredHost) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('Invalid prompt supplied.');
  }

  const host = normalizeChatHost(preferredHost);
  const url = `https://${host}/`;
  const tab = await chrome.tabs.create({ url, active: true });

  if (!tab?.id) {
    throw new Error('Failed to open ChatGPT tab.');
  }

  await setPendingPrompt(tab.id, { prompt, attempts: 0, host });
  scheduleInjectionAttempt(tab.id, 1500);
  return { status: 'opening', tabId: tab.id };
}

function scheduleInjectionAttempt(tabId, delay) {
  if (activeInjections.has(tabId)) {
    return;
  }

  setTimeout(() => {
    void attemptPromptInjection(tabId);
  }, Math.max(0, delay));
}

async function attemptPromptInjection(tabId) {
  if (activeInjections.has(tabId)) {
    return;
  }
  activeInjections.add(tabId);

  try {
    await ensurePendingPromptsLoaded();
    const pending = pendingPrompts.get(tabId);
    if (!pending) {
      return;
    }

    if ((pending.attempts ?? 0) >= MAX_INJECTION_ATTEMPTS) {
      console.warn('Maximum prompt injection attempts reached for tab', tabId);
      await removePendingPrompt(tabId);
      return;
    }

    pending.attempts = (pending.attempts ?? 0) + 1;
    await persistPendingPrompts();

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: injectPromptAndSend,
      args: [pending.prompt]
    });

    const status = result?.status || (result === true ? 'success' : 'retry');

    if (status === 'success') {
      await removePendingPrompt(tabId);
      return;
    }

    if (status === 'permanent-failure') {
      console.warn('Prompt injection reported a permanent failure for tab', tabId, result?.reason);
      await removePendingPrompt(tabId);
      return;
    }

    if ((pending.attempts ?? 0) < MAX_INJECTION_ATTEMPTS) {
      scheduleInjectionAttempt(tabId, RETRY_DELAY_MS);
    } else {
      await removePendingPrompt(tabId);
    }
  } catch (error) {
    console.error('Prompt injection failed for tab', tabId, error);
    await removePendingPrompt(tabId);
  } finally {
    activeInjections.delete(tabId);
  }
}

async function waitForTabComplete(tabId, timeoutMs) {
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Timed out while waiting for Glasp to load.'));
    }, timeoutMs);

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId) {
        return;
      }

      if (changeInfo.status === 'complete') {
        clearTimeout(timeoutId);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }

      if (changeInfo.status === 'loading' && Date.now() - startTime > timeoutMs) {
        clearTimeout(timeoutId);
        chrome.tabs.onUpdated.removeListener(listener);
        reject(new Error('Glasp took too long to load.'));
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function getTabInnerText(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => document?.body?.innerText || ''
    });
    if (typeof result !== 'string') {
      throw new Error('Unable to read transcript content from Glasp.');
    }
    return result;
  } catch (error) {
    throw error instanceof Error ? error : new Error('Failed to read transcript from Glasp.');
  }
}

function parseTranscriptFromReaderText(pageText) {
  if (typeof pageText !== 'string' || pageText.trim().length === 0) {
    throw new Error('Empty response received from Glasp.');
  }

  if (/Attention Required! \| Cloudflare/i.test(pageText)) {
    throw new Error('Glasp is requesting additional verification. Open glasp.co in your browser and retry.');
  }

  if (/Please\s+(?:sign\s+in|log\s+in)/i.test(pageText)) {
    throw new Error('Please sign in to Glasp in this browser to access transcripts.');
  }

  const lines = pageText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const transcriptStart = lines.findIndex((line) => /^Transcript$/i.test(line) || /Transcript:?$/i.test(line));
  const contentLines = transcriptStart >= 0 ? lines.slice(transcriptStart + 1) : lines;

  const stopPattern = /^(Summary|Highlights|Notes?|Comments|Write a comment|Related)/i;
  const timestampInline = /^(?:\[\s*)?((?:\d{1,2}:)?\d{1,2}:\d{2})(?:\s*\]?)(?:\s*[-–:\u2013]\s*|\s+)(.+)$/;
  const timestampSolo = /^(?:\[\s*)?((?:\d{1,2}:)?\d{1,2}:\d{2})(?:\s*\]?)(?:\s*[-–:\u2013]\s*)?$/;

  const segments = [];
  let index = 0;

  while (index < contentLines.length) {
    const line = contentLines[index];
    if (stopPattern.test(line)) {
      break;
    }

    const inlineMatch = line.match(timestampInline);
    if (inlineMatch) {
      const [, timestamp, text] = inlineMatch;
      segments.push(formatTranscriptSegment(timestamp, text));
      index += 1;
      continue;
    }

    const soloMatch = line.match(timestampSolo);
    if (soloMatch) {
      const [, timestamp] = soloMatch;
      index += 1;
      const textParts = [];
      while (index < contentLines.length) {
        const nextLine = contentLines[index];
        if (stopPattern.test(nextLine) || timestampSolo.test(nextLine) || timestampInline.test(nextLine)) {
          break;
        }
        textParts.push(nextLine);
        index += 1;
      }
      if (textParts.length > 0) {
        segments.push(formatTranscriptSegment(timestamp, textParts.join(' ')));
      }
      continue;
    }

    index += 1;
  }

  if (segments.length === 0) {
    const fallbackTranscript = contentLines.join('\n').trim();
    if (!fallbackTranscript) {
      throw new Error('Transcript data not found on Glasp for this video.');
    }
    return fallbackTranscript;
  }

  return segments.join('\n');
}

function formatTranscriptSegment(timestamp, text) {
  const normalizedText = (text || '').replace(/\s+/g, ' ').trim();
  const normalizedTimestamp = normalizeTimestamp(timestamp);
  if (normalizedText) {
    return `[${normalizedTimestamp}] ${normalizedText}`;
  }
  return `[${normalizedTimestamp}]`;
}

function normalizeTimestamp(raw) {
  if (typeof raw !== 'string') {
    return '00:00';
  }
  const cleaned = raw.replace(/[^0-9:]/g, '');
  if (!cleaned) {
    return '00:00';
  }

  const parts = cleaned.split(':').map((part) => Number.parseInt(part, 10)).filter((value) => !Number.isNaN(value));
  if (parts.length === 0) {
    return cleaned;
  }

  let totalSeconds = 0;
  for (const part of parts) {
    totalSeconds = totalSeconds * 60 + part;
  }

  if (!Number.isFinite(totalSeconds)) {
    return cleaned;
  }

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');

  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

function isChatUrl(url) {
  if (typeof url !== 'string') {
    return false;
  }
  return url.startsWith('https://chat.openai.com') || url.startsWith('https://chatgpt.com');
}

function normalizeChatHost(host) {
  if (typeof host === 'string') {
    const trimmed = host.trim().toLowerCase();
    if (trimmed === 'chat.openai.com' || trimmed === 'chat.openai.com/') {
      return 'chat.openai.com';
    }
    if (trimmed === 'chatgpt.com' || trimmed === 'chatgpt.com/') {
      return 'chatgpt.com';
    }
  }
  return 'chatgpt.com';
}

async function ensurePendingPromptsLoaded() {
  if (pendingLoaded) {
    return;
  }
  if (pendingLoadingPromise) {
    await pendingLoadingPromise;
    return;
  }

  pendingLoadingPromise = (async () => {
    try {
      const stored = await chrome.storage.session.get(PENDING_STORAGE_KEY);
      const rawEntries = stored?.[PENDING_STORAGE_KEY];
      if (rawEntries && typeof rawEntries === 'object') {
        const restored = new Map();
        for (const [key, value] of Object.entries(rawEntries)) {
          const numericKey = Number.parseInt(key, 10);
          if (Number.isNaN(numericKey)) {
            continue;
          }
          if (value && typeof value.prompt === 'string') {
            restored.set(numericKey, {
              prompt: value.prompt,
              attempts: Number.isFinite(value.attempts) ? value.attempts : 0,
              host: typeof value.host === 'string' ? value.host : undefined
            });
          }
        }
        pendingPrompts = restored;
      } else {
        pendingPrompts = new Map();
      }
    } finally {
      pendingLoaded = true;
      pendingLoadingPromise = null;
    }
  })();

  await pendingLoadingPromise;
}

async function persistPendingPrompts() {
  await ensurePendingPromptsLoaded();
  if (pendingPrompts.size === 0) {
    await chrome.storage.session.remove(PENDING_STORAGE_KEY);
    return;
  }

  const serialized = {};
  for (const [tabId, value] of pendingPrompts.entries()) {
    serialized[String(tabId)] = {
      prompt: value.prompt,
      attempts: value.attempts ?? 0,
      host: value.host
    };
  }

  await chrome.storage.session.set({ [PENDING_STORAGE_KEY]: serialized });
}

async function setPendingPrompt(tabId, data) {
  await ensurePendingPromptsLoaded();
  pendingPrompts.set(tabId, { ...data, attempts: data.attempts ?? 0 });
  await persistPendingPrompts();
}

async function removePendingPrompt(tabId) {
  await ensurePendingPromptsLoaded();
  if (!pendingPrompts.has(tabId)) {
    return;
  }
  pendingPrompts.delete(tabId);
  await persistPendingPrompts();
}

function injectPromptAndSend(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return { status: 'permanent-failure', reason: 'Invalid prompt provided.' };
  }

  const preferredSelectors = [
    'textarea#prompt-textarea',
    'textarea[data-id="root"]',
    'textarea[data-id="prompt-textarea"]',
    'textarea[placeholder*="Send a message"]',
    '[contenteditable="true"]',
    '[role="textbox"]'
  ];

  const composer = findEditor(preferredSelectors);
  if (!composer) {
    return { status: 'retry', reason: 'Composer not found yet.' };
  }

  if (!applyPromptToComposer(composer, prompt)) {
    return { status: 'permanent-failure', reason: 'Unable to write prompt into composer.' };
  }

  if (!sendMessage(composer)) {
    return { status: 'retry', reason: 'Send button not ready.' };
  }

  return { status: 'success' };

  function findEditor(selectors) {
    for (const selector of selectors) {
      const element = deepQuerySelector(selector);
      if (element && isEditable(element)) {
        return element;
      }
    }

    const matches = [];
    traverse(document, (node) => {
      if (node instanceof HTMLElement && isEditable(node)) {
        matches.push(node);
      }
    });

    if (matches.length === 0) {
      return null;
    }

    matches.sort((a, b) => getElementScore(b) - getElementScore(a));
    return matches[0];
  }

  function deepQuerySelector(selector) {
    const queue = [document.documentElement];
    const visited = new Set();

    while (queue.length > 0) {
      const node = queue.shift();
      if (!node || visited.has(node)) {
        continue;
      }
      visited.add(node);

      if (node instanceof Element) {
        const found = node.querySelector(selector);
        if (found) {
          return found;
        }

        if (node.shadowRoot) {
          queue.push(node.shadowRoot);
        }
      }

      if (node instanceof ShadowRoot || node instanceof DocumentFragment) {
        queue.push(...node.children);
      }
    }

    return null;
  }

  function traverse(root, visitor) {
    const stack = [root];
    const seen = new Set();

    while (stack.length > 0) {
      const node = stack.pop();
      if (!node || seen.has(node)) {
        continue;
      }
      seen.add(node);
      visitor(node);

      if (node instanceof Element) {
        if (node.shadowRoot) {
          stack.push(node.shadowRoot);
        }
        for (let i = node.children.length - 1; i >= 0; i -= 1) {
          stack.push(node.children[i]);
        }
      } else if (node instanceof ShadowRoot || node instanceof DocumentFragment) {
        for (let i = node.children.length - 1; i >= 0; i -= 1) {
          stack.push(node.children[i]);
        }
      }
    }
  }

  function isEditable(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    if (element.tagName === 'TEXTAREA') {
      return isVisible(element);
    }

    if (element.isContentEditable) {
      return isVisible(element);
    }

    const role = element.getAttribute('role');
    if (role && role.toLowerCase() === 'textbox') {
      return isVisible(element);
    }

    return false;
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      return false;
    }
    const style = window.getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  function getElementScore(element) {
    const rect = element.getBoundingClientRect();
    return rect.width * rect.height;
  }

  function applyPromptToComposer(element, value) {
    try {
      element.focus({ preventScroll: false });
    } catch (error) {
      element.focus();
    }

    if ('value' in element) {
      setNativeValue(element, value);
      dispatchInputEvents(element, value);
      element.scrollTop = element.scrollHeight;
      return true;
    }

    if (element.isContentEditable || element.getAttribute('contenteditable') === 'true' || element.getAttribute('role') === 'textbox') {
      clearEditableContent(element);
      const success = document.execCommand('insertText', false, value);
      if (!success || element.innerText.trim() !== value.trim()) {
        element.innerText = value;
      }
      dispatchInputEvents(element, value);
      return true;
    }

    return false;
  }

  function clearEditableContent(element) {
    const selection = window.getSelection();
    if (!selection) {
      element.innerHTML = '';
      return;
    }

    selection.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.addRange(range);
    selection.deleteFromDocument();
  }

  function setNativeValue(element, value) {
    const { set: valueSetter } = Object.getOwnPropertyDescriptor(element, 'value') || {};
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : element instanceof HTMLInputElement
          ? HTMLInputElement.prototype
          : HTMLElement.prototype;
    const { set: prototypeSetter } = Object.getOwnPropertyDescriptor(prototype, 'value') || {};

    if (prototypeSetter && valueSetter !== prototypeSetter) {
      prototypeSetter.call(element, value);
    } else if (valueSetter) {
      valueSetter.call(element, value);
    } else {
      element.value = value;
    }
  }

  function dispatchInputEvents(element, value) {
    element.dispatchEvent(new Event('input', { bubbles: true }));
    try {
      element.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          data: value,
          inputType: 'insertText'
        })
      );
    } catch (error) {
      // Ignore environments where InputEvent is not supported.
    }
  }

  function sendMessage(element) {
    const sendButton = findSendButton(element);
    if (sendButton) {
      sendButton.click();
      return true;
    }

    try {
      element.focus();
      const keyDown = new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true
      });
      element.dispatchEvent(keyDown);

      const keyUp = new KeyboardEvent('keyup', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true
      });
      element.dispatchEvent(keyUp);
      return true;
    } catch (error) {
      console.warn('Failed to simulate Enter key press', error);
      return false;
    }
  }

  function findSendButton(contextElement) {
    const candidates = [];
    traverse(document, (node) => {
      if (!(node instanceof HTMLElement)) {
        return;
      }

      if (!isPotentialSendButton(node)) {
        return;
      }

      const rect = node.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        return;
      }

      candidates.push({ node, distance: distanceTo(contextElement, node) });
    });

    if (candidates.length === 0) {
      return null;
    }

    candidates.sort((a, b) => a.distance - b.distance);
    return candidates[0].node;
  }

  function isPotentialSendButton(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    const role = element.getAttribute('role');
    if (element.tagName !== 'BUTTON' && role !== 'button') {
      return false;
    }

    const labelSources = [
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      element.dataset?.testid,
      element.textContent
    ];

    const normalizedLabel = labelSources
      .filter(Boolean)
      .map((value) => value.trim().toLowerCase())
      .find((value) => value.includes('send') || value.includes('submit') || value.includes('enter'));

    if (normalizedLabel) {
      return true;
    }

    const datasetTestId = element.dataset?.testid || element.getAttribute('data-testid');
    if (datasetTestId && datasetTestId.toLowerCase().includes('send')) {
      return true;
    }

    return false;
  }

  function distanceTo(from, to) {
    try {
      const rectA = from.getBoundingClientRect();
      const rectB = to.getBoundingClientRect();
      const dx = rectB.left - rectA.left;
      const dy = rectB.top - rectA.top;
      return Math.sqrt(dx * dx + dy * dy);
    } catch (error) {
      return Number.MAX_SAFE_INTEGER;
    }
  }
}
