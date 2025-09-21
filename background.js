const pendingPrompts = new Map();
const MAX_INJECTION_ATTEMPTS = 10;
const RETRY_DELAY_MS = 1000;

const GLASP_READER_BASE_URL = 'https://glasp.co/reader?url=';
const GLASP_TEXT_KEYS = [
  'text',
  'textOriginal',
  'textDisplay',
  'caption',
  'content',
  'body',
  'snippet',
  'description',
  'transcriptText',
  'textContent',
  'value',
  'displayText',
  'plainText'
];
const GLASP_TIMESTAMP_KEYS = [
  'start',
  'startMs',
  'startTime',
  'startTimeText',
  'startSeconds',
  'offset',
  'offsetMs',
  'offsetSeconds',
  'startOffset',
  'time',
  'timecode',
  'timeCode',
  'ts',
  'timestamp',
  'displayTime',
  'timeText',
  'begin'
];

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'fetchTranscriptFromGlasp' && typeof message.videoUrl === 'string') {
    fetchTranscriptFromGlasp(message.videoUrl)
      .then((transcript) => sendResponse({ status: 'success', transcript }))
      .catch((error) => {
        console.error('Failed to fetch transcript from Glasp:', error);
        sendResponse({
          status: 'error',
          error: error?.message || 'Unable to retrieve transcript from Glasp.'
        });
      });
    return true;
  }

  if (message?.type === 'openChatGPT' && typeof message.prompt === 'string') {
    chrome.tabs.create({ url: 'https://chat.openai.com/' }, (tab) => {
      if (tab?.id !== undefined) {
        pendingPrompts.set(tab.id, { prompt: message.prompt, attempts: 0 });
      }
    });
    sendResponse({ status: 'opening' });
    return true;
  }
  return false;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const pending = pendingPrompts.get(tabId);
  if (!pending) {
    return;
  }

  const updatedUrl = changeInfo.url || tab.url;
  if (!updatedUrl?.startsWith('https://chat.openai.com/')) {
    return;
  }

  if (changeInfo.status === 'complete' || changeInfo.url) {
    attemptPromptInjection(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  pendingPrompts.delete(tabId);
});

const attemptPromptInjection = (tabId) => {
  const pending = pendingPrompts.get(tabId);
  if (!pending) {
    return;
  }

  if (pending.attempts >= MAX_INJECTION_ATTEMPTS) {
    console.warn('Max prompt injection attempts reached for tab', tabId);
    pendingPrompts.delete(tabId);
    return;
  }

  pending.attempts += 1;

  chrome.scripting
    .executeScript({
      target: { tabId },
      world: 'MAIN',
      func: injectPrompt,
      args: [pending.prompt]
    })
    .then((results) => {
      const [result] = results || [];
      if (result?.result) {
        pendingPrompts.delete(tabId);
      } else {
        scheduleRetry(tabId);
      }
    })
    .catch((error) => {
      console.error('Failed to inject prompt:', error);
      pendingPrompts.delete(tabId);
    });
};

const scheduleRetry = (tabId) => {
  const pending = pendingPrompts.get(tabId);
  if (!pending) {
    return;
  }

  if (pending.attempts >= MAX_INJECTION_ATTEMPTS) {
    console.warn('Retry limit reached before scheduling for tab', tabId);
    pendingPrompts.delete(tabId);
    return;
  }

  setTimeout(() => {
    const currentPending = pendingPrompts.get(tabId);
    if (!currentPending) {
      return;
    }

    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        pendingPrompts.delete(tabId);
        return;
      }

      if (tab?.url?.startsWith('https://chat.openai.com/')) {
        attemptPromptInjection(tabId);
      }
    });
  }, RETRY_DELAY_MS);
};

function injectPrompt(prompt) {
  const findTextArea = () => {
    const selectors = [
      'textarea#prompt-textarea',
      'textarea[data-id="root"]',
      'textarea[data-id="prompt-textarea"]',
      'textarea[placeholder*="Send a message"]',
      'form textarea'
    ];

    for (const selector of selectors) {
      const element = document.querySelector(selector);
      if (element) {
        return element;
      }
    }

    return null;
  };

  const textArea = findTextArea();
  if (!textArea) {
    console.warn('ChatGPT text area not found.');
    return false;
  }

  textArea.focus();
  textArea.value = prompt;
  const inputEvent = new Event('input', { bubbles: true });
  textArea.dispatchEvent(inputEvent);
  return true;
}

async function fetchTranscriptFromGlasp(videoUrl) {
  const targetUrl = `${GLASP_READER_BASE_URL}${encodeURIComponent(videoUrl)}`;
  let response;
  try {
    response = await fetch(targetUrl, {
      method: 'GET',
      credentials: 'include',
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });
  } catch (error) {
    throw new Error('Unable to reach Glasp.');
  }

  if (!response.ok) {
    throw new Error(`Glasp request failed with status ${response.status}`);
  }

  const html = await response.text();
  return parseTranscriptFromGlaspHtml(html);
}

function parseTranscriptFromGlaspHtml(html) {
  if (typeof html !== 'string' || html.length === 0) {
    throw new Error('Empty response received from Glasp.');
  }

  if (/Attention Required! \| Cloudflare/i.test(html)) {
    throw new Error('Glasp is requesting additional verification. Open glasp.co in your browser and retry.');
  }

  const signInMatch = detectGlaspSignInPrompt(html);

  const nextDataMatch = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!nextDataMatch) {
    if (signInMatch) {
      throw new Error('Please sign in to Glasp in this browser to access transcripts.');
    }
    throw new Error('Unable to locate transcript data on Glasp.');
  }

  let nextData;
  try {
    nextData = JSON.parse(nextDataMatch[1]);
  } catch (error) {
    throw new Error('Failed to parse transcript data returned by Glasp.');
  }

  const segments = extractTranscriptSegments(nextData);
  if (!segments || segments.length === 0) {
    if (signInMatch) {
      throw new Error('Please sign in to Glasp to view transcripts for this video.');
    }
    throw new Error('Transcript data not available from Glasp for this video.');
  }

  return segments
    .map((segment) => {
      const text = segment.text;
      if (segment.timestamp) {
        return `[${segment.timestamp}] ${text}`;
      }
      return text;
    })
    .join('\n');
}

function detectGlaspSignInPrompt(html) {
  if (typeof html !== 'string' || html.length === 0) {
    return false;
  }

  const signInPattern = /Please\s+Sign\s+In/i;

  try {
    if (typeof DOMParser === 'function') {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      const bodyText = doc?.body?.textContent || '';
      if (bodyText && signInPattern.test(bodyText)) {
        return true;
      }
    }
  } catch (error) {
    // Ignore DOM parsing errors and fall back to text extraction via regex replacements.
  }

  const textOnly = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');

  const normalizedText = decodeHtmlEntities(textOnly);

  return signInPattern.test(normalizedText);
}

function decodeHtmlEntities(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return '';
  }

  let decoded = text;

  decoded = decoded.replace(/&amp;/gi, '&');
  decoded = decoded.replace(/&#(\d+);/gi, (match, value) => {
    const codePoint = Number.parseInt(value, 10);
    return codePoint === 38 ? '&' : match;
  });
  decoded = decoded.replace(/&#x([0-9a-f]+);/gi, (match, value) => {
    const codePoint = Number.parseInt(value, 16);
    return codePoint === 0x26 ? '&' : match;
  });
  decoded = decoded.replace(/&lt;/gi, '<');
  decoded = decoded.replace(/&gt;/gi, '>');

  const whitespaceEntityPatterns = [
    /&nbsp;/gi,
    /&#160;/gi,
    /&#xA0;/gi,
    /&#xa0;/gi,
    /&NonBreakingSpace;/gi,
    /&ensp;/gi,
    /&#8194;/gi,
    /&#x2002;/gi,
    /&emsp;/gi,
    /&#8195;/gi,
    /&#x2003;/gi,
    /&thinsp;/gi,
    /&#8201;/gi,
    /&#x2009;/gi
  ];

  for (const pattern of whitespaceEntityPatterns) {
    decoded = decoded.replace(pattern, ' ');
  }

  return decoded;
}

(() => {
  const samples = [
    '<div>Please&nbsp;Sign&nbsp;In</div>',
    '<div>Please&amp;nbsp;Sign&amp;nbsp;In</div>',
    '<div>Please&#38;nbsp;Sign&#38;nbsp;In</div>',
    '<div>Please&#x26;nbsp;Sign&#x26;nbsp;In</div>'
  ];

  for (const sample of samples) {
    if (!detectGlaspSignInPrompt(sample)) {
      console.warn('Sign-in detection failed for HTML entity sample:', sample);
      break;
    }
  }
})();

function extractTranscriptSegments(root) {
  const visited = new WeakSet();
  let best = null;

  const visit = (node) => {
    if (!node || typeof node !== 'object') {
      return;
    }

    if (visited.has(node)) {
      return;
    }
    visited.add(node);

    if (Array.isArray(node)) {
      const segments = node.map((item) => normalizeTranscriptSegment(item)).filter(Boolean);
      if (segments.length >= 5) {
        const timestampCount = segments.filter((segment) => Boolean(segment.timestamp)).length;
        const averageLength =
          segments.reduce((total, segment) => total + segment.text.length, 0) / segments.length;

        const meetsTimestampRequirement = timestampCount >= Math.max(3, Math.floor(segments.length * 0.5));
        const meetsLengthRequirement = averageLength >= 8;

        if ((meetsTimestampRequirement && meetsLengthRequirement) || (!best && segments.length >= 5)) {
          if (!best || segments.length > best.length) {
            best = segments;
          }
        }
      }

      for (const item of node) {
        if (item && typeof item === 'object') {
          visit(item);
        }
      }
      return;
    }

    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') {
        visit(value);
      }
    }
  };

  visit(root);
  return best;
}

function normalizeTranscriptSegment(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const text = extractTextValue(item);
  if (!text) {
    return null;
  }

  const timestamp = extractTimestampValue(item);
  return { text, timestamp };
}

function extractTextValue(node) {
  const visited = new WeakSet();
  const stack = [node];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current == null) {
      continue;
    }

    if (typeof current === 'string') {
      const cleaned = cleanText(current);
      if (cleaned) {
        return cleaned;
      }
      continue;
    }

    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) {
        stack.push(current[index]);
      }
      continue;
    }

    if (typeof current === 'object') {
      if (visited.has(current)) {
        continue;
      }
      visited.add(current);

      if (typeof current.simpleText === 'string') {
        const simple = cleanText(current.simpleText);
        if (simple) {
          return simple;
        }
      }

      if (typeof current.text === 'string') {
        const text = cleanText(current.text);
        if (text) {
          return text;
        }
      }

      for (const key of GLASP_TEXT_KEYS) {
        if (key in current) {
          stack.push(current[key]);
        }
      }

      for (const value of Object.values(current)) {
        if (value && (typeof value === 'object' || typeof value === 'string')) {
          stack.push(value);
        }
      }
    }
  }

  return null;
}

function extractTimestampValue(node) {
  const visited = new WeakSet();
  const stack = [node];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current == null) {
      continue;
    }

    if (typeof current === 'number') {
      const formatted = formatSecondsToTimestamp(current);
      if (formatted) {
        return formatted;
      }
      continue;
    }

    if (typeof current === 'string') {
      const formatted = normalizeTimestampString(current);
      if (formatted) {
        return formatted;
      }
      continue;
    }

    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) {
        stack.push(current[index]);
      }
      continue;
    }

    if (typeof current === 'object') {
      if (visited.has(current)) {
        continue;
      }
      visited.add(current);

      for (const key of GLASP_TIMESTAMP_KEYS) {
        if (key in current) {
          stack.push(current[key]);
        }
      }

      for (const value of Object.values(current)) {
        if (value && (typeof value === 'object' || typeof value === 'string' || typeof value === 'number')) {
          stack.push(value);
        }
      }
    }
  }

  return null;
}

function cleanText(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned || null;
}

function normalizeTimestampString(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const colonMatch = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (colonMatch) {
    const [, part1, part2, part3] = colonMatch;
    if (typeof part3 === 'string') {
      const hours = part1.padStart(2, '0');
      const minutes = part2.padStart(2, '0');
      const seconds = part3.padStart(2, '0');
      return `${hours}:${minutes}:${seconds}`;
    }
    const minutes = part1.padStart(2, '0');
    const seconds = part2.padStart(2, '0');
    return `${minutes}:${seconds}`;
  }

  const numeric = Number(trimmed);
  if (!Number.isNaN(numeric)) {
    return formatSecondsToTimestamp(numeric);
  }

  return null;
}

function formatSecondsToTimestamp(value) {
  if (!Number.isFinite(value)) {
    return null;
  }

  let seconds = value;
  if (seconds > 1000 && seconds < 1000000) {
    seconds = seconds / 1000;
  }

  if (seconds < 0) {
    seconds = 0;
  }

  const rounded = Math.max(0, Math.round(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const secs = rounded % 60;

  const paddedMinutes = String(minutes).padStart(2, '0');
  const paddedSeconds = String(secs).padStart(2, '0');

  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${paddedMinutes}:${paddedSeconds}`;
  }

  return `${paddedMinutes}:${paddedSeconds}`;
}
