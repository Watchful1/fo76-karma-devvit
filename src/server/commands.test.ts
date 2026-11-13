import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseCommand } from './commands';

test('give commands', () => {
  for (const body of [
    '+karma',
    '++KARMA',
    'karma+',
    '\\+karma',
    '+karma thanks',
    '  +Karma\n',
  ]) {
    assert.equal(parseCommand(body), 'give', body);
  }
});

test('take commands', () => {
  for (const body of ['-karma', 'karma--', '\\-karma', '-KARMA bad trader']) {
    assert.equal(parseCommand(body), 'take', body);
  }
});

test('close commands', () => {
  for (const body of ['!close', 'CLOSE!', '!Close thanks']) {
    assert.equal(parseCommand(body), 'close', body);
  }
});

test('anything else is not a command', () => {
  for (const body of [
    'karma',
    '+ karma',
    'I gave +karma',
    '',
    'close',
    '!clos',
  ]) {
    assert.equal(parseCommand(body), undefined, body);
  }
});

test('--karma and karma-- are takes, and repeated signs still count', () => {
  for (const body of ['--karma', 'karma--', '---karma', 'karma---', '-karma']) {
    assert.equal(parseCommand(body), 'take', body);
  }
  for (const body of ['++karma', 'karma++', '+++KARMA']) {
    assert.equal(parseCommand(body), 'give', body);
  }
});

test('a command is only read at the start of the comment', () => {
  for (const body of [
    'no -karma',
    "don't !close",
    'I gave +karma',
    'thanks! +karma',
    'please close!',
    'x\n+karma',
  ]) {
    assert.equal(parseCommand(body), undefined, body);
  }
});

test('close works as !close and close!', () => {
  assert.equal(parseCommand('!close'), 'close');
  assert.equal(parseCommand('close!'), 'close');
  assert.equal(parseCommand('!CLOSE'), 'close');
  assert.equal(parseCommand('Close! thanks'), 'close');
});

test('leading whitespace, newlines and backslashes are ignored', () => {
  assert.equal(parseCommand('   +karma'), 'give');
  assert.equal(parseCommand('\n\t +karma'), 'give');
  assert.equal(parseCommand('\\+karma'), 'give');
  assert.equal(parseCommand('\\-karma'), 'take');
  assert.equal(parseCommand('\\!close'), 'close');
  assert.equal(parseCommand('  \\+\\+karma'), 'give');
});

test('commands are case-insensitive', () => {
  assert.equal(parseCommand('+KaRmA'), 'give');
  assert.equal(parseCommand('KARMA+'), 'give');
  assert.equal(parseCommand('-Karma'), 'take');
  assert.equal(parseCommand('!ClOsE'), 'close');
});

test('a bare sign is not a command', () => {
  assert.equal(parseCommand('+'), undefined);
  assert.equal(parseCommand('-'), undefined);
  assert.equal(parseCommand('!'), undefined);
  assert.equal(parseCommand('! close'), undefined);
  assert.equal(parseCommand('++ karma'), undefined);
});
