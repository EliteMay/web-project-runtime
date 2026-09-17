export const FAILURE_CLASSES = Object.freeze([
  'transient_failure',
  'stale_revision',
  'concurrent_conflict',
  'validation_failure',
  'partial_persistence',
  'integrity_corruption',
  'untracked_change',
  'provenance_conflict',
  'ambiguous_attribution',
  'external_unavailable',
  'unsafe_dirty_state',
]);

export const RECOVERY_DISPOSITIONS = Object.freeze([
  'retry_same_operation',
  'reread_then_retry',
  'abort_uncommitted_candidate',
  'roll_forward',
  'rebuild_derived',
  'record_expected_external',
  'fail_closed',
  'manual_reconcile',
]);

const FAILURE_CLASS_SET = new Set(FAILURE_CLASSES);
const DISPOSITION_SET = new Set(RECOVERY_DISPOSITIONS);

export function makeFailureClassification({
  failureClass,
  disposition,
  reasonCode,
  retryable = false,
  writeBlocked = false,
}) {
  if (!FAILURE_CLASS_SET.has(failureClass)) {
    throw new Error(`Unsupported failure class: ${failureClass}`);
  }
  if (!DISPOSITION_SET.has(disposition)) {
    throw new Error(`Unsupported recovery disposition: ${disposition}`);
  }
  if (typeof reasonCode !== 'string' || reasonCode.trim() === '') {
    throw new Error('reasonCode must be a non-empty string.');
  }
  if (typeof retryable !== 'boolean') throw new Error('retryable must be boolean.');
  if (typeof writeBlocked !== 'boolean') throw new Error('writeBlocked must be boolean.');

  return {
    failureClass,
    disposition,
    reasonCode,
    retryable,
    writeBlocked,
  };
}

export function defaultFailureClassification(failureClass, reasonCode = failureClass) {
  switch (failureClass) {
    case 'stale_revision':
    case 'concurrent_conflict':
      return makeFailureClassification({ failureClass, disposition: 'reread_then_retry', reasonCode, retryable: true, writeBlocked: true });
    case 'provenance_conflict':
    case 'integrity_corruption':
      return makeFailureClassification({ failureClass, disposition: 'fail_closed', reasonCode, retryable: false, writeBlocked: true });
    case 'unsafe_dirty_state':
    case 'ambiguous_attribution':
      return makeFailureClassification({ failureClass, disposition: 'manual_reconcile', reasonCode, retryable: false, writeBlocked: true });
    case 'transient_failure':
    case 'external_unavailable':
      return makeFailureClassification({ failureClass, disposition: 'retry_same_operation', reasonCode, retryable: true, writeBlocked: false });
    case 'partial_persistence':
      return makeFailureClassification({ failureClass, disposition: 'roll_forward', reasonCode, retryable: true, writeBlocked: true });
    case 'validation_failure':
      return makeFailureClassification({ failureClass, disposition: 'fail_closed', reasonCode, retryable: false, writeBlocked: true });
    case 'untracked_change':
      return makeFailureClassification({ failureClass, disposition: 'manual_reconcile', reasonCode, retryable: false, writeBlocked: true });
    default:
      throw new Error(`Unsupported failure class: ${failureClass}`);
  }
}
