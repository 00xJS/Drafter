import UIKit
import Capacitor
import UserNotifications

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    /// The notification centre's delegate until Capacitor's bridge exists (LaunchNotificationRelay, below).
    private let notificationRelay = LaunchNotificationRelay()

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Apple asks for the notification centre's delegate before launch
        // finishes; Capacitor sets its own only as the scene connects.
        notificationRelay.install()
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    // Server push. iOS hands the device token (or the reason there is none) to
    // the app delegate and nowhere else; the push plugin listens for these two
    // notifications, so without them PushNotifications.register() never
    // answered and Settings waited out its 15 seconds (src/push.ts).
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}

/// A tap on a notification that started the app — a reminder's banner, or its
/// Done, Tomorrow or Saw them — reaches the notification centre's delegate,
/// and Apple asks for that delegate to be set before launch finishes: one set
/// later may miss it. Capacitor sets its own (NotificationRouter) only when the
/// bridge is built, as the scene connects. This stands in until then: a
/// response that reaches it is held, and handed to Capacitor's delegate once
/// the bridge's view has appeared, whose plugins keep it for the page
/// (localNotificationActionPerformed, pushNotificationActionPerformed) until
/// the page listens. The bridge makes its own router the delegate as it is
/// built, so from then on this hears nothing.
final class LaunchNotificationRelay: NSObject, UNUserNotificationCenterDelegate {
    private var held: [(response: UNNotificationResponse, done: () -> Void)] = []
    /// Set until the bridge's view has appeared.
    private var observer: NSObjectProtocol?

    func install() {
        UNUserNotificationCenter.current().delegate = self
        observer = NotificationCenter.default.addObserver(forName: .capacitorViewDidAppear, object: nil, queue: .main) { [weak self] _ in
            self?.bridgeAppeared()
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        DispatchQueue.main.async {
            self.held.append((response, completionHandler))
            self.handOver()
        }
    }

    // One arriving while the app is still starting in front: shown as it would
    // be with the app shut, since nothing of the app's is up to show it in.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound, .badge])
    }

    private func bridgeAppeared() {
        if let observer {
            NotificationCenter.default.removeObserver(observer)
        }
        observer = nil
        handOver()
    }

    /// Everything held, to the delegate the bridge put in this one's place. The
    /// bridge sets it and loads its plugins in one go on the main thread, so a
    /// delegate other than this one is ready to take them.
    private func handOver() {
        let center = UNUserNotificationCenter.current()
        let waiting = held
        if let next = center.delegate, next !== self {
            held.removeAll()
            for (response, done) in waiting {
                if next.userNotificationCenter?(center, didReceive: response, withCompletionHandler: done) == nil {
                    done()
                }
            }
        } else if observer == nil {
            // the bridge is up and set no delegate of its own: nobody will take these
            held.removeAll()
            for (_, done) in waiting {
                done()
            }
        }
        // otherwise the bridge is not built yet, and they wait for it
    }
}
