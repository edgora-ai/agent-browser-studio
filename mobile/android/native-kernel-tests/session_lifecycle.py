#!/usr/bin/env python3
"""Bound the lifetime of one already-authorized, exclusively owned lab session.

This module does not issue a runtime/storage permit or create a listener, ADB,
emulator, subprocess, file or browser. The entry point must supply its actual,
nonblocking permit/ownership check before prepare performs any effects. Resource
factories must return only this session's new resources, never borrowed ones.

Prepare, on_ready and accepted clients share one start-relative deadline. Stop
first closes acceptance, then cancels/awaits work and closes writers, then asks
owned child controllers for normal stop AND actual wait, and only then closes
logs. Failed or unconfirmed cleanup is retained, not promoted to success. No
force-kill, default endpoint, raw request/exception logging or native PASS here.
"""
import asyncio
from dataclasses import dataclass
import math
import time

MAX_SESSION_SECONDS = 3000.0
MAX_CLEANUP_SECONDS = 45.0
MAX_LISTENERS = 4
MAX_TASKS = 64
MAX_WRITERS = 64
MAX_CHILDREN = 16
MAX_LOGS = 8
REASONS = frozenset((
    'requested-stop', 'session-deadline', 'external-cancellation', 'session-failed',
    'invalid-clock', 'clock-regressed', 'not-running', 'already-run',
    'permit-unavailable', 'required-child-exited', 'owned-task-failed',
    'resource-bound', 'resource-contract',
))


class SessionError(RuntimeError):
    def __init__(self, code):
        self.code = code if code in REASONS else 'resource-contract'
        super().__init__(self.code)


@dataclass(frozen=True)
class ChildStopResult:
    """wait_returncode is the controller's actual wait result, not poll/EOF/TERM."""
    wait_returncode: int | None
    remaining_pids: tuple

    def confirmed(self):
        return (type(self.wait_returncode) is int and type(self.remaining_pids) is tuple
                and not self.remaining_pids)


@dataclass(frozen=True)
class SessionOutcome:
    reason: str
    cleanup: str
    ready_completed: bool
    pending_tasks: int
    unconfirmed_writers: int
    unconfirmed_children: int
    unconfirmed_listeners: int
    unconfirmed_logs: int

    @property
    def normal_stop(self):
        return (self.reason in ('requested-stop', 'session-deadline')
                and self.cleanup == 'CONFIRMED')


@dataclass(frozen=True)
class _Child:
    handle: object
    required: bool
    stop: object


def _seconds(value, maximum):
    if (type(value) not in (int, float) or not math.isfinite(value)
            or not 0 < value <= maximum):
        raise ValueError('invalid-duration')
    return float(value)


class OwnedSession:
    def __init__(self, *, require_runtime_permit, stop_requested,
                 seconds=MAX_SESSION_SECONDS, cleanup_seconds=MAX_CLEANUP_SECONDS,
                 now=time.monotonic, tick_seconds=0.1):
        self.seconds = _seconds(seconds, MAX_SESSION_SECONDS)
        self.cleanup_seconds = _seconds(cleanup_seconds, MAX_CLEANUP_SECONDS)
        self.tick_seconds = _seconds(tick_seconds, 1.0)
        if not all(callable(fn) for fn in (require_runtime_permit, stop_requested, now)):
            raise ValueError('required-session-checks')
        self._permit = require_runtime_permit
        self._stop_requested = stop_requested
        self._now = now
        self._previous = None
        self._deadline = None
        self._running = False
        self._used = False
        self._stopping = False
        self._requested = False
        self._ready_completed = False
        self._task_failed = False
        self._workflow_failed = False
        self._child_failed = False
        self._rejected_writers = 0
        self._tasks = set()
        self._writers = set()
        self._listeners = []
        self._children = []
        self._logs = []
        self._cleanup_tasks = set()
        self.outcome = None

    @property
    def deadline(self):
        if self._deadline is None:
            raise SessionError('not-running')
        return self._deadline

    def _clock(self):
        current = self._now()
        if (type(current) not in (int, float) or not math.isfinite(current)
                or current < 0):
            raise SessionError('invalid-clock')
        if self._previous is not None and current < self._previous:
            raise SessionError('clock-regressed')
        self._previous = current
        return current

    def guard(self):
        """Cheap synchronous check; no inventory walk or blocking child command."""
        if not self._running or self._stopping:
            raise SessionError('not-running')
        if self._clock() >= self.deadline:
            raise SessionError('session-deadline')
        if self._task_failed:
            raise SessionError('owned-task-failed')
        for child in self._children:
            if child.required and child.handle.poll() is not None:
                raise SessionError('required-child-exited')
        if self._requested or self._stop_requested():
            raise SessionError('requested-stop')
        try:
            # A returned True/dictionary/token is not an actual permit check.
            if self._permit() is not None:
                raise SessionError('permit-unavailable')
        except Exception:
            raise SessionError('permit-unavailable') from None
        return self.deadline

    def request_stop(self):
        self._requested = True

    def _workflow_done(self, task):
        if not task.cancelled():
            error = task.exception()
            if error is not None and not (isinstance(error, SessionError)
                    and error.code in ('requested-stop', 'session-deadline')):
                self._workflow_failed = True

    def _task_done(self, task):
        self._tasks.discard(task)
        if not task.cancelled() and task.exception() is not None:
            self._task_failed = True

    def create_task(self, factory):
        """Create no coroutine until checks pass; client/relay work stays owned."""
        self.guard()
        if len(self._tasks) >= MAX_TASKS:
            raise SessionError('resource-bound')
        coroutine = factory()
        try:
            task = asyncio.create_task(coroutine)
        except BaseException:
            coroutine.close()
            raise
        self._tasks.add(task)
        task.add_done_callback(self._task_done)
        return task

    async def create_listener(self, factory):
        self.guard()
        if len(self._listeners) >= MAX_LISTENERS:
            raise SessionError('resource-bound')
        listener = await factory()
        # Register BEFORE the post-await guard, including a late-returning factory.
        self._listeners.append(listener)
        if self._stopping:
            listener.close()
        self.guard()
        return listener

    def own_writer(self, writer):
        # Only pass a freshly accepted OWNED stream here, not a borrowed writer.
        # A rejection still closes it; without a completed close await this is
        # explicitly unconfirmed, rather than losing the stream or calling PASS.
        if writer in self._writers:
            raise SessionError('resource-contract')
        try:
            self.guard()
            if len(self._writers) >= MAX_WRITERS:
                raise SessionError('resource-bound')
        except Exception:
            self._rejected_writers += 1
            writer.close()
            raise
        self._writers.add(writer)
        return writer

    async def close_writer(self, writer):
        if writer not in self._writers:
            raise SessionError('resource-contract')
        writer.close()
        # The caller's task remains tracked while this await can block. Cleanup
        # repeats a normal close/wait if the caller is cancelled in that window.
        await writer.wait_closed()
        self._writers.discard(writer)

    def spawn_child(self, factory, *, required, stop):
        """The fixed owner must verify identity and normally stop/wait this handle.

        factory is synchronous, starts a NEW owned child and returns its handle.
        stop(handle, absolute_cleanup_deadline) is async, must recheck ownership,
        never force-kill, and returns ChildStopResult from an actual child wait.
        """
        self.guard()
        if (type(required) is not bool or not callable(stop)
                or len(self._children) >= MAX_CHILDREN):
            raise SessionError('resource-bound')
        handle = factory()
        self._children.append(_Child(handle, required, stop))
        self.guard()
        return handle

    def open_log(self, factory):
        self.guard()
        if len(self._logs) >= MAX_LOGS:
            raise SessionError('resource-bound')
        stream = factory()
        self._logs.append(stream)
        self.guard()
        return stream

    async def _workflow(self, prepare, on_ready):
        self.guard()
        context = await prepare(self)
        self.guard()
        await on_ready(self, context)
        self.guard()
        self._ready_completed = True
        # Completing on_ready is not permission to leave the lifetime unbounded.
        await asyncio.Future()

    async def _watch(self):
        while True:
            self.guard()
            await asyncio.sleep(min(self.tick_seconds, self.deadline - self._previous))

    async def _cleanup_await(self, factory, deadline, *, seconds=5.0):
        """asyncio.wait, not wait_for: cancellation suppression cannot extend grace."""
        async def invoke():
            # Protect synchronous callback/awaitable-construction failures too.
            return await factory()
        remaining = max(0.0, min(seconds, deadline - time.monotonic()))
        if remaining <= 0:
            return False, None
        task = asyncio.create_task(invoke())
        self._cleanup_tasks.add(task)
        # Retrieve late exceptions without printing raw callback/error content.
        task.add_done_callback(lambda done: None if done.cancelled() else done.exception())
        done, _pending = await asyncio.wait({task}, timeout=remaining)
        if not done:
            task.cancel()
            return False, None
        self._cleanup_tasks.discard(task)
        if task.cancelled():
            return False, None
        try:
            return True, task.result()
        except Exception:
            return False, None

    async def _cleanup(self, workflow, watch):
        # Cleanup has its own bounded grace, never a renewed session deadline.
        self._stopping = True
        deadline = time.monotonic() + self.cleanup_seconds
        for child in self._children:
            try:
                if child.required and child.handle.poll() is not None:
                    self._child_failed = True
            except Exception:
                self._child_failed = True
        listener_failures = child_failures = log_failures = 0
        writer_failures = self._rejected_writers
        for listener in self._listeners:
            try:
                listener.close()
            except Exception:
                listener_failures += 1
        for task in (workflow, watch, *tuple(self._tasks)):
            task.cancel()
        for writer in tuple(self._writers):
            try:
                writer.close()
            except Exception:
                writer_failures += 1
        # Cancel/await ready, client and relay work before stopping their children.
        pending = {task for task in (workflow, watch, *tuple(self._tasks)) if not task.done()}
        if pending:
            _done, pending = await asyncio.wait(
                pending, timeout=max(0.0, min(5.0, deadline - time.monotonic())))
        for task in (workflow, watch):
            if task.done() and not task.cancelled():
                task.exception()
        for listener in self._listeners:
            ok, _result = await self._cleanup_await(listener.wait_closed, deadline)
            if not ok:
                listener_failures += 1
        for writer in tuple(self._writers):
            ok, _result = await self._cleanup_await(writer.wait_closed, deadline)
            if ok:
                self._writers.discard(writer)
            else:
                writer_failures += 1
        for child in reversed(self._children):
            ok, result = await self._cleanup_await(
                lambda child=child: child.stop(child.handle, deadline), deadline, seconds=30.0)
            if not ok or not isinstance(result, ChildStopResult) or not result.confirmed():
                child_failures += 1
        # No client/relay logging is accepted once stopping; logs close last.
        for stream in self._logs:
            failed = False
            try:
                stream.flush()
            except Exception:
                failed = True
            finally:
                try:
                    stream.close()
                    if stream.closed is not True:
                        failed = True
                except Exception:
                    failed = True
            log_failures += int(failed)
        pending_count = sum(not task.done() for task in pending | self._cleanup_tasks)
        failures = (pending_count, writer_failures, child_failures, listener_failures, log_failures)
        # Missing the work-drain phase is still unconfirmed even if a late task
        # finishes during child cleanup: it could have returned another resource.
        confirmed = not pending and not any(failures)
        return ('CONFIRMED' if confirmed else 'UNCONFIRMED', *failures)

    async def run(self, prepare, on_ready):
        if self._used:
            raise SessionError('already-run')
        self._used = True
        self._deadline = self._clock() + self.seconds
        self._running = True
        workflow = asyncio.create_task(self._workflow(prepare, on_ready))
        workflow.add_done_callback(self._workflow_done)
        watch = asyncio.create_task(self._watch())
        watch.add_done_callback(lambda done: None if done.cancelled() else done.exception())
        cancelled = False
        reason = 'session-failed'
        try:
            done, _pending = await asyncio.wait({workflow, watch}, return_when=asyncio.FIRST_COMPLETED)
            # Examine both results. A simultaneous failed workflow must not be
            # hidden by an otherwise normal stop/deadline from the watch task.
            errors = [task.exception() for task in done if not task.cancelled()]
            normal = ('requested-stop', 'session-deadline')
            failures = [error for error in errors
                        if not isinstance(error, SessionError) or error.code not in normal]
            selected = failures[0] if failures else (errors[0] if errors else None)
            reason = selected.code if isinstance(selected, SessionError) else 'session-failed'
        except asyncio.CancelledError:
            cancelled = True
            reason = 'external-cancellation'
        finally:
            # Repeated parent cancellation cannot abandon owned cleanup. Its
            # internal phases use the one absolute cleanup deadline above.
            cleanup = asyncio.create_task(self._cleanup(workflow, watch))
            while not cleanup.done():
                try:
                    await asyncio.shield(cleanup)
                except asyncio.CancelledError:
                    cancelled = True
                    reason = 'external-cancellation'
            values = cleanup.result()
            self._running = False
            if reason in ('requested-stop', 'session-deadline'):
                if self._task_failed:
                    reason = 'owned-task-failed'
                elif self._workflow_failed:
                    reason = 'session-failed'
                elif self._child_failed:
                    reason = 'required-child-exited'
            self.outcome = SessionOutcome(reason, values[0], self._ready_completed, *values[1:])
        if cancelled:
            raise asyncio.CancelledError()
        return self.outcome
