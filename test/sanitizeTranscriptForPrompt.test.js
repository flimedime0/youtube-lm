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

test('sanitizeTranscriptForPrompt removes single-line Glasp header boilerplate', () => {
  const rawTranscript = [
    '& SummaryPOV: If Tag this to revisit later. Share VideoDownload .srtCopy',
    'Daniel: Welcome back everyone.',
    'Sarah: Thanks for having me!'
  ].join('\n');

  const sanitized = sanitizeTranscriptForPrompt(rawTranscript);

  assert.strictEqual(
    sanitized,
    'Daniel: Welcome back everyone.\nSarah: Thanks for having me!'
  );
});

test('sanitizeTranscriptForPrompt splits inline Glasp header markers', () => {
  const rawTranscript = [
    'Understanding AI in 2024 • Jan 5, 2024 • by Daniel Johnson Share VideoDownload .srtCopyDaniel.',
    'Daniel: Welcome back everyone.',
    'Sarah: Thanks for having me!'
  ].join('\n');

  const sanitized = sanitizeTranscriptForPrompt(rawTranscript);

  assert.ok(
    sanitized.startsWith('Daniel.'),
    `Expected sanitized transcript to start with "Daniel." but received: ${sanitized}`
  );
});

test('sanitizeTranscriptForPrompt splits markers following inline text', () => {
  const rawTranscript = [
    'Understanding AI in 2024 • Jan 5, 2024 • by Daniel Johnson #videogamessShare VideoDownload .srtCopyDaniel.',
    'Daniel: Welcome back everyone.',
    'Sarah: Thanks for having me!'
  ].join('\n');

  const sanitized = sanitizeTranscriptForPrompt(rawTranscript);

  assert.ok(
    sanitized.startsWith('Daniel.'),
    `Expected sanitized transcript to start with "Daniel." but received: ${sanitized}`
  );
});

test('sanitizeTranscriptForPrompt strips zero-width separator characters around markers', () => {
  const zeroWidthSeparator = '\u2060';
  const rawTranscript = [
    `Understanding AI in 2024 • Jan 5, 2024 • by Daniel Johnson Share Video${zeroWidthSeparator}Download .srt${zeroWidthSeparator}Copy${zeroWidthSeparator}Daniel.`,
    'Daniel: Welcome back everyone.',
    'Sarah: Thanks for having me!'
  ].join('\n');

  const sanitized = sanitizeTranscriptForPrompt(rawTranscript);

  assert.ok(
    sanitized.startsWith('Daniel.'),
    `Expected sanitized transcript to start with "Daniel." but received: ${sanitized}`
  );
});
