// Copyright 2026 The Agent Browser Studio Authors
// Use of this source code is governed by a BSD-style license.

#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>

#include "base/android/jni_android.h"
#include "base/android/jni_string.h"
#include "base/android/scoped_java_ref.h"
#include "base/callback_list.h"
#include "base/command_line.h"
#include "base/containers/flat_map.h"
#include "base/functional/bind.h"
#include "base/location.h"
#include "base/memory/weak_ptr.h"
#include "base/strings/string_util.h"
#include "base/task/sequenced_task_runner.h"
#include "base/time/time.h"
#include "content/public/browser/browser_context.h"
#include "content/public/browser/browser_thread.h"
#include "content/public/browser/global_routing_id.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/navigation_entry.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/page.h"
#include "content/public/browser/page_manifest_manager.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/ssl_host_state_delegate.h"
#include "content/public/browser/ssl_status.h"
#include "content/public/browser/visibility.h"
#include "content/public/browser/weak_document_ptr.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"
#include "content/public/browser/web_contents_user_data.h"
#include "content/public/common/page_type.h"
#include "content/shell/browser/shell.h"
#include "net/base/net_errors.h"
#include "net/cert/cert_status_flags.h"
#include "net/http/http_response_headers.h"
#include "net/ssl/ssl_info.h"
#include "third_party/blink/public/common/manifest/manifest_util.h"
#include "third_party/blink/public/common/navigation/product_standalone_scope.h"
#include "third_party/blink/public/mojom/manifest/display_mode.mojom.h"
#include "third_party/blink/public/mojom/manifest/manifest.mojom.h"
#include "url/gurl.h"
#include "url/origin.h"
#include "url/url_constants.h"

// Must follow headers that provide JNI type conversions.
#include "jni_headers/content/shell/agent_browser_product_jni_headers/NativePwaBridge_jni.h"

namespace content {
namespace {

using base::android::ConvertUTF16ToJavaString;
using base::android::ConvertUTF8ToJavaString;
using base::android::JavaRef;
using base::android::ScopedJavaGlobalRef;
using base::android::ScopedJavaLocalRef;
using blink::mojom::DisplayMode;

constexpr auto kManifestTimeout = base::Seconds(10);
constexpr size_t kMaxNameLength = 256;
constexpr size_t kMaxInstallUrlLength = 8192;

struct InstallManifest {
  std::string id;
  std::u16string name;
  std::string start_url;
  std::string scope;
  std::string origin;
};

bool IsHttpsWithoutUserInfo(const GURL& url) {
  return url.is_valid() && url.SchemeIs(url::kHttpsScheme) && url.has_host() &&
         !url.has_username() && !url.has_password();
}

bool IsCertificateCheckBypassed() {
  const auto* command_line = base::CommandLine::ForCurrentProcess();
  return command_line->HasSwitch("ignore-certificate-errors") ||
         command_line->HasSwitch("ignore-certificate-errors-spki-list") ||
         command_line->HasSwitch("allow-insecure-localhost");
}

bool HasNormalSSLStatus(const SSLStatus& ssl) {
  return ssl.initialized && ssl.certificate && !ssl.pkp_bypassed &&
         !net::IsCertStatusError(ssl.cert_status) &&
         ssl.content_status == SSLStatus::NORMAL_CONTENT;
}

// HTTPS in the address string is not proof of a secure committed document.
// Require the browser's actual main-frame origin and its current SSL state.
const NavigationEntry* GetCommittedSecurePageEntry(WebContents* contents) {
  if (!contents || contents->IsBeingDestroyed() || contents->IsCrashed() ||
      IsCertificateCheckBypassed()) {
    return nullptr;
  }

  NavigationEntry* entry = contents->GetController().GetLastCommittedEntry();
  if (!entry || entry->IsInitialEntry() ||
      entry->GetPageType() != PAGE_TYPE_NORMAL) {
    return nullptr;
  }

  const GURL& url = entry->GetURL();
  RenderFrameHost* frame = contents->GetPrimaryMainFrame();
  if (!IsHttpsWithoutUserInfo(url) || entry->GetVirtualURL() != url || !frame ||
      !frame->IsActive() || !frame->IsRenderFrameLive() ||
      frame->IsErrorDocument() || frame->GetLastCommittedURL() != url ||
      !frame->GetLastCommittedOrigin().IsSameOriginWith(url)) {
    return nullptr;
  }

  const int status = entry->GetHttpStatusCode();
  if (status != 0 && (status < 200 || status >= 300)) {
    return nullptr;
  }

  return HasNormalSSLStatus(entry->GetSSL()) ? entry : nullptr;
}

const NavigationEntry* GetSecurePageEntry(WebContents* contents) {
  const NavigationEntry* entry = GetCommittedSecurePageEntry(contents);
  if (!entry) {
    return nullptr;
  }
  NavigationController& controller = contents->GetController();
  return !controller.GetPendingEntry() && controller.GetVisibleEntry() == entry
             ? entry
             : nullptr;
}

bool IsSecureStandaloneCommit(NavigationHandle& navigation, const GURL& scope) {
  if (navigation.IsPageActivation() || navigation.GetNetErrorCode() != net::OK ||
      IsCertificateCheckBypassed() ||
      !blink::IsUrlInProductStandaloneScope(navigation.GetURL(), scope)) {
    return false;
  }

  const auto* entry = navigation.GetNavigationEntry();
  if (entry && entry->IsViewSourceMode()) {
    return false;
  }

  const auto origin = navigation.GetOriginToCommit();
  const auto& ssl = navigation.GetSSLInfo();
  const auto* headers = navigation.GetResponseHeaders();
  if (!origin || !origin->IsSameOriginWith(scope) || !ssl || !ssl->cert ||
      ssl->pkp_bypassed || net::IsCertStatusError(ssl->cert_status) ||
      !headers || headers->response_code() < 200 ||
      headers->response_code() >= 300) {
    return false;
  }

  // SSLManager reapplies these profile-wide flags during commit. Do not grant
  // a document the role if its host is already known to have run bad content.
  auto* delegate = navigation.GetWebContents()
                       ->GetBrowserContext()
                       ->GetSSLHostStateDelegate();
  const std::string host = origin->host();
  return !delegate ||
         (!delegate->DidHostRunInsecureContent(
              host, SSLHostStateDelegate::MIXED_CONTENT) &&
          !delegate->DidHostRunInsecureContent(
              host, SSLHostStateDelegate::CERT_ERRORS_CONTENT));
}

class ProductStandaloneRole final
    : public WebContentsObserver,
      public WebContentsUserData<ProductStandaloneRole> {
 public:
  void Revoke() {
    if (scope_.is_empty()) {
      return;
    }
    // Permanent. Clear the browser authority before any renderer IPC.
    scope_ = GURL();
    committed_document_ = WeakDocumentPtr();
    RenderFrameHost* primary = web_contents()->GetPrimaryMainFrame();
    auto revoke_frame = [](RenderFrameHost* frame) {
      if (frame && frame->IsRenderFrameLive()) {
        frame->RevokeProductStandaloneRole();
      }
    };
    revoke_frame(primary);
    for (const auto& pending : pending_commits_) {
      RenderFrameHost* frame = RenderFrameHost::FromID(pending.second);
      if (frame != primary) {
        revoke_frame(frame);
      }
    }
    pending_commits_.clear();
  }

  bool IsStandalonePage() const {
    if (scope_.is_empty() ||
        committed_document_.AsRenderFrameHostIfValid() !=
            web_contents()->GetPrimaryMainFrame()) {
      return false;
    }
    const auto* entry = GetSecurePageEntry(web_contents());
    return entry && blink::IsUrlInProductStandaloneScope(entry->GetURL(), scope_);
  }

 private:
  friend class WebContentsUserData<ProductStandaloneRole>;
  WEB_CONTENTS_USER_DATA_KEY_DECL();

  ProductStandaloneRole(WebContents* contents, GURL scope)
      : WebContentsObserver(contents),
        WebContentsUserData(*contents),
        scope_(std::move(scope)) {}

  void ReadyToCommitNavigation(NavigationHandle* navigation) override {
    if (scope_.is_empty() || !navigation->IsInPrimaryMainFrame() ||
        navigation->IsSameDocument()) {
      return;
    }
    if (!IsSecureStandaloneCommit(*navigation, scope_) ||
        !navigation->SetProductStandaloneScopeForCommit(scope_)) {
      Revoke();
      return;
    }
    pending_commits_.emplace(navigation->GetNavigationId(),
                             navigation->GetRenderFrameHost()->GetGlobalId());
  }

  void DidFinishNavigation(NavigationHandle* navigation) override {
    if (scope_.is_empty() || !navigation->IsInPrimaryMainFrame()) {
      return;
    }
    const auto pending = pending_commits_.find(navigation->GetNavigationId());
    RenderFrameHost* frame = navigation->HasCommitted()
                                 ? navigation->GetRenderFrameHost()
                                 : nullptr;
    const bool approved = pending != pending_commits_.end() && frame &&
                          pending->second == frame->GetGlobalId();
    if (pending != pending_commits_.end()) {
      pending_commits_.erase(pending);
    }
    if (!navigation->HasCommitted()) {
      return;
    }
    const auto* entry = GetCommittedSecurePageEntry(web_contents());
    if (!entry || !blink::IsUrlInProductStandaloneScope(entry->GetURL(), scope_) ||
        !blink::IsUrlInProductStandaloneScope(navigation->GetURL(), scope_) ||
        !frame || frame != web_contents()->GetPrimaryMainFrame() ||
        (navigation->IsSameDocument()
             ? committed_document_.AsRenderFrameHostIfValid() != frame
             : !approved)) {
      Revoke();
      return;
    }
    if (!navigation->IsSameDocument()) {
      committed_document_ = frame->GetWeakDocumentPtr();
    }
  }

  void PrimaryDocumentInputStreamOpened(const GURL& url) override {
    if (!scope_.is_empty() &&
        !blink::IsUrlInProductStandaloneScope(url, scope_)) {
      Revoke();
      // document.open() does not notify Java's navigation observer.
      web_contents()->DidChangeVisibleSecurityState();
    }
  }

  void DidChangeVisibleSecurityState() override {
    if (scope_.is_empty()) {
      return;
    }
    auto* entry = web_contents()->GetController().GetLastCommittedEntry();
    if (entry && !entry->IsInitialEntry() &&
        !HasNormalSSLStatus(entry->GetSSL())) {
      Revoke();
    }
  }

  void PrimaryMainFrameRenderProcessGone(base::TerminationStatus) override {
    Revoke();
  }

  GURL scope_;
  WeakDocumentPtr committed_document_;
  base::flat_map<int64_t, GlobalRenderFrameHostId> pending_commits_;
};

WEB_CONTENTS_USER_DATA_KEY_IMPL(ProductStandaloneRole);

bool HasInstallDisplayMode(const blink::mojom::Manifest& manifest) {
  DisplayMode mode = manifest.display;
  for (const auto& display_override : manifest.display_override) {
    // The first supported mode wins, including an explicit `browser`.
    // ABS v1 doesn't implement enhanced or URL-pattern-based modes.
    if (blink::IsBasicDisplayMode(display_override.display()) &&
        display_override.url_patterns().empty()) {
      mode = display_override.display();
      break;
    }
  }
  return mode == DisplayMode::kStandalone || mode == DisplayMode::kMinimalUi ||
         mode == DisplayMode::kFullscreen;
}

std::u16string_view GetInstallName(const std::optional<std::u16string>& value) {
  if (!value || value->size() > kMaxNameLength) {
    return {};
  }
  const std::u16string_view name = base::TrimWhitespace(*value, base::TRIM_ALL);
  for (char16_t c : name) {
    // Leave ordinary RTL text intact, but don't pass control characters or
    // explicit bidi formatting from page metadata to Android install surfaces.
    if (base::IsUnicodeControl(c) || c == 0x061c || c == 0x200e ||
        c == 0x200f || (c >= 0x2028 && c <= 0x202e) ||
        (c >= 0x2066 && c <= 0x2069)) {
      return {};
    }
  }
  return name;
}

std::optional<InstallManifest> GetInstallManifest(
    const blink::mojom::Manifest& manifest,
    const GURL& document_url,
    const url::Origin& origin) {
  // Content manages the linked manifest. The response URL may differ from the
  // page's link URL after a redirect.
  if (!IsHttpsWithoutUserInfo(manifest.manifest_url) ||
      !manifest.has_valid_specified_start_url ||
      !HasInstallDisplayMode(manifest)) {
    return std::nullopt;
  }

  for (const GURL* url : {&manifest.id, &manifest.start_url, &manifest.scope}) {
    if (!IsHttpsWithoutUserInfo(*url) || !origin.IsSameOriginWith(*url) ||
        url->spec().size() > kMaxInstallUrlLength) {
      return std::nullopt;
    }
  }

  // Use canonical paths, not a textual prefix of full URLs. Install into the
  // declared/defaulted scope only; no scope-extension support in v1.
  if (manifest.id.has_ref() || manifest.scope.has_ref() ||
      manifest.scope.has_query() ||
      !base::StartsWith(manifest.start_url.path(), manifest.scope.path()) ||
      !base::StartsWith(document_url.path(), manifest.scope.path())) {
    return std::nullopt;
  }

  std::u16string_view name = GetInstallName(manifest.name);
  if (name.empty()) {
    name = GetInstallName(manifest.short_name);
  }
  if (name.empty()) {
    return std::nullopt;
  }
  return InstallManifest{.id = manifest.id.spec(),
                         .name = std::u16string(name),
                         .start_url = manifest.start_url.spec(),
                         .scope = manifest.scope.spec(),
                         .origin = origin.Serialize()};
}

void ReplyWithManifest(ScopedJavaGlobalRef<jobject> callback,
                       std::optional<InstallManifest> manifest) {
  JNIEnv* env = base::android::AttachCurrentThread();
  if (!manifest) {
    const ScopedJavaLocalRef<jstring> absent;
    Java_NativePwaBridge_onManifestResult(env, callback, absent, absent, absent,
                                          absent, absent);
    return;
  }
  Java_NativePwaBridge_onManifestResult(
      env, callback, ConvertUTF8ToJavaString(env, manifest->id),
      ConvertUTF16ToJavaString(env, manifest->name),
      ConvertUTF8ToJavaString(env, manifest->start_url),
      ConvertUTF8ToJavaString(env, manifest->scope),
      ConvertUTF8ToJavaString(env, manifest->origin));
}

// The timeout task owns this request; the Content subscription and posted
// result only hold weak references. Neither can indefinitely retain the Java
// callback if the renderer stops responding or the manifest link disappears.
class ManifestRequest final : public WebContentsObserver {
 public:
  ManifestRequest(WebContents* contents,
                  const NavigationEntry& entry,
                  const GURL& link_url,
                  ScopedJavaGlobalRef<jobject> callback)
      : WebContentsObserver(contents),
        page_(contents->GetPrimaryPage().GetWeakPtr()),
        document_(page_->GetMainDocument().GetWeakDocumentPtr()),
        document_url_(entry.GetURL()),
        origin_(page_->GetMainDocument().GetLastCommittedOrigin()),
        entry_id_(entry.GetUniqueID()),
        link_url_(link_url),
        callback_(std::move(callback)) {}

  void Start() {
    subscription_ =
        PageManifestManager::GetOrCreate(*page_)->GetSpecifiedManifest(
            base::BindOnce(&ManifestRequest::OnManifest,
                           weak_factory_.GetWeakPtr()));
  }

  void Complete(std::optional<InstallManifest> manifest) {
    if (callback_.is_null()) {
      return;
    }
    if (manifest && !StillCurrent()) {
      manifest.reset();
    }
    Observe(nullptr);
    subscription_ = {};
    weak_factory_.InvalidateWeakPtrs();
    ReplyWithManifest(std::move(callback_), std::move(manifest));
  }

 private:
  bool StillCurrent() const {
    WebContents* contents = web_contents();
    if (stale_ || !contents || !page_ ||
        contents->GetVisibility() != Visibility::VISIBLE) {
      return false;
    }
    const NavigationEntry* entry = GetSecurePageEntry(contents);
    return entry && entry->GetUniqueID() == entry_id_ &&
           entry->GetURL() == document_url_ && page_->IsPrimary() &&
           page_.get() == &contents->GetPrimaryPage() &&
           document_.AsRenderFrameHostIfValid() ==
               contents->GetPrimaryMainFrame() &&
           page_->GetManifestUrl() == link_url_;
  }

  void OnManifest(const PageManifestManager::ManifestResult& result) {
    std::optional<InstallManifest> manifest;
    if (result.has_value() && *result && StillCurrent()) {
      manifest = GetInstallManifest(**result, document_url_, origin_);
    }
    // Don't call into an Activity from inside the manifest subscription's
    // notification stack. Revalidate once more on the UI reply task.
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE,
        base::BindOnce(&ManifestRequest::Complete, weak_factory_.GetWeakPtr(),
                       std::move(manifest)));
  }

  void DidStartNavigation(NavigationHandle* navigation) override {
    if (navigation->IsInPrimaryMainFrame()) {
      Invalidate();
    }
  }

  void PrimaryPageChanged(Page&) override { Invalidate(); }

  void OnVisibilityChanged(Visibility visibility) override {
    if (visibility != Visibility::VISIBLE) {
      Invalidate();
    }
  }

  void DidUpdateWebManifestURL(RenderFrameHost*, const GURL&) override {
    Invalidate();
  }

  void WebContentsDestroyed() override { Invalidate(); }

  void Invalidate() {
    if (stale_) {
      return;
    }
    stale_ = true;
    // Complete after the observer notification unwinds, never reenter Java
    // or detach the observer from inside a WebContents state change.
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(&ManifestRequest::Complete,
                                  weak_factory_.GetWeakPtr(), std::nullopt));
  }

  const base::WeakPtr<Page> page_;
  const WeakDocumentPtr document_;
  const GURL document_url_;
  const url::Origin origin_;
  const int entry_id_;
  const GURL link_url_;
  ScopedJavaGlobalRef<jobject> callback_;
  base::CallbackListSubscription subscription_;
  bool stale_ = false;
  base::WeakPtrFactory<ManifestRequest> weak_factory_{this};
};

WebContents* FromJavaContents(const JavaRef<jobject>& contents) {
  return contents.is_null() ? nullptr
                            : WebContents::FromJavaWebContents(contents);
}

}  // namespace

static void JNI_NativePwaBridge_RequestManifest(
    JNIEnv* env,
    const JavaRef<jobject>& j_contents,
    const JavaRef<jobject>& j_callback) {
  DCHECK_CURRENTLY_ON(BrowserThread::UI);
  WebContents* contents = FromJavaContents(j_contents);
  const NavigationEntry* entry = GetSecurePageEntry(contents);
  const std::optional<GURL> link =
      entry ? contents->GetPrimaryPage().GetManifestUrl() : std::nullopt;
  auto runner = base::SequencedTaskRunner::GetCurrentDefault();
  ScopedJavaGlobalRef<jobject> callback(j_callback);
  if (!entry || contents->GetVisibility() != Visibility::VISIBLE || !link ||
      !IsHttpsWithoutUserInfo(*link)) {
    runner->PostTask(
        FROM_HERE,
        base::BindOnce(&ReplyWithManifest, std::move(callback), std::nullopt));
    return;
  }

  auto request = std::make_unique<ManifestRequest>(contents, *entry, *link,
                                                   std::move(callback));
  request->Start();
  runner->PostDelayedTask(FROM_HERE,
                          base::BindOnce(
                              [](std::unique_ptr<ManifestRequest> pending) {
                                pending->Complete(std::nullopt);
                              },
                              std::move(request)),
                          kManifestTimeout);
}

static bool JNI_NativePwaBridge_IsSecurePage(
    JNIEnv* env,
    const JavaRef<jobject>& j_contents) {
  DCHECK_CURRENTLY_ON(BrowserThread::UI);
  return GetSecurePageEntry(FromJavaContents(j_contents)) != nullptr;
}

bool Shell::SetProductStandaloneScope(const GURL* scope) {
  WebContents* contents = web_contents();
  if (!scope) {
    product_standalone_scope_installable_ = false;
    if (auto* role = ProductStandaloneRole::FromWebContents(contents)) {
      role->Revoke();
    }
    return true;
  }

  NavigationController& controller = contents->GetController();
  if (!product_standalone_scope_installable_ || contents->IsCrashed() ||
      contents->IsLoading() || contents->HasOpener() ||
      contents->GetOuterWebContents() || !controller.IsInitialBlankNavigation() ||
      controller.GetPendingEntry() || IsCertificateCheckBypassed()) {
    return false;
  }
  product_standalone_scope_installable_ = false;
  ProductStandaloneRole::CreateForWebContents(contents, *scope);
  return true;
}

bool Shell::HasInstalledProductStandaloneRole() const {
  return ProductStandaloneRole::FromWebContents(web_contents()) != nullptr;
}

static bool JNI_NativePwaBridge_SetStandaloneScope(
    JNIEnv* env,
    const JavaRef<jobject>& j_contents,
    const JavaRef<jstring>& j_scope) {
  DCHECK_CURRENTLY_ON(BrowserThread::UI);
  WebContents* contents = FromJavaContents(j_contents);
  Shell* shell = contents && !contents->IsBeingDestroyed()
                     ? Shell::FromWebContents(contents)
                     : nullptr;
  if (!shell) {
    return false;
  }
  if (j_scope.is_null()) {
    return shell->SetProductStandaloneScope(nullptr);
  }
  const std::string raw = base::android::ConvertJavaStringToUTF8(env, j_scope);
  if (raw.size() > blink::kMaxProductStandaloneUrlLength) {
    return false;
  }
  const GURL scope(raw);
  return scope.spec() == raw && blink::IsProductStandaloneScope(scope) &&
         shell->SetProductStandaloneScope(&scope);
}

static bool JNI_NativePwaBridge_IsStandalonePage(
    JNIEnv* env,
    const JavaRef<jobject>& j_contents) {
  DCHECK_CURRENTLY_ON(BrowserThread::UI);
  WebContents* contents = FromJavaContents(j_contents);
  if (!contents || contents->IsBeingDestroyed()) {
    return false;
  }
  const auto* role = ProductStandaloneRole::FromWebContents(contents);
  return role && role->IsStandalonePage();
}

}  // namespace content

DEFINE_JNI(NativePwaBridge)
