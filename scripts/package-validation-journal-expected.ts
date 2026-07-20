import {
  legacyCreatedAt,
  legacyStaleAttemptStartedAt,
  type PreservedJournalRecords,
} from './package-validation-journal-records';

const completedLegacyAttempt = {
  account_id: null,
  codex_thread_id: null,
  codex_turn_id: null,
  finished_at: legacyCreatedAt,
  id: 'legacy-attempt',
  logical_turn_id: 'legacy-turn',
  started_at: legacyCreatedAt,
  state: 'Completed',
};

const staleTerminalAttempt = {
  account_id: null,
  codex_thread_id: null,
  codex_turn_id: null,
  finished_at: null,
  id: 'stale-terminal-attempt',
  logical_turn_id: 'legacy-turn',
  started_at: legacyStaleAttemptStartedAt,
  state: 'Prepared',
};

const expectedVersionOneRecords = {
  accountObservations: [
    {
      account_id: 'legacy-account',
      id: 1,
      observed_at: legacyCreatedAt,
      reset_at: legacyCreatedAt,
      usable: 0,
      usage_json: '{"remainingPercent":0}',
    },
  ],
  approvals: [],
  attachments: [
    {
      attachment_guid: 'legacy-attachment-guid',
      content_hash: 'legacy-attachment-hash',
      created_at: legacyCreatedAt,
      filename: '/legacy/active.png',
      id: 'legacy-attachment',
      inbound_message_id: 'legacy-message',
      mime_type: 'image/png',
      payload_redacted_at: null,
      source_path: '/legacy/source.png',
      staged_path: '/legacy/staged.png',
      state: 'Assigned',
      total_bytes: 128,
      transfer_name: 'active.png',
      uti: 'public.png',
    },
  ],
  attempts: [completedLegacyAttempt, staleTerminalAttempt],
  batchMessages: [
    { inbound_message_id: 'legacy-message', input_batch_id: 'legacy-batch', ordinal: 0 },
  ],
  batches: [
    {
      created_at: legacyCreatedAt,
      fingerprint: 'legacy-fingerprint',
      id: 'legacy-batch',
      kind: 'Initial',
      logical_turn_id: 'legacy-turn',
    },
  ],
  deliveryAttempts: [
    {
      attempt_number: 1,
      error: null,
      finished_at: legacyCreatedAt,
      id: 'legacy-delivery-attempt',
      outbound_chunk_id: 'legacy-chunk',
      started_at: legacyCreatedAt,
      state: 'Reconciled',
    },
  ],
  failures: [
    {
      correlation_id: 'legacy-correlation',
      created_at: legacyCreatedAt,
      details_json: null,
      error_tag: 'Fixture',
      id: 1,
      message: 'preserve failure row',
      operation: 'package-validation',
    },
  ],
  generationThread: 'legacy-thread',
  generations: [
    {
      created_at: legacyCreatedAt,
      id: 'legacy-generation',
      sequence: 1,
      state: 'Current',
      superseded_at: null,
    },
  ],
  messages: [
    {
      chat_guid: 'iMessage;-;spike@example.com',
      handle: 'spike@example.com',
      id: 'legacy-message',
      message_guid: 'legacy-message-guid',
      messages_rowid: 1,
      observed_at: legacyCreatedAt,
      sent_at: legacyCreatedAt,
      service: 'iMessage',
      source_id: 'legacy-message-guid',
      source_kind: 'Messages',
      text: 'preserve this journal row',
    },
  ],
  outboundChunks: [
    {
      id: 'legacy-chunk',
      message_guid: 'legacy-outbound-guid',
      messages_rowid: 2,
      ordinal: 0,
      outbound_message_id: 'legacy-outbound',
      state: 'Reconciled',
      text: 'preserve outbound delivery',
    },
  ],
  outboundMessages: [
    {
      created_at: legacyCreatedAt,
      delivered_at: legacyCreatedAt,
      id: 'legacy-outbound',
      logical_turn_id: 'legacy-turn',
      message_kind: 'Final',
      source_id: 'legacy-item',
      source_kind: 'CodexAgentItem',
      state: 'Delivered',
      text: 'preserve outbound delivery',
    },
  ],
  scheduleToolCalls: [],
  scheduledRuns: [],
  scheduler: [
    {
      active_acknowledged: 0,
      active_codex_turn_id: null,
      active_logical_turn_id: null,
      generation_id: 'legacy-generation',
      singleton: 1,
      timer_deadline_at: null,
      updated_at: legacyCreatedAt,
    },
  ],
  schedules: [],
  turns: [
    {
      completed_at: legacyCreatedAt,
      correlation_id: 'legacy-correlation',
      created_at: legacyCreatedAt,
      generation_id: 'legacy-generation',
      id: 'legacy-turn',
      sequence: 1,
      state: 'Completed',
    },
  ],
} satisfies PreservedJournalRecords;

const expectedUpgradedVersionOneRecords = {
  ...expectedVersionOneRecords,
  attempts: [
    completedLegacyAttempt,
    { ...staleTerminalAttempt, finished_at: legacyCreatedAt, state: 'Failed' },
  ],
} satisfies PreservedJournalRecords;

export { expectedUpgradedVersionOneRecords, expectedVersionOneRecords };
