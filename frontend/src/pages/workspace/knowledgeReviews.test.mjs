import { expect, test } from 'bun:test';
import { filterReviews, reviewState, selectedReviewIds } from './knowledgeReviews.ts';
const row = (id, state = 'unverifiable', reason = 'not_checked') => ({ id, capability: 'knowledge.answer', createdAt: '2026-11-06T00:00:00Z', canCheck: true, references: [{ path: 'Release/API.md', sourceKind: 'markdown' }], assessment: { state, reason } });
test('review status distinguishes never checked and unknown; old current remains a dated previous result', () => {
  expect(reviewState(row('a'))).toBe('not_checked');
  expect(reviewState(row('a', 'unverifiable', 'check_incomplete'))).toBe('unverifiable');
  expect(reviewState(row('a', 'current'))).toBe('current');
  expect(reviewState(row('a', 'invalid'))).toBe('unverifiable');
});
test('history filters use real reference paths, result types, IDs and the selected assessment state', () => {
  const reviews = [row('First'), row('Second', 'needs_review')];
  expect(filterReviews(reviews, ' api.MD ', 'all')).toEqual(reviews);
  expect(filterReviews(reviews, 'second', 'needs_review')).toEqual([reviews[1]]);
  expect(filterReviews(reviews, '知识问答', 'not_checked')).toEqual([reviews[0]]);
  expect(filterReviews(reviews, 'missing', 'all')).toEqual([]);
});
test('batch selection excludes disabled and removed rows, deduplicates picks and caps actual execution at twenty', () => {
  const reviews = Array.from({ length: 30 }, (_, index) => row(String(index)));
  reviews[0].canCheck = false;
  const ids = selectedReviewIds(reviews, ['missing', '1', '1', ...reviews.map(review => review.id)]);
  expect(ids).toHaveLength(20);
  expect(new Set(ids).size).toBe(20);
  expect(ids).not.toContain('0');
  expect(ids).not.toContain('missing');
  expect(selectedReviewIds([], ['1'])).toEqual([]);
});
