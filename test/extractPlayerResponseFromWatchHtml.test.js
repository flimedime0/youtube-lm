const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const noop = () => {};

global.chrome = {
  runtime: { onMessage: { addListener: noop } },
  tabs: {
    onUpdated: { addListener: noop, removeListener: noop },
    onRemoved: { addListener: noop },
    create: async () => ({ id: 1 }),
    get: async () => ({ url: '' }),
    remove: async () => {}
  },
  scripting: {
    executeScript: async () => [{ result: null }]
  },
  storage: {
    session: {
      get: async () => ({}),
      set: async () => {},
      remove: async () => {}
    }
  }
};

const { extractPlayerResponseFromWatchHtml } = require('../background.js');

test('extractPlayerResponseFromWatchHtml parses JSON after fallback expression', () => {
  const html = `
    <html>
      <head>
        <script>
          var ytInitialPlayerResponse = window.ytInitialPlayerResponse || {"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://example.com/captions"}]}}};
        </script>
      </head>
    </html>
  `;

  const result = extractPlayerResponseFromWatchHtml(html);
  assert.ok(result, 'Expected player response to be parsed');
  assert.strictEqual(
    result.captions.playerCaptionsTracklistRenderer.captionTracks[0].baseUrl,
    'https://example.com/captions'
  );
});

test('extractPlayerResponseFromWatchHtml parses JSON after window fallback in watch page fixture', () => {
  const fixturePath = path.join(__dirname, 'fixtures/watch-with-fallback.html');
  const html = fs.readFileSync(fixturePath, 'utf8');

  const result = extractPlayerResponseFromWatchHtml(html);
  assert.ok(result, 'Expected player response to be parsed from fixture');
  assert.strictEqual(
    result.captions.playerCaptionsTracklistRenderer.captionTracks[0].baseUrl,
    'https://example.com/captions'
  );
});
