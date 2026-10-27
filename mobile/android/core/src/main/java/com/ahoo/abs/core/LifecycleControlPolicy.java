package com.ahoo.abs.core;

/** Controller-side drain decisions; transport receipts never establish process death. */
public final class LifecycleControlPolicy {
    public enum DrainAction { WAIT_FOR_HELLO, SEND_DRAIN, WAIT_FOR_EXIT }

    private LifecycleControlPolicy() { }

    /** Called by the production controller, including retries on a revalidated connection. */
    public static DrainAction requestDrain(RuntimeStateMachine machine, String sessionId,
                                           boolean validatedControl) {
        if (machine != null && !machine.sessionId.equals(sessionId)) {
            throw CoreValidation.error("SESSION_MISMATCH", "Drain belongs to another runtime session");
        }
        if (!validatedControl) return DrainAction.WAIT_FOR_HELLO;
        if (machine == null) return DrainAction.SEND_DRAIN;
        switch (machine.state()) {
            case STARTING:
            case BOOTSTRAPPED:
            case PROBING:
            case READY:
            case BLOCKED:
                machine.requestDrain(sessionId);
                return DrainAction.SEND_DRAIN;
            case DRAINING:
            case EXIT_WAIT:
            case EXIT_UNKNOWN:
                // Transport retry is idempotent at the service, not a new state transition.
                return DrainAction.SEND_DRAIN;
            case EXIT_CONFIRMED:
                return DrainAction.WAIT_FOR_EXIT;
            default:
                throw CoreValidation.error("INVALID_TRANSITION", "Unknown drain state");
        }
    }

    /** Applies a validated receipt without treating it as process-exit evidence. */
    public static void drainReported(RuntimeStateMachine machine, String sessionId) {
        if (machine != null && !machine.sessionId.equals(sessionId)) {
            throw CoreValidation.error("SESSION_MISMATCH", "Drain belongs to another runtime session");
        }
        if (machine == null) return;
        switch (machine.state()) {
            case DRAINING:
                machine.drainComplete(sessionId);
                break;
            case STARTING:
            case BOOTSTRAPPED:
            case PROBING:
            case READY:
            case BLOCKED:
                machine.finishReported(sessionId);
                break;
            case EXIT_WAIT:
            case EXIT_UNKNOWN:
            case EXIT_CONFIRMED:
                // A repeated receipt cannot upgrade unknown/confirmed death evidence.
                break;
            default:
                throw CoreValidation.error("INVALID_TRANSITION", "Unknown drain receipt state");
        }
    }
}
