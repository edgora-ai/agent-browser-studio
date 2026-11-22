import SwiftUI

/// Full-screen history destination. Mirrors the Android `HistoryPanel`:
/// header with clear-all confirmation, optional search field (origin/title
/// substring), day-grouped rows (今天 / 昨天 / 更早), per-site removal, and
/// the interaction hint line. Opens in the current tab; long-press style
/// "open in new tab" is an explicit action.
struct HistoryPanelOverlay: View {
    let history: BrowserHistory
    let onOpen: (URL) -> Void
    let onOpenNewTab: (URL) -> Void
    let onRemove: (String) -> Void
    let onClear: () -> Void
    let onDismiss: () -> Void

    @State private var query: String = ""
    @State private var showSearch = false
    @State private var showClearConfirm = false

    private var filtered: [BrowserHistory.SiteVisit] {
        let ranked = history.ranked()
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return ranked }
        let lowered = trimmed.lowercased()
        return ranked.filter {
            $0.origin.lowercased().contains(lowered) || $0.title.lowercased().contains(lowered)
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            if showSearch {
                searchField
            }
            Divider()
            list
        }
        .background(Color(.systemGroupedBackground))
        .alert("清空历史记录", isPresented: $showClearConfirm) {
            Button("取消", role: .cancel) {}
            Button("清空", role: .destructive) { onClear() }
        } message: {
            Text("仅删除浏览记录，不影响该环境的 Cookie 与网站数据。")
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Button {
                onDismiss()
            } label: {
                Image(systemName: "chevron.backward")
            }
            .accessibilityIdentifier("history.back")
            Text("历史记录")
                .font(.headline)
                .accessibilityIdentifier("history.title")
            Spacer()
            Button {
                if showSearch {
                    query = ""
                }
                showSearch.toggle()
            } label: {
                Image(systemName: showSearch ? "xmark.circle" : "magnifyingglass")
            }
            .disabled(history.size == 0)
            Button {
                showClearConfirm = true
            } label: {
                Text("清空")
            }
            .disabled(history.size == 0)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    private var searchField: some View {
        HStack {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
            TextField("搜索 origin 或标题", text: $query)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            if !query.isEmpty {
                Button {
                    query = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(10)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 10))
        .padding(.horizontal, 16)
        .padding(.bottom, 10)
    }

    private var list: some View {
        ScrollView {
            if filtered.isEmpty {
                VStack(spacing: 8) {
                    Text(history.size == 0 ? "该环境还没有浏览记录。" : "没有匹配“\(query)”的记录。")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Text("历史记录按环境隔离，仅保存在本设备。")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
                .padding(.top, 60)
            } else {
                ForEach(dayGroups, id: \.key) { group in
                    VStack(alignment: .leading, spacing: 0) {
                        Text(group.key)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 16)
                            .padding(.top, 18)
                            .padding(.bottom, 6)
                        ForEach(group.rows) { visit in
                            Row(
                                visit: visit,
                                onOpen: { open(visit, newTab: false) },
                                onOpenNewTab: { open(visit, newTab: true) },
                                onRemove: { onRemove(visit.origin) }
                            )
                        }
                    }
                }
                Text("点按在当前标签页打开 · ⌘点按在新标签页打开 · × 删除该站点")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .padding(.vertical, 16)
            }
        }
    }

    private func open(_ visit: BrowserHistory.SiteVisit, newTab: Bool) {
        guard let url = URL(string: visit.origin) else { return }
        if newTab {
            onOpenNewTab(url)
        } else {
            onOpen(url)
        }
    }

    private struct DayGroup {
        let key: String
        let rows: [BrowserHistory.SiteVisit]
    }

    private var dayGroups: [DayGroup] {
        let calendar = Calendar.current
        let now = Date()
        var buckets: (today: [BrowserHistory.SiteVisit], yesterday: [BrowserHistory.SiteVisit], earlier: [BrowserHistory.SiteVisit]) = ([], [], [])
        for visit in filtered {
            let date = Date(timeIntervalSince1970: TimeInterval(visit.lastVisitMillis) / 1000)
            if calendar.isDateInToday(date) {
                buckets.today.append(visit)
            } else if calendar.isDateInYesterday(date) {
                buckets.yesterday.append(visit)
            } else {
                buckets.earlier.append(visit)
            }
        }
        _ = now
        var groups: [DayGroup] = []
        if !buckets.today.isEmpty { groups.append(DayGroup(key: "今天", rows: buckets.today)) }
        if !buckets.yesterday.isEmpty { groups.append(DayGroup(key: "昨天", rows: buckets.yesterday)) }
        if !buckets.earlier.isEmpty { groups.append(DayGroup(key: "更早", rows: buckets.earlier)) }
        return groups
    }
}

private struct Row: View {
    let visit: BrowserHistory.SiteVisit
    let onOpen: () -> Void
    let onOpenNewTab: () -> Void
    let onRemove: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Text(letter)
                .font(.system(.subheadline, design: .rounded).weight(.semibold))
                .frame(width: 30, height: 30)
                .background(.tint.opacity(0.14), in: Circle())
                .foregroundStyle(.tint)
            VStack(alignment: .leading, spacing: 2) {
                Text(displayTitle)
                    .font(.subheadline)
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Text(visit.origin)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text(RelativeTimeFormatter.label(millis: visit.lastVisitMillis))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Text("\(visit.visitCount) 次")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            Button {
                onRemove()
            } label: {
                Image(systemName: "xmark")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(8)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(Color(.secondarySystemGroupedBackground))
        .contentShape(Rectangle())
        .onTapGesture(perform: onOpen)
        .onTapGesture(count: 2, perform: onOpenNewTab)
        .contextMenu {
            Button(action: onOpenNewTab) {
                Label("在新标签页打开", systemImage: "plus.square.on.square")
            }
            Button(role: .destructive, action: onRemove) {
                Label("删除该站点", systemImage: "trash")
            }
        }
    }

    private var displayTitle: String {
        visit.title.isEmpty ? visit.origin : visit.title
    }

    private var letter: String {
        guard let url = URL(string: visit.origin), let host = url.host, !host.isEmpty else { return "·" }
        let trimmed = host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
        return String(trimmed.first ?? "·").uppercased()
    }
}
