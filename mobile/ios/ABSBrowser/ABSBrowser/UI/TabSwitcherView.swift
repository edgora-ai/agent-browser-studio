import SwiftUI

/// Full-screen tab overview. Mirrors the Android `TabSwitcherView`: header
/// with back / title / count / ＋, a profile identity line, and a vertically
/// scrolling adaptive grid (2 columns on iPad widths, 1 below 300pt). Cards
/// show title, URL and an honest letter placeholder — never a fabricated
/// page thumbnail.
struct TabSwitcherOverlay: View {
    @ObservedObject var tabs: TabManager
    let onClose: (UUID) -> Void
    let onNewTab: () -> Void
    let onDismiss: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            profileLine
            Divider()
            grid
        }
        .background(Color(.systemGroupedBackground))
    }

    private var header: some View {
        HStack(spacing: 12) {
            Button {
                onDismiss()
            } label: {
                Image(systemName: "chevron.backward")
            }
            Text("标签页")
                .font(.headline)
                .accessibilityIdentifier("switcher.title")
            Text("· \(tabs.tabs.count)")
                .font(.headline)
                .foregroundStyle(.secondary)
            Spacer()
            Button {
                onNewTab()
            } label: {
                Image(systemName: "plus")
            }
            .disabled(tabs.tabs.count >= TabManager.maxTabs)
            .accessibilityIdentifier("switcher.new")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    private var profileLine: some View {
        HStack {
            Text("浏览环境：\(tabs.profile.name)")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Spacer()
            Text("点按卡片切换 · × 关闭")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    private var grid: some View {
        GeometryReader { proxy in
            ScrollView {
                LazyVGrid(columns: columns(for: proxy.size.width), spacing: 14) {
                    ForEach(tabs.displayModels) { cardModel in
                        TabCard(
                            card: cardModel,
                            onClose: { onClose(cardModel.id) },
                            onSelect: {
                                tabs.select(cardModel.id)
                                onDismiss()
                            }
                        )
                    }
                }
                .padding(16)
            }
        }
    }

    /// Android parity: 1 column below 300pt, otherwise floor(width / 300).
    private func columns(for width: CGFloat) -> [GridItem] {
        let minWidth: CGFloat = 300
        guard width >= minWidth else {
            return [GridItem(.flexible(), spacing: 14)]
        }
        let count = max(1, Int(width / minWidth))
        return Array(repeating: GridItem(.flexible(), spacing: 14), count: count)
    }
}

private struct TabCard: View {
    let card: TabManager.TabDisplayModel
    let onClose: () -> Void
    let onSelect: () -> Void

    var body: some View {
        Button(action: onSelect) {
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Text(title)
                        .font(.subheadline.weight(.medium))
                        .lineLimit(1)
                        .foregroundStyle(.primary)
                    Spacer()
                    Button {
                        onClose()
                    } label: {
                        Image(systemName: "xmark")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .padding(6)
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)

                Text(displayURL)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .padding(.horizontal, 12)

                preview
                    .frame(maxWidth: .infinity)
                    .frame(height: 120)
                    .background(activeBackground)
                    .padding(12)
            }
            .background(cardBackground)
            .clipShape(RoundedRectangle(cornerRadius: 14))
            .overlay(
                RoundedRectangle(cornerRadius: 14)
                    .strokeBorder(
                        card.isActive ? Color.accentColor.opacity(0.6) : Color.clear,
                        lineWidth: 2
                    )
            )
        }
        .buttonStyle(.plain)
    }

    private var title: String {
        if card.title.isEmpty { return card.isBlank ? "新标签页" : "加载中…" }
        return card.title
    }

    private var displayURL: String {
        card.isBlank ? "空白页 · 历史记录按环境隔离" : card.urlString
    }

    /// Honest placeholder: letter avatar keyed by the URL host. No fabricated
    /// page bitmaps (same rule as the Android switcher).
    private var preview: some View {
        ZStack {
            Text(hostLetter)
                .font(.system(size: 44, weight: .semibold, design: .rounded))
                .foregroundStyle(Color.accentColor.opacity(0.55))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var hostLetter: String {
        guard !card.isBlank,
              let url = URL(string: card.urlString),
              let host = url.host, !host.isEmpty else { return "＋" }
        return String(host.trimmingCharacters(in: CharacterSet(charactersIn: "www.")).first ?? "·").uppercased()
    }

    private var cardBackground: Color {
        card.isActive ? Color(.systemBackground) : Color(.secondarySystemGroupedBackground)
    }

    private var activeBackground: Color {
        card.isActive ? Color.accentColor.opacity(0.06) : Color(.tertiarySystemGroupedBackground)
    }
}
