const pendingPrompts = new Map();
const MAX_INJECTION_ATTEMPTS = 10;
const RETRY_DELAY_MS = 1000;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
