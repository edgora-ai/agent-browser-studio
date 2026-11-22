import SwiftUI

/// Create/edit one environment. Validation runs through `ProfileSpec`
/// (the same fail-closed rules as the Android core), so the form can be
/// permissive and surface the canonical errors on save.
struct ProfileEditorView: View {
    @ObservedObject var model: AppModel
    let existing: ProfileSpec?

    @Environment(\.dismiss) private var dismiss

    @State private var name: String = ""
    @State private var timeZoneId: String = "Asia/Hong_Kong"
    @State private var languagesText: String = "zh-HK, en-US"
    @State private var countryCode: String = ""
    @State private var userAgentOverride: String = ""
    @State private var theme: ProfileSpec.ProfileTheme = .system
    @State private var geoMode: ProfileSpec.GeolocationMode = .real
    @State private var latitudeText: String = ""
    @State private var longitudeText: String = ""
    @State private var useProxy: Bool = false
    @State private var proxyScheme: ProxySpec.Scheme = .http
    @State private var proxyHost: String = ""
    @State private var proxyPortText: String = ""
    @State private var proxyUsername: String = ""
    @State private var proxyPassword: String = ""
    @State private var timezoneQuery: String = ""
    @State private var showingTimezonePicker = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                identitySection
                personaSection
                proxySection
                if existing != nil {
                    Section {
                        Text("指纹 \(existing?.fingerprintDigest ?? "")")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } header: {
                        Text("身份摘要")
                    } footer: {
                        Text("摘要由时区、语言、地区、代理与 UA 推导；代理凭证不参与。")
                    }
                }
            }
            .navigationTitle(existing == nil ? "新建环境" : "编辑环境")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") { save() }
                }
            }
            .sheet(isPresented: $showingTimezonePicker) {
                TimezonePicker(query: $timezoneQuery, selection: $timeZoneId)
            }
            .alert("无法保存", isPresented: .init(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })) {
                Button("好", role: .cancel) {}
            } message: {
                Text(errorMessage ?? "")
            }
            .onAppear(perform: loadExisting)
        }
    }

    private func loadExisting() {
        guard let spec = existing, name.isEmpty else { return }
        name = spec.name
        timeZoneId = spec.timeZoneId
        languagesText = spec.languageTags.joined(separator: ", ")
        countryCode = spec.countryCode ?? ""
        userAgentOverride = spec.userAgentOverride ?? ""
        theme = spec.theme
        geoMode = spec.geolocationMode
        if spec.geolocationMode == .custom {
            latitudeText = String(format: "%.7f", spec.geolocationLatitude ?? 0)
            longitudeText = String(format: "%.7f", spec.geolocationLongitude ?? 0)
        }
        if let proxy = spec.proxy {
            useProxy = true
            proxyScheme = proxy.scheme
            proxyHost = proxy.host
            proxyPortText = String(proxy.port)
        }
        if let credentials = model.credentialStore.credentials(for: spec.id) {
            proxyUsername = credentials.username
            proxyPassword = credentials.password
        }
    }

    private var identitySection: some View {
        Section {
            TextField("环境名称（如：HK 日常）", text: $name)
            Button {
                showingTimezonePicker = true
            } label: {
                HStack {
                    Text("时区").foregroundStyle(.primary)
                    Spacer()
                    Text(timeZoneId).foregroundStyle(.secondary)
                }
            }
            TextField("语言标签（逗号分隔，如 zh-HK, en-US）", text: $languagesText)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            TextField("地区代码（可选，两位，如 HK）", text: $countryCode)
                .textInputAutocapitalization(.characters)
        } header: {
            Text("身份")
        }
    }

    private var personaSection: some View {
        Section {
            TextField("UA 覆盖（留空使用 iPad 原生身份）", text: $userAgentOverride, axis: .vertical)
                .font(.system(.caption))
                .lineLimit(2...3)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Picker("外观", selection: $theme) {
                ForEach(ProfileSpec.ProfileTheme.allCases, id: \.self) { theme in
                    Text(themeLabel(theme)).tag(theme)
                }
            }
            Picker("地理位置", selection: $geoMode) {
                ForEach(ProfileSpec.GeolocationMode.allCases, id: \.self) { mode in
                    Text(geoLabel(mode)).tag(mode)
                }
            }
            if geoMode == .custom {
                TextField("纬度（-90 ~ 90）", text: $latitudeText)
                    .keyboardType(.numbersAndPunctuation)
                TextField("经度（-180 ~ 180）", text: $longitudeText)
                    .keyboardType(.numbersAndPunctuation)
            }
        } header: {
            Text("声明身份")
        } footer: {
            Text("UA 覆盖仅改变页面观察到的 navigator.userAgent，Accept-Language 与 Client Hints 请求头仍由系统决定，这一泄漏面会在「身份检查」页如实显示。")
        }
    }

    private var proxySection: some View {
        Section {
            Toggle("使用代理", isOn: $useProxy.animation())
            if useProxy {
                Picker("类型", selection: $proxyScheme) {
                    ForEach(ProxySpec.Scheme.allCases, id: \.self) { scheme in
                        Text(scheme.rawValue.uppercased()).tag(scheme)
                    }
                }
                .pickerStyle(.segmented)
                TextField("主机（如 192.168.4.100）", text: $proxyHost)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.asciiCapable)
                TextField("端口", text: $proxyPortText)
                    .keyboardType(.numberPad)
                TextField("用户名（可选）", text: $proxyUsername)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                SecureField("密码（可选）", text: $proxyPassword)
                Text("代理凭证保存在本设备钥匙串，不写入环境文件，也不参与指纹摘要。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                Text("显式直连：该环境不配置任何代理。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text("网络")
        }
    }

    private func themeLabel(_ theme: ProfileSpec.ProfileTheme) -> String {
        switch theme {
        case .system: return "跟随系统"
        case .light: return "浅色"
        case .dark: return "深色"
        }
    }

    private func geoLabel(_ mode: ProfileSpec.GeolocationMode) -> String {
        switch mode {
        case .real: return "真实"
        case .off: return "关闭"
        case .custom: return "自定义"
        }
    }

    private func save() {
        do {
            var proxy: ProxySpec?
            if useProxy {
                guard let port = Int(proxyPortText.trimmingCharacters(in: .whitespaces)) else {
                    throw ProxySpec.SpecError.portRange
                }
                proxy = try ProxySpec(scheme: proxyScheme, host: proxyHost, port: port)
            }

            let geoMode = self.geoMode
            let lat = Double(latitudeText.trimmingCharacters(in: .whitespaces))
            let lon = Double(longitudeText.trimmingCharacters(in: .whitespaces))

            let ua = userAgentOverride.trimmingCharacters(in: .whitespacesAndNewlines)
            let spec = try ProfileSpec(
                id: existing?.id ?? UUID(),
                revision: existing?.revision ?? UUID(),
                name: name,
                timeZoneId: timeZoneId,
                languageTags: languagesText.split(separator: ",").map(String.init),
                countryCode: countryCode.isEmpty ? nil : countryCode.uppercased(),
                proxy: proxy,
                userAgentOverride: ua.isEmpty ? nil : ua,
                theme: theme,
                geolocationMode: geoMode,
                geolocationLatitude: geoMode == .custom ? lat : nil,
                geolocationLongitude: geoMode == .custom ? lon : nil,
                geolocationAccuracy: geoMode == .custom ? 30 : nil
            )

            let credentials: ProxyCredentials? = (useProxy && !proxyUsername.isEmpty)
                ? ProxyCredentials(username: proxyUsername, password: proxyPassword)
                : nil

            if let existing {
                try model.saveProfile(spec, credentials: credentials)
            } else {
                try model.createProfile(spec, credentials: credentials, activate: true)
            }
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

/// Searchable IANA timezone picker (mirrors the Android editor's search
/// selection).
struct TimezonePicker: View {
    @Binding var query: String
    @Binding var selection: String
    @Environment(\.dismiss) private var dismiss

    private var candidates: [String] {
        let all = TimeZone.knownTimeZoneIdentifiers
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return all }
        let lowered = trimmed.lowercased()
        return all.filter { $0.lowercased().contains(lowered) }
    }

    var body: some View {
        NavigationStack {
            List(candidates, id: \.self) { identifier in
                Button {
                    selection = identifier
                    dismiss()
                } label: {
                    HStack {
                        Text(identifier).foregroundStyle(.primary)
                        Spacer()
                        if identifier == selection {
                            Image(systemName: "checkmark").foregroundStyle(.tint)
                        }
                    }
                }
            }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "搜索时区")
            .navigationTitle("选择时区")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
            }
        }
    }
}
