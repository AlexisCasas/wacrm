import { describe, expect, it } from 'vitest';

import type { Conversation, Message } from '@/types';
import {
  applyMessageActivity,
  getConversationActivitySnapshot,
  mergeConversationActivitySnapshot,
  mergeConversationUpdate,
  rollbackOptimisticMessageActivity,
  sortConversationsByActivity,
} from './conversation-activity';

const at = (seconds: number) =>
  `2026-01-01T00:00:${String(seconds).padStart(2, '0')}Z`;

function conversation(
  id: string,
  lastMessageAt: string | undefined,
  createdAt = at(1)
): Conversation {
  return {
    id,
    user_id: 'user-1',
    contact_id: `contact-${id}`,
    status: 'open',
    unread_count: 0,
    created_at: createdAt,
    updated_at: createdAt,
    last_message_at: lastMessageAt,
    last_message_text: id,
  };
}

function message(
  conversationId: string,
  createdAt: string,
  overrides: Partial<Message> = {}
): Message {
  return {
    id: `message-${conversationId}-${createdAt}`,
    conversation_id: conversationId,
    sender_type: 'customer',
    content_type: 'text',
    content_text: `from ${conversationId}`,
    status: 'sent',
    created_at: createdAt,
    ...overrides,
  };
}

const ids = (conversations: Conversation[]) =>
  conversations.map((item) => item.id);

describe('conversation activity ordering', () => {
  it('moves a lower inbound chat to first position and updates its preview/unread', () => {
    const result = applyMessageActivity(
      [conversation('A', at(40)), conversation('D', at(10))],
      message('D', at(42)),
      { incrementUnread: true }
    );

    expect(ids(result)).toEqual(['D', 'A']);
    expect(result[0]).toMatchObject({
      last_message_at: at(42),
      last_message_text: 'from D',
      unread_count: 1,
    });
  });

  it('moves a lower optimistic agent reply immediately without adding unread', () => {
    const result = applyMessageActivity(
      [conversation('A', at(40)), conversation('D', at(10))],
      message('D', at(42), { sender_type: 'agent' })
    );

    expect(ids(result)).toEqual(['D', 'A']);
    expect(result[0].unread_count).toBe(0);
  });

  it('converges successive messages to the actual activity order', () => {
    let result = [
      conversation('A', at(1)),
      conversation('B', at(1)),
      conversation('C', at(1)),
    ];
    result = applyMessageActivity(result, message('A', at(10)));
    result = applyMessageActivity(result, message('C', at(20)));
    result = applyMessageActivity(result, message('B', at(30)));

    expect(ids(result)).toEqual(['B', 'C', 'A']);
  });

  it('does not let an out-of-order INSERT replace newer activity, but still applies unread', () => {
    const result = applyMessageActivity(
      [
        {
          ...conversation('A', at(45)),
          last_message_text: 'new message',
          unread_count: 2,
        },
        conversation('B', at(44)),
      ],
      message('A', at(40), { content_text: 'delayed message' }),
      { incrementUnread: true }
    );

    expect(ids(result)).toEqual(['A', 'B']);
    expect(result[0]).toMatchObject({
      last_message_at: at(45),
      last_message_text: 'new message',
      unread_count: 3,
    });
  });

  it('does not roll back an optimistic send over a newer inbound activity', () => {
    const snapshot = {
      ...conversation('A', at(40)),
      last_message_text: 'before send',
    };
    const optimistic = message('A', at(50), {
      sender_type: 'agent',
      content_text: 'optimistic outbound',
    });
    const withOptimistic = applyMessageActivity(
      [snapshot, conversation('B', at(45))],
      optimistic
    );
    const withNewInbound = applyMessageActivity(
      withOptimistic,
      message('A', at(51), { content_text: 'new inbound' }),
      { incrementUnread: true }
    );
    const afterFailure = rollbackOptimisticMessageActivity(
      withNewInbound,
      optimistic,
      snapshot
    );

    expect(afterFailure).toBe(withNewInbound);
    expect(afterFailure[0]).toMatchObject({
      id: 'A',
      last_message_at: at(51),
      last_message_text: 'new inbound',
    });
  });

  it('restores only activity after a failed optimistic send, preserving concurrent fields', () => {
    const beforeOptimistic = {
      ...conversation('A', at(40)),
      last_message_text: 'old',
    };
    const optimistic = message('A', at(50), {
      sender_type: 'agent',
      content_text: 'sending',
    });
    const optimisticState = applyMessageActivity(
      [beforeOptimistic],
      optimistic
    );
    const concurrentlyUpdated = {
      ...optimisticState[0],
      status: 'pending' as const,
      unread_count: 3,
      assigned_agent_id: 'agent-new',
      contact: {
        id: 'contact-A',
        user_id: 'user-1',
        account_id: 'account-1',
        phone: '+15550000000',
        created_at: at(1),
        updated_at: at(51),
        tags: [
          {
            id: 'tag-new',
            user_id: 'user-1',
            name: 'New tag',
            color: '#000000',
            created_at: at(51),
          },
        ],
      },
    };
    const result = rollbackOptimisticMessageActivity(
      [concurrentlyUpdated],
      optimistic,
      getConversationActivitySnapshot(beforeOptimistic)
    );

    expect(result[0]).toMatchObject({
      last_message_at: at(40),
      last_message_text: 'old',
      status: 'pending',
      unread_count: 3,
      assigned_agent_id: 'agent-new',
      contact: { tags: [{ id: 'tag-new' }] },
    });
  });

  it('restores the freshest pre-optimistic activity snapshot after a queued realtime update', () => {
    const initialActivity = getConversationActivitySnapshot(
      conversation('A', at(40))
    );
    const realtimeActivity = {
      ...conversation('A', at(45)),
      last_message_text: 'realtime before send',
    };
    // This mirrors the page's synchronous ref update that occurs before its
    // React state update can commit.
    const latestActivity = mergeConversationActivitySnapshot(
      initialActivity,
      getConversationActivitySnapshot(realtimeActivity)
    );
    const optimistic = message('A', at(50), {
      sender_type: 'agent',
      content_text: 'sending',
    });
    const afterOptimistic = applyMessageActivity(
      [realtimeActivity],
      optimistic
    );
    const result = rollbackOptimisticMessageActivity(
      afterOptimistic,
      optimistic,
      latestActivity
    );

    expect(result[0]).toMatchObject({
      last_message_at: at(45),
      last_message_text: 'realtime before send',
    });
  });

  it('converges a realtime confirmation of optimistic activity without duplicate movement', () => {
    const optimistic = message('A', at(50), {
      sender_type: 'agent',
      content_text: 'local preview',
    });
    const optimisticState = applyMessageActivity(
      [conversation('B', at(45)), conversation('A', at(40))],
      optimistic
    );
    const confirmed = mergeConversationUpdate(optimisticState[0], {
      ...optimisticState[0],
      last_message_at: at(50),
      last_message_text: 'server canonical preview',
    });
    const result = sortConversationsByActivity([confirmed, optimisticState[1]]);

    expect(ids(result)).toEqual(['A', 'B']);
    expect(result).toHaveLength(2);
    expect(result[0].last_message_text).toBe('server canonical preview');
  });

  it('keeps newest activity and preview when a stale conversation UPDATE arrives', () => {
    const current = {
      ...conversation('A', at(50)),
      last_message_text: 'new preview',
      status: 'open' as const,
    };
    const stale = {
      ...current,
      last_message_at: at(45),
      last_message_text: 'stale preview',
      status: 'pending' as const,
    };
    const merged = mergeConversationUpdate(current, stale);
    const result = sortConversationsByActivity([
      conversation('B', at(49)),
      merged,
    ]);

    expect(result[0]).toMatchObject({
      id: 'A',
      last_message_at: at(50),
      last_message_text: 'new preview',
      status: 'pending',
    });
  });

  it.each([
    [
      'tag',
      {
        contact: {
          id: 'contact-A',
          user_id: 'user-1',
          account_id: 'account-1',
          phone: '+15550000000',
          created_at: at(1),
          updated_at: at(1),
          tags: [],
        },
      },
    ],
    ['status', { status: 'pending' as const }],
    ['read receipt', { unread_count: 0 }],
  ])('does not reorder on a %s-only conversation update', (_name, patch) => {
    const current = conversation('A', at(10));
    const updated = mergeConversationUpdate(current, { ...current, ...patch });
    const result = sortConversationsByActivity([
      conversation('B', at(20)),
      updated,
    ]);

    expect(ids(result)).toEqual(['B', 'A']);
  });

  it('keeps activity ordering inside filtered and searched subsets', () => {
    const all = applyMessageActivity(
      [
        {
          ...conversation('pending-old', at(10)),
          status: 'pending' as const,
          last_message_text: 'invoice',
        },
        {
          ...conversation('pending-new', at(20)),
          status: 'pending' as const,
          last_message_text: 'invoice',
        },
        { ...conversation('open', at(30)), last_message_text: 'invoice' },
      ],
      message('pending-old', at(40), { content_text: 'invoice paid' })
    );
    const pending = all.filter((item) => item.status === 'pending');
    const searched = all.filter((item) =>
      item.last_message_text?.includes('invoice')
    );

    expect(ids(pending)).toEqual(['pending-old', 'pending-new']);
    expect(ids(searched)).toEqual(['pending-old', 'open', 'pending-new']);
  });

  it('uses the same rule after refetch and is idempotent for an equivalent realtime event', () => {
    const refreshed = sortConversationsByActivity([
      conversation('A', at(10)),
      conversation('C', at(30)),
      conversation('B', at(20)),
    ]);
    const once = applyMessageActivity(refreshed, message('B', at(40)));
    const twice = applyMessageActivity(once, message('B', at(40)));

    expect(ids(refreshed)).toEqual(['C', 'B', 'A']);
    expect(twice).toEqual(once);
  });

  it('breaks equal activity timestamps by created_at then id', () => {
    const result = sortConversationsByActivity([
      conversation('z', at(20), at(1)),
      conversation('b', at(20), at(2)),
      conversation('a', at(20), at(2)),
    ]);

    expect(ids(result)).toEqual(['a', 'b', 'z']);
  });

  it('keeps null or malformed activity timestamps deterministic and below valid activity', () => {
    const input = [
      conversation('null', undefined, at(3)),
      conversation('invalid', 'not-a-date', at(2)),
      conversation('valid', at(10), at(1)),
    ];
    const result = sortConversationsByActivity(input);

    expect(ids(result)).toEqual(['valid', 'null', 'invalid']);
    expect(input.map((item) => item.id)).toEqual(['null', 'invalid', 'valid']);
  });
});
