import Capacitor
import Foundation

/// The iPhone half of the garment cut-out: Vision lifts the garment out of the
/// photo here, on the device, and the web view puts it on white (src/native.ts,
/// liftSubject). Registered by DrafterBridgeViewController in SceneDelegate.swift,
/// because `cap sync` lists only the plugins that come from node_modules.
@objc(SubjectLiftPlugin)
public class SubjectLiftPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SubjectLiftPlugin"
    public let jsName = "SubjectLift"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "lift", returnType: CAPPluginReturnPromise)
    ]

    /// Capacitor runs every plugin call on one serial queue. A lift can take a
    /// second, and a haptic tap or the keyboard must not wait behind it.
    private let queue = DispatchQueue(label: "app.drafter.subject-lift", qos: .userInitiated)

    /// Photos bigger than this (as base64) are refused unread; the web path takes
    /// them. A backstop a little above the JS cap of 16,000,000 bytes (21.3M chars).
    private static let maxBase64 = 22_000_000

    @objc func isAvailable(_ call: CAPPluginCall) {
        #if targetEnvironment(simulator)
        // Vision has no CPU path for this request, and the Simulator offers nothing else.
        call.resolve(["available": false, "reason": "simulator"])
        #else
        if #available(iOS 17.0, *) {
            call.resolve(["available": true])
        } else {
            call.resolve(["available": false, "reason": "ios-version"])
        }
        #endif
    }

    @objc func lift(_ call: CAPPluginCall) {
        #if targetEnvironment(simulator)
        call.unavailable("Subject lifting does not run in the Simulator")
        #else
        guard #available(iOS 17.0, *) else {
            call.unavailable("Subject lifting needs iOS 17")
            return
        }
        guard let base64 = call.getString("image"), !base64.isEmpty else {
            call.reject("No photo was sent", "BAD_IMAGE")
            return
        }
        guard base64.utf8.count <= Self.maxBase64 else {
            call.reject("The photo is too large to lift here", "TOO_LARGE")
            return
        }
        let maxDimension = min(max(call.getInt("maxDimension") ?? 2048, 512), 4096)
        queue.async {
            guard let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters) else {
                call.reject("The photo could not be read", "BAD_IMAGE")
                return
            }
            do {
                let lifted = try autoreleasepool { try SubjectLift.lift(data, maxDimension: maxDimension) }
                call.resolve([
                    "image": lifted.png.base64EncodedString(),
                    "width": lifted.width,
                    "height": lifted.height,
                    "instanceMask": lifted.mask.base64EncodedString(),
                    "maskWidth": lifted.maskWidth,
                    "maskHeight": lifted.maskHeight,
                    "found": lifted.found
                ])
            } catch SubjectLift.Failure.noSubject {
                call.reject("No subject was found in the photo", "NO_SUBJECT")
            } catch SubjectLift.Failure.badImage {
                call.reject("The photo could not be read", "BAD_IMAGE")
            } catch SubjectLift.Failure.vision(let error) {
                call.reject("Vision could not lift the subject", "VISION_FAILED", error)
            } catch {
                call.reject("The cut-out could not be written", "ENCODE_FAILED", error)
            }
        }
        #endif
    }
}
