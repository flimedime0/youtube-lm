# YouTube Transcript Summarizer

This Chrome extension adds a "Summarize with ChatGPT" button to YouTube video pages. When clicked, the extension gathers the video's transcript (if one is available) and opens ChatGPT in a new tab with a pre-formatted prompt that requests a summary of the video.

## Features

- Injects a button into the YouTube video action bar.
- Retrieves the video transcript from [Glasp](https://glasp.co/).
- Opens ChatGPT in a new tab and pastes a structured prompt for summarization.
- Retries the prompt injection if the ChatGPT interface is not immediately ready.

## Installation

1. Clone or download this repository.
2. Open **chrome://extensions** in Google Chrome and enable **Developer mode**.
3. Click **Load unpacked** and select the folder containing the extension files (`manifest.json`, `background.js`, and `contentScript.js`).
4. Navigate to a YouTube video. A "Summarize with ChatGPT" button should appear alongside the other video actions once the page finishes loading.
5. Click the button to open ChatGPT with the transcript ready to summarize.

## Notes

- The extension requires access to `https://www.youtube.com/*` to insert the button, `https://glasp.co/*` to fetch transcripts, and `https://chat.openai.com/*` to open ChatGPT.
- Sign in to Glasp in the same browser to ensure transcripts are accessible when requested.
- For videos without transcripts, the extension will notify you that a transcript is unavailable.
- If you are not logged in to ChatGPT, you may need to log in before the prompt appears. The extension will retry several times while the ChatGPT interface loads.
