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
        const response = await openChatGPTTab(message.prompt, message.preferredHost, message.autoSend);
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
    const parsedTranscript = parseTranscriptFromReaderText(pageText);
    const transcript = await ensureTranscriptHasTimestamps(parsedTranscript, videoUrl);
    await cleanup();
    return transcript;
  } catch (error) {
    await cleanup();
    throw error instanceof Error ? error : new Error('Unable to read transcript from Glasp.');
  }
}

async function openChatGPTTab(prompt, preferredHost, autoSend) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('Invalid prompt supplied.');
  }

  const host = normalizeChatHost(preferredHost);
  const url = `https://${host}/`;
  const tab = await chrome.tabs.create({ url, active: true });

  if (!tab?.id) {
    throw new Error('Failed to open ChatGPT tab.');
  }

  const shouldAutoSend = autoSend !== false;
  await setPendingPrompt(tab.id, { prompt, attempts: 0, host, autoSend: shouldAutoSend });
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
      args: [pending.prompt, pending.autoSend !== false]
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

  const sanitized = pageText.replace(/\r/g, '\n').replace(/\u00a0/g, ' ');
  const truncated = truncateMarketingContent(sanitized);
  const transcriptSection = extractTranscriptSection(truncated).trim();

  if (!transcriptSection) {
    throw new Error('Transcript data not found on Glasp for this video.');
  }

  const segments = extractSegmentsFromPlainText(transcriptSection);
  if (segments.length > 0) {
    return segments.join('\n');
  }

  const marketingPattern = /(Share This Page|Get YouTube Video Transcript|Download browser extensions|Apps & Extensions|Key Features|More Features|APIs|Blog|Company|About us|Community|FAQs|Job Board|Newsletter|Pricing|Terms|Privacy|Guidelines|Glasp Inc\.)/i;
  const headerPattern = /^(?:Summarize\s+)?Transcript(?:\s*English\s*\(auto-generated\))?$/i;

  const fallbackLines = transcriptSection
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !marketingPattern.test(line) && !headerPattern.test(line) && !/^English\s*\(auto-generated\)$/i.test(line));

  const fallbackTranscript = fallbackLines.join('\n').trim();
  if (!fallbackTranscript) {
    throw new Error('Transcript data not found on Glasp for this video.');
  }

  return fallbackTranscript;
}

function truncateMarketingContent(text) {
  const marketingPattern = /(Share This Page|Get YouTube Video Transcript|Download browser extensions|Apps & Extensions|Key Features|More Features|Glasp Reader|Kindle Highlight Export|Idea Hatch|Integrations|Obsidian Plugin|Notion Integration|Pocket Integration|Instapaper Integration|Medium Integration|Readwise Integration|Snipd Integration|Hypothesis Integration|APIs|Blog & Post|Embed Links|Image Highlight|Personality Test|Quote Shots|Company|About us|Blog|Community|FAQs|Job Board|Newsletter|Pricing|Terms|Privacy|Guidelines|©\s*\d{4}\s+Glasp)/i;
  const match = marketingPattern.exec(text);
  if (match) {
    return text.slice(0, match.index);
  }
  return text;
}

function extractTranscriptSection(text) {
  if (!text) {
    return '';
  }

  const timestampPattern = /((?:\d{1,2}:)?\d{1,2}:\d{2})/;
  const headerPattern = /(?:Summarize\s+)?Transcript(?:\s*English\s*\(auto-generated\))?/i;

  const timestampMatch = timestampPattern.exec(text);
  if (timestampMatch) {
    return text.slice(timestampMatch.index);
  }

  const headerMatch = headerPattern.exec(text);
  let working = headerMatch ? text.slice(headerMatch.index + headerMatch[0].length) : text;

  working = working.replace(/Summarize\s+Transcript/gi, ' ');
  working = working.replace(/Transcript:?/gi, ' ');
  working = working.replace(/English\s*\(auto-generated\)/gi, ' ');
  working = working.replace(/Language\s*:?.*?English.*?(?:\n|$)/gi, ' ');

  return working;
}

function extractSegmentsFromPlainText(text) {
  const cleaned = truncateMarketingContent(text)
    .replace(/Summarize\s+Transcript/gi, ' ')
    .replace(/Transcript:?/gi, ' ')
    .replace(/English\s*\(auto-generated\)/gi, ' ')
    .replace(/Language\s*:?.*?English/gi, ' ');

  const normalized = cleaned.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return [];
  }

  const timestampPattern = /((?:\d{1,2}:)?\d{1,2}:\d{2})(?:\s*[-–:\u2013]\s*|\s+)?/g;
  const matches = [];
  let match;
  while ((match = timestampPattern.exec(normalized)) !== null) {
    matches.push({ index: match.index, raw: match[0], timestamp: match[1] });
  }

  if (matches.length === 0) {
    return [];
  }

  const segments = [];
  for (let i = 0; i < matches.length; i += 1) {
    const current = matches[i];
    const next = matches[i + 1];
    const start = current.index + current.raw.length;
    const end = next ? next.index : normalized.length;
    const segmentText = normalized.slice(start, end).trim();
    if (!segmentText) {
      continue;
    }
    segments.push(formatTranscriptSegment(current.timestamp, segmentText));
  }

  return segments;
}

async function ensureTranscriptHasTimestamps(transcript, videoUrl) {
  if (transcriptHasTimestamps(transcript)) {
    return transcript;
  }

  try {
    const fallback = await fetchTranscriptFromYouTube(videoUrl);
    if (fallback) {
      return fallback;
    }
  } catch (error) {
    console.warn('Timed transcript fallback failed', error);
  }

  return transcript;
}

function transcriptHasTimestamps(transcript) {
  if (typeof transcript !== 'string') {
    return false;
  }
  return /\[(?:\d{1,2}:)?\d{1,2}:\d{2}\]/.test(transcript);
}

async function fetchTranscriptFromYouTube(videoUrl) {
  const videoId = extractVideoIdFromUrl(videoUrl);
  if (!videoId) {
    throw new Error('Unable to determine video ID for transcript fallback.');
  }

  const paramVariants = ['lang=en&fmt=json3', 'lang=en&kind=asr&fmt=json3', 'lang=en-US&fmt=json3', 'lang=en-US&kind=asr&fmt=json3'];

  for (const params of paramVariants) {
    const requestUrl = `https://www.youtube.com/api/timedtext?v=${encodeURIComponent(videoId)}&${params}`;
    try {
      const response = await fetch(requestUrl, { credentials: 'include' });
      if (!response.ok) {
        continue;
      }

      const data = await response.json();
      const formatted = parseTimedTextJson(data);
      if (formatted) {
        return formatted;
      }
    } catch (error) {
      console.debug('Failed to fetch YouTube timed transcript with params', params, error);
    }
  }

  throw new Error('Timed YouTube transcript unavailable.');
}

function extractVideoIdFromUrl(videoUrl) {
  if (typeof videoUrl !== 'string') {
    return null;
  }

  try {
    const url = new URL(videoUrl);
    if (url.hostname === 'youtu.be') {
      return url.pathname.slice(1) || null;
    }
    if (url.searchParams.has('v')) {
      return url.searchParams.get('v');
    }
    const shortsMatch = url.pathname.match(/\/shorts\/([\w-]{11})/);
    if (shortsMatch) {
      return shortsMatch[1];
    }
  } catch (error) {
    return null;
  }

  const fallbackMatch = videoUrl.match(/(?:v=|\/)([\w-]{11})(?:[&?/]|$)/);
  if (fallbackMatch) {
    return fallbackMatch[1];
  }

  return null;
}

function parseTimedTextJson(json) {
  if (!json || !Array.isArray(json.events)) {
    return '';
  }

  const segments = [];
  for (const event of json.events) {
    if (!event || !Array.isArray(event.segs) || event.segs.length === 0) {
      continue;
    }

    const text = event.segs
      .map((segment) => (typeof segment?.utf8 === 'string' ? segment.utf8 : ''))
      .join('')
      .replace(/\s+/g, ' ')
      .replace(/\s*\n\s*/g, ' ')
      .trim();

    if (!text) {
      continue;
    }

    const timestamp = formatMillisecondsToTimestamp(event.tStartMs ?? 0);
    segments.push(`[${timestamp}] ${text}`);
  }

  return segments.join('\n');
}

function formatMillisecondsToTimestamp(ms) {
  const safeMs = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  const totalSeconds = Math.floor(safeMs / 1000);
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
              host: typeof value.host === 'string' ? value.host : undefined,
              autoSend: value.autoSend !== false
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
      host: value.host,
      autoSend: value.autoSend !== false
    };
  }

  await chrome.storage.session.set({ [PENDING_STORAGE_KEY]: serialized });
}

async function setPendingPrompt(tabId, data) {
  await ensurePendingPromptsLoaded();
  pendingPrompts.set(tabId, { ...data, attempts: data.attempts ?? 0, autoSend: data.autoSend !== false });
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

function injectPromptAndSend(prompt, autoSend = true) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return { status: 'permanent-failure', reason: 'Invalid prompt provided.' };
  }

  const shouldAutoSend = autoSend !== false;

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

  if (!shouldAutoSend) {
    focusComposer(composer);
    placeCaretAtEnd(composer);
    return { status: 'success', mode: 'manual' };
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

    if (isContentEditableElement(element)) {
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
    focusComposer(element);

    if ('value' in element) {
      setNativeValue(element, value);
      dispatchInputEvents(element, value);
      element.scrollTop = element.scrollHeight;
      placeCaretAtEnd(element);
      return true;
    }

    if (isContentEditableElement(element)) {
      clearEditableContent(element);
      const success = document.execCommand('insertText', false, value);
      if (!success || element.innerText.trim() !== value.trim()) {
        element.innerText = value;
      }
      dispatchInputEvents(element, value);
      element.scrollTop = element.scrollHeight;
      placeCaretAtEnd(element);
      return true;
    }

    return false;
  }

  function focusComposer(element) {
    if (!element || typeof element.focus !== 'function') {
      return;
    }
    try {
      element.focus({ preventScroll: false });
    } catch (error) {
      element.focus();
    }
  }

  function placeCaretAtEnd(element) {
    if (!element) {
      return;
    }

    if (typeof element.selectionStart === 'number' && typeof element.selectionEnd === 'number') {
      const length = element.value?.length ?? 0;
      element.selectionStart = length;
      element.selectionEnd = length;
      return;
    }

    if (isContentEditableElement(element)) {
      const selection = window.getSelection();
      if (!selection) {
        return;
      }
      selection.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      selection.addRange(range);
    }
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
      if (!isSendButtonEnabled(sendButton)) {
        return false;
      }
      sendButton.click();
      clearComposer(element);
      return true;
    }

    if (!simulateEnterKey(element)) {
      return false;
    }

    clearComposer(element);
    return true;
  }

  function simulateEnterKey(element) {
    try {
      focusComposer(element);
      const keyDown = new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
      });
      const accepted = element.dispatchEvent(keyDown);
      if (!accepted) {
        return false;
      }

      const keyPress = new KeyboardEvent('keypress', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
      });
      element.dispatchEvent(keyPress);

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

  function clearComposer(element) {
    if (!element) {
      return;
    }

    if ('value' in element) {
      setNativeValue(element, '');
      dispatchInputEvents(element, '');
      return;
    }

    if (isContentEditableElement(element)) {
      element.innerHTML = '';
      dispatchInputEvents(element, '');
      placeCaretAtEnd(element);
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

  function isSendButtonEnabled(button) {
    if (!(button instanceof HTMLElement)) {
      return false;
    }

    if (button.disabled) {
      return false;
    }

    const ariaDisabled = button.getAttribute('aria-disabled');
    if (ariaDisabled && ariaDisabled.toLowerCase() === 'true') {
      return false;
    }

    const dataDisabled = button.getAttribute('data-disabled') || button.dataset?.disabled;
    if (typeof dataDisabled === 'string' && dataDisabled.toLowerCase() === 'true') {
      return false;
    }

    try {
      const style = window.getComputedStyle(button);
      if (style.pointerEvents === 'none') {
        return false;
      }
      if (style.opacity && Number.parseFloat(style.opacity) < 0.2) {
        return false;
      }
    } catch (error) {
      // Ignore style lookup errors.
    }

    return true;
  }

  function isContentEditableElement(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }
    if (element.isContentEditable) {
      return true;
    }
    const contentEditable = element.getAttribute('contenteditable');
    if (contentEditable && contentEditable.toLowerCase() === 'true') {
      return true;
    }
    const role = element.getAttribute('role');
    return Boolean(role && role.toLowerCase() === 'textbox');
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
