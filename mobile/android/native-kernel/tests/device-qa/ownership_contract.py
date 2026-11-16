"""Pure host-only QA metadata checks. No device access or import-time I/O.

These are partial, best-effort evidence gates, NOT input authorization. Call/awake
checks, fresh exact QA URL/document ownership, user permission and non-atomic
capture boundaries remain the runner's responsibility. Historical runners do not
import this module. This strict portrait profile is for the recorded OnePlus
Android 16 window shape only, not a general Android/SystemUI whitelist.
"""
from dataclasses import dataclass
import re

PACKAGE = 'com.ahoo.abs.browser'
COMPONENT = PACKAGE + '/com.ahoo.abs.android.nativekernel.NativeBrowserActivity'
PREFIX = '切换到标签页：'
ALIASES = {p: {PREFIX + f'RECOVERY {p} · 真机验证',
               PREFIX + f'renderer-{p.lower()}.qa.test'} for p in ('A', 'B')}


def _one(pattern, text):
    values = re.findall(pattern, text, re.M)
    return values[0] if len(values) == 1 else None


def _field(names, text):
    # Whitespace/start is the field boundary; '-' and quoted prefixes are not.
    # Match empty assignments too, so a malformed duplicate cannot disappear.
    return _one(r'(?<!\S)(?:' + names + r')=([^\s]*)', text)


def _noninteractive_flags(body):
    markers = list(re.finditer(r'(?<!\S)fl=', body))
    if len(markers) != 1:
        return False
    first_line = body[markers[0].end():].split('\n', 1)[0]
    flags = []
    for token in first_line.split():
        if '=' in token or token == '}':
            break
        if not re.fullmatch(r'[A-Z][A-Z_0-9]*', token):
            return False
        flags.append(token)
    return (len(flags) == len(set(flags))
            and {'NOT_TOUCHABLE', 'NOT_FOCUSABLE'} <= set(flags))


def window_policy(windows, *, user_id=0):
    """Check exact native focus and bounded visible windows above it.

    Accepts only an externally obtained complete ``dumpsys window -a`` capture.
    No raw metadata or unknown titles are returned in the fixed reason strings.
    It cannot establish capture freshness, idle/awake state or QA page ownership.
    """
    if not isinstance(windows, str):
        return False, 'invalid-window-capture'
    if type(user_id) is not int or user_id < 0:
        return False, 'invalid-user'
    focus_text = _one(r'^\s*mCurrentFocus=([^\n]*)$', windows)
    if focus_text is None:
        return False, 'ambiguous-focus'
    focus = re.fullmatch(r'Window\{([a-f0-9]+) u(\d+) ([^\n}]+)\}', focus_text.strip())
    if not focus or focus[2] != str(user_id) or focus[3] != COMPONENT:
        return False, 'not-exact-native-focus'
    sections = list(re.finditer(r'^[ \t]*Window #[^\n]*', windows, re.M))
    parsed = []
    for i, section in enumerate(sections):
        header = re.fullmatch(r'  Window #(\d+) Window\{([a-f0-9]+) u(\d+) ([^\n}]+)\}:', section[0])
        if not header:
            return False, 'malformed-window-header'
        end = sections[i + 1].start() if i + 1 < len(sections) else len(windows)
        parsed.append((header, windows[section.end():end]))
    indices = [int(h[1]) for h, _ in parsed]
    tokens = [h[2] for h, _ in parsed]
    if not indices or indices != sorted(set(indices)) or len(tokens) != len(set(tokens)):
        return False, 'ambiguous-window-order'
    owners = [i for i, (h, _) in enumerate(parsed) if h[2] == focus[1]]
    if len(owners) != 1:
        return False, 'ambiguous-focused-window'
    owner_index = owners[0]
    owner = parsed[owner_index][0]
    if owner[3] != str(user_id) or owner[4] != COMPONENT:
        return False, 'focused-header-mismatch'
    for header, body in parsed[:owner_index]:
        surface = _field('mHasSurface', body)
        visible = _field('isVisible', body)
        if surface not in ('true', 'false') or visible not in ('true', 'false'):
            return False, 'ambiguous-surface-visibility'
        if surface == 'false' or visible == 'false':
            continue
        uid = _field('mOwnerUid', body)
        package = _field('package', body)
        kind = _field('ty', body)
        frame_text = _field('mFrame|frame', body)
        frame = re.fullmatch(r'\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]', frame_text or '')
        if (uid is None or not re.fullmatch(r'[0-9]+', uid) or package is None
                or kind is None or not re.fullmatch(r'[A-Z_0-9]+', kind) or frame is None):
            return False, 'ambiguous-overlay-metadata'
        rect = tuple(map(int, frame.groups()))
        noninteractive = _noninteractive_flags(body)
        systemui = package == 'com.android.systemui' and uid == '10217' and header[3] == str(user_id)
        if systemui and kind == 'STATUS_BAR' and rect == (0, 0, 1080, 120):
            continue
        if systemui and kind == 'NAVIGATION_BAR' and rect == (0, 2244, 1080, 2376):
            continue
        if systemui and kind == 'NAVIGATION_BAR_PANEL' and noninteractive and rect in ((0, 0, 1080, 299), (0, 2077, 1080, 2376)):
            continue
        # OEM edge package was not independently pinned: do not infer it from UID/title.
        return False, 'unknown-visible-overlay'
    return True, 'bounded-native-window-metadata'


def task_policy(activities, expected_task_id, *, user_id=0):
    """Bind resumed Activity to explicit original task; deduplicate references.

    Activity data must come from a fresh package-filtered activities dump. Task
    affinity is only corroborating metadata, not QA document or profile proof.
    """
    if not isinstance(activities, str):
        return False, 'invalid-activity-capture'
    if type(expected_task_id) is not int or expected_task_id <= 0 or type(user_id) is not int or user_id < 0:
        return False, 'invalid-expected-owner'
    resumed = _one(r'^\s*topResumedActivity=([^\n]*)$', activities)
    if resumed is None:
        return False, 'ambiguous-resumed-activity'
    record = re.fullmatch(r'ActivityRecord\{[a-f0-9]+ u(\d+) ([^\s}]+) t(\d+)\}', resumed.strip())
    if not record or record[1] != str(user_id) or record[2] != COMPONENT or int(record[3]) != expected_task_id:
        return False, 'resumed-owner-mismatch'
    identities = {}
    for line in activities.splitlines():
        if not re.match(r'^\s*(?:\*\s*)?Task\b', line):
            continue
        if not re.fullmatch(r'\s*(?:\*\s*)?Task\{[a-f0-9]+ [^{}]*\}\s*', line):
            return False, 'unsupported-task-shape'
        ids = re.findall(r'(?<!\S)#([^\s}]*)', line)
        affinities = re.findall(r'(?<!\S)A=([^\s}]*)', line)
        users = re.findall(r'(?<!\S)U=([^\s}]*)', line)
        if (len(ids) != 1 or not re.fullmatch(r'[0-9]+', ids[0])
                or len(affinities) != 1 or len(users) != 1
                or not re.fullmatch(r'[0-9]+', users[0])):
            return False, 'ambiguous-task-record'
        affinity = re.fullmatch(r'([0-9]+):([A-Za-z0-9_.]+)', affinities[0])
        if not affinity:
            return False, 'ambiguous-task-record'
        uid, package = affinity.groups()
        uid, task_user, task_id = int(uid), int(users[0]), int(ids[0])
        if uid // 100000 != task_user:
            return False, 'task-user-mismatch'
        identity = (uid, package, task_user)
        if task_id in identities and identities[task_id] != identity:
            return False, 'conflicting-task-identity'
        identities[task_id] = identity
    owned = {task_id: identity for task_id, identity in identities.items() if identity[1] == PACKAGE}
    if set(owned) != {expected_task_id}:
        return False, 'original-task-not-unique'
    uid, _, task_user = owned[expected_task_id]
    if task_user != user_id or not 10000 <= uid % 100000 < 90000:
        return False, 'task-user-mismatch'
    return True, 'exact-original-task-metadata'


def metadata_policy(windows, activities, expected_task_id, *, user_id=0):
    """Combine partial window/task checks; still NOT permission for any input."""
    ok, reason = window_policy(windows, user_id=user_id)
    return task_policy(activities, expected_task_id, user_id=user_id) if ok else (ok, reason)


@dataclass(frozen=True)
class CardLabelCounts:
    total: int = 0
    a: int = 0
    b: int = 0
    startup_label: int = 0
    unrecognized: int = 0

    def matches_candidate_set(self, *, a=1, b=1, startup_label=1):
        """Label-shape test ONLY: titles cannot prove native origin or URL."""
        return (all(type(n) is int and n >= 0 for n in (a, b, startup_label))
                and self.unrecognized == 0
                and (self.a, self.b, self.startup_label) == (a, b, startup_label)
                and self.total == a + b + startup_label)


def card_label_counts(descriptions):
    """Classify already obtained descriptions, returning counts, never contents.

    A startup *label* is not evidence of about:blank; aliases also do not prove
    QA path/document ownership. Do not select unrecognized cards to resolve it.
    """
    total = a = b = startup = unknown = 0
    for desc in descriptions:
        if not isinstance(desc, str):
            raise TypeError('Descriptions must be strings; contents withheld')
        if not desc.startswith(PREFIX):
            continue
        total += 1
        if desc in ALIASES['A']:
            a += 1
        elif desc in ALIASES['B']:
            b += 1
        elif desc == PREFIX + '新标签页':
            startup += 1
        else:
            unknown += 1
    return CardLabelCounts(total, a, b, startup, unknown)
