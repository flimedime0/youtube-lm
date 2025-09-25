const test = require('node:test');
const assert = require('node:assert/strict');

global.chrome = {
  runtime: {
    onMessage: { addListener: () => {} }
  },
  tabs: {
    onUpdated: { addListener: () => {} },
    onRemoved: { addListener: () => {} },
    create: async () => ({ id: 1 }),
    remove: async () => {},
    get: async () => ({})
  },
  storage: {
    session: {
      get: async () => ({}),
      set: async () => {},
      remove: async () => {}
    }
  }
};

const { parseTranscriptFromReaderText } = require('../background.js');

test('parseTranscriptFromReaderText strips leading Glasp metadata headers', () => {
  const pageText = [
    'Transcript',
    '#philosophaire',
    '#stoicism',
    'May 5, 2024',
    'by',
    'Philosophaire',
    'Host: Welcome back to the show.',
    'Guest: Thanks for inviting me.'
  ].join('\n');

  const transcript = parseTranscriptFromReaderText(pageText);

  assert.ok(
    transcript.startsWith('Host: Welcome back to the show.'),
    `Expected transcript to start with spoken text, received: ${transcript}`
  );
  assert.ok(!/philosophaire/i.test(transcript));
  assert.ok(!/May 5, 2024/.test(transcript));
});
