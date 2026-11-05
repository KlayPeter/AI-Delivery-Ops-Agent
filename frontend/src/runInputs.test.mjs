import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { formatRunInput, readRunInput, rememberRunInput, setInputCapture } from './runInputs.mjs';
afterEach(() => setInputCapture(false));
test('recipe candidates are opt-in, bounded, isolated copies kept only in this page session', () => {
  rememberRunInput('disabled', {prompt:'private'}); assert.equal(readRunInput('disabled'), undefined);
  setInputCapture(true);
  const input={prompt:'fictional task'}; rememberRunInput('selected',input); input.prompt='changed';
  const copy=readRunInput('selected'); assert.equal(copy.prompt,'fictional task'); copy.prompt='changed again'; assert.equal(readRunInput('selected').prompt,'fictional task');
  rememberRunInput('large',{prompt:'中'.repeat(20000)}); assert.equal(readRunInput('large'),undefined);
  const circular={}; circular.self=circular; rememberRunInput('circular',circular); assert.equal(readRunInput('circular'),undefined);
  for(let index=0;index<50;index++) rememberRunInput(String(index),{index});
  assert.equal(readRunInput('selected'),undefined); assert.deepEqual(readRunInput('49'),{index:49});
  setInputCapture(false); assert.equal(readRunInput('49'),undefined);
});

test('large valid task parameters remain valid and within the editor budget after formatting', () => {
  const input = {items: Array.from({length:1500}, () => ({text:'sample'}))};
  const formatted = formatRunInput(input);
  assert.ok(new TextEncoder().encode(formatted).byteLength <= 32768);
  assert.deepEqual(JSON.parse(formatted),input);
});
