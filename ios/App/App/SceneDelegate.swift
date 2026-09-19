import UIKit
import WebKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    /// The LaunchScreen, in the app's current light or dark, held over the window
    /// while the scene is not active so the App Switcher card cannot show the
    /// planner. `LockGate` only paints once Capacitor's `resume` has reached JS
    /// and React has committed, which is long after iOS took its snapshot — so
    /// the cover has to live out here.
    private var privacyCoverController: UIViewController?
    /// Bumped on every resign-active so the delayed uncover queued by an earlier
    /// activation cannot strip a cover that a later one has just put up.
    private var coverGeneration = 0
    /// A Home Screen quick action that launched a cold start. Held here until
    /// the bridge's view appears — not in a local `var` the appear closure
    /// would capture and then mutate, which Swift warns about.
    private var pendingShortcut: UIApplicationShortcutItem?

    deinit {
        NotificationCenter.default.removeObserver(self, name: .capacitorViewDidAppear, object: nil)
    }

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        // Settings → Appearance, before anything is drawn: the status bar, the
        // keyboard, pickers, alerts and the web view's own prefers-color-scheme
        // all follow the window's style. The page sends its choice again as it
        // starts (AppearancePlugin, below).
        window?.overrideUserInterfaceStyle = AppearanceChoice.saved
        window?.rootViewController = DrafterBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)

        // A Home Screen quick action that cold-started the app. Plugins are not
        // registered yet, so hold it until the bridge's view appears — the same
        // deferral SceneDelegateProxy uses for a cold-start drafter:// link.
        if let shortcutItem = connectionOptions.shortcutItem {
            deliverAfterViewDidAppear(shortcutItem)
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }

    // MARK: - Home Screen quick actions

    /// The drafter:// route behind each `UIApplicationShortcutItemType` in Info.plist.
    /// Every one of these is a route the app already parses (see src/links.ts).
    static func url(for shortcutType: String) -> URL? {
        switch shortcutType {
        case "journal":
            // ...?tab=journal opens today's editor; drafter://journal?text= carries a line to append
            return URL(string: "drafter://open?tab=journal")
        case "new":
            return URL(string: "drafter://new")
        case "plan":
            // Plan my day, over Home → Today; it writes nothing until its own button is pressed
            return URL(string: "drafter://open?plan=day")
        case "wardrobe":
            // Home → Wardrobe (routes.ts, LEGACY_VIEW_TO_HOME)
            return URL(string: "drafter://open?view=wardrobe")
        case "today":
            return URL(string: "drafter://open?view=today")
        default:
            return nil
        }
    }

    /// A quick action tapped while the app was already running.
    func windowScene(
        _ windowScene: UIWindowScene,
        performActionFor shortcutItem: UIApplicationShortcutItem,
        completionHandler: @escaping (Bool) -> Void
    ) {
        completionHandler(deliver(shortcutItem))
    }

    @discardableResult
    private func deliver(_ shortcutItem: UIApplicationShortcutItem) -> Bool {
        guard let url = Self.url(for: shortcutItem.type) else { return false }
        // AppPlugin observes this and turns it into the JS `appUrlOpen` that
        // native.ts already routes, retaining it until a listener consumes it.
        // Deliberately NOT also ApplicationDelegateProxy.lastURL: App.getLaunchUrl()
        // drains that, and a quick action fed to both channels would be applied twice.
        NotificationCenter.default.post(name: .capacitorOpenURL, object: ["url": url, "options": [String: Any]()])
        return true
    }

    private func deliverAfterViewDidAppear(_ shortcutItem: UIApplicationShortcutItem) {
        NotificationCenter.default.removeObserver(self, name: .capacitorViewDidAppear, object: nil)
        pendingShortcut = shortcutItem
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleBridgeViewDidAppear),
            name: .capacitorViewDidAppear,
            object: nil
        )
    }

    @objc private func handleBridgeViewDidAppear() {
        NotificationCenter.default.removeObserver(self, name: .capacitorViewDidAppear, object: nil)
        guard let item = pendingShortcut else { return }
        pendingShortcut = nil
        deliver(item)
    }

    // MARK: - App Switcher privacy cover

    // Resign-active, not enter-background: the switcher can be dragged open while
    // the scene is merely inactive, and that is the moment iOS snapshots.
    func sceneWillResignActive(_ scene: UIScene) {
        coverGeneration += 1
        showPrivacyCover()
    }

    // Resign-active stays phone-only (see `showPrivacyCover`), but entering the
    // background is unambiguous on every idiom and still precedes the switcher
    // snapshot — so an iPad, which this target also ships to, is covered too.
    // On iPhone this is a no-op after the resign-active cover already went up.
    func sceneDidEnterBackground(_ scene: UIScene) {
        coverGeneration += 1
        showPrivacyCover(force: true)
    }

    // Unconditional on the way out (there is no reliable way to read the
    // `drafter:app-lock` flag out of localStorage here), so uncover on a short
    // delay: it gives LockGate's overlay a frame to commit before the live
    // planner is exposed, and costs an unlocked app about a sixth of a second.
    func sceneDidBecomeActive(_ scene: UIScene) {
        let generation = coverGeneration
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
            guard let self, self.coverGeneration == generation else { return }
            self.hidePrivacyCover()
        }
    }

    private func showPrivacyCover(force: Bool = false) {
        // Merely losing focus covers on phone only. On iPad a scene that loses
        // focus (Slide Over, Split View, Stage Manager) stays fully on screen in
        // `foregroundInactive` and does not become active again until it is
        // tapped — covering it there would replace the pane with a splash for as
        // long as the user works in the other app. `force` is the background
        // path, which is unambiguous everywhere.
        guard force || UIDevice.current.userInterfaceIdiom == .phone else { return }
        guard let window = window, privacyCoverController == nil else { return }
        let storyboard = Bundle.main.path(forResource: "LaunchScreen", ofType: "storyboardc") != nil
            ? UIStoryboard(name: "LaunchScreen", bundle: nil).instantiateInitialViewController()
            : nil
        let controller = storyboard ?? fallbackCoverController()
        controller.loadViewIfNeeded()
        let cover: UIView = controller.view
        cover.frame = window.bounds
        // the storyboard's ground is the light one iOS launches on; the cover
        // takes the app's current one, so a Dark app is covered in dark
        cover.backgroundColor = Ground.of(window.traitCollection)
        cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        // Touches are not delivered to an inactive scene anyway, so swallowing
        // them buys nothing — and would eat a tap that arrives in the 0.15s
        // window before the uncover fires.
        cover.isUserInteractionEnabled = false
        window.addSubview(cover)
        privacyCoverController = controller
    }

    private func hidePrivacyCover() {
        privacyCoverController?.viewIfLoaded?.removeFromSuperview()
        privacyCoverController = nil
    }

    /// If LaunchScreen.storyboard is ever missing or loses its initial view
    /// controller, still cover — on the app's light ground, which
    /// `showPrivacyCover` repaints for the current theme.
    private func fallbackCoverController() -> UIViewController {
        let controller = UIViewController()
        controller.view.backgroundColor = Ground.light
        return controller
    }
}

// MARK: - Appearance (Settings → Appearance)

/// The grounds painted before the page: THEME_GROUND in src/theme.ts.
/// launchscreen.test.ts holds these, the storyboard and the web tokens equal.
enum Ground {
    static let light = UIColor(red: 0.9647, green: 0.9686, blue: 0.9765, alpha: 1)
    static let dark = UIColor(red: 0.0588, green: 0.0667, blue: 0.0824, alpha: 1)
    static func of(_ traits: UITraitCollection) -> UIColor { traits.userInterfaceStyle == .dark ? dark : light }
}

/// The page keeps the choice in localStorage ('drafter:theme'); this copy exists
/// only so the window can take it before the web view has run a line.
enum AppearanceChoice {
    static let key = "drafter.theme"
    static func style(_ raw: String?) -> UIUserInterfaceStyle {
        switch raw {
        case "dark": return .dark
        case "system": return .unspecified
        default: return .light
        }
    }
    static var saved: UIUserInterfaceStyle { style(UserDefaults.standard.string(forKey: key)) }
}

/// `Appearance.apply({ style })` from syncNativeAppearance in src/native.ts: keep
/// the choice for the next cold start and give it to the window now.
@objc(AppearancePlugin)
public class AppearancePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppearancePlugin"
    public let jsName = "Appearance"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "apply", returnType: CAPPluginReturnPromise)]

    @objc func apply(_ call: CAPPluginCall) {
        let raw = call.getString("style") ?? "light"
        UserDefaults.standard.set(raw, forKey: AppearanceChoice.key)
        DispatchQueue.main.async {
            (self.bridge?.viewController as? DrafterBridgeViewController)?.applyAppearance(AppearanceChoice.style(raw))
            call.resolve()
        }
    }
}

/// The bridge, plus the plugins compiled into this target: the page's own light
/// or dark (AppearancePlugin, above) and the garment cut-out's subject lifting
/// (SubjectLiftPlugin.swift). `cap sync` writes packageClassList from
/// node_modules alone and rewrites it every time, so a plugin that lives in
/// ios/App is registered here, by hand. It has to be this hook: registering
/// injects the plugin's JS proxy as a user script, and capacitorDidLoad is the
/// last moment before the page loads.
class DrafterBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(AppearancePlugin())
        bridge?.registerPluginInstance(SubjectLiftPlugin())
        paintGround()
    }

    func applyAppearance(_ style: UIUserInterfaceStyle) {
        view.window?.overrideUserInterfaceStyle = style
        setNeedsStatusBarAppearanceUpdate()
        paintGround()
    }

    /// Behind the page before it paints, and in the overscroll above and below it.
    func paintGround() {
        let ground = Ground.of(view.window?.traitCollection ?? traitCollection)
        webView?.backgroundColor = ground
        webView?.scrollView.backgroundColor = ground
    }

    // iOS 16 is the deployment target, so this rather than registerForTraitChanges (17+)
    override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
        super.traitCollectionDidChange(previousTraitCollection)
        paintGround()
    }
}
