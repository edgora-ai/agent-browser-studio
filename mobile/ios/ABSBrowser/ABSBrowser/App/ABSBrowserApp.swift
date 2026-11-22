import SwiftUI

@main
struct ABSBrowserApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView(model: model)
        }
    }
}

struct RootView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        switch model.screen {
        case .list:
            ProfileListView(model: model)
        case .browser(let id):
            if let session = model.session, session.profile.id == id {
                BrowserView(model: model, session: session, historyStore: model.historyStore)
            } else {
                ProfileListView(model: model)
            }
        }
    }
}
