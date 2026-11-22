import SwiftUI

/// New tab page shown over blank web contents. Mirrors the Android
/// `NewTabPage`: identity row, "最近访问" tiles (3 per row, max 9) with
/// honest letter avatars, footer privacy note, and long-press removal that
/// deletes the record only, never site data.
struct NewTabPageView: View {
    let profile: ProfileSpec
    let history: BrowserHistory
    let onOpen: (URL) -> Void
    let onRemoveTile: (String) -> Void
    let onShowAll: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                identityRow
                Divider()
                recentSection
                Spacer(minLength: 12)
                footer
            }
            .padding(20)
        }
        .background(Color(.systemBackground))
    }

    private var identityRow: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text(profile.name)
                    .font(.title3.weight(.semibold))
                Text("历史记录按环境隔离 · 时区 \(profile.timeZoneId)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
    }

    private var tiles: [BrowserHistory.SiteVisit] {
        history.topTiles(limit: 9)
    }

    private var recentSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("最近访问")
                    .font(.headline)
                Spacer()
                Button("全部") { onShowAll() }
                    .font(.subheadline)
                    .disabled(tiles.isEmpty)
            }

            if tiles.isEmpty {
                emptyTiles
            } else {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: 3), spacing: 12) {
                    ForEach(tiles) { visit in
                        Tile(visit: visit, onOpen: { open(visit) }, onRemove: { onRemoveTile(visit.origin) })
                    }
                }
            }
        }
    }

    private var emptyTiles: some View {
        Text("该环境还没有浏览记录。在上方输入网址开始访问。")
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .padding(.vertical, 18)
    }

    private func open(_ visit: BrowserHistory.SiteVisit) {
        // Origins are scheme://host[:port]; navigating reuses the stored scheme.
        if let url = URL(string: visit.origin) {
            onOpen(url)
        }
    }

    private var footer: some View {
        Text("记录仅保存在本设备的当前环境，不会上传；长按卡片可移除记录（不影响网站数据）。")
            .font(.caption)
            .foregroundStyle(.tertiary)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct Tile: View {
    let visit: BrowserHistory.SiteVisit
    let onOpen: () -> Void
    let onRemove: () -> Void

    var body: some View {
        Button(action: onOpen) {
            VStack(spacing: 8) {
                Text(letter)
                    .font(.system(.title2, design: .rounded).weight(.semibold))
                    .frame(width: 42, height: 42)
                    .background(.tint.opacity(0.14), in: Circle())
                    .foregroundStyle(.tint)
                Text(host)
                    .font(.caption)
                    .lineLimit(1)
                    .foregroundStyle(.primary)
                Text(meta)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .background(.quinary, in: RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button(role: .destructive, action: onRemove) {
                Label("移除该站点记录", systemImage: "trash")
            }
        }
    }

    private var host: String {
        let raw = visit.origin
        guard let url = URL(string: raw), let host = url.host else { return raw }
        let trimmed = host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
        return trimmed
    }

    private var letter: String {
        String(host.first ?? "·").uppercased()
    }

    private var meta: String {
        "\(RelativeTimeFormatter.label(millis: visit.lastVisitMillis)) · \(visit.visitCount) 次"
    }
}

/// Shared Chinese relative-time formatting ("刚刚 / N 分钟前 / 昨天 / yyyy-MM-dd").
enum RelativeTimeFormatter {
    static func label(millis: Int64, now: Date = Date()) -> String {
        let date = Date(timeIntervalSince1970: TimeInterval(millis) / 1000)
        let seconds = now.timeIntervalSince(date)
        if seconds < 60 { return "刚刚" }
        if seconds < 3600 { return "\(Int(seconds / 60)) 分钟前" }
        if seconds < 86_400 { return "\(Int(seconds / 3600)) 小时前" }

        let calendar = Calendar.current
        if calendar.isDateInYesterday(date) { return "昨天" }
        if seconds < 86_400 * 30 { return "\(Int(seconds / 86_400)) 天前" }

        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }
}
