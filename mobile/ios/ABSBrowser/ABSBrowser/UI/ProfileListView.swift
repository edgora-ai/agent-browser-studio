import SwiftUI

/// Environment list — the entry screen, mirroring the Android environment
/// app: profile cards with their identity summary, create/edit/delete.
struct ProfileListView: View {
    @ObservedObject var model: AppModel
    /// Nested store observation: AppModel does not republish store changes,
    /// so create/delete must be observed at the source.
    @ObservedObject private var store: ProfileStore
    @State private var editingProfile: ProfileSpec?
    @State private var creatingProfile = false
    @State private var pendingDelete: ProfileSpec?

    init(model: AppModel) {
        self.model = model
        self._store = ObservedObject(wrappedValue: model.profileStore)
    }

    var body: some View {
        NavigationStack {
            Group {
                if store.profiles.isEmpty {
                    emptyState
                } else {
                    profileList
                }
            }
            .navigationTitle("浏览环境")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        creatingProfile = true
                    } label: {
                        Image(systemName: "plus")
                    }
                    .keyboardShortcut("n", modifiers: .command)
                    .accessibilityIdentifier("profile.create")
                }
            }
            .sheet(isPresented: $creatingProfile) {
                ProfileEditorView(model: model, existing: nil)
            }
            .sheet(item: $editingProfile) { spec in
                ProfileEditorView(model: model, existing: spec)
            }
            .alert("删除环境", isPresented: deleteBinding) {
                Button("取消", role: .cancel) {}
                Button("删除", role: .destructive) {
                    if let target = pendingDelete {
                        model.deleteProfile(target.id)
                    }
                }
            } message: {
                Text("将删除该环境的名称与配置、历史记录、指纹种子和全部网站数据（Cookie、存储、缓存）。此操作不可恢复。")
            }
            .alert("出错了", isPresented: .init(get: { model.lastError != nil }, set: { _ in model.lastError = nil })) {
                Button("好", role: .cancel) {}
            } message: {
                Text(model.lastError ?? "")
            }
        }
    }

    private var deleteBinding: Binding<Bool> {
        Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } })
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: "person.crop.circle.badge.shield.checkmark")
                .font(.system(size: 44))
                .foregroundStyle(.tint)
            Text("还没有浏览环境")
                .font(.headline)
            Text("每个环境拥有独立的时间区、语言、代理、Cookie 与历史记录，互不可见。")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
            Button("新建环境") { creatingProfile = true }
                .buttonStyle(.borderedProminent)
        }
    }

    private var profileList: some View {
        List {
            ForEach(store.profiles) { spec in
                profileRow(spec)
            }
            .onDelete { offsets in
                guard let first = offsets.first,
                      store.profiles.indices.contains(first) else { return }
                pendingDelete = store.profiles[first]
            }
        }
        .listStyle(.insetGrouped)
    }

    private func profileRow(_ spec: ProfileSpec) -> some View {
        Button {
            model.openProfile(spec.id)
        } label: {
            HStack(alignment: .top, spacing: 14) {
                Image(systemName: spec.proxy == nil ? "network" : "arrow.triangle.branch")
                    .font(.title2)
                    .foregroundStyle(.tint)
                    .frame(width: 36)
                VStack(alignment: .leading, spacing: 4) {
                    Text(spec.name)
                        .font(.headline)
                        .foregroundStyle(.primary)
                    Text(identityLine(spec))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                    Text(networkLine(spec))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if store.activeProfileId == spec.id {
                    Text("当前")
                        .font(.caption.weight(.semibold))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(.tint.opacity(0.15), in: Capsule())
                        .foregroundStyle(.tint)
                }
            }
            .padding(.vertical, 4)
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(role: .destructive) {
                pendingDelete = spec
            } label: {
                Label("删除", systemImage: "trash")
            }
            Button {
                editingProfile = spec
            } label: {
                Label("编辑", systemImage: "slider.horizontal.3")
            }
            .tint(.blue)
        }
    }

    private func identityLine(_ spec: ProfileSpec) -> String {
        var parts = [spec.timeZoneId, spec.languageTags.joined(separator: ", ")]
        if let code = spec.countryCode { parts.append(code) }
        return parts.joined(separator: " · ")
    }

    private func networkLine(_ spec: ProfileSpec) -> String {
        let network = spec.proxy.map { "代理 \($0.display)" } ?? "直连"
        let geo: String
        switch spec.geolocationMode {
        case .real: geo = "位置真实"
        case .off: geo = "位置关闭"
        case .custom:
            let lat = spec.geolocationLatitude ?? 0
            let lon = spec.geolocationLongitude ?? 0
            geo = String(format: "位置自定义 (%.4f, %.4f)", lat, lon)
        }
        return "\(network) · \(geo) · 指纹 \(spec.fingerprintDigest)"
    }
}
