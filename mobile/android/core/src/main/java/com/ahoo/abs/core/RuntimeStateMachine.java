package com.ahoo.abs.core;

/**
 * One launch/session per machine. All observations must come from the trusted controller adapter.
 * Runtime IPC claiming finish/death is not trusted process-death evidence. A free-lock observation
 * must be fresh and paired with the death/ESRCH observation for this exact session and process.
 */
public final class RuntimeStateMachine {
    public enum State {
        STARTING, BOOTSTRAPPED, PROBING, READY, BLOCKED,
        DRAINING, EXIT_WAIT, EXIT_UNKNOWN, EXIT_CONFIRMED
    }

    public static final int ESRCH = 3;
    public final String sessionId;
    private final ProfileSpec profile;
    private State state = State.STARTING;
    private int recordedPid;

    /** The controller must reuse its guard, not create a fresh guard for every launch. */
    public RuntimeStateMachine(LaunchSpec launch, LaunchReplayGuard guard, long nowMillis) {
        if (launch == null) throw CoreValidation.error("INVALID_LAUNCH", "A launch envelope is required");
        if (guard == null) throw CoreValidation.error("INVALID_REPLAY_GUARD", "A shared replay guard is required");
        guard.consume(launch, nowMillis);
        sessionId = launch.sessionId;
        profile = launch.profile;
    }

    public synchronized State state() {
        return state;
    }

    public synchronized int recordedPid() {
        return recordedPid;
    }

    public synchronized void recordPid(String messageSessionId, int pid) {
        requireSession(messageSessionId);
        requireState(State.STARTING, State.BOOTSTRAPPED);
        if (recordedPid != 0) throw invalidTransition();
        if (pid <= 0) throw CoreValidation.error("INVALID_PID", "A positive observed runtime PID is required");
        recordedPid = pid;
    }

    public synchronized void bootstrapped(String messageSessionId) {
        requireSession(messageSessionId);
        requireState(State.STARTING);
        state = State.BOOTSTRAPPED;
    }

    public synchronized void beginProbing(String messageSessionId) {
        requireSession(messageSessionId);
        requireState(State.BOOTSTRAPPED);
        state = State.PROBING;
    }

    /** A later loss of evidence removes READY immediately; BLOCKED is terminal until draining. */
    public synchronized void applyAdmission(String messageSessionId, AdmissionGate.Decision decision) {
        requireSession(messageSessionId);
        requireState(State.PROBING, State.READY);
        if (decision == null) throw CoreValidation.error("INVALID_EVIDENCE", "An admission decision is required");
        if (!decision.matches(profile)) {
            throw CoreValidation.error("PROFILE_MISMATCH", "Admission evidence belongs to another profile revision");
        }
        switch (decision.status) {
            case VERIFIED:
                state = State.READY;
                break;
            case BLOCKED:
                state = State.BLOCKED;
                break;
            case UNVERIFIED:
                state = State.PROBING;
                break;
            default:
                throw CoreValidation.error("INVALID_EVIDENCE", "An unknown admission status cannot admit a runtime");
        }
    }

    public synchronized void requestDrain(String messageSessionId) {
        requireSession(messageSessionId);
        requireState(State.STARTING, State.BOOTSTRAPPED, State.PROBING, State.READY, State.BLOCKED);
        state = State.DRAINING;
    }

    public synchronized void drainComplete(String messageSessionId) {
        requireSession(messageSessionId);
        requireState(State.DRAINING);
        state = State.EXIT_WAIT;
    }

    /** Activity.finish/onDestroy is a lifecycle report, not proof that the process exited. */
    public synchronized void finishReported(String messageSessionId) {
        requireSession(messageSessionId);
        requireState(State.STARTING, State.BOOTSTRAPPED, State.PROBING, State.READY, State.BLOCKED, State.DRAINING);
        state = State.EXIT_WAIT;
    }

    public synchronized void exitTimedOut(String messageSessionId) {
        requireSession(messageSessionId);
        requireState(State.DRAINING, State.EXIT_WAIT);
        state = State.EXIT_UNKNOWN;
    }

    /** trustedDeath is set only by the controller's actual session-bound Binder.DeathRecipient. */
    public synchronized void observeBinderDeath(String messageSessionId, boolean trustedDeath, boolean lifecycleLockFree) {
        requireSession(messageSessionId);
        if (!trustedDeath) {
            throw CoreValidation.error("UNTRUSTED_EXIT_EVIDENCE", "An IPC death claim is not a trusted binder-death observation");
        }
        requireNotConfirmed();
        state = lifecycleLockFree ? State.EXIT_CONFIRMED : State.EXIT_UNKNOWN;
    }

    /** errno must be the actual no-signal PID check result; EPERM/unknown/timeout never mean ESRCH. */
    public synchronized void observePidCheck(String messageSessionId, int observedPid, int errno, boolean lifecycleLockFree) {
        requireSession(messageSessionId);
        if (recordedPid <= 0 || observedPid != recordedPid) {
            throw CoreValidation.error("PID_MISMATCH", "Exit evidence must identify the recorded runtime PID exactly");
        }
        requireNotConfirmed();
        state = errno == ESRCH && lifecycleLockFree ? State.EXIT_CONFIRMED : State.EXIT_UNKNOWN;
    }

    private void requireSession(String messageSessionId) {
        if (!sessionId.equals(messageSessionId)) {
            throw CoreValidation.error("SESSION_MISMATCH", "The message does not belong to this runtime session");
        }
    }

    private void requireState(State... allowed) {
        for (State candidate : allowed) {
            if (state == candidate) return;
        }
        throw invalidTransition();
    }

    private void requireNotConfirmed() {
        if (state == State.EXIT_CONFIRMED) throw invalidTransition();
    }

    private static ValidationException invalidTransition() {
        return CoreValidation.error("INVALID_TRANSITION", "The event is not valid in the current runtime state");
    }
}
