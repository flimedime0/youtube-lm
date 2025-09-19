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
  button.className = 'yt-spec-button-shape-next yt-spec-button-shape-next--tonal yt-spec-button-shape-next--size-m';
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

  try {
    const transcript = await fetchTranscript();
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
      url: window.location.href,
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
    alert('An error occurred while fetching the transcript. See the console for details.');
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

const fetchTranscript = async () => {
  const playerResponse = getPlayerResponse();
  const captionTracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

  if (!captionTracks || captionTracks.length === 0) {
    return null;
  }

  let track = captionTracks.find((item) => !item.kind || item.kind !== 'asr');
  if (!track) {
    track = captionTracks[0];
  }

  const transcriptUrl = track.baseUrl.includes('&fmt=') ? track.baseUrl : `${track.baseUrl}&fmt=json3`;
  const response = await fetch(transcriptUrl);
  if (!response.ok) {
    throw new Error(`Transcript request failed with status ${response.status}`);
  }

  const body = await response.text();

  try {
    const data = JSON.parse(body);
    const transcriptFromJson = parseJsonTranscript(data);
    if (transcriptFromJson) {
      return transcriptFromJson;
    }
  } catch (error) {
    console.debug('Transcript JSON parsing failed, attempting XML fallback.', error);
  }

  return parseXmlTranscript(body);
};

const parseJsonTranscript = (data) => {
  if (!data?.events) {
    return null;
  }

  const parts = [];
  for (const event of data.events) {
    if (!event.segs) {
      continue;
    }

    const text = event.segs.map((seg) => seg.utf8).join('');
    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (cleaned) {
      parts.push(cleaned);
    }
  }

  return parts.join(' ');
};

const parseXmlTranscript = (xmlText) => {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'text/xml');
  const textNodes = Array.from(doc.getElementsByTagName('text'));

  if (textNodes.length === 0) {
    return null;
  }

  const parts = textNodes
    .map((node) => node.textContent?.replace(/\s+/g, ' ').trim())
    .filter((value) => Boolean(value));

  return parts.join(' ');
};

const getPlayerResponse = () => {
  if (window.ytInitialPlayerResponse) {
    return window.ytInitialPlayerResponse;
  }

  const watchFlexy = document.querySelector('ytd-watch-flexy');
  if (watchFlexy?.playerResponse) {
    return watchFlexy.playerResponse;
  }

  const playerElement = document.querySelector('ytd-player');
  const player = playerElement?.player_ || playerElement;

  if (player?.getPlayerResponse) {
    try {
      return player.getPlayerResponse();
    } catch (error) {
      console.warn('Failed to retrieve player response from player object.', error);
    }
  }

  if (playerElement?.getPlayerResponse) {
    try {
      return playerElement.getPlayerResponse();
    } catch (error) {
      console.warn('Failed to retrieve player response from player element.', error);
    }
  }

  if (typeof window.ytplayer !== 'undefined' && window.ytplayer?.config?.args?.player_response) {
    try {
      return JSON.parse(window.ytplayer.config.args.player_response);
    } catch (error) {
      console.warn('Failed to parse player response from ytplayer config.', error);
    }
  }

  return null;
};

const observer = new MutationObserver(() => addButtonIfNeeded());
observer.observe(document.body, { childList: true, subtree: true });

window.addEventListener('yt-navigate-finish', () => {
  setTimeout(() => {
    addButtonIfNeeded();
  }, 1000);
});

addButtonIfNeeded();
