import { describe, expect, it } from 'vitest';
import { deriveFact, factViewFromRow, ownershipIntervals, responseTurns, type ChatSource, type FactInput } from './facts';
import { aggregate } from './measures';

const T0 = Date.parse('2026-10-12T10:00:00Z');
const at = (s: number) => new Date(T0 + s * 1000);

function chat(over: Partial<ChatSource> = {}): ChatSource {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    siteId: 'site',
    departmentId: 'dept-a',
    acquisitionDepartmentId: 'dept-a',
    ownerMembershipId: null,
    status: 'queued',
    startedBy: 'visitor',
    requestedAt: at(0),
    firstAssignedAt: null,
    closedAt: null,
    closeReason: null,
    closedByActor: null,
    isPreview: false,
    version: 1,
    nextSeq: 2,
    ...over,
  };
}

function input(over: Partial<FactInput> = {}): FactInput {
  return { chat: chat(), firstHumanReplyAt: null, firstHumanReplyAuthorId: null, humanReplyCount: 0, replyAuthorIds: [], rating: null, history: [], tagIds: [], invitationId: null, ...over };
}

describe('deriveFact (MET01)', () => {
  it('assigned but never replied is not served, and is missed once closed', () => {
    const f = deriveFact(
      input({
        chat: chat({ status: 'closed', ownerMembershipId: 'a', firstAssignedAt: at(20), closedAt: at(300), closeReason: 'resolved', closedByActor: 'agent', version: 5, nextSeq: 6 }),
        history: [{ reason: 'picked_up', previousOwnerId: null, nextOwnerId: 'a', occurredAt: at(20) }],
      }),
    );
    expect(f.served).toBe(false);
    expect(f.firstAssignedAt).toEqual(at(20));
    expect(f.missed).toBe(true);
    expect(f.abandoned).toBe(false);
    expect(f.sourceVersion).toBe(11);
  });

  it('served requires a human public reply; first response time comes from it', () => {
    const f = deriveFact(input({ chat: chat({ status: 'active', firstAssignedAt: at(5), ownerMembershipId: 'a' }), firstHumanReplyAt: at(12), firstHumanReplyAuthorId: 'a', humanReplyCount: 2, replyAuthorIds: ['a'] }));
    expect(f.served).toBe(true);
    expect(f.missed).toBe(false);
    expect(f.firstResponseAt).toEqual(at(12));
    expect(f.snapshot.firstResponderId).toBe('a');
  });

  it('visitor ending before assignment is abandoned (and a quick cancel within 10 s)', () => {
    const quick = deriveFact(input({ chat: chat({ status: 'closed', closedAt: at(8), closeReason: 'visitor_ended', closedByActor: 'visitor' }) }));
    expect(quick).toMatchObject({ abandoned: true, missed: true, served: false });
    expect(quick.snapshot.quickCancel).toBe(true);
    const slow = deriveFact(input({ chat: chat({ status: 'closed', closedAt: at(45), closeReason: 'visitor_ended', closedByActor: 'visitor' }) }));
    expect(slow.abandoned).toBe(true);
    expect(slow.snapshot.quickCancel).toBe(false);
    const grace = deriveFact(input({ chat: chat({ status: 'closed', closedAt: at(400), closeReason: 'visitor_disconnected', closedByActor: 'system' }) }));
    expect(grace.abandoned).toBe(true);
    const afterAssign = deriveFact(input({ chat: chat({ status: 'closed', firstAssignedAt: at(5), closedAt: at(60), closeReason: 'visitor_ended', closedByActor: 'visitor' }) }));
    expect(afterAssign.abandoned).toBe(false);
    expect(afterAssign.missed).toBe(true);
  });

  it('attributes ownership to interval owners and replies to actual authors across a transfer', () => {
    const history = [
      { reason: 'offered', previousOwnerId: null, nextOwnerId: null, occurredAt: at(1) },
      { reason: 'picked_up', previousOwnerId: null, nextOwnerId: 'a', occurredAt: at(10) },
      { reason: 'transfer_offered', previousOwnerId: 'a', nextOwnerId: null, occurredAt: at(50) },
      { reason: 'transfer_accepted', previousOwnerId: 'a', nextOwnerId: 'b', occurredAt: at(60) },
    ];
    const f = deriveFact(
      input({
        chat: chat({ status: 'closed', ownerMembershipId: 'b', firstAssignedAt: at(10), closedAt: at(200), closeReason: 'resolved', closedByActor: 'agent' }),
        history,
        firstHumanReplyAt: at(15),
        firstHumanReplyAuthorId: 'a',
        humanReplyCount: 3,
        replyAuthorIds: ['b', 'a', 'b'],
      }),
    );
    expect(f.snapshot.ownership).toEqual([
      { m: 'a', from: at(10).toISOString(), to: at(60).toISOString() },
      { m: 'b', from: at(60).toISOString(), to: at(200).toISOString() },
    ]);
    expect(f.snapshot.replyAuthorIds).toEqual(['a', 'b']);
    expect(f.snapshot.agentIds).toEqual(['a', 'b']);
    expect(f.snapshot.firstResponderId).toBe('a');
  });

  it('department transfers release ownership; open intervals stay open', () => {
    const iv = ownershipIntervals(
      [
        { reason: 'picked_up', previousOwnerId: null, nextOwnerId: 'a', occurredAt: at(10) },
        { reason: 'department_transfer', previousOwnerId: 'a', nextOwnerId: null, occurredAt: at(30) },
        { reason: 'offer_accepted', previousOwnerId: null, nextOwnerId: 'c', occurredAt: at(40) },
      ],
      null,
    );
    expect(iv).toEqual([
      { membershipId: 'a', from: T0 + 10_000, to: T0 + 30_000 },
      { membershipId: 'c', from: T0 + 40_000, to: null },
    ]);
  });

  it('a late rating change revises the fact with a greater source version and counts once', () => {
    const base = input({
      chat: chat({ status: 'closed', ownerMembershipId: 'a', firstAssignedAt: at(5), closedAt: at(100), closeReason: 'resolved', closedByActor: 'agent', version: 6, nextSeq: 5 }),
      firstHumanReplyAt: at(9),
      firstHumanReplyAuthorId: 'a',
      humanReplyCount: 1,
      replyAuthorIds: ['a'],
      rating: { rating: 'bad', submittedAt: at(120), revisedAt: null, revisionCount: 0 },
    });
    const first = deriveFact(base);
    const revised = deriveFact({ ...base, chat: { ...base.chat, version: 7 }, rating: { rating: 'good', submittedAt: at(120), revisedAt: at(130), revisionCount: 1 } });
    expect(revised.sourceVersion).toBeGreaterThan(first.sourceVersion);
    const opts = { excludeQuickCancellations: false };
    expect(aggregate([factViewFromRow(first)], null, null, opts).csat).toMatchObject({ value: 0, numerator: 0, denominator: 1 });
    expect(aggregate([factViewFromRow(revised)], null, null, opts).csat).toMatchObject({ value: 100, numerator: 1, denominator: 1, n: 1 });
  });
});

describe('responseTurns', () => {
  it('measures from the first visitor message of a burst to the next human reply', () => {
    const turns = responseTurns([
      { at: 0, kind: 'visitor', authorId: null },
      { at: 5, kind: 'visitor', authorId: null },
      { at: 20, kind: 'human', authorId: 'a' },
      { at: 25, kind: 'human', authorId: 'a' },
      { at: 30, kind: 'visitor', authorId: null },
      { at: 70, kind: 'human', authorId: 'b' },
      { at: 90, kind: 'visitor', authorId: null },
    ]);
    expect(turns).toEqual([
      { start: 0, end: 20, authorId: 'a' },
      { start: 30, end: 70, authorId: 'b' },
    ]);
  });
});
