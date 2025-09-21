const BUTTON_ID = 'ytlm-summarize-btn';
const BUTTON_LABEL_DEFAULT = 'Summarize with ChatGPT';
const BUTTON_LABEL_LOADING = 'Fetching transcript…';
const BUTTON_LABEL_OPENING = 'Opening ChatGPT…';

const addButtonIfNeeded = () => {
  if (document.getElementById(BUTTON_ID)) {
    return;
  }

  const container = document.querySelector('#top-row #actions #top-level-buttons-computed');
  const fallbackContainer = document.querySelector('#top-level-buttons-computed');
  const targetContainer = container || fallbackContainer;

  if (!targetContainer) {
    return;
  }

  const button = document.createElement('button');
  button.id = BUTTON_ID;
  button.type = 'button';
  button.textContent = BUTTON_LABEL_DEFAULT;

  const referenceButton =
    targetContainer.querySelector('button.yt-spec-button-shape-next') || targetContainer.querySelector('button');
  if (referenceButton) {
    button.className = referenceButton.className;
  } else {
    button.className = 'yt-spec-button-shape-next yt-spec-button-shape-next--outline yt-spec-button-shape-next--size-m';
  }

  button.setAttribute('aria-label', BUTTON_LABEL_DEFAULT);
  button.style.marginLeft = '8px';
  button.addEventListener('click', onButtonClick);
  targetContainer.appendChild(button);
};

const onButtonClick = async () => {
  const button = document.getElementById(BUTTON_ID);
  if (!button) {
    return;
  }

  button.disabled = true;
  button.textContent = BUTTON_LABEL_LOADING;

  const canonicalUrl = getCanonicalVideoUrl();
  const targetUrl = canonicalUrl || window.location.href;

  try {
    const transcript = await fetchTranscript(targetUrl);
    if (!transcript) {
      alert('Transcript unavailable for this video.');
      button.textContent = BUTTON_LABEL_DEFAULT;
      button.disabled = false;
      return;
    }

    const titleElement = document.querySelector('h1.ytd-watch-metadata') || document.querySelector('h1.title');
    const title = titleElement ? titleElement.innerText.trim() : document.title;
    const prompt = buildPrompt({
      title,
      url: targetUrl,
      transcript
    });

    if (!chrome?.runtime?.sendMessage) {
      console.error('chrome.runtime.sendMessage is unavailable.');
      alert('Unable to communicate with the extension background script.');
      button.textContent = BUTTON_LABEL_DEFAULT;
      button.disabled = false;
      return;
    }

    button.textContent = BUTTON_LABEL_OPENING;
    chrome.runtime.sendMessage({ type: 'openChatGPT', prompt }, () => {
      if (chrome.runtime.lastError) {
        console.error('Failed to open ChatGPT tab', chrome.runtime.lastError);
        alert('Unable to open ChatGPT. Check extension permissions.');
      }

      button.textContent = BUTTON_LABEL_DEFAULT;
      button.disabled = false;
    });
  } catch (error) {
    console.error('Failed to fetch transcript', error);
    const message = error?.message || 'An error occurred while fetching the transcript.';
    alert(`${message} See the console for details.`);
    button.textContent = BUTTON_LABEL_DEFAULT;
    button.disabled = false;
  }
};

const buildPrompt = ({ title, url, transcript }) => {
  const trimmedTranscript = transcript.trim();
  return [
    'You are an expert note taker. Please summarize the following YouTube video transcript.',
    '',
    `Title: ${title}`,
    `URL: ${url}`,
    '',
    'Instructions:',
    '1. Provide a concise overview in 2-3 sentences.',
    '2. List the main takeaways as bullet points.',
    '3. Include any actionable steps separately if applicable.',
    '',
    'Transcript:',
    trimmedTranscript
  ].join('\n');
};

const fetchTranscript = async (videoUrl) => {
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
};

const getCanonicalVideoUrl = () => {
  const videoId = getCurrentVideoId();
  if (!videoId) {
    return null;
  }

  return `https://www.youtube.com/watch?v=${videoId}`;
};

const getCurrentVideoId = () => {
  const urlVideoId = new URLSearchParams(window.location.search).get('v');
  if (urlVideoId) {
    return urlVideoId;
  }

  const playerElement = document.querySelector('ytd-player');
  const player = playerElement?.player_ || playerElement;

  if (player?.getVideoData) {
    try {
      const videoData = player.getVideoData();
      return videoData?.video_id || videoData?.videoId || null;
    } catch (error) {
      console.debug('Failed to read video data from player.', error);
    }
  }

  return playerElement?.__data?.playerResponse?.videoDetails?.videoId || null;
};

const observer = new MutationObserver(() => addButtonIfNeeded());
observer.observe(document.body, { childList: true, subtree: true });

window.addEventListener('yt-navigate-finish', () => {
  setTimeout(() => {
    addButtonIfNeeded();
  }, 1000);
});

addButtonIfNeeded();
