"""Synthetic offline controls only. No ADB, fixture, device or private dumps."""
import dataclasses
import unittest
from ownership_contract import (COMPONENT, PACKAGE, PREFIX, card_label_counts,
                                metadata_policy, task_policy, window_policy)

NATIVE = '  Window #1 Window{abc u0 ' + COMPONENT + '}:\n'
FOCUS = 'mCurrentFocus=Window{abc u0 ' + COMPONENT + '}\n'
TASK = '  * Task{def #36957 type=standard A=10456:' + PACKAGE + ' U=0}\n'
RESUMED = 'topResumedActivity=ActivityRecord{bca u0 ' + COMPONENT + ' t36957}\n'
ACTIVITIES = TASK + RESUMED


def window(body='', title='StatusBar'):
    return FOCUS + ('  Window #0 Window{def u0 ' + title + '}:\n' + body + '\n' if body else '') + NATIVE


STATUS = 'mHasSurface=true isVisible=true mOwnerUid=10217 package=com.android.systemui ty=STATUS_BAR frame=[0,0][1080,120]'


class WindowControls(unittest.TestCase):
    def test_native_no_overlay(self):
        self.assertTrue(window_policy(window())[0])

    def test_exact_fixed_bars(self):
        cases = [STATUS, STATUS.replace('STATUS_BAR', 'NAVIGATION_BAR').replace('[0,0][1080,120]', '[0,2244][1080,2376]')]
        for body in cases:
            with self.subTest(body=body):
                self.assertTrue(window_policy(window(body))[0])
                self.assertTrue(window_policy(window(body.replace('frame=', 'mFrame=')))[0])

    def test_noninteractive_panels(self):
        for rect in ('[0,0][1080,299]', '[0,2077][1080,2376]'):
            body = STATUS.replace('STATUS_BAR', 'NAVIGATION_BAR_PANEL').replace('[0,0][1080,120]', rect)
            self.assertFalse(window_policy(window(body))[0])
            self.assertTrue(window_policy(window(body + ' fl=NOT_TOUCHABLE NOT_FOCUSABLE'))[0])
            for flag in ('NOT_TOUCHABLE', 'NOT_FOCUSABLE'):
                self.assertFalse(window_policy(window(body + ' fl=' + flag))[0])

    def test_oem_edge_package_is_not_inferred(self):
        body = 'mHasSurface=true isVisible=true mOwnerUid=10199 package=com.oplus.exserviceui ty=2314 frame=[1056,391][1080,621] fl=NOT_TOUCHABLE NOT_FOCUSABLE'
        self.assertFalse(window_policy(window(body, 'OplusOSEdgeFloatBar'))[0])
        self.assertFalse(window_policy(window(body, 'prefixOplusOSEdgeFloatBarSuffix'))[0])

    def test_duplicate_or_conflicting_overlay_identity(self):
        for field, conflict in [('mOwnerUid=10217', 'mOwnerUid=1'), ('package=com.android.systemui', 'package=unknown'), ('ty=STATUS_BAR', 'ty=2003')]:
            for extra in (field, conflict):
                for replacement in (field + ' ' + extra, extra + ' ' + field):
                    with self.subTest(field=field, replacement=replacement):
                        self.assertFalse(window_policy(window(STATUS.replace(field, replacement)))[0])

    def test_invalid_tokens_are_not_valid_prefixes_or_ignored_duplicates(self):
        for field, bad in [('mOwnerUid=10217', 'mOwnerUid=10217x'), ('package=com.android.systemui', 'package=unknown'), ('ty=STATUS_BAR', 'ty=STATUS_BARx'), ('frame=[0,0][1080,120]', 'frame=[0,0][1080,120]junk'), ('isVisible=true', 'isVisible=notabool'), ('mHasSurface=true', 'mHasSurface=notabool')]:
            for replacement in (bad, field + ' ' + bad, bad + ' ' + field):
                self.assertFalse(window_policy(window(STATUS.replace(field, replacement)))[0])

    def test_empty_assignments_are_counted_before_value_validation(self):
        for field in ('mOwnerUid', 'package', 'ty', 'frame', 'mFrame', 'mHasSurface', 'isVisible'):
            for empty in (field + '=', field + '= ', field + '=\n '):
                for body in (STATUS + ' ' + empty, empty + ' ' + STATUS):
                    self.assertFalse(window_policy(window(body))[0])

    def test_fake_field_boundaries_are_not_real_fields(self):
        for field in ('mOwnerUid', 'package', 'ty', 'frame', 'mHasSurface', 'isVisible'):
            self.assertFalse(window_policy(window(STATUS.replace(field + '=', 'fake-' + field + '=')))[0])

    def test_flags_are_real_fl_tokens_not_words_in_other_values(self):
        panel = STATUS.replace('STATUS_BAR', 'NAVIGATION_BAR_PANEL').replace('[0,0][1080,120]', '[0,0][1080,299]')
        for flags in ('NOT_TOUCHABLE NOT_FOCUSABLE', 'fl=NOT_TOUCHABLE=0 NOT_FOCUSABLE=0', 'fl=not-NOT_TOUCHABLE NOT_FOCUSABLE', 'fake-fl=NOT_TOUCHABLE NOT_FOCUSABLE', 'other=NOT_TOUCHABLE NOT_FOCUSABLE', 'fl=NOT_TOUCHABLE NOT_FOCUSABLE fl=', 'fl=NOT_TOUCHABLE NOT_FOCUSABLE NOT_TOUCHABLE'):
            self.assertFalse(window_policy(window(panel + ' ' + flags))[0])
        self.assertTrue(window_policy(window(panel + ' fl=NOT_TOUCHABLE NOT_FOCUSABLE pfl=OTHER'))[0])

    def test_duplicate_overlay_token_and_unsupported_indent(self):
        first = window(STATUS)
        second = '  Window #1 Window{def u0 StatusBar}:\n' + STATUS + '\n'
        self.assertFalse(window_policy(first.replace(NATIVE, second + NATIVE.replace('#1', '#2')))[0])
        self.assertFalse(window_policy(first.replace('  Window #0', '    Window #0'))[0])

    def test_missing_overlay_identity(self):
        for field in ('mOwnerUid=10217', 'package=com.android.systemui', 'ty=STATUS_BAR', 'frame=[0,0][1080,120]'):
            self.assertFalse(window_policy(window(STATUS.replace(field, '')))[0])

    def test_visibility_missing_or_ambiguous(self):
        for field in ('mHasSurface=true', 'isVisible=true'):
            for replacement in ('', field + ' ' + field, field + ' ' + field.replace('true', 'false')):
                self.assertFalse(window_policy(window(STATUS.replace(field, replacement)))[0])
        self.assertFalse(window_policy(window('mHasSurface=false'))[0])
        self.assertTrue(window_policy(window('mHasSurface=false isVisible=false'))[0])

    def test_duplicate_or_alternative_frame_fields(self):
        for duplicate in ('frame=[0,0][1080,120]', 'mFrame=[0,0][1080,120]', 'frame=[0,0][1080,600]'):
            self.assertFalse(window_policy(window(STATUS + ' ' + duplicate))[0])

    def test_expanded_wrong_uid_or_unknown_overlay(self):
        for old, new in [('[0,0][1080,120]', '[0,0][1080,600]'), ('mOwnerUid=10217', 'mOwnerUid=1'), ('package=com.android.systemui', 'package=unknown'), ('ty=STATUS_BAR', 'ty=INPUT_METHOD')]:
            self.assertFalse(window_policy(window(STATUS.replace(old, new)))[0])

    def test_lookalike_component_or_other_user(self):
        for component in (COMPONENT + 'Suffix', 'prefix' + COMPONENT, PACKAGE + '/.NativeBrowserActivity'):
            self.assertFalse(window_policy(window().replace(COMPONENT, component))[0])
        self.assertFalse(window_policy(window().replace('u0 ', 'u10 '))[0])
        self.assertFalse(window_policy(window(), user_id=True)[0])

    def test_ambiguous_focus_and_focused_header(self):
        for dump in (window() + FOCUS, NATIVE, FOCUS, window().replace('Window{abc u0', 'Window{def u0', 1), FOCUS + NATIVE.replace(COMPONENT, COMPONENT + 'Suffix'), window() + NATIVE.replace('#1', '#2')):
            self.assertFalse(window_policy(dump)[0])

    def test_malformed_duplicate_or_unsorted_window_headers(self):
        for dump in (window(STATUS).replace('#0', '#1'), window(STATUS).replace('#0', '#3'), window(STATUS).replace('Window{def', 'Window{???')):
            self.assertFalse(window_policy(dump)[0])

    def test_ignored_below_owner_does_not_become_above(self):
        # Z-order is explicit and monotonic; no blanket package whitelist.
        self.assertTrue(window_policy(window() + '  Window #2 Window{def u0 below}:\n unknown\n')[0])


class TaskControls(unittest.TestCase):
    def test_exact_original_task(self):
        self.assertTrue(task_policy(ACTIVITIES, 36957)[0])
        self.assertTrue(metadata_policy(window(STATUS), ACTIVITIES, 36957)[0])

    def test_repeated_task_references_are_one_task(self):
        self.assertTrue(task_policy(TASK * 5 + RESUMED, 36957)[0])

    def test_different_or_extra_task(self):
        self.assertFalse(task_policy(ACTIVITIES, 36958)[0])
        self.assertFalse(task_policy(ACTIVITIES + TASK.replace('#36957', '#36958'), 36957)[0])
        self.assertFalse(task_policy(ACTIVITIES + TASK.replace('10456:', '10457:'), 36957)[0])

    def test_missing_or_conflicting_resumed_activity(self):
        for value in (TASK, ACTIVITIES + RESUMED, ACTIVITIES.replace('t36957', 't36958'), ACTIVITIES.replace(COMPONENT, COMPONENT + 'Suffix'), ACTIVITIES.replace('u0 ', 'u10 ')):
            self.assertFalse(task_policy(value, 36957)[0])

    def test_task_affinity_is_exact_and_user_scoped(self):
        for value in (ACTIVITIES.replace(':' + PACKAGE, ':' + PACKAGE + '.suffix'), ACTIVITIES.replace('10456:', '1010456:'), ACTIVITIES.replace('10456:', '0:'), ACTIVITIES.replace('A=10456:', 'A=10456:' + PACKAGE + ' A=10456:')):
            self.assertFalse(task_policy(value, 36957)[0])

    def test_invalid_task_tokens_are_not_valid_prefixes(self):
        for old, new in [('#36957', '#36957:junk'), ('A=10456:', 'A=bad A=10456:'), ('A=10456:', 'A=bad:'), ('topResumedActivity=', 'topResumedActivity=\n topResumedActivity=')]:
            self.assertFalse(task_policy(ACTIVITIES.replace(old, new), 36957)[0])

    def test_empty_task_fields_are_counted(self):
        for field in ('A=', 'U=', '#'):
            for empty in (field, field + ' ', field + '  '):
                for line in (TASK.replace(' U=0}', ' ' + empty + ' U=0}'), TASK.replace('Task{def ', 'Task{def ' + empty + ' ')):
                    self.assertFalse(task_policy(line + RESUMED, 36957)[0])

    def test_task_user_is_required_unique_and_consistent(self):
        for replacement in ('', 'U=10', 'U=0 U=10', 'U=0 U=0', 'U=0 U=', 'fake-U=0'):
            self.assertFalse(task_policy(ACTIVITIES.replace('U=0', replacement), 36957)[0])

    def test_conflicting_same_id_is_not_filtered_by_package(self):
        for other in (TASK.replace(PACKAGE, 'other.package'), TASK.replace('10456:', '10457:'), TASK.replace('U=0', 'U=10')):
            self.assertFalse(task_policy(ACTIVITIES + other, 36957)[0])

    def test_unknown_or_incomplete_task_envelopes_stop(self):
        for other in (TASK.replace('Task{', 'Task {'), TASK.replace('}', ''), TASK.replace('Task{def', 'Task{???'), TASK.replace('#36957', '#36958').replace('Task{', 'Task {')):
            self.assertFalse(task_policy(ACTIVITIES + other, 36957)[0])

    def test_multiline_synthetic_activity_dump_with_references(self):
        text = 'ACTIVITY MANAGER ACTIVITIES\n  Display #0\n' + TASK + '    child activity details omitted\n' + TASK + '  ' + RESUMED + '  mLastPausedActivity=null\n'
        self.assertTrue(task_policy(text, 36957)[0])

    def test_invalid_expected_task(self):
        for task in (None, True, 0, -1, '36957'):
            self.assertFalse(task_policy(ACTIVITIES, task)[0])

    def test_window_and_activity_must_both_pass(self):
        self.assertFalse(metadata_policy(window().replace(COMPONENT, COMPONENT + 'Suffix'), ACTIVITIES, 36957)[0])
        self.assertFalse(metadata_policy(window(), TASK, 36957)[0])


class CardLabelControls(unittest.TestCase):
    def test_expected_labels_are_only_candidates(self):
        c = card_label_counts([PREFIX + 'RECOVERY A · 真机验证', PREFIX + 'renderer-b.qa.test', PREFIX + '新标签页'])
        self.assertTrue(c.matches_candidate_set())
        self.assertEqual(dataclasses.asdict(c), {'total': 3, 'a': 1, 'b': 1, 'startup_label': 1, 'unrecognized': 0})

    def test_current_unknown_card_blocks_expected_shape(self):
        c = card_label_counts([PREFIX + 'RECOVERY A · 真机验证', PREFIX + '新标签页', PREFIX + 'synthetic-private-title-not-returned'])
        self.assertFalse(c.matches_candidate_set())
        self.assertEqual((c.total, c.a, c.b, c.startup_label, c.unrecognized), (3, 1, 0, 1, 1))
        self.assertNotIn('synthetic-private-title', repr(c))

    def test_duplicate_owned_card_or_extra_blank_is_not_ignored(self):
        base = [PREFIX + 'renderer-a.qa.test', PREFIX + 'renderer-b.qa.test', PREFIX + '新标签页']
        for extra in (base[0], base[1], base[2], PREFIX + 'unknown'):
            self.assertFalse(card_label_counts(base + [extra]).matches_candidate_set())

    def test_pending_title_aliases_but_no_fuzzy_match(self):
        self.assertEqual(card_label_counts([PREFIX + 'renderer-a.qa.test', PREFIX + 'renderer-b.qa.test']).unrecognized, 0)
        for title in ('RECOVERY A', 'RECOVERY B · 真机验证 extra', '', 'about:blank'):
            self.assertEqual(card_label_counts([PREFIX + title]).unrecognized, 1)

    def test_other_controls_not_counted_as_cards(self):
        c = card_label_counts(['返回浏览器', '关闭标签页：RECOVERY A · 真机验证', '新建标签页'])
        self.assertEqual(c.total, 0)
        self.assertFalse(c.matches_candidate_set())

    def test_withheld_type_error_and_invalid_expected_counts(self):
        with self.assertRaisesRegex(TypeError, 'contents withheld'):
            card_label_counts([{'secret': 'not returned'}])
        c = card_label_counts([])
        self.assertFalse(c.matches_candidate_set(a=True, b=0, startup_label=0))
        self.assertFalse(c.matches_candidate_set(a=-1, b=0, startup_label=0))


if __name__ == '__main__':
    unittest.main()
