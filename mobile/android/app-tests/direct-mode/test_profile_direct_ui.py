"""UI source contracts only; not Android execution, visual or networking evidence."""
from pathlib import Path
import unittest

ANDROID = Path(__file__).resolve().parents[2]
APP = ANDROID / "app/src/main/java/com/ahoo/abs/android"
EDITOR = (APP / "ProfileEditor.java").read_text()
MANAGER = (APP / "MainActivity.java").read_text()


class DirectUiSourceContract(unittest.TestCase):
    def test_new_profile_does_not_require_catalog(self):
        create = MANAGER.split("private void createItem()", 1)[1].split("private void openProfile", 1)[0]
        self.assertIn("ProfileEditor.show(this, repository, null", create)
        self.assertNotIn("proxies.isEmpty()", create)
        self.assertNotIn("先添加一个代理", create)

    def test_explicit_visible_default_and_disclosure(self):
        self.assertIn("boolean baselineDirect = original == null || original.isDirect();", EDITOR)
        self.assertIn('useDirect.setText("不使用代理（直连）")', EDITOR)
        self.assertIn("useDirect.setChecked(baselineDirect)", EDITOR)
        self.assertIn("系统 VPN", EDITOR)
        self.assertIn("公网 IP", EDITOR)
        self.assertIn("useDirect.setMinHeight(Ui.dp(activity, 48))", EDITOR)
        self.assertIn("if (!useDirect.isChecked() && selectedProxy[0] == null", EDITOR)
        self.assertIn("&& (original == null || original.isDirect())", EDITOR)

    def test_save_is_explicit_and_proxy_credentials_preserved(self):
        save = EDITOR.split("if (useDirect.isChecked())", 2)[-1]
        self.assertIn("nameValue, null, countryValue", save)
        self.assertIn("repository.saveProfileWithoutProxy(candidate", save)
        self.assertIn("repository.saveProfileKeepingCredentials(candidate, original.revision)", save)
        self.assertIn("repository.saveProfileWithProxy(candidate, original.revision, selected.id)", save)
        self.assertIn("original.credentialRevision", save)
        self.assertLess(save.index("repository.saveProfileWithoutProxy"), save.index("holder[0].dismiss()"))

    def test_mode_choice_dirty_revert_and_proxy_callbacks(self):
        self.assertIn("|| useDirect.isChecked() != baselineDirect", EDITOR)
        self.assertIn("|| (!useDirect.isChecked() && selectedProxy[0] != null)", EDITOR)
        self.assertEqual(2, EDITOR.count("useDirect.setChecked(false)"))
        self.assertIn("useDirect.setOnCheckedChangeListener", EDITOR)
        revert = EDITOR.split("revertProxy.setOnClickListener", 1)[1].split("// Dirty check", 1)[0]
        self.assertIn("selectedProxy[0] = null", revert)
        self.assertIn("useDirect.setChecked(baselineDirect)", revert)
        self.assertIn("setError(proxyError, \"\")", revert)

    def test_manager_direct_search_summary_and_copy(self):
        self.assertIn("matches(query, profile.name, routeLabel(profile)", MANAGER)
        self.assertIn('profile.isDirect() ? "不使用代理（直连）"', MANAGER)
        self.assertIn("if (copy.isDirect()) repository.saveProfileWithoutProxy(copy, null)", MANAGER)
        self.assertIn("!profile.hasProxyCredentials()", MANAGER)
        self.assertNotIn("profile.proxy.hasCredentials", MANAGER)

    def test_archived_webview_cannot_inherit_direct_system_proxy(self):
        activity = (APP / "browser/BrowserActivity.java").read_text()
        runtime = (APP / "browser/BrowserRuntime.java").read_text()
        self.assertLess(activity.index("if (launch.profile.isDirect())"), activity.index("runtime.acquireView"))
        self.assertLess(runtime.index("if (launch.profile.isDirect())"), runtime.index("new ProxyConfig.Builder()"))
        self.assertIn(".removeImplicitRules().build()", runtime)
        self.assertNotIn("clearProxyOverride", runtime)


if __name__ == "__main__":
    unittest.main(verbosity=2)
