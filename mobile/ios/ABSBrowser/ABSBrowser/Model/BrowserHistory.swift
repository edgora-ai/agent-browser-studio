import Foundation

/// Per-profile site-visit history model. Semantics mirror
/// `mobile/android/native-kernel/.../BrowserHistory.java`: canonical origins
/// only, 200-site LRU eviction, 3-second merge window so a page refresh does
/// not inflate visit counts, and ranked order = recency → count → origin.
struct BrowserHistory: Equatable, Codable {
    struct SiteVisit: Equatable, Codable, Identifiable {
        var origin: String
        var title: String
        var lastVisitMillis: Int64
        var visitCount: Int

        var id: String { origin }
    }

    static let maxSites = 200
    static let maxTitleLength = 200
    static let maxVisitCount = 9999
    /// Refreshes landing within this window only refresh title/time.
    static let mergeWindowMillis: Int64 = 3_000

    private(set) var sites: [SiteVisit] = []
    private var pendingOrigins: [String: Int64] = [:]

    /// Snapshot restore path used by `HistoryStore`.
    init(sites: [SiteVisit] = []) {
        self.sites = sites
    }

    // MARK: - Recording

    /// Records a completed load. Returns `true` when the visible model changed.
    mutating func recordVisit(url: String, title: String, nowMillis: Int64) -> Bool {
        guard let origin = Self.resolveOrigin(url) else { return false }
        let cleanTitle = Self.cleanTitle(title)
        let lastPending = pendingOrigins[origin]
        pendingOrigins[origin] = nowMillis

        if let index = sites.firstIndex(where: { $0.origin == origin }) {
            let withinWindow = lastPending.map { nowMillis - $0 < Self.mergeWindowMillis } ?? false
            if withinWindow {
                // Merge window: title/time refresh only, no count bump.
                if sites[index].title != cleanTitle || sites[index].lastVisitMillis != nowMillis {
                    sites[index].title = cleanTitle
                    sites[index].lastVisitMillis = nowMillis
                    return true
                }
                return false
            }
            sites[index].title = cleanTitle
            sites[index].lastVisitMillis = nowMillis
            sites[index].visitCount = min(sites[index].visitCount + 1, Self.maxVisitCount)
            return true
        }

        sites.append(SiteVisit(origin: origin, title: cleanTitle, lastVisitMillis: nowMillis, visitCount: 1))
        evictIfNeeded()
        return true
    }

    mutating func updateTitle(origin: String, title: String, nowMillis: Int64) -> Bool {
        guard let index = sites.firstIndex(where: { $0.origin == origin }) else { return false }
        let cleanTitle = Self.cleanTitle(title)
        guard sites[index].title != cleanTitle else { return false }
        sites[index].title = cleanTitle
        sites[index].lastVisitMillis = nowMillis
        return true
    }

    /// Removes one site's record. Returns `true` when a visible row was
    /// removed. Never touches cookies or site storage — record-only.
    mutating func removeSite(origin: String) -> Bool {
        let before = sites.count
        sites.removeAll { $0.origin == origin }
        pendingOrigins.removeValue(forKey: origin)
        return sites.count != before
    }

    mutating func clear() {
        sites.removeAll()
        pendingOrigins.removeAll()
    }

    var size: Int { sites.count }

    /// Recency first, then visit count, then origin — mirrors `ranked()`.
    func ranked() -> [SiteVisit] {
        sites.sorted {
            if $0.lastVisitMillis != $1.lastVisitMillis { return $0.lastVisitMillis > $1.lastVisitMillis }
            if $0.visitCount != $1.visitCount { return $0.visitCount > $1.visitCount }
            return $0.origin < $1.origin
        }
    }

    /// Top sites for the new-tab tiles (deduped by origin, max 9).
    func topTiles(limit: Int = 9) -> [SiteVisit] {
        Array(ranked().prefix(limit))
    }

    private mutating func evictIfNeeded() {
        guard sites.count > Self.maxSites else { return }
        // Evict stalest / least visited / lexically smallest origins first.
        let overflow = sites.count - Self.maxSites
        let victims = sites.sorted { a, b in
            if a.lastVisitMillis != b.lastVisitMillis { return a.lastVisitMillis < b.lastVisitMillis }
            if a.visitCount != b.visitCount { return a.visitCount < b.visitCount }
            return a.origin > b.origin
        }.prefix(overflow).map(\.origin)
        sites.removeAll { victims.contains($0.origin) }
    }

    // MARK: - Origin canonicalization (mirrors resolveOrigin)

    /// Canonical `scheme://host[:port]` for http(s) URLs only; everything else
    /// (userinfo, path, query, fragment) is dropped. Returns nil for
    /// non-http(s) or unparseable input.
    static func resolveOrigin(_ raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed), let scheme = url.scheme?.lowercased() else { return nil }
        guard scheme == "http" || scheme == "https" else { return nil }
        guard var host = url.host?.lowercased(), !host.isEmpty else { return nil }
        if host.hasSuffix(".") { host.removeLast() }
        if host.isEmpty { return nil }

        let port = url.port
        let defaultPort = (scheme == "https" && port == 443) || (scheme == "http" && port == 80)
        if let port, !defaultPort {
            let bracketed = host.contains(":") && !host.hasPrefix("[")
            return "\(scheme)://\(bracketed ? "[\(host)]" : host):\(port)"
        }
        let bracketed = host.contains(":") && !host.hasPrefix("[")
        return "\(scheme)://\(bracketed ? "[\(host)]" : host)"
    }

    static func cleanTitle(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return "" }
        return String(trimmed.prefix(Self.maxTitleLength))
    }

    // MARK: - Input resolution (mirrors resolveInput)

    /// Omnibox navigation rules from `NativeBrowserActivity.navigate`:
    /// absolute http(s) → as-is, non-http(s) scheme → rejected, bare host
    /// (incl. `host:port`) → https, anything else → search.
    static func resolveInput(_ raw: String) -> URL? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        if let url = URL(string: trimmed), let scheme = url.scheme?.lowercased(), !scheme.isEmpty {
            if scheme == "http" || scheme == "https", url.host != nil {
                return url
            }
            // `host:port` is parsed by URL as scheme "host"; rescue it.
            if url.host == nil, isHostPortForm(trimmed),
               let withScheme = URL(string: "https://\(trimmed)"),
               let host = withScheme.host, isPlausibleHost(host) {
                return withScheme
            }
            return nil // explicit non-web scheme (javascript:, file:, …) is rejected
        }
        // Missing-scheme URL like "example.com".
        if let withScheme = URL(string: "https://\(trimmed)"),
           let host = withScheme.host, isPlausibleHost(host) {
            return withScheme
        }
        return searchURL(for: trimmed)
    }

    /// `localhost:8080`-style input: single host token followed by a port.
    private static func isHostPortForm(_ input: String) -> Bool {
        guard let colon = input.firstIndex(of: ":") else { return false }
        let host = input[input.startIndex..<colon]
        let port = input[input.index(after: colon)...]
        guard !host.isEmpty, !port.isEmpty else { return false }
        return host.allSatisfy { $0.isLetter || $0.isNumber || $0 == "." || $0 == "-" }
            && port.allSatisfy(\.isNumber)
    }

    static func searchURL(for query: String) -> URL? {
        guard var components = URLComponents(string: "https://www.bing.com/search") else { return nil }
        components.queryItems = [URLQueryItem(name: "q", value: query)]
        return components.url
    }

    private static func isPlausibleHost(_ host: String) -> Bool {
        if host == "localhost" { return true }
        return host.contains(".") && !host.contains(" ") && host.count <= 253
    }
}
