const test = require('node:test');
const assert = require('node:assert/strict');

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
