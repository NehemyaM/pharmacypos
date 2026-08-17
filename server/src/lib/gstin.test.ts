import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { describeGstinProblem, isValidGstin, normaliseGstin } from './gstin.js';

const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** The published GSTN algorithm, written independently: backwards, factor 2,1. */
function checkDigitPerSpec(first14: string): string {
  let factor = 2, sum = 0;
  for (let i = first14.length - 1; i >= 0; i--) {
    let digit = factor * CHARS.indexOf(first14[i]);
    factor = factor === 2 ? 1 : 2;
    digit = Math.floor(digit / 36) + (digit % 36);
    sum += digit;
  }
  return CHARS[(36 - (sum % 36)) % 36];
}

/** A well-formed GSTIN with a correct check digit, for the given state. */
function makeGstin(state = '36', pan = 'AABCT3518Q', entity = '1'): string {
  const base = `${state}${pan}${entity}Z`;
  return base + checkDigitPerSpec(base);
}

describe('GSTIN validation', () => {
  test('accepts the canonical example', () => {
    assert.equal(isValidGstin('27AAPFU0939F1ZV'), true);
    assert.equal(describeGstinProblem('27AAPFU0939F1ZV'), null);
  });

  test('the check digit agrees with the published algorithm', () => {
    // Every state code, several PANs, both entity shapes.
    for (const state of ['36', '37', '27', '29', '07', '19']) {
      for (const pan of ['AABCT3518Q', 'AAPFU0939F', 'BZAHM6385P', 'ZZZZZ9999Z']) {
        for (const entity of ['1', '9', 'A', 'Z']) {
          const g = makeGstin(state, pan, entity);
          assert.equal(g[14], checkDigitPerSpec(g.slice(0, 14)), g);
          assert.equal(isValidGstin(g), true, g);
        }
      }
    }
  });

  test('rejects a single mistyped character anywhere in the number', () => {
    const good = makeGstin();
    let caught = 0, tried = 0;
    for (let i = 0; i < 14; i++) {
      for (const c of CHARS) {
        const bad = good.slice(0, i) + c + good.slice(i + 1);
        if (bad === good) continue;
        tried++;
        if (!isValidGstin(bad)) caught++;
      }
    }
    // A mod-36 check digit cannot catch every possible corruption, but it must
    // catch the overwhelming majority — anything less means it is not working.
    assert.ok(caught / tried > 0.95, `caught ${caught}/${tried}`);
  });
});

describe('GSTIN diagnosis', () => {
  test('reads a number the way it appears on a certificate', () => {
    // Spaced, hyphenated and lower-case are all the same number.
    const g = makeGstin();
    assert.equal(normaliseGstin(g.toLowerCase()), g);
    assert.equal(normaliseGstin(`${g.slice(0, 5)} ${g.slice(5, 10)} ${g.slice(10)}`), g);
    assert.equal(isValidGstin(g.toLowerCase()), true);
    assert.equal(isValidGstin(`${g.slice(0, 2)}-${g.slice(2)}`), true);
  });

  test('says how far off the length is', () => {
    assert.match(describeGstinProblem('36AABCT3518Q1Z') ?? '', /15 characters — this one has 14/);
    assert.match(describeGstinProblem('36AABCT3518Q1ZXY') ?? '', /has 16/);
  });

  test('names an unknown state code, with the local ones as examples', () => {
    const problem = describeGstinProblem('99AABCT3518Q1ZX') ?? '';
    assert.match(problem, /"99" is not a state code/);
    assert.match(problem, /Telangana is 36/);
  });

  test('points at the PAN when its shape is wrong', () => {
    assert.match(describeGstinProblem('36AAB1T3518Q1ZX') ?? '', /PAN/);
  });

  test('gives the expected check digit, which is the actionable part', () => {
    const good = makeGstin();
    const wrongLast = good.slice(0, 14) + (good[14] === 'A' ? 'B' : 'A');
    const problem = describeGstinProblem(wrongLast) ?? '';
    assert.match(problem, new RegExp(`should be "${good[14]}"`));
    assert.match(problem, /typo earlier in the number/);
  });

  test('says nothing about an empty field', () => {
    assert.equal(describeGstinProblem(''), null);
    assert.equal(describeGstinProblem('   '), null);
    // ...but empty is still not a valid GSTIN.
    assert.equal(isValidGstin(''), false);
  });
});
