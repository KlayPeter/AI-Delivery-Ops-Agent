export interface KnowledgeReview {
  id: string; capability: string; createdAt: string; canCheck: boolean;
  references: { path: string; sourceKind?: 'markdown' | 'web' }[];
  assessment: { state: 'current' | 'needs_review' | 'unverifiable' | 'not_applicable'; reason?: string; checkedAt?: string; checkRunId?: string };
}
export function reviewState(review: KnowledgeReview) {
  if (review.assessment.state === 'unverifiable' && review.assessment.reason === 'not_checked') return 'not_checked';
  return ['current', 'needs_review', 'not_applicable'].includes(review.assessment.state) ? review.assessment.state : 'unverifiable';
}
export const reviewLabels: Record<string, string> = { not_checked: '尚未检查', needs_review: '需要复核', current: '上次版本未变化', unverifiable: '无法核验', not_applicable: '无实际知识引用' };
export function filterReviews(reviews: KnowledgeReview[], query: string, state: string) {
  const search = query.trim().toLowerCase();
  return reviews.filter(review => (state === 'all' || reviewState(review) === state)
    && [review.id, review.capability === 'knowledge.answer' ? '知识问答' : '发布准备', ...review.references.map(reference => reference.path)].some(value => value.toLowerCase().includes(search)));
}
export const selectedReviewIds = (reviews: KnowledgeReview[], picked: string[]) => reviews.filter(review => review.canCheck && picked.includes(review.id)).slice(0, 20).map(review => review.id);
