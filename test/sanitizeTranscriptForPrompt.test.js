const test = require('node:test');
const assert = require('node:assert/strict');

const { sanitizeTranscriptForPrompt } = require('../contentScript.js');

test('sanitizeTranscriptForPrompt removes Glasp header boilerplate', () => {
  const rawTranscript = [
    '& Summary',
    'Share Video',
    'Download .srt',
    'Copy',
    'Understanding AI in 2024',
    'Understanding AI in 2024',
    'Daniel.',
    'Daniel.',
    '',
    'Daniel: Welcome back everyone.',
    'Sarah: Thanks for having me!'
  ].join('\r\n');

  const sanitized = sanitizeTranscriptForPrompt(rawTranscript);

  assert.strictEqual(
    sanitized,
    'Daniel: Welcome back everyone.\nSarah: Thanks for having me!'
  );
});
